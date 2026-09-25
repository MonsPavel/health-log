import electron = require('electron');

/**
 * Пустой contextBridge-мост (TASK-007 §11): namespace `hl` фиксируется как
 * единственная точка доступа рендерера к main. Наполнение каналами и контракт
 * (конверты, zod-валидация) — TASK-008.
 *
 * Файл — .cts: пакет ESM («type»: «module»), а sandbox-preload обязан быть CommonJS
 * (§22) — TypeScript компилирует .cts только в CJS (dist/main/preload.cjs). Отсюда
 * verbatim-совместимый CJS-синтаксис `import = require` (verbatimModuleSyntax,
 * TASK-002 §13, отключение запрещено).
 */
electron.contextBridge.exposeInMainWorld('hl', {});
