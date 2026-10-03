// TASK-080 §19/§20: интеграционные тесты ModelStore — РЕАЛЬНЫЙ трафик через
// EgressGateway (tmp-БД v5 + broadcast-мост, прецедент egress-gateway.int.test.ts)
// на локальный node:http мок-сервер с фикстурами обрывов/Range/mismatch.
//
// Матрица §19 → приёмка §20:
//  1. happy: загрузка → installed, sha256 совпадает, файл атомарно (нет .part) — AC1;
//  2. обрыв (сервер рвёт соединение после N байт) → retry → докачка Range — AC2
//     (сервер логирует Range-заголовок с offset);
//  3. сервер без Range → полный путь, рестарт вместо докачки, resumable=false
//     отмечен в состоянии (§5/§13);
//  4. mismatch (фикстура с другим хешем в манифесте-моке) → .part удалена, статус
//     error, reset → повторная установка проходит — AC3;
//  5. DISK_FULL до старта (мок fs-статс) — AC4;
//  6. место перед финальным rename (§13) → error, .part сохранена, resume досматривает;
//  7. прогресс-события ≤4/сек (throttle 250 мс) — AC5;
//  8. пауза → «перезапуск приложения» (новый store, тот же каталог) → paused →
//     resume докачивает с Range — AC6;
//  9. вторая загрузка при активной → AI/DOWNLOAD_BUSY (§9);
// 10. модель вне манифеста → AI/MODEL_NOT_FOUND, без сети;
// 11. path traversal в file манифеста → APP/INTERNAL, без сети и записи (§14).
//
// URL в манифесте — https-форма (схема §13 079 требует https); транспорт
// loopback-клиента уводит его на локальный мок-сервер — как в 075: «локальный
// мок-сервер тестов — не политика», а глобальный fetch в тестах заблокирован
// guard'ом FR-7.2 (vitest.setup) — трафик идёт через gateway-деп node:http.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- TASK-080 §19: локальный http-сервер фикстур (обрывы/Range/mismatch) — тестовая loopback-петля, не сетевой путь приложения: ModelStore ходит только через EgressGateway-порт (§14), guard FR-7.2 (vitest.setup) сохранён
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import type { ModelDescriptor, ModelProgressPayload, NetConsents } from '@hl/contracts';
import { AppError, FixedClock, unsafeUnwrap, type Result } from '@hl/kernel';

import { createBroadcastToWindows, type BroadcastTarget } from '../../../events/broadcast.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { EgressGateway } from '../../platform-services/index.js';
import { ModelsRegistry } from './models-registry.js';
import { ModelStore } from './model-store.js';
import { silentLogger } from '../../../shared/logger/silent-logger.js';

// --- вспомогательные чистые хелперы ---

/** Детерминированное содержимое фикстуры (§19). */
const makeContent = (total: number): Buffer =>
  Buffer.from(Array.from({ length: total }, (_, i) => (i * 7 + 11) % 256));

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/** Извлечение err-ветки Result с падением теста на ok. */
const failOf = (result: Result<unknown, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидался err, получен ok');
  }
  return result.error;
};

/** Ожидание условия опросом (детерминизм межпроцессных моментов в тестах). */
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: условие не выполнено за отведённое время');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
};

// --- мок-сервер модели (§19: обрывы/Range/hold/pace-фикстуры + лог запросов) ---

interface MockModelServer {
  /** Реальный loopback-адрес (http) — только для транспортного деп fetch теста. */
  readonly port: number;
  /** URL манифеста — https-форма (схема 079), транспорт уводится на port. */
  readonly endpoint: string;
  readonly requests: { readonly method: string; readonly range: string | null }[];
  readonly rangeLog: string[];
  tearNextGetAfter(bytes: number): void;
  /** Держит следующий GET: первый кусок сразу, остаток — по release(). */
  holdNextGet(): { release(): void };
  paceNextGet(chunkSize: number, paceMs: number): void;
  close(): Promise<void>;
}

