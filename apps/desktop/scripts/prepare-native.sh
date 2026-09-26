#!/usr/bin/env bash
#
# TASK-022 §5: подготовка нативного SQLCipher-стека better-sqlite3 (шифрование в
# покое, NFR-2) — идемпотентная (§19/§24): при рабочем стеке — no-op, exit 0.
#
# Путь решения (ADR-0002): community-пресет better-sqlite3-multiple-ciphers —
# npm-пакет с prebuilt-бинарниками (v13: Node-API, один бинарник для node и
# Electron ≥35, bundled в пакет, выбирается в рантайме). Поэтому по умолчанию
# скрипт НИЧЕГО не собирает: проверяет окружение и прогоняет smoke-тест.
#
# Проверки (§5):
#   1. окружение: node ≥ 22 (engines пресета), Electron ≥ 35 (совместимость v13);
#   2. smoke-тест (scripts/prepare-native-smoke.cjs): открыть зашифрованную БД
#      с PRAGMA key → вставить → закрыть → переоткрыть → прочитать; неверный
#      ключ → SQLITE_NOTADB; первые байты ≠ SQLite-магии. Загрузка модуля под
#      текущим node = проверка совместимости нативного бинарника (Node-API).
#      ВАЖНО (§22): скрипт обязан фейлиться ПОНЯТНО, а не собирать тихо без
#      шифрования — при провале smoke выполняется electron-rebuild (потребует
#      VS Build Tools на Windows), затем повторный smoke.
#
# Флаги:
#   --electron-smoke — дополнительно прогнать smoke-тест под самим Electron
#   (реальная проверка ABI Electron); для CI/паковки, где нужна гарантия
#   совместимости именно с рантаймом Electron.
#
# Использование: postinstall @hl/desktop («bash scripts/prepare-native.sh»),
# вручную — «pnpm run prepare-native» (§24), повторный запуск — no-op.
#
# Требование bash — сознательное: среда разработки проекта Windows + Git Bash,
# .cmd-обёртка для вызова из cmd.exe. Сбой окружения = понятная ошибка ниже.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DESKTOP_DIR"

# Модуль и минимальные версии пресета (ADR-0002): node ≥ 22, Electron ≥ 35.
MODULE_NAME='better-sqlite3-multiple-ciphers'
MIN_NODE_MAJOR=22
MIN_ELECTRON_MAJOR=35

fail() {
  echo "prepare-native: ОШИБКА — $*" >&2
  echo "prepare-native: стек БЕЗ шифрования не оставляем (§22) — устраните причину и запустите скрипт снова." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node не найден в PATH — установите Node.js ≥ ${MIN_NODE_MAJOR} (см. ADR-0002)."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] ||
  fail "node ${NODE_MAJOR} < ${MIN_NODE_MAJOR}: prebuilt-бинарники пресета v13 собраны для node ≥ ${MIN_NODE_MAJOR} (Node-API, ADR-0002). Обновите Node.js."

[ -d node_modules ] || fail "node_modules отсутствует — сначала выполните pnpm install (скрипт вызывается автоматически как postinstall)."

ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)"
if [ -n "$ELECTRON_VERSION" ]; then
  ELECTRON_MAJOR="$(node -p "Number('${ELECTRON_VERSION}'.split('.')[0])")"
  [ "$ELECTRON_MAJOR" -ge "$MIN_ELECTRON_MAJOR" ] ||
    fail "Electron ${ELECTRON_VERSION} < ${MIN_ELECTRON_MAJOR}: пресет v13 поддерживает Electron ≥ ${MIN_ELECTRON_MAJOR} (ADR-0002). Проверьте совместимость версии Electron или пересмотрите путь получения стека (§4: альтернативы — сборка из исходников / план Б)."
else
  echo "prepare-native: предупреждение — пакет electron не найден (devDep @hl/desktop); проверка версии Electron пропущена."
fi

MODULE_ROOT="$(node -p "path.dirname(require.resolve('${MODULE_NAME}/package.json'))")"
# Бинарник текущей платформы (prebuilds/<platform>-<arch>.node); если пресет когда-нибудь
# вернётся к раскладке build/Release — откат на первый найденный *.node.
PLATFORM_TAG="$(node -p "process.platform + '-' + process.arch")"
NATIVE_BIN="$(find "$MODULE_ROOT" -type f -name "${PLATFORM_TAG}.node" -print -quit)"
[ -n "$NATIVE_BIN" ] || NATIVE_BIN="$(find "$MODULE_ROOT" -type f -name '*.node' -print -quit)"
[ -n "$NATIVE_BIN" ] || fail "нативный бинарник (*.node) не найден в ${MODULE_ROOT} — переустановите зависимости (pnpm install)."

# sha256 через node — без MSYS-квирков sha256sum Git Bash (экранирование путей).
hashOf() {
  node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" "$1"
}

smoke() {
  node scripts/prepare-native-smoke.cjs
}

# --- быстрый путь: стек уже рабочий → no-op (идемпотентность §19/§24) ---
if smoke; then
  echo "prepare-native: OK (no-op) — ${MODULE_NAME} совместим с текущим рантаймом."
  echo "  бинарник: ${NATIVE_BIN}"
  echo "  sha256:   $(hashOf "$NATIVE_BIN")"
  echo "  electron: ${ELECTRON_VERSION:-<не найден>}"
else
  echo "prepare-native: smoke не прошёл — попытка пересборки (electron-rebuild; потребует компилятор, на Windows — VS Build Tools)..."
  command -v "${DESKTOP_DIR}/node_modules/.bin/electron-rebuild" >/dev/null 2>&1 ||
    fail "devDependency @electron/rebuild не установлена — выполните pnpm install и повторите."
  "${DESKTOP_DIR}/node_modules/.bin/electron-rebuild" -f -w "$MODULE_NAME" ||
    fail "electron-rebuild завершился с ошибкой — см. вывод выше (§4: путь сборки из исходников; §22: без рабочей сборки задачу не закрываем)."
  smoke || fail "smoke не прошёл и после electron-rebuild — стек нерабочий (§4: fallback-план Б не активируется молча, решение фиксируется в ADR)."
  echo "prepare-native: OK (после electron-rebuild) — ${MODULE_NAME}."
  echo "  бинарник: ${NATIVE_BIN}"
  echo "  sha256:   $(hashOf "$NATIVE_BIN")"
fi

# --- опционально: проверка под самим Electron (реальный ABI Electron, §5) ---
if [ "${1:-}" = "--electron-smoke" ]; then
  [ -n "$ELECTRON_VERSION" ] || fail "--electron-smoke: пакет electron не найден."
  echo "prepare-native: electron-smoke (Electron ${ELECTRON_VERSION})..."
  "${DESKTOP_DIR}/node_modules/.bin/electron" scripts/prepare-native-smoke.cjs ||
    fail "smoke под Electron провалился — prebuilt-бинарник несовместим с рантаймом Electron (§22)."
  echo "prepare-native: electron-smoke OK."
fi
