'use strict';

/**
 * TASK-022 §5: smoke-тест SQLCipher-стека better-sqlite3-multiple-ciphers.
 *
 * Запускается скриптом prepare-native.sh под текущим node И (флаг
 * --electron-smoke у скрипта) под самим Electron — единственная честная проверка
 * ABI конкретного рантайма (§22: целевая платформа x64 Windows). Файл CJS и не
 * требует 'electron' — одна и та же проверка работает в обоих рантаймах.
 *
 * Проверки (§5/§20):
 *  1. модуль загружается (prebuilt-бинарник совместим с рантаймом);
 *  2. создать БД с `PRAGMA key = "x'<hex>'"` и дефолтами cipher='sqlcipher' →
 *     вставить строку → закрыть;
 *  3. открыть с тем же ключом — данные читаются;
 *  4. открыть с неверным ключом — чтение даёт SQLITE_NOTADB (ошибка, не данные);
 *  5. первые байты файла ≠ «SQLite format 3\0» (шифрование в покое работает);
 *  6. journal_mode=WAL устанавливается (§15: без WAL вставки в 10+ раз медленнее).
 *
 * Ключ генерируется здесь и никогда не печатается (§14); tmp-каталог удаляется.
 */

const Database = require('better-sqlite3-multiple-ciphers');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeName = typeof process.versions.electron === 'string' ? 'electron' : 'node';

/** SQLCipher-прагмы ключа — тот же порядок, что в обёртке openEncrypted (§7). */
function setCipherKey(db, keyHex) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = "x'${keyHex}'"`);
}

function runSmoke() {
  const keyHex = crypto.randomBytes(32).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-prepare-native-'));
  const file = path.join(dir, 'smoke.sqlite');
  try {
    const db = new Database(file);
    setCipherKey(db, keyHex);
    db.pragma('journal_mode = WAL');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new Error('journal_mode=WAL не установлен');
    }
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke (v) VALUES (?)').run('smoke-ok');
    db.close();

    const reopened = new Database(file);
    setCipherKey(reopened, keyHex);
    const row = reopened.prepare('SELECT v FROM smoke').get();
    if (row === undefined || row.v !== 'smoke-ok') {
      throw new Error('данные не прочитаны после переоткрытия с тем же ключом');
    }
    reopened.close();

    const impostor = new Database(file);
    setCipherKey(impostor, crypto.randomBytes(32).toString('hex'));
    let rejected = false;
    try {
      impostor.prepare('SELECT count(*) AS n FROM smoke').get();
    } catch (error) {
      rejected = error !== null && typeof error === 'object' && error.code === 'SQLITE_NOTADB';
    } finally {
      impostor.close();
    }
    if (!rejected) {
      throw new Error('неверный ключ не дал SQLITE_NOTADB — шифрование не работает');
    }

    const header = fs.readFileSync(file).subarray(0, 16).toString('latin1');
    if (header === 'SQLite format 3\0') {
      throw new Error('файл начинается с SQLite-магии — шифрование в покое не работает');
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort: неудача удаления tmp не ошибка smoke-теста
    }
  }
}

let exitCode = 0;
try {
  runSmoke();
  console.log(`prepare-native smoke: OK (${runtimeName})`);
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prepare-native smoke: FAILED (${runtimeName}) — ${message}`);
}
process.exit(exitCode);