const startModelServer = (content: Buffer, supportRange: boolean): Promise<MockModelServer> => {
  const requests: { method: string; range: string | null }[] = [];
  const rangeLog: string[] = [];
  let tearAfterBytes: number | null = null;
  let paced: { chunkSize: number; paceMs: number } | null = null;
  let heldGate: { open: () => void; gate: Promise<void> } | null = null;

  const server: Server = createServer((req, res) => {
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;
    if (req.method === 'HEAD') {
      requests.push({ method: 'HEAD', range: rangeHeader });
      res.writeHead(200, {
        'content-length': String(content.length),
        ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
      });
      res.end();
      return;
    }
    requests.push({ method: req.method ?? 'GET', range: rangeHeader });
    if (rangeHeader !== null) {
      rangeLog.push(rangeHeader);
    }

    let slice = content;
    let status = 200;
    if (supportRange && rangeHeader !== null) {
      const match = /^bytes=(\d+)-$/.exec(rangeHeader);
      const start = match === null ? 0 : Number(match[1]);
      slice = content.subarray(start);
      status = 206;
    }
    res.writeHead(status, {
      'content-length': String(slice.length),
      ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
    });

    if (tearAfterBytes !== null) {
      // Обрыв (§19): отдать N байт и разрушить соединение (одноразово).
      const n = Math.min(tearAfterBytes, slice.length);
      tearAfterBytes = null;
      res.end(slice.subarray(0, n), () => {
        res.destroy();
      });
      return;
    }
    if (heldGate !== null) {
      // Hold-фикстура: первый кусок отдаём сразу, остаток — ТОЛЬКО по release
      // (гейт резолвит_release, не flush-колбэк — иначе ответ уходит целиком).
      const held = heldGate;
      heldGate = null;
      const first = Math.min(64, slice.length);
      res.write(slice.subarray(0, first));
      void held.gate.then(() => {
        if (!res.destroyed) {
          res.end(slice.subarray(first));
        }
      });
      return;
    }
    if (paced !== null) {
      // Pace-фикстура: куски по chunkSize с паузой paceMs — для throttle-теста.
      const { chunkSize, paceMs } = paced;
      paced = null;
      let offset = 0;
      const writeNext = (): void => {
        if (res.destroyed) {
          return;
        }
        const next = slice.subarray(offset, offset + chunkSize);
        offset += next.length;
        if (next.length === 0) {
          res.end();
          return;
        }
        res.write(next, () => {
          setTimeout(writeNext, paceMs);
        });
      };
      writeNext();
      return;
    }
    res.end(slice);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new TypeError('мок-сервер: ожидается AddressInfo (listen на порту 0)');
      }
      resolve({
        port: address.port,
        endpoint: 'https://models.local.test/models/fixture.gguf',
        requests,
        rangeLog,
        tearNextGetAfter: (bytes) => {
          tearAfterBytes = bytes;
        },
        paceNextGet: (chunkSize, paceMs) => {
          paced = { chunkSize, paceMs };
        },
        holdNextGet: () => {
          let open!: () => void;
          const gate = new Promise<void>((resolveGate) => {
            open = resolveGate;
          });
          heldGate = { open, gate };
          return { release: open };
        },
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
          }),
      });
    });
  });
};

/**
 * Реальный HTTP-клиент теста (§19): loopback node:http к мок-серверу, тело
 * ответа — живой поток (Readable.toWeb), abort из init.signal рвёт запрос
 * (пауза ModelStore). URL из манифеста (https-форма) уводится на порт
 * мок-сервера: в тестах сеть = локальный сервер (см. шапку файла).
 */
const makeStreamingFetch =
  (realPort: number) =>
  (endpoint: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: realPort,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers: (init?.headers as Record<string, string> | undefined) ?? undefined,
        },
        (res) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              headers.set(name, value);
            } else if (Array.isArray(value)) {
              for (const item of value) {
                headers.append(name, item);
              }
            }
          }
          const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status: res.statusCode ?? 200, headers }));
        },
      );
      req.on('error', reject);
      init?.signal?.addEventListener('abort', () => req.destroy(), { once: true });
      req.end();
    });

// --- общая фикстура: tmp-каталог + манифест-мок + gateway + ModelStore ---

const dirs: string[] = [];
const servers: MockModelServer[] = [];
const dbs: EncryptedDatabase[] = [];

