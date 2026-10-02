/**
 * TASK-104 §5/§19: test-хелпер локального update-фида и механики подписи Windows.
 *
 * ТРИ части (§5 «тест-механики ДО сертификата», §19 «e2e-хелпер с локальным
 * http-фидом»):
 *  1. YAML-строители фида — зеркало того, что генерирует electron-builder:
 *     latest-файл канала (version/path/sha512/files) и app-update.yml
 *     (generic provider + publisherName для проверки подписи updater'ом).
 *  2. test-cert механика: New-SelfSignedCertificate (CodeSigningCert) → signtool
 *     /fd sha256 → Get-AuthenticodeSignature. Доверие корня — импорт в
 *     Cert:\CurrentUser\Root: Windows показывает интерактивный диалог
 *     подтверждения (защита от тихой установки корней), поэтому importRootTrust
 *     ограничен по времени и требует присутствия человека
 *     (HL_TEST_CERT_TRUST_ROOT=1, см. docs/dev/certificates.md).
 *  3. Драйвер БОЕВОГО NsisUpdater (electron-updater) в plain node: fake-AppAdapter
 *     (точки Electron подменяются tmp-каталогами) + node-executor поверх
 *     HttpExecutor (аналог ElectronHttpExecutor, §19-прецедент порта-обёртки
 *     updates-service).Updater проходит боевой конвейер: latest-файл → sha512
 *     (DigestTransform загрузчика) → проверка подписи (Get-AuthenticodeSignature
 *     через PowerShell) → update-downloaded.
 *
 * Сеть (node:http) — ТОЛЬКО локальный фид 127.0.0.1 и клиент updater'а к нему:
 * D11 (сеть приложения через EgressGateway) не затронут — это тестовая
 * инфраструктура релиза, гейт вынесен в eslint-override файла.
 * tmp-каталоги — mkdtemp(os.tmpdir()) (§13 vitest.setup).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import {
  configureRequestOptions,
  configureRequestUrl,
  HttpExecutor,
  type DownloadOptions,
} from 'builder-util-runtime';
import { NsisUpdater } from 'electron-updater';

/** Корень пакета @hl/desktop (helpers/* → три уровня вверх). */
const APP_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Локальные структурные типы поверхности electron-updater (deep-import .d.ts
 * недоступен при moduleResolution nodenext): совместимы по построению с
 * AppAdapter/Logger пакета — проверяется присваиванием в createTestUpdater.
 */
interface UpdaterAppAdapter {
  readonly version: string;
  readonly name: string;
  readonly isPackaged: boolean;
  readonly appUpdateConfigPath: string;
  readonly userDataPath: string;
  readonly baseCachePath: string;
  whenReady(): Promise<void>;
  relaunch(): void;
  quit(): void;
  onQuit(handler: (exitCode: number) => void): void;
}

/** Поверхность логгера electron-updater (параметры пакета any — здесь unknown). */
interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message: string): void;
}

/** Таймаут по умолчанию для дочерних процессов механики (сек; signtool/PowerShell). */
const CHILD_TIMEOUT_MS = 60_000;

/** Бюджет интерактивного подтверждения импорта корня (диалог Windows). */
const ROOT_CONFIRM_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 1. YAML-строители фида (§13: поля version/path/sha512 — builder генерирует)
// ---------------------------------------------------------------------------

/** Аргументы latest-файла канала (electric builder: latest.yml для latest, stable.yml для stable). */
export interface LatestYmlInfo {
  /** Версия обновления (semver). */
  readonly version: string;
  /** Имя файла установщика в фиде (= files[].url). */
  readonly path: string;
  /** sha512 установщика, base64 (кодировка builder'а). */
  readonly sha512: string;
  /** Размер установщика, байты. */
  readonly size: number;
  /** Дата релиза; по умолчанию — текущий момент (ISO). */
  readonly releaseDate?: string;
}

