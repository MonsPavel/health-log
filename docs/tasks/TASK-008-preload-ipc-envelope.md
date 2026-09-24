# TASK-008: Реализовать preload-мост и конверты IPC

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-008 |
| Название | Реализовать preload-мост и конверты IPC |
| Фаза | P0 — Фундамент |
| Эпик | 0.2 — Каркас Electron-приложения |
| Веха | M-0.2 — Каркас приложения |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1,5–2 ч |
| Зависимости | TASK-002, TASK-006, TASK-007 |
| Блокирует | TASK-009, TASK-013, TASK-028 (первый прикладной канал) |
| Блокируется | TASK-006, TASK-007 |
| Исходная задача дорожной карты | T-0.2.2 (`docs/roadmap/01-phase-0.md`) |

## 2. Цель

Типизированный механизм «рендерер вызывает main и получает `ApiResult<T>`»: пакет `@hl/contracts` с формой конверта и zod-валидацией, preload-обёртка `window.hl.invoke(channel, payload)`, обрабатывающий каркас в main с маппингом любых ошибок в структурированный `AppErrorDto`.

## 3. Бизнес-контекст

Единственный API приложения — IPC-контракт (арх. 05 §1). От его формы зависит каждый последующий экран: пользователь не должен видеть «Error: undefined» (NFR-12), а агент-кодировщик не должен изобретать формат ответа. Решение принимается до первого прикладного канала (TASK-028), чтобы контракт не менялся под грузом фич.

## 4. Технический контекст

- **Архитектура:** D6, конверты и ошибки — `docs/architecture/05-api-ipc.md` §1–2; граница доверия — 08 §1/§4.
- **Пакеты:** `@hl/contracts` (новое содержимое), `apps/desktop` (preload + ipc-каркас).
- **API:** создаётся сам механизм API.
- **Обоснование:** zod на границе — рантайм-валидация недоверенного ввода обязательна (типы не защищают от рантайма). Альтернатива tRPC-подобная генерация без zod — отклонена (арх. 05 §1).

## 5. Объём

- **Включено:** contracts: `ApiResult<T>`, `AppErrorDto {code, messageKey, params?, retryable?}`, `ApiEnvelope {v: 1}`, тип `ChannelName` (строковый union, сейчас: `'app/ping'`), реестр схем `CHANNEL_SCHEMAS: Record<ChannelName, {request: ZodSchema, response: ZodSchema}>`; preload: `window.hl.invoke(channel, payload)` + `window.hl.on(name, cb)` заготовка (реальная шина — TASK-009); main: `registerChannel(name, schemas, handler)` — обёртка, которая: валидирует payload zod-схемой → вызывает handler → заворачивает результат в `{ok:true,data}`; ловит AppError → `{ok:false,error}`; ловит unknown → лог + `{ok:false, error:{code:'APP/INTERNAL', messageKey:'errors.internal'}}`; ping-канал + тест-проверка полного круга.
- **Не включено:** прикладные каналы (TASK-028+), CSP-заголовок (добавляется сюда же — см. §14: включён в объём), стриминг (P5).
- **Будущая работа:** batching/пагинация конвертов — при появлении больших payload (лимит 5 МБ на payload — валидация в каркасе).

## 6. Файлы

- **Создать:** `packages/contracts/src/{api-result.ts,app-error-dto.ts,channels.ts,schemas.ts,index.ts}`; `apps/desktop/src/main/ipc/{register-channel.ts,handlers/ping.ts}`; тесты contracts (schema-тесты) и main (каркас-тест с mock ipcMain).
- **Изменить:** `apps/desktop/src/main/preload.ts` (реальный мост), `src-renderer/lib/ipc.ts` (клиент), `src/main/app/create-window.ts` (CSP-заголовок через session.webRequest или meta-тег — решение: заголовок `Content-Security-Policy: default-src 'self'; script-src 'self'` в onHeadersReceived + dev-разрешение vite-хоста).

## 7. Модель предметной области

Контракты: `AppErrorDto` — сериализованная форма `AppError` из kernel: `code` (тот же ErrorCode union), `messageKey`, `params`, `retryable?: boolean`; правило: стеки и `cause` никогда не сериализуются наружу (арх. 05 §2). Функция `toDto(e: AppError): AppErrorDto` — в contracts.

## 8. База данных

N/A.

## 9. Бэкенд