afterAll(async () => {
  for (const server of servers) {
    await server.close();
  }
  for (const db of dbs) {
    db.close();
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Fake-окно (webContents со шпионом send + отметка времени) — приёмник событий. */
const makeFakeWindow = (): {
  target: BroadcastTarget;
  envelopes: { channel: string; envelope: unknown; atMs: number }[];
} => {
  const envelopes: { channel: string; envelope: unknown; atMs: number }[] = [];
  const target: BroadcastTarget = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      envelopes.push({ channel, envelope: payload, atMs: Date.now() });
    },
    once: () => undefined,
  };
  return { target, envelopes };
};

/** Событие ai:progress с моментом доставки моста (для throttle-теста AC5). */
type ProgressEnvelope = ModelProgressPayload & { readonly atMs: number };

interface Fixture {
  readonly modelsDir: string;
  readonly manifestPath: string;
  readonly store: ModelStore;
  readonly server: MockModelServer;
  readonly gateway: EgressGateway;
  readonly fetchCalls: { endpoint: string; init?: RequestInit }[];
  descriptor(overrides?: Partial<ModelDescriptor>): ModelDescriptor;
  setManifest(models: ModelDescriptor[]): void;
  setFreeDiskBytes(impl: (dir: string) => number | Promise<number>): void;
  /** Новый store над тем же каталогом/манифестом — «перезапуск приложения» (AC6). */
  reopenStore(): ModelStore;
  partPath(): string;
  metaPath(): string;
  finalPath(): string;
  progressPayloads(): ProgressEnvelope[];
}

const makeFixture = (
  options: {
    readonly supportRange?: boolean;
    readonly content?: Buffer;
    readonly freeDiskBytes?: (dir: string) => number | Promise<number>;
  } = {},
): Promise<Fixture> => {
  const content = options.content ?? makeContent(2048);
  const supportRange = options.supportRange ?? true;
  return startModelServer(content, supportRange).then((server) => {
    servers.push(server);
    const root = mkdtempSync(join(tmpdir(), 'hl-model-store-int-'));
    dirs.push(root);
    const modelsDir = join(root, 'models');
    const manifestPath = join(root, 'models-manifest.json');

    const descriptor = (overrides: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
      id: 'test-model',
      name: 'Test Model',
      version: '1.0.0',
      file: 'test-model.gguf',
      url: server.endpoint,
      sha256: sha256Hex(content),
      sizeBytes: content.length,
      languages: ['ru'],
      minRamGb: 8,
      license: 'Test-License',
      ...overrides,
    });
    const setManifest = (models: ModelDescriptor[]): void => {
      writeFileSync(manifestPath, JSON.stringify(models));
    };
    setManifest([descriptor()]);

    const db = openEncrypted(
      join(root, 'egress.sqlite'),
      createHash('sha256').update(root).digest('hex'),
    );
    dbs.push(db);
    return new MigrationRunner({ migrations: MIGRATIONS }).migrate(db).then((): Fixture => {
      const consents: NetConsents = { updatesCheck: true, modelsDownload: true };
      const fetchCalls: { endpoint: string; init?: RequestInit }[] = [];
      const { target, envelopes } = makeFakeWindow();
      const notify = createBroadcastToWindows({
        getAllTargets: () => [target],
        logger: silentLogger(),
      });
      let freeDisk: (dir: string) => number | Promise<number> =
        options.freeDiskBytes ?? (() => Number.MAX_SAFE_INTEGER);
      const gateway = new EgressGateway({
        db,
        clock: new FixedClock(1_758_816_000_000, 180),
        logger: silentLogger(),
        consents: () => Promise.resolve(consents),
        fetch: (endpoint, init) => {
          fetchCalls.push({ endpoint, init });
          return makeStreamingFetch(server.port)(endpoint, init);
        },
        notify,
      });
      const makeStore = (): ModelStore =>
        new ModelStore({
          modelsDir,
          registry: new ModelsRegistry({ manifestPath }),
          egress: gateway,
          notify,
          logger: silentLogger(),
          retryBackoffMs: [1, 1, 1],
          stallTimeoutMs: 1_000, // обрыв/hold короче таймаута теста (см. шапку файла)
          freeDiskBytes: (dir) => freeDisk(dir),
        });
      return {
        modelsDir,
        manifestPath,
        store: makeStore(),
        server,
        gateway,
        fetchCalls,
        descriptor,
        setManifest,
        setFreeDiskBytes: (impl) => {
          freeDisk = impl;
        },
        reopenStore: makeStore,
        partPath: () => join(modelsDir, 'test-model.gguf.part'),
        metaPath: () => join(modelsDir, 'test-model.gguf.part.meta.json'),
        finalPath: () => join(modelsDir, 'test-model.gguf'),
        progressPayloads: () =>
          envelopes
            .map((item) => ({
              atMs: item.atMs,
              parsed: item.envelope as { name: string; payload: unknown },
            }))
            .filter(({ parsed }) => parsed.name === 'ai:progress')
            .map(({ atMs, parsed }) => ({ ...(parsed.payload as ModelProgressPayload), atMs })),
      };
    });
  });
};