/** sha512 файла в base64 — кодировка latest-файла electron-builder (§13). */
export function sha512Base64(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** Latest-файл канала фида (§13): version/path/sha512/releaseDate + files[{url,size,sha512}]. */
export function buildLatestYml(info: LatestYmlInfo): string {
  const releaseDate = info.releaseDate ?? new Date().toISOString();
  return [
    `version: ${info.version}`,
    `path: ${info.path}`,
    `sha512: ${info.sha512}`,
    `releaseDate: ${releaseDate}`,
    'files:',
    `  - url: ${info.path}`,
    `    size: ${info.size}`,
    `    sha512: ${info.sha512}`,
    '',
  ].join('\n');
}

/** Аргументы app-update.yml — ресурс, updater читает его из установленного приложения. */
export interface AppUpdateYmlOptions {
  /** Базовый URL фида (generic-провайдер). */
  readonly url: string;
  /** Канал обновлений; имя latest-файла = `<channel>.yml` (§5: stable). */
  readonly channel?: string;
  /**
   * Ожидаемый издатель подписи (DN) — updater сравнивает его с подписью
   * скачанного установщика (§5: «совпадает с подписью — требование updater'а»).
   * Отсутствие поля = проверка подписи пропускается.
   */
  readonly publisherName?: string;
  /** Каталог кэша скачанных обновлений в %LOCALAPPDATA% (basename без пробелов — PHI-правило путей). */
  readonly updaterCacheDirName: string;
}

/** app-update.yml — зеркало того, что electron-builder кладёт в resources (§5). */
export function buildAppUpdateYml(options: AppUpdateYmlOptions): string {
  const lines = ['provider: generic', `url: ${options.url}`];
  if (options.channel !== undefined) {
    lines.push(`channel: ${options.channel}`);
  }
  if (options.publisherName !== undefined) {
    lines.push(`publisherName: ${options.publisherName}`);
  }
  lines.push(`updaterCacheDirName: ${options.updaterCacheDirName}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 2. test-cert механика (§5: New-SelfSignedCertificate → подпись → проверка)
// ---------------------------------------------------------------------------

/** Тестовый самоподписанный сертификат подписи кода (Cert:\CurrentUser\My). */
export interface TestCodeSigningCert {
  /** Отпечаток SHA-1 (адресация в хранилище и /sha1 signtool). */
  readonly thumbprint: string;
  /** Subject DN в формате PowerShell (SignerCertificate.Subject) — publisherName фида. */
  readonly subjectDn: string;
  /** Экспорт публичной части (.cer) — для импорта доверия. */
  readonly cerPath: string;
  /** Удаление из хранилищ CurrentUser (My и Root) — клин после теста. */
  remove(): void;
}

/**
 * Запуск PowerShell-скрипта, единственный вывод которого — JSON (ConvertTo-Json
 * -Compress). Скрипт пишется файлом: кавычки путей/DN не проходят через shell.
 */
function runPowerShellJson(script: string, timeoutMs = CHILD_TIMEOUT_MS): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'hl-update-feed-ps-'));
  try {
    const scriptPath = join(dir, 'script.ps1');
    writeFileSync(scriptPath, script, 'utf-8');
    const run = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: timeoutMs, encoding: 'utf-8', windowsHide: true },
    );
    if (run.error !== undefined && run.status !== 0) {
      throw new Error(`powershell не запущен: ${String(run.error)}`);
    }
    const stdout = (run.stdout ?? '').trim();
    if (run.status !== 0 || stdout.length === 0) {
      throw new Error(
        `powershell завершился с кодом ${String(run.status)}: ${stdout}${run.stderr ?? ''}`,
      );
    }
    return JSON.parse(stdout) as unknown;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Создаёт самоподписанный CodeSigningCert в Cert:\CurrentUser\My и экспортирует .cer (§5). */
export function createTestCodeSigningCert(dir: string, commonName: string): TestCodeSigningCert {
  const cerPath = join(dir, 'test-cert.cer');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$cert = New-SelfSignedCertificate -Type CodeSigningCert ` +
      `-Subject "CN=${commonName},O=Health Log,C=RU" ` +
      '-KeyUsage DigitalSignature -KeySpec Signature -KeyUsageProperty Sign ' +
      '-CertStoreLocation Cert:\\CurrentUser\\My ' +
      '-NotAfter (Get-Date).AddDays(7)',
    `Export-Certificate -Cert $cert -FilePath "${cerPath.replaceAll('\\', '\\\\')}" | Out-Null`,
    '@{ thumbprint = $cert.Thumbprint; subject = $cert.Subject } | ConvertTo-Json -Compress',
  ].join('\r\n');
  const parsed = runPowerShellJson(script) as { thumbprint?: unknown; subject?: unknown };
  const thumbprint = typeof parsed.thumbprint === 'string' ? parsed.thumbprint : '';
  const subjectDn = typeof parsed.subject === 'string' ? parsed.subject : '';
  if (thumbprint.length === 0 || subjectDn.length === 0) {
    throw new Error(`New-SelfSignedCertificate не вернул сертификат: ${JSON.stringify(parsed)}`);
  }
  return {
    thumbprint,
    subjectDn,
    cerPath,
    remove(): void {
      const cleanup = [
        "$ErrorActionPreference = 'Stop'",
        `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`,
        `$t = "${thumbprint}"`,
        `Remove-Item -LiteralPath ("Cert:\\CurrentUser\\My\\" + $t) -ErrorAction SilentlyContinue`,
        `$root = Get-Item -LiteralPath ("Cert:\\CurrentUser\\Root\\" + $t) -ErrorAction SilentlyContinue`,
        'if ($root) { Remove-Item -LiteralPath $root.PSPath }',
        '$myLeft = (Get-Item -LiteralPath ("Cert:\\CurrentUser\\My\\" + $t) -ErrorAction SilentlyContinue) -eq $null',
        '$rootLeft = (Get-Item -LiteralPath ("Cert:\\CurrentUser\\Root\\" + $t) -ErrorAction SilentlyContinue) -eq $null',
        '@{ removedMy = $myLeft; removedRoot = $rootLeft } | ConvertTo-Json -Compress',
      ].join('\r\n');
      try {
        runPowerShellJson(cleanup, 30_000);
      } catch (cause) {
        // Клин не маскирует результат теста, но остаток в хранилище должен быть замечен.
        console.warn(
          `[update-feed] не удалось дочистить тестовый сертификат ${thumbprint}: ${String(cause)}`,
        );
      }
    },
  };
}

/** Находится ли сертификат уже в доверенных корнях текущего пользователя. */
export function isRootTrusted(thumbprint: string): boolean {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`,
    `$present = (Get-Item -LiteralPath ("Cert:\\CurrentUser\\Root\\" + "${thumbprint}") ` +
      '-ErrorAction SilentlyContinue) -ne $null',
    '@{ present = $present } | ConvertTo-Json -Compress',
  ].join('\r\n');
  return (runPowerShellJson(script) as { present?: unknown }).present === true;
}

export type RootTrustResult = 'trusted' | 'declined' | 'timeout';

/**
 * Импорт тестового корня в Cert:\CurrentUser\Root (certutil -user -addstore).
 * Windows показывает диалог «установить сертификат?» — выполняйте только в
 * присутствии человека (HL_TEST_CERT_TRUST_ROOT=1). Бюджет ожидания —
 * ROOT_CONFIRM_TIMEOUT_MS, после него процесс убивается (диалог закрывается).
 */
export function importRootTrust(cerPath: string): RootTrustResult {
  const thumbprint = thumbprintOfCer(cerPath);
  const run = spawnSync('certutil.exe', ['-user', '-addstore', 'Root', cerPath], {
    timeout: ROOT_CONFIRM_TIMEOUT_MS,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (run.signal !== null) {
    return 'timeout'; // диалог не подтверждён за бюджет — процесс убит, диалог закрыт
  }
  return thumbprint.length > 0 && isRootTrusted(thumbprint) ? 'trusted' : 'declined';
}

/** Thumbprint .cer-файла — чтение файла сертификатом без store-операций (без диалогов). */
function thumbprintOfCer(cerPath: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 ` +
      `"${cerPath.replaceAll('\\', '\\\\')}"`,
    '@{ thumbprint = $cert.Thumbprint } | ConvertTo-Json -Compress',
  ].join('\r\n');
  return ((runPowerShellJson(script) as { thumbprint?: unknown }).thumbprint as string) ?? '';
}

/** Путь к signtool.exe Windows SDK (env SIGNTOOL_PATH → Kits\10\bin\<версия>\x64). */
export function findSigntoolPath(): string {
  const fromEnv = process.env['SIGNTOOL_PATH'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const kitsRoot = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  if (!existsSync(kitsRoot)) {
    throw new Error(`Windows SDK не найден: ${kitsRoot} (или задайте SIGNTOOL_PATH)`);
  }
  const versions = readdirSync(kitsRoot)
    .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
    .sort()
    .reverse();
  for (const version of versions) {
    for (const arch of ['x64', 'x86']) {
      const signtool = join(kitsRoot, version, arch, 'signtool.exe');
      if (existsSync(signtool)) {
        return signtool;
      }
    }
  }
  throw new Error(`signtool.exe не найден под ${kitsRoot} (или задайте SIGNTOOL_PATH)`);
}

/**
 * Подпись установщика test-cert'ом (§5): signtool /fd sha256 (дайджест файла
 * SHA-256; timestamp в боевой сборке добавляет electron-builder — rfc3161TimeStampServer,
 * локальной фикстуре TSA-сеть не нужна).
 */
export function signInstaller(installerPath: string, cert: TestCodeSigningCert): void {
  const signtool = findSigntoolPath();
  const run = spawnSync(
    signtool,
    ['sign', '/fd', 'sha256', '/sha1', cert.thumbprint, installerPath],
    { timeout: CHILD_TIMEOUT_MS, encoding: 'utf-8', windowsHide: true },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.status !== 0 || !output.includes('Successfully signed')) {
    throw new Error(`signtool не подписал ${installerPath} (код ${String(run.status)}): ${output}`);
  }
}

/** Результат Get-AuthenticodeSignature (status: 0 = Valid, §20-1). */
export interface AuthenticodeStatus {
  /** Код SignatureStatus: 0 = Valid (§20-1 «подпись Valid»). */
  readonly status: number;
  readonly statusMessage: string;
  /** Subject DN сертификата подписи (undefined — подписи нет). */
  readonly signerSubject?: string;
}

/** Проверка подписи файла штатной проверкой Windows (§5: Get-AuthenticodeSignature). */
export function getAuthenticodeStatus(installerPath: string): AuthenticodeStatus {
  const escaped = installerPath.replaceAll('\\', '\\\\').replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    '[ordered]@{',
    '  status = [int]$signature.Status',
    '  statusMessage = $signature.StatusMessage',
    '  subject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })',
    '} | ConvertTo-Json -Compress',
  ].join('\r\n');
  const parsed = runPowerShellJson(script) as {
    status?: unknown;
    statusMessage?: unknown;
    subject?: unknown;
  };
  if (typeof parsed.status !== 'number') {
    throw new Error(`Get-AuthenticodeSignature не вернул статус: ${JSON.stringify(parsed)}`);
  }
  return {
    status: parsed.status,
    statusMessage: typeof parsed.statusMessage === 'string' ? parsed.statusMessage : '',
    ...(typeof parsed.subject === 'string' ? { signerSubject: parsed.subject } : {}),
  };
}

/**
 * Catalog-free PE для фикстуры: esbuild.exe из pnpm-стора (~1 МБ, без каталожной
 * подписи Windows). Системные exe (System32) покрыты каталогами Windows —
 * Get-AuthenticodeSignature отвечает по каталогу, а не по нашей embedded-подписи.
 */
export function findUnsignedFixtureExe(): string {
  const pnpmStore = join(APP_ROOT, '..', '..', 'node_modules', '.pnpm');
  if (!existsSync(pnpmStore)) {
    throw new Error(`pnpm-стор не найден: ${pnpmStore} (выполните pnpm install)`);
  }
  const entry = readdirSync(pnpmStore).find((name) => name.startsWith('@esbuild+win32-x64@'));
  if (entry === undefined) {
    throw new Error(`@esbuild/win32-x64 не найден в ${pnpmStore} (выполните pnpm install)`);
  }
  const exe = join(pnpmStore, entry, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  if (!existsSync(exe)) {
    throw new Error(`фикстура установщика не найдена: ${exe}`);
  }
  return exe;
}

// ---------------------------------------------------------------------------
// 3. Локальный http-фид (§19: latest-файл + подписанный exe-фикстура)
// ---------------------------------------------------------------------------

/** Управление локальным фидом: выдаёт файлы каталога, поддерживает подмену байтов. */
export interface UpdateFeedHandle {
  /** Базовый URL фида (http://127.0.0.1:<порт>/) — url в app-update.yml теста. */
  readonly baseUrl: string;
  /** Путь установщика внутри каталога фида. */
  readonly installerPath: string;
  /** Подмена ОТДАВАЕМЫХ байтов установщика (негатив §20-4: подмена после подписи). */
  tamperInstaller(mutate: (bytes: Buffer) => Buffer): void;
  /** Запрошенные пути (диагностика: latest-файл, установщик, 404 blockmap). */
  readonly requests: string[];
  close(): Promise<void>;
}

/** Локальный http-фид каталога dir (127.0.0.1, эфемерный порт). */
export async function startLocalUpdateFeed(options: {
  dir: string;
  installerSource: string;
}): Promise<UpdateFeedHandle> {
  mkdirSync(options.dir, { recursive: true });
  const installerName = basename(options.installerSource);
  const requests: string[] = [];
  let tamper: ((bytes: Buffer) => Buffer) | undefined;
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    requests.push(pathname);
    const base = normalize(options.dir + sep);
    const target = normalize(join(options.dir, pathname));
    if (!target.startsWith(base)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch {
      response.writeHead(404);
      response.end();
      return; // blockmap у локального фида нет — updater откатится к полной загрузке
    }
    if (basename(pathname) === installerName && tamper !== undefined) {
      bytes = tamper(bytes);
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    get baseUrl(): string {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('фид не слушает: нет адреса');
      }
      return `http://127.0.0.1:${String(address.port)}/`;
    },
    installerPath: options.installerSource,
    tamperInstaller(mutate: (bytes: Buffer) => Buffer): void {
      tamper = mutate;
    },
    requests,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Драйвер боевого NsisUpdater в plain node (§19: тесты подменяют Electron-слой)
// ---------------------------------------------------------------------------

/** Executor поверх node:http(s) — аналог ElectronHttpExecutor для plain node. */
class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  // Публичный abstract в HttpExecutor (builder-util-runtime) — сужать видимость нельзя.
  override createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest {
    const transport = options.protocol === 'https:' ? httpsRequest : httpRequest;
    return transport(options, callback);
  }

  /** Полная загрузка в файл (sha512-гейт DigestTransform — внутри базового doDownload). */
  download(url: URL, destination: string, options: DownloadOptions): Promise<void> {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      // redirect:'manual' — опция electron net; node http сам не следует редиректам,
      // location обрабатывает базовый doDownload.
      const requestOptions: RequestOptions = {};
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel,
          // Небрежное `== null` — как в ElectronHttpExecutor: колбэк закрытия
          // WriteStream приходит БЕЗ аргумента (undefined), строгий `=== null`
          // превращал успешную загрузку в reject(undefined).
          callback: (error) => {
            if (error == null) {
              resolve();
            } else {
              reject(error);
            }
          },
          responseHandler: null,
        },
        0,
      );
    });
  }
}