`registerChannel` — единственный способ регистрации; прямые `ipcMain.handle` вне каркаса запрещены (depcruise-правило появится вместе с первым нарушением; конвенция документируется). Обработка concurrency: Electron `handle` сериализует вызовы канала естественным образом; асинхронные хендлеры допустимы.

## 10. Фронтенд

`src-renderer/lib/ipc.ts`: типизированная обёртка над `window.hl.invoke` с дженериком по реестру схем: `call('app/ping', payload): Promise<ApiResult<PingResponse>>`. Никаких прямых `ipcRenderer` в компонентах (зона renderer — TASK-003).

## 11. API

Канал `app/ping`: request `{}` (zod `z.object({}).strict()`), response `{pong: true, ts: number}`. Конверт: `{v:1, ...result}`. Ошибка неизвестного канала: `APP/INTERNAL` + лог. Лимит payload 5 МБ (pre-check structuredClone-размера недоступен — валидация длины сериализованной строки в dev-режиме, лог-предупреждение).

## 12. Управление состоянием

N/A (клиент-обёртка интегрируется с TanStack Query в TASK-013).

## 13. Бизнес-логика

Порядок обработки в `registerChannel`: (1) channel существует? (2) payload валиден? — иначе `VALIDATION/FAILED` с messageKey; (3) handler → Result или throw AppError; (4) throw неизвестного → лог с cause (только в main-лог), наружу — APP/INTERNAL. Повторные: `retryable: true` только для кодов, помеченных в реестре кодов как повторяемые (сейчас — пусто; NET/* появится в TASK-075/080).

## 14. Безопасность

Валидация zod всех входов (недоверенный рендерер, арх. 08 §4); CSP `default-src 'self'` (dev: + vite-хост для HMR); никаких `ipcRenderer.sendSync`; контекст-изоляция уже включена (TASK-007). OWASP-соображение: инъекция через payload невозможна до валидации; объекты прототипов (pollution) — `z.object().strict()` по умолчанию в реестре схем.

## 15. Производительность

IPC-вызов ping ≤5 мс (замер в тесте); оверхед zod на маленьких payload пренебрежим; для больших списков — пагинация на уровне каналов (TASK-030), не конверта.

## 16. Доступность

N/A.

## 17. Интернационализация

messageKey-конвенция: `errors.<CODE_SNAKE>`; каталог пополняется в TASK-013 (`errors.internal`, `errors.validation`).

## 18. Телеметрия

Все необработанные ошибки main-хендлеров логируются (категория `ipc`) с cause — единственное место с техническими деталями.

## 19. Стратегия тестирования

Schema-тесты contracts (валидные/невалидные payload, сериализация AppError→Dto без cause); интеграционный тест каркаса: mock `ipcMain`/`event` (in-memory harness, экспортируемая функция-обработчик тестируется напрямую): ping OK; ping с невалидным payload → VALIDATION/FAILED; handler throws Error → APP/INTERNAL, cause в логе-спае; handler throws AppError → точный код.

## 20. Критерии приёмки

- [ ] `window.hl.invoke('app/ping', {})` из рендерера возвращает `{ok:true, data:{pong:true}}` (ручная проверка в dev).
- [ ] Schema-тесты: невалидный payload отклонён до вызова handler (spy не вызван).
- [ ] AppError из хендлера приходит как `{ok:false,error:{code,messageKey}}`, без стека/cause.
- [ ] CSP-заголовок присутствует в ответе окна (DevTools → Network → headers).
- [ ] Неизвестный канал → APP/INTERNAL + запись в лог категории ipc.

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Изменение формата конверта позже — дорого: поэтому v-поле и реестр каналов с первого дня (версионирование — арх. 05 §6).
- CSP может сломать HMR — dev-override задокументирован в конфиге окна.

## 23. Будущие соображения

Стриминг-каналы (P5, `ai:token`) пойдут через событийный механизм TASK-009 с тем же неймспейсом `hl`; автогенерация TS-типов из zod (z.infer) уже используется — никакой ручной синхронизации типов.

## 24. Проверка

Автоматически: `pnpm test` (schema + каркас-тесты) зелёный. Ручная: dev-запуск → в DevTools рендерера выполнить `window.hl.invoke('app/ping', {})` → Promise с pong; выполнить `window.hl.invoke('app/nope', {})` → {ok:false, APP/INTERNAL}. Откат: revert; TASK-009/013 не начаты.
