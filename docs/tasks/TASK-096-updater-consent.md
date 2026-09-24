# TASK-096: Интегрировать electron-updater за согласием

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-096 |
| Название | Интегрировать electron-updater: проверка по согласию, через политику, с журналом |
| Фаза | P6 — Безопасность и надёжность |
| Эпик | 6.2 — Обновления |
| Веха | M-6.2 — Обновления |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1,5–2,5 ч |
| Зависимости | TASK-075 (EgressGateway), TASK-074 (JobScheduler) |
| Блокирует | TASK-097, TASK-104 |
| Блокируется | TASK-075 |
| Исходная задача дорожной карты | T-6.2.1 (`docs/roadmap/07-phase-6.md`) |

## 2. Цель

electron-updater в ручном режиме: проверка обновлений — только при выданном согласии (`prefs.netConsents.updatesCheck`), разрешение через `EgressGateway.checkPermission` + журналирование каждой проверки, установка — только по явному действию; событие `update:available`; авто-проверка (24 ч, JobScheduler) — только при согласии.

## 3. Бизнес-контекст

NFR-11: даже проверка обновлений — сетевой след (IP); пользователь, поверивший в локальность, не должен обнаруживать неожиданные соединения. Согласие запрашивается один раз (настройки/первый старт), отзыв мгновенен.

## 4. Технический контекст

- **Архитектура:** D15; белый список — TASK-075 (`updates.check` op).
- **Обоснование:** electron-updater сам выполняет сеть (внутри) — через gateway физически не провести; честная модель: gateway.checkPermission(op) — единая точка решения + журналирования; updater вызывается ТОЛЬКО после разрешения; `autoDownload: false`, `disableWebInstaller: true` — никаких фоновых загрузок. Ограничение документируется: трафик updater'а наблюдаем, но инициируем и журналируем мы (аудит P7 — TASK-106 сверяет факт).

## 5. Объём

- **Включено:** `UpdatesService`: gateway.checkPermission('updates.check') → throw NET/BLOCKED_BY_POLICY (или «нет согласия») → journal entry через gateway-journal API → `autoUpdater.checkForUpdates()` → события: `update-available` (version), `update-not-available`, `error` → journal update; `downloadUpdate()` — отдельное согласие? РЕШЕНИЕ: скачивание покрывается тем же согласием updatesCheck (один флаг, текст согласия упоминает и загрузку) — документируется; `quitAndInstall()` — только по кнопке; авто-проверка: JobScheduler задача `updates.check` (interval 24 ч, runOnStart=true — только если consent; иначе задача сама молчит — проверка внутри); канал `updates/check {} → {status: 'available'|'latest'|'error', version?}`, `updates/download {} → {progress-события?}` (прогресс — update-download-progress событие), `updates/install {} → {restarting: true}`; consent-toggle в prefs — точка (UI — 097/099); тесты с моком autoUpdater.
- **Не включено:** подпись/фид (TASK-104 — дев-режим на unpublished feed: заглушка latest.yml локального http — тест-хелпер), дифф-обновления (nsis full — дефолт).
- **Будущая работа:** delta/блоки — не планируется; beta-канал — 107.

## 6. Файлы

- **Создать:** `main/modules/platform-services/updates/updates-service.ts` + тесты (мок autoUpdater); `ipc/handlers/updates.ts`; gateway-расширение `checkPermission(op): {allowed, journal(fn)}`.
- **Изменить:** `container.ts` (задача планировщика), `contracts` (каналы+события update:*), `EgressPolicy` уже содержит op (075).

## 7. Модель предметной области

`UpdateStatus {state: 'idle'|'checking'|'available'|'latest'|'downloading'|'ready'|'error'; version?; progress?}` — единый снимок для UI.

## 8. База данных

N/A (журнал — network_event).

## 9. Бэкенд

Порядок проверки: consent? (prefs) → permission+journal-start → updater.checkForUpdates → события → journal-end. Ошибка сети → status error + journal failed (не тост-спам).

## 10. Фронтенд

N/A (097).

## 11. API

Каналы §5; события `update:available {version}`, `update:progress {percent}`, `update:ready`.

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Кейсы: без согласия check → BLOCKED (журнал blocked — как в 075); с согласием → проверка; install без downloaded → отказ; скачивание требует → прогресс → ready → install → relaunch (updater сам); повторная проверка в backoff ошибки (не чаще 10 мин — throttle).

## 14. Безопасность

Подпись обновлений проверяет updater (NFR-11 — настроится в 104; до подписи — dev-only); никакого autoDownload; permissions байпас исключён тестом (spy: без согласия checkForUpdates не вызван).

## 15. Производительность

N/A.

## 16–17. Доступность / i18n

N/A (097); текст согласия — 099/097.

## 18. Телеметрия

Каждая проверка — в журнале сети (kind updates.check, статус, байты) — FR-7.1.

## 19. Стратегия тестирования

Мок `autoUpdater` (интерфейс-обёртка UpdatesAdapter для тестируемости): без согласия — spy 0 вызовов + журнал blocked; с согласием — проверка + события; ошибка сети → статус; планировщик: consent=false → задача молчит на tick (тест 074-каркаса); download/install последовательность (мок).

## 20. Критерии приёмки

- [ ] Без согласия: 0 вызовов checkForUpdates; журнал содержит blocked (тест).
- [ ] С согласием: проверка → событие статуса → журнал ok.
- [ ] autoDownload=false установлен (тест конфига).
- [ ] Планировщик: без согласия тик молчит; с согласием — проверка раз в 24 ч (FixedClock).
- [ ] Ошибка сети → статус error, не креш; throttle повторов.
- [ ] Install без ready → отказ.

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- updater-трафик вне журнала байтов (внутренний) — аудиторская оговорка в TASK-106 (журнал фиксирует факт проверки; байты — приблизительные/отсутствуют для updater'а; документируется честно).

## 23. Будущие соображения

СвойUpdater через gateway (полный контроль байтов) — пост-MVP, если аудит-требования ужесточатся.

## 24. Проверка

Автоматически: тесты с моком зелёные. Ручная: revoke согласия → проверка из UI → отказ мгновенный. Откат: revert (кнопки 097 скрыты).
