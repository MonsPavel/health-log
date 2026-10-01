/**
 * TASK-092 §5/§14: скачивание dev-модели для ночного eval-прогона из манифеста
 * моделей приложения (apps/desktop/resources/models-manifest.json — ЕДИНСТВЕННЫЙ
 * источник, «переиспользует манифест» §6). Шаг workflow eval-nightly.yml (в
 * паре с actions/cache по пути ~/.hl-eval-model, ключ model-1b-v1):
 *
 *   node tools/scripts/fetch-eval-model.mjs [--manifest <path>] [--id <id>] [--dir <dir>]
 *
 * Поведение (§20.2/§20.3): файл уже на месте с верным sha256 — скачивание
 * ПРОПУСКАЕТСЯ (лог пропуска — второй прогон кэш не скачивает); на месте с
 * битым sha256 — перекачивается (порча кэша не роняет прогон навсегда);
 * скачанное не сошлось по sha256 из манифеста — ШАГ ПАДАЕТ с понятной ошибкой
 * (§14: «не верим URL» — sha256 обязателен). Путь к модели дополнительно
 * пишется в $GITHUB_OUTPUT (model-path=…), когда скрипт работает внутри
 * Actions, — следующий шаг eval получает путь без дубля констант.
 *
 * Загрузка — curl (§5): потоковая запись 0.7–0.8 ГБ на диск без буфера в
 * памяти, ретраи на нестабильной сети; на ubuntu-runner предустановлен.
 *
 * Юнит-тесты: fetch-eval-model.test.mjs (tools-scripts) — гейт-функции
 * чистые, загрузчик внедряется (§19: без сети); CLI-режим определяется как в
 * tools/eval/runner.ts (импорт из тестов main не запускает).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { argv as processArgv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Манифест по умолчанию — тот же файл, что читает ModelsRegistry 079. */
const DEFAULT_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/desktop/resources/models-manifest.json',
);

/** Каталог кэша модели по умолчанию (§5: путь ~/.hl-eval-model). */
export const DEFAULT_MODEL_DIR = join(homedir(), '.hl-eval-model');

/**
 * Выбор dev-записи манифеста (§5 «скрипт скачивает dev-модель из манифеста»):
 * по умолчанию — первая запись (манифест 079 держит dev-модель первой; тест
 * 079 «одна dev-запись» — сегодня это dev-placeholder до отбора реальной),
 * опционально — по явному id (--id / HL_EVAL_MODEL_ID). Пустой манифест,
 * неизвестный id или запись без file/url/sha256 — контролируемый отказ.
 */
export function pickModelEntry(manifest, modelId = undefined) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('fetch-eval-model: манифест моделей пуст или не список — скачивать нечего');
  }
  const entry =
    modelId === undefined ? manifest[0] : manifest.find((candidate) => candidate.id === modelId);
  if (entry === undefined) {
    throw new Error(`fetch-eval-model: в манифесте нет записи с id «${modelId}»`);
  }
  for (const field of ['file', 'url', 'sha256']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(
        `fetch-eval-model: запись «${String(entry.id)}» манифеста без поля ${field} ` +
          '(sha256 обязателен — §14: не верим URL)',
      );
    }
  }
  return entry;
}

/** sha256 строки/буфера (hex) — для тестов и сообщений об отказе. */
export function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Гейт целостности (§14/§20.3): потоковый sha256 файла против ожидания из
 * манифеста. Совпало → true; файл не читается или hex другой → Error с
 * ожиданием и фактом (понятная ошибка шага CI).
 */
export function verifySha256(filePath, expectedHex) {
  const hash = createHash('sha256');
  try {
    hash.update(readFileSync(filePath));
  } catch (cause) {
    throw new Error(
      `fetch-eval-model: файл модели не читается: ${filePath} (${String(cause?.code ?? cause)})`,
    );
  }
  const actual = hash.digest('hex');
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(
      `fetch-eval-model: sha256-мismatch для ${filePath} — ожидалось ${expectedHex}, получено ${actual} ` +
        '(скачанный файл не соответствует манифесту — шаг падает, §20.3)',
    );
  }
  return true;
}

