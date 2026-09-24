# 05. Стратегия API (IPC-контракт)

**Статус:** черновик v0.1 · 2026-09-24

---

## 1. Позиция: API = контракт Renderer ↔ Main

Единственный «публичный API» системы — **типизированный IPC-контракт** между песочницей-рендерером и главным процессом. REST/GraphQL/HTTP не существует по продуктовым причинам (локальность, 01 §3): серверных клиентов, портов, CORS и сетевой аутентификации в архитектуре нет — это не упущение, а следствие SRS (FR-7.2/7.3).

**D6: контракт первичен.** Пакет `contracts` содержит DTO, zod-схемы (валидация на границе), коды ошибок и типы событий. Рендерер получает типобезопасный клиент через preload (`contextBridge`).

**Почему контракт в общем пакете, а не «просто вызовы ipcRenderer»:**
(1) валидация на границе доверия (рендерер недоверенный, 08 §4) — каждая полезная нагрузка проверяется zod-схемой до входа в use case;
(2) contract-тесты (10 §4) проверяют, что хендлеры соответствуют схемам;
(3) рендерер не может «дозвониться» до несуществующего канала — типы.
**Альтернатива** (tRPC-подобная генерация из типов без zod) отклонена: рантайм-валидация на недоверенной границе обязательна, типы её не заменяют.

## 2. Форма конверта

```ts
// Запрос → Ответ (все каналы)
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorDto };

type AppErrorDto = {
  code: ErrorCode;          // 'MEASUREMENT/INVALID_RANGE' — стабильный идентификатор
  messageKey: string;       // ключ i18n: 'errors.MEASUREMENT_INVALID_RANGE'
  params?: Record<string, string | number>;  // подстановки {sys}, {max}
  retryable?: boolean;
};
```

Правила:
- Ошибки **никогда** не пересекают границу как исключения/стек-трейсы (NFR-12): use case возвращает `Result`, IPC-слой маппит в `AppErrorDto`.
- Тексты — только ключи локализации; русский текст подставляет рендерер (FR-5.9, единый каталог).
- Каналы именуются `домен/действие`: `measurements/add`, `stats/period`, `ai/summary/generate`, `report/pdf`, `backup/create`, `vault/unlock`, `updates/check`.

## 3. Реестр каналов (MVP)

| Канал | Направление | Назначение | Требования |
|---|---|---|---|
| `measurements/add` \| `update` \| `delete` | req/resp | CRUD журнала; ответ включает флаги эвристик (typo/duplicate) и `criticalValue` | FR-1, FR-2, EC-01–04, FR-7.4 |
| `measurements/list` | req/resp | список с фильтрами периода/руки/заметки | FR-2.1–2.2 |
| `notes/search` | req/resp | FTS-поиск заметок | FR-2.2 |
| `stats/period` \| `trend/series` | req/resp | статистика и серии для графиков | FR-3, FR-4 |
| `scales/active` | req/resp | активная шкала + источник/версия | FR-4.5 |
| `ai/summary/generate` | **stream** | генерация резюме: возвращает `requestId` | FR-5.1, UC-03 |
| `ai/chat/send` \| `ai/chat/clear` | **stream**/req | чат | FR-5.1, UC-04 |
| `ai/cancel` | req | отмена генерации по requestId | FR-5.7, EC-16 |
| `ai/models/list` \| `ai/models/download` | req/resp, **stream прогресса** | реестр/загрузка модели (докачка) | FR-5.8, EC-15 |
| `ai/context/preview` | req/resp | «какие данные будут переданы» | FR-5.5 |
| `report/pdf` \| `report/export-csv` \| `report/export-json` | req/resp | диалог сохранения + файл | FR-6.1–6.3, 6.7 |
| `backup/create` \| `backup/restore` | req/resp, прогресс | копия/восстановление | FR-6.4, UC-08 |
| `data/wipe` | req/resp (двухшаговое подтверждение) | полное удаление | FR-6.5, UC-10 |
| `prefs/get` \| `prefs/set` | req/resp | настройки | FR-8 |
| `vault/unlock` \| `vault/set-passphrase` \| `vault/lock` | req/resp | локальный вход | 08 §2–3 |
| `privacy/journal` \| `privacy/consents` | req/resp | экран «Приватность» | FR-7.1 |
| `updates/check` \| `updates/install` | req/resp | только с согласием | FR-7.3, NFR-11 |
| `app/meta` | req/resp | версии приложения/шкал/модели, флаги | NFR-10 |

**Стриминг:** генерации и загрузки не держат открытый вызов IPC — возвращают `requestId`, данные идут событиями (§4). **Почему:** IPC-вызовы в Electron плохо пригодны для длительных стримов; события дают отмену, переподключение UI и изоляцию от зависаний (EC-16).

## 4. События (Main → Renderer broadcast)

| Событие | Payload | Потребитель |
|---|---|---|
| `measurement:changed` | {profileId} | инвалидация кэшей UI |
| `data:versionBumped` | {newVersion} | бейдж стейлса резюме (FR-5.7) |
| `ai:token` \| `ai:status` | {requestId, …} | стрим резюме/чата, индикаторы |
| `ai:progress` | {modelId, downloaded, total} | прогресс загрузки модели |
| `lock:engaged` \| `lock:required` | — | экран блокировки |
| `net:activity` | {kind, endpoint} | журнал приватности в реальном времени |
| `update:available` | {version} | предложение обновления |

## 5. Ключевые последовательности

**UC-01 — ввод измерения:**
```
UI ── measurements/add ──▶ ipc(zod) ──▶ AddMeasurement ──▶ BpMeasurement.validate
      │                                                        │ TypoHeuristic/DuplicateDetector (флаги)
      │                                                        ▼
      │                                        repo.add() [транзакция: insert + data_version+1]
      │                                                        │
UI ◀── ответ {saved, flags?, criticalValue?}                    ▼
UI ◀── события measurement:changed, data:versionBumped   EventBus.publish
```
Критические значения: флаг `criticalValue` вычисляется **правилами домена**, не ИИ; UI показывает панель FR-7.4.

**UC-03 — ИИ-резюме:** см. 07 §5.

## 6. Версионирование контракта

- Конверт несёт `v` (схема контракта); зод-схемы допускают добавление опциональных полей без смены `v`.
- Обновление приложения атомарно обновляет обе стороны контракта → проблема «разношёрстных версий» отсутствует; `v` нужен только для диагностических сообщений и будущих внешних интеграций (импорт/экспорт, синхронизация).
- Коды ошибок и имена каналов — стабильный публичный API модулей: изменение = мажорная версия приложения.

**Компромисс:** полное версионирование «на всякий случай» (двойные хендлеры v1/v2) избыточно для локального приложения и не строится; фиксируется точка расширения.
