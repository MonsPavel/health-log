# TASK-007: Запустить Electron + React с изоляцией процессов

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-007 |
| Название | Запустить Electron + React с изоляцией процессов |
| Фаза | P0 — Фундамент |
| Эпик | 0.2 — Каркас Electron-приложения |
| Веха | M-0.2 — Каркас приложения |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1,5–2 ч |
| Зависимости | TASK-001 |
| Блокирует | TASK-008, TASK-010, TASK-012, TASK-022 |
| Блокируется | TASK-001 |
| Исходная задача дорожной карты | T-0.2.1 (`docs/roadmap/01-phase-0.md`) |

## 2. Цель

Приложение открывает окно с React-интерфейсом: в dev — через Vite dev-сервер (HMR), в prod — из собранных файлов; все защитные флаги Electron включены с первого запуска.

## 3. Бизнес-контекст

Рендерер исполняет веб-контент и по модели угроз (арх. 08 §1) недоверен: он не должен иметь доступа к Node и БД никогда. Включение изоляции сейчас — бесплатно; включение «потом» — сломает half-written код. Позиция: первая задача эпика каркаса, на неё опираются все остальные.

## 4. Технический контекст

- **Архитектура:** модель процессов и безопасность — `docs/architecture/01-high-level.md` §1, 08 §4; рендерер — 06.
- **Пакеты:** `apps/desktop`.
- **Обоснование:** Vite для рендерера (фикс. решения) — быстрый HMR, общий рантайм с Vitest. Electron-Vite-шаблон берётся как референс конфигурации, не как форк.

## 5. Объём

- **Включено:** main: `app.whenReady` → BrowserWindow (1440×900, min 1024×700) с флагами `contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true`; загрузка: `ELECTRON_RENDERER_URL` в dev иначе `dist-renderer/index.html`; Vite-сборка рендерера (root `src-renderer`, outDir `dist-renderer`); React 18 root c одним экраном-заглушкой «Health Log»; скрипты `dev` (concurrently: vite + electron с ожиданием порта), `build:renderer`; npm-зависимости: electron, vite, @vitejs/plugin-react, react, react-dom.
- **Не включено:** preload-мост (TASK-008), меню приложения (нет в MVP-объёме; системное по умолчанию), иконки/упаковка (TASK-034).
- **Будущая работа:** utilityProcess (TASK-076) — тот же паттерн изоляции.

## 6. Файлы

- **Создать:** `apps/desktop/src/main/app/{bootstrap.ts,create-window.ts}`; `apps/desktop/src/main/preload.ts` (пустой contextBridge — наполнение TASK-008); `apps/desktop/src-renderer/{index.html,src/main.tsx,src/App.tsx}`; `apps/desktop/vite.config.ts`; `apps/desktop/tsconfig.json` (extends `tsconfig.web.json`).
- **Изменить:** `apps/desktop/package.json` (main: dist путь, скрипты dev/build:renderer).

## 7. Модель предметной области

N/A.

## 8. База данных

N/A.

## 9. Бэкенд

`bootstrap.ts`: порядок запуска — requestSingleInstanceLock резервируется здесь (фактическая логика — TASK-012, но вызов размещается в точке расширения), whenReady → createWindow; обработка `window-all-closed` → `app.quit()` (Windows-целевая платформа, macOS-семантика не нужна в MVP — задокументировано).

## 10. Фронтенд

`App.tsx` рендерит статическую заглушку; entry `main.tsx` с `createRoot`; `<div id="root">`. Версия React — 18 (фикс. решения).

## 11. API

N/A (мост — TASK-008). Требование: preload объявляет `contextBridge.exposeInMainWorld('hl', {})` — неймспейс `hl` фиксируется как единственная точка доступа рендерера к main.

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Поведение dev/prod: если `process.env.ELECTRON_RENDERER_URL` задан → `loadURL`, иначе → `loadFile` относительно `__dirname`. Отключение навигации: `webContents.on('will-navigate')` → preventDefault (кроме dev-сервера), `setWindowOpenHandler` → deny с открытием внешних ссылок в системном браузере (арх. 08 §4). DevTools: только в dev.

## 14. Безопасность

Флаги окна (§5) — обязательны; автоматизированная проверка (§20) читает их из фактического `webPreferences` через тестовый запуск. CSP-заголовок рендерера добавляется в TASK-008 (вместе с контрактом) — здесь только will-navigate/setWindowOpenHandler.

## 15. Производительность

Старт окна <1 с на dev-машине (наблюдение, не гейт — гейт NFR-4 в TASK-111). Vite build renderer <20 с.

## 16. Доступность

Заглушка — `<h1>`; окно имеет `title: "Health Log"` (скринридер-базис). Полная a11y — с TASK-013+.

## 17. Интернационализация

Заглушка с i18n-ключом пока невозможна (i18n — TASK-013); допустимая техническая строка «Health Log» — имя продукта, не переводимый контент (документируется в коде комментарием).

## 18. Телеметрия

N/A.

## 19. Стратегия тестирования

Автотест изоляции: unit-тест читает собранный `webPreferences` через экспортируемую фабрику `createWindowOptions()` (чистая функция, тестируемая без запуска Electron): ожидание трёх флагов. Ручной smoke: dev-запуск, `window.hl === undefined` в DevTools-консоли (наполнение `hl` — TASK-008; на этом шаге `hl` — пустой объект).

## 20. Критерии приёмки

- [ ] `pnpm dev` (в apps/desktop) открывает окно с React-заглушкой; HMR работает.
- [ ] Сборка `pnpm build:renderer` + запуск main без dev-сервера — заглушка из файлов.
- [ ] Тест `createWindowOptions()`: contextIsolation=true, sandbox=true, nodeIntegration=false.
- [ ] В DevTools рендерера `window.hl` существует и не содержит Node API.
- [ ] `will-navigate` на внешний URL блокируется (ручная проверка кликом по `<a href>`-заглушке).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Конфликт версий Electron/Vite — зафиксированы в фикс. решениях; при обновлении Electron проверять API `utilityProcess` (нужен в TASK-076).
- Sandbox-режим ограничивает preload (только ограниченный набор API) — учтено: мост TASK-008 не требует Node-модулей в preload.

## 23. Будущие соображения

Мультиконтекстность (пост-MVP профили) не требует второго окна; окно recreate-логика — при необходимости восстановления после краша рендерера (не планируется в MVP).

## 24. Проверка

Автоматически: `pnpm test` (тест createWindowOptions) зелёный. Ручная: см. §20 шаги 1, 4, 5. Откат: revert — TASK-001/002/003/004/005 не зависят от Electron.