describe('ModelStore — интеграция (TASK-080 §19/§20)', () => {
  it('(1) happy: загрузка → installed, sha256 совпадает, файл атомарно (нет .part/meta), listInstalled видит (AC1)', async () => {
    const fx = await makeFixture();

    const result = await fx.store.download('test-model');

    expect(result.ok).toBe(true);
    expect(unsafeUnwrap(result)).toMatchObject({ state: 'installed' });
    expect(existsSync(fx.finalPath())).toBe(true);
    expect(readFileSync(fx.finalPath()).equals(makeContent(2048))).toBe(true);
    expect(existsSync(fx.partPath())).toBe(false);
    expect(existsSync(fx.metaPath())).toBe(false);
    expect(fx.store.status('test-model')).toMatchObject({ state: 'installed' });
    expect(fx.store.listInstalled()).toEqual(['test-model']);
    // Прогресс дошёл до renderer-моста: старт downloading с нуля, финал installed (§11).
    const progress = fx.progressPayloads();
    expect(progress[0]).toMatchObject({
      modelId: 'test-model',
      downloadedBytes: 0,
      totalBytes: 2048,
      state: 'downloading',
    });
    expect(progress.at(-1)).toMatchObject({
      modelId: 'test-model',
      downloadedBytes: 2048,
      totalBytes: 2048,
      state: 'installed',
    });
  });

  it('(2) обрыв после N байт → retry → докачка Range с offset (лог сервера), installed без рестарта (AC2)', async () => {
    const content = makeContent(2048);
    const fx = await makeFixture({ content });
    fx.server.tearNextGetAfter(700);

    const result = await fx.store.download('test-model');

    expect(result.ok).toBe(true);
    expect(unsafeUnwrap(result)).toMatchObject({ state: 'installed' });
    // Сервер получил Range с offset — докачка, а не рестарт (тест-лог, AC2).
    expect(fx.server.rangeLog).toEqual(['bytes=700-']);
    expect(fx.server.requests).toEqual([
      { method: 'HEAD', range: null },
      { method: 'GET', range: null },
      { method: 'GET', range: 'bytes=700-' },
    ]);
    expect(readFileSync(fx.finalPath()).equals(content)).toBe(true);
    expect(existsSync(fx.partPath())).toBe(false);
  });

  it('(3) сервер без Range: resumable=false отмечен в состоянии; рестарт вместо докачки (§5/§13)', async () => {
    const content = makeContent(1024);
    const fx = await makeFixture({ content, supportRange: false });
    // Хвост «прошлой загрузки» + meta — сервер без Range обязан начать с нуля.
    mkdirSync(fx.modelsDir, { recursive: true });
    writeFileSync(fx.partPath(), makeContent(400));
    writeFileSync(
      fx.metaPath(),
      JSON.stringify({ modelId: 'test-model', sha256: sha256Hex(content), total: content.length }),
    );

    const gate = fx.server.holdNextGet();
    const promise = fx.store.download('test-model');
    // GET в полёте: сервер начал отдавать первый кусок (лог запросов).
    await waitFor(() => fx.server.requests.length === 2);
    // Пометка в состоянии (§5 «докачка невозможна — отмечаем в состоянии»).
    expect(fx.store.status('test-model')).toMatchObject({ state: 'downloading', resumable: false });
    gate.release();

    expect((await promise).ok).toBe(true);
    expect(fx.server.requests).toEqual([
      { method: 'HEAD', range: null },
      { method: 'GET', range: null },
    ]);
    expect(readFileSync(fx.finalPath()).equals(content)).toBe(true);
    expect(existsSync(fx.partPath())).toBe(false);
  });

  it('(4) mismatch: .part удалена, статус error c errorKey, reset → повторная установка проходит (AC3)', async () => {
    const content = makeContent(1024);
    const fx = await makeFixture({ content });
    // Фикстура-мок: в манифесте чужой (валидный по форме) хеш.
    fx.setManifest([fx.descriptor({ sha256: sha256Hex('not-the-content') })]);

    const result = await fx.store.download('test-model');

    const error = failOf(result);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('AI/HASH_MISMATCH');
    // Не хламим диск (§13): .part и meta удалены, финального файла нет.
    expect(existsSync(fx.partPath())).toBe(false);
    expect(existsSync(fx.metaPath())).toBe(false);
    expect(existsSync(fx.finalPath())).toBe(false);
    expect(fx.store.status('test-model')).toMatchObject({
      state: 'error',
      errorKey: 'errors.AI_HASH_MISMATCH',
    });
    // RESET-возможность (§7): reset → not_installed; верный манифест → installed.
    fx.store.reset('test-model');
    expect(fx.store.status('test-model')).toMatchObject({ state: 'not_installed' });
    fx.setManifest([fx.descriptor()]);
    const second = await fx.store.download('test-model');
    expect(unsafeUnwrap(second)).toMatchObject({ state: 'installed' });
    expect(readFileSync(fx.finalPath()).equals(content)).toBe(true);
  });

  it('(5) недостаток места до старта → AI/DISK_FULL, сети не было, статус not_installed (AC4)', async () => {
    const fx = await makeFixture({
      freeDiskBytes: () => 2048 + 100 * 1024 * 1024 - 1, // sizeBytes + 100 МБ запас − 1 байт
    });

    const result = await fx.store.download('test-model');

    expect(failOf(result).code).toBe('AI/DISK_FULL');
    expect(fx.fetchCalls).toEqual([]);
    expect(fx.store.status('test-model')).toMatchObject({ state: 'not_installed' });
    expect(existsSync(fx.finalPath())).toBe(false);
  });

  it('(6) место перед финальным rename (§13): error, .part сохранена; после освобождения resume досматривает до installed', async () => {
    const content = makeContent(2048);
    let calls = 0;
    const fx = await makeFixture({
      content,
      freeDiskBytes: () => {
        calls += 1;
        return calls === 1 ? Number.MAX_SAFE_INTEGER : 0; // старт ок, перед rename — нет места
      },
    });

    const result = await fx.store.download('test-model');

    expect(failOf(result).code).toBe('AI/DISK_FULL');
    expect(fx.store.status('test-model')).toMatchObject({
      state: 'error',
      errorKey: 'errors.AI_DISK_FULL',
    });
    expect(existsSync(fx.partPath())).toBe(true); // .part сохранена — не скачивать заново

    fx.setFreeDiskBytes(() => Number.MAX_SAFE_INTEGER);
    const resumed = await fx.store.resume('test-model');
    expect(unsafeUnwrap(resumed)).toMatchObject({ state: 'installed' });
    // Полная .part → GET не нужен: HEAD + verify + rename.
    expect(fx.server.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(readFileSync(fx.finalPath()).equals(content)).toBe(true);
  });

  it('(7) троттл прогресса: чанки чаще окна 250 мс — downloading-события подавлены до ≤4/сек (AC5, §15)', async () => {
    // Чанки приходят РЕЖЕ окна не годится: тогда троттл ничего не подавляет и
    // тест проходил бы при удалённом троттле. Гоняем 64 Б раз в 50 мс (~20/с —
    // как у реальной закачки 2–3 ГБ, где чанки на порядки чаще 4/сек, §15).
    const content = makeContent(1600); // 25 кусков по 64 байта, ~1.3 с суммарно
    const fx = await makeFixture({ content });
    fx.server.paceNextGet(64, 50);

    const result = await fx.store.download('test-model');
    expect(unsafeUnwrap(result)).toMatchObject({ state: 'installed' });

    const downloading = fx
      .progressPayloads()
      .filter((payload) => payload.state === 'downloading')
      .map((payload) => payload.atMs);
    // События текут, но ПОДАВЛЕНЫ: без троттла их было бы ~26 (старт + 25 чанков).
    expect(downloading.length).toBeGreaterThanOrEqual(2);
    expect(downloading.length).toBeLessThan(15);
    // throttle 250 мс: между byte-событиями пауза ≥250 мс (допуск 10 мс на часы).
    for (let i = 1; i < downloading.length; i += 1) {
      expect(downloading[i]! - downloading[i - 1]!).toBeGreaterThanOrEqual(240);
    }
    // ≤4/сек: в любом окне 1000 мс не больше 4 downloading-событий.
    for (const at of downloading) {
      const withinSecond = downloading.filter((other) => other >= at && other < at + 1000);
      expect(withinSecond.length).toBeLessThanOrEqual(4);
    }
  });

  it('(8) пауза → «перезапуск приложения» (новый store, тот же каталог) → paused → resume докачивает Range (AC6)', async () => {
    const content = makeContent(2048);
    const fx = await makeFixture({ content });

    const gate = fx.server.holdNextGet();
    const promise = fx.store.download('test-model');
    await waitFor(() => existsSync(fx.partPath()) && statSync(fx.partPath()).size >= 64);
    fx.store.pause('test-model');
    const result = await promise;
    gate.release();

    expect(unsafeUnwrap(result)).toMatchObject({ state: 'paused' });
    const bytesLoaded = statSync(fx.partPath()).size;
    expect(bytesLoaded).toBeGreaterThanOrEqual(64);
    expect(fx.store.status('test-model')).toMatchObject({
      state: 'paused',
      bytesLoaded,
      totalBytes: 2048,
    });

    // «Перезапуск»: новый экземпляр store над тем же каталогом — состояние из .part.
    const store2 = fx.reopenStore();
    expect(store2.status('test-model')).toMatchObject({
      state: 'paused',
      bytesLoaded,
      totalBytes: 2048,
    });

    const resumed = await store2.resume('test-model');
    expect(unsafeUnwrap(resumed)).toMatchObject({ state: 'installed' });
    expect(fx.server.rangeLog).toEqual([`bytes=${String(bytesLoaded)}-`]);
    expect(readFileSync(fx.finalPath()).equals(content)).toBe(true);
    expect(existsSync(fx.partPath())).toBe(false);
  });

  it('(9) вторая загрузка при активной → AI/DOWNLOAD_BUSY, активная не задета (§9)', async () => {
    const fx = await makeFixture();
    const gate = fx.server.holdNextGet();
    const first = fx.store.download('test-model');
    await waitFor(() => fx.server.requests.length === 2);

    const second = await fx.store.download('test-model');

    expect(failOf(second).code).toBe('AI/DOWNLOAD_BUSY');
    expect(fx.store.status('test-model')).toMatchObject({ state: 'downloading' });
    gate.release();
    expect(unsafeUnwrap(await first)).toMatchObject({ state: 'installed' });
  });

  it('(10) модель вне манифеста → AI/MODEL_NOT_FOUND, без сети', async () => {
    const fx = await makeFixture();

    const result = await fx.store.download('no-such-model');

    expect(failOf(result).code).toBe('AI/MODEL_NOT_FOUND');
    expect(fx.fetchCalls).toEqual([]);
    expect(fx.store.status('no-such-model')).toMatchObject({ state: 'not_installed' });
  });

  it('(11) path traversal в file манифеста → APP/INTERNAL, без сети и записи за каталог (§14)', async () => {
    const fx = await makeFixture();
    fx.setManifest([fx.descriptor({ file: '../evil.gguf' })]);

    const result = await fx.store.download('test-model');

    expect(failOf(result).code).toBe('APP/INTERNAL');
    expect(fx.fetchCalls).toEqual([]);
    expect(existsSync(join(fx.modelsDir, '..', 'evil.gguf'))).toBe(false);
    expect(existsSync(fx.finalPath())).toBe(false);
  });
});