/** Аргументы createTestUpdater: все точки Electron подменены tmp-каталогами. */
export interface TestUpdaterOptions {
  /** Путь к app-update.yml теста (publisherName/url/channel) — updater читает ЕГО. */
  readonly appUpdateYmlPath: string;
  /** «Установленная» версия приложения (semver < версии фида). */
  readonly installedVersion: string;
  /** tmp-каталог кэша скачанных обновлений (baseCachePath). */
  readonly cacheDir: string;
  /** tmp-каталог userData (.updaterId — staging-идентификатор updater'а). */
  readonly userDataDir: string;
  readonly name?: string;
}

/**
 * Боевой NsisUpdater с подменённым Electron-слоем (§19): сеть — локальный фид,
 * конфиг — app-update.yml теста (как в установленном приложении). Конфиг задаётся
 * через updateConfigPath (test-only сеттер electron-updater) — никакого setFeedURL:
 * провайдер собирается из app-update.yml, ровно как в бою.
 */
export function createTestUpdater(options: TestUpdaterOptions): NsisUpdater {
  const adapter: UpdaterAppAdapter = {
    version: options.installedVersion,
    name: options.name ?? 'health-log',
    isPackaged: true,
    appUpdateConfigPath: options.appUpdateYmlPath,
    userDataPath: options.userDataDir,
    baseCachePath: options.cacheDir,
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };
  const updater = new NsisUpdater(undefined, adapter);
  // httpExecutor — рантайм-поле AppUpdater, не объявленное в d.ts electron-updater
  // 6.8.9 (назначается в конструкторе): присваиваем через структурный cast.
  const withExecutor = updater as unknown as { httpExecutor?: HttpExecutor<ClientRequest> | null };
  withExecutor.httpExecutor = new NodeHttpExecutor();
  // §14/паритет updates-service (AC3 096): ручной режим — фоновых загрузок нет,
  // скачивание вызывает только явный downloadUpdate() теста.
  updater.autoDownload = false;
  updater.updateConfigPath = options.appUpdateYmlPath;
  // Тихий логгер: поверхность Logger (any-параметры) принимает unknown по бивариантности.
  const silent: UpdaterLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  updater.logger = silent;
  return updater;
}
