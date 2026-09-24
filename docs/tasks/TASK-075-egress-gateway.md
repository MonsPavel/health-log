# TASK-075: Реализовать EgressGateway и журнал сети

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-075 |
| Название | Реализовать EgressGateway: белый список, согласия, журнал network_event |
| Фаза | P5 — Локальный ИИ |
| Эпик | 5.1 — Контролируемая сеть |
| Веха | M-5.1 — Контролируемая сеть |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1,5–2 ч |
| Зависимости | TASK-026 (БД), TASK-003 (линт) |
| Блокирует | TASK-080 (загрузка моделей), TASK-096 (обновления) |
| Блокируется | TASK-026 |
| Исходная задача дорожной карты | T-5.1.1 (`docs/roadmap/06-phase-5.md`) |

## 2. Цель

Единственная точка сети приложения: `EgressGateway.request(op)` — проверка белого списка (`EgressPolicy`: `updates.check`, `models.download`), проверка согласия пользователя (prefs.netConsents), запись в журнал `network_event` (миграция **v5** — лиджер обновлён: v5 network_event, v6 ai_summary, v7 chat), событие `net:activity`; ESLint-правило запрещает fetch/net мимо гейтвея.

## 3. Бизнес-контекст

BG-2 «нулевого сетевого следа» проверяемо только если весь трафик идёт через один контролируемый компонент (D11, FR-7.1/7.3): аудит AC-4.1 = проверка одного файла. Строится ДО первой сетевой операции (загрузки моделей), иначе гарантии нет.

## 4. Технический контекст

- **Архитектура:** EgressPolicy/Gateway — `docs/architecture/08-security.md` §5; журнал — 09 §3.
- **Модуль:** `platform-services` (+ миграция v5 в shared/db).
- **Обоснование:** net.fetch Electron для запросов (уважает прокси ОС); ESLint `no-restricted-imports`/синтаксис на `node:https`, `node:fetch`, глобальный `fetch` вне `egress/` каталога — дисциплина кодом.

## 5. Объём

- **Включено:** миграция **v5** `network_event (id, kind, endpoint, status, bytes, at_utc)` + индекс; `EgressPolicy`: `ALLOWED = {models.download: {consentKey: 'modelsDownload'}, updates.check: {consentKey: 'updatesCheck'}}` (prefs.netConsents расширяется: modelsDownload — согласие запрашивается в TASK-081 UI); `EgressGateway.request(op, {endpoint, init}) → Promise<Response>`: (1) op в ALLOWED? (2) consent[op]? иначе — throw `NET/BLOCKED_BY_POLICY {op}`; (3) journal: запись `running` → выполнение → обновить `status/bytes/at`; (4) emit `net:activity {kind, endpoint}`; helper `listRecent(limit)`; ESLint-правило (зона-исключение `**/egress/**`); тесты.
- **Не включено:** UI согласий/журнала (TASK-081/099), rate-limit (не нужен — операции user-initiated).
- **Будущая работа:** домен- allowlist пер-операции (пин домены в политике) — при ADR-0004 на P7-аудит.

## 6. Файлы

- **Создать:** `shared/db/migrations/v5-network-event.ts`; `main/modules/platform-services/egress/{egress-policy.ts,egress-gateway.ts}`; eslint-правило в конфиге; `contracts` событие `net:activity`; тесты (миграция, gateway 4 ветки, журнал).

## 7. Модель предметной области

События журнала — только метаданные (kind/endpoint/status/bytes/at): URL не содержит PHI (эндпоинты — CDN моделей/сервер обновлений); правило фиксируется тестом.

## 8. База данных

v5 DDL; ретеншн 90 дней — задача TASK-103 (ротация), здесь только индекс (kind, at_utc).

## 9. Бэкенд

Gateway singleton в контейнере; отказ (нет согласия) — БЫСТРЫЙ отказ до сети, журнал пишет «blocked» — пользовательский журнал честен и про отказы (решение: blocked-записи тоже в журнале).

## 10. Фронтенд

N/A (лента — TASK-099).

## 11. API

N/A (событие `net:activity` в HlEventMap — TASK-009 карта расширяема).

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Ветки тестов: op вне списка → BLOCKED_BY_POLICY (журнал blocked); op в списке, согласия нет → BLOCKED (журнал); согласие есть → выполнение + журнал ok/failed с байтами; сетевая ошибка → статус failed, проброс ошибки вызывающему.

## 14. Безопасность

Согласия — из prefs (TASK-047), read-only для gateway; отмена согласия мгновенно блокирует следующий запрос; OWASP: TLS всегда (нет http-эндпоинтов в политике).

## 15. Производительность

N/A (обёртка над fetch).

## 16–17. Доступность / i18n

N/A (UI 099); коды стабильны.

## 18. Телеметрия

Журнал = телеметрия сети (локальная); лог категории net — дублирует ключевые события.

## 19. Стратегия тестирования

Интеграционные (tmp-БД): 4 ветки §13; мок-сервер http (локальный node http) как endpoint — трафик реальный через gateway; ESLint-фикстура: fetch вне egress → error, внутри → чисто; `net:activity` событие доставлено (fake window).

## 20. Критерии приёмки

- [ ] 4 ветки §13 зелёные; blocked-записи в журнале.
- [ ] Реальный запрос через мок-сервер: журнал обновлён байтами.
- [ ] ESLint-фикстуры: нарушение ловится (тест правил).
- [ ] `net:activity` доходит в renderer (тест моста).
- [ ] Миграция v5: таблица+индекс; runner идемпотентен.

## 21. Definition of Done

Шаблонный §21 (`docs/tasks/_TEMPLATE.md`).

## 22. Риски

- Обход гейтвея зависимостью (электрон-updater сам ходит) — известный риск: TASK-096 интегрирует updater через gateway-модель on-demand; финальная проверка — сетевой аудит P7 (TASK-106).

## 23. Будущие соображения

Пин TLS-сертификатов/домены в политике — пост-MVP усиление.

## 24. Проверка

Автоматически: тесты зелёные. Ручная: revoke consent → попытка → BLOCKED. Откат: revert (потребителей нет).