/** Скачивание curl'ом по умолчанию: -L (редиректы HF→CDN), --fail, ретраи. */
function downloadWithCurl(url, destPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('curl', ['-fL', '--retry', '3', '-o', destPath, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (cause) => {
      rejectPromise(new Error(`fetch-eval-model: curl не запущен (${url}): ${String(cause)}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(undefined);
        return;
      }
      rejectPromise(
        new Error(
          `fetch-eval-model: curl завершился с кодом ${String(code)} (${url}) — ` +
            `stderr: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

/**
 * Оркестратор (§5): выбор записи манифеста → <dir>/<file> → проверка/скачивание
 * → гейт sha256 → model-path в GITHUB_OUTPUT (если задан). Возвращает
 * { modelPath, downloaded, entry }. Загрузчик внедряется (§19: тесты без сети);
 * каталог создаётся при необходимости.
 */
export async function fetchEvalModel({
  manifest = undefined,
  manifestPath = DEFAULT_MANIFEST_PATH,
  modelId = undefined,
  dir = DEFAULT_MODEL_DIR,
  download = downloadWithCurl,
  log = (message) => console.log(message),
  githubOutputPath = process.env['GITHUB_OUTPUT'],
} = {}) {
  const source = manifest ?? JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = pickModelEntry(source, modelId);
  mkdirSync(dir, { recursive: true });
  const modelPath = join(dir, entry.file);
  log(`fetch-eval-model: запись манифеста ${entry.id} (${entry.file}), sha256 ${entry.sha256}`);

  if (existsSync(modelPath)) {
    try {
      verifySha256(modelPath, entry.sha256);
      log(`fetch-eval-model: модель уже на месте, sha256 ок — скачивание пропущено: ${modelPath}`);
      emitGithubOutput(githubOutputPath, modelPath);
      return { modelPath, downloaded: false, entry };
    } catch {
      log('fetch-eval-model: файл в кэше не сошёлся по sha256 — перекачивание');
    }
  }

  writeFileSync(modelPath, '', { flag: 'a' }); // каталог могла не создать даже запись
  await download(entry.url, modelPath);
  verifySha256(modelPath, entry.sha256);
  log(`fetch-eval-model: скачано и проверено по sha256 манифеста: ${modelPath}`);
  emitGithubOutput(githubOutputPath, modelPath);
  return { modelPath, downloaded: true, entry };
}

/** model-path в $GITHUB_OUTPUT (шаги workflow читают steps.<id>.outputs); вне Actions — no-op. */
function emitGithubOutput(githubOutputPath, modelPath) {
  if (githubOutputPath === undefined || githubOutputPath.length === 0) {
    return;
  }
  writeFileSync(githubOutputPath, `model-path=${modelPath}\n`, { flag: 'a' });
}

/** Аргументы CLI. */
function parseCliArgs(args) {
  const parsed = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    modelId: undefined,
    dir: DEFAULT_MODEL_DIR,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--manifest') {
      parsed.manifestPath = resolve(args[index + 1] ?? '');
      index += 1;
    } else if (arg === '--id') {
      parsed.modelId = args[index + 1];
      index += 1;
    } else if (arg === '--dir') {
      parsed.dir = resolve(args[index + 1] ?? '');
      index += 1;
    } else if (arg === '--help') {
      parsed.help = true;
    } else {
      throw new Error(`fetch-eval-model: неизвестный аргумент: ${String(arg)}`);
    }
  }
  return parsed;
}

/** Запуск как CLI (импорт из тестов не запускает — прецедент tools/eval/runner.ts). */
if (
  processArgv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(processArgv[1])).href
) {
  if (processArgv.slice(2).includes('--help')) {
    console.log(
      'использование: node tools/scripts/fetch-eval-model.mjs [--manifest <path>] [--id <id>] [--dir <dir>]',
    );
    exit(0);
  }
  try {
    const args = parseCliArgs(processArgv.slice(2));
    fetchEvalModel(args)
      .then((result) => {
        console.log(`fetch-eval-model: модель готова: ${result.modelPath}`);
        exit(0);
      })
      .catch((error) => {
        console.error('fetch-eval-model: ОТКАЗ:', error instanceof Error ? error.message : error);
        exit(1);
      });
  } catch (error) {
    console.error('fetch-eval-model: ОТКАЗ:', error instanceof Error ? error.message : error);
    exit(1);
  }
}
