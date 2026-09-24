# TASK-087: Реализовать GenerateSummary use case

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-087 |
| Название | Реализовать GenerateSummary: кэш, стейлс, стрим, отмена (+ миграция v6) |
| Фаза | P5 — Локальный ИИ |
| Эпик | 5.5 — Резюме периода |
| Веха | M-5.5 — Резюме |
| Приоритет | Must (MVP) |
| Сложность | L |
| Оценка времени | 2,5–4 ч |
| Зависимости | TASK-078, TASK-083, TASK-084, TASK-085, TASK-086 |
| Блокирует | TASK-088, TASK-089, TASK-091 |
| Блокируется | TASK-078, TASK-083–086 |
| Исходная задача дорожной карты | T-5.5.1 (`docs/roadmap/06-phase-5.md`) |

## 2. Цель

Полный поток UC-03: `GenerateSummary(period, options)` → префильтр (086) → кэш по context_hash → стрим генерации (084+083 → движок) → ResponseGuard (085) → дисклеймер+период → сохранение (миграция **v6** ai_summary) с data_version; события ai:token/status; отмена; бейдж стейлса по data_version.

## 3. Бизнес-контекст

US-18 «объясни мою динамику»: пользователь нажал кнопку — получил честный разбор; повторный запрос без изменений — мгновенный кэш; изменил данные — бейдж «обновите» (FR-5.7). Атомарность и честность — здесь.

## 4. Технический контекст

- **Архитектура:** поток — арх. 07 §5; кэш/стейлс — 04 §4 (data_version).
- **Модуль:** `ai-insight/application` + миграция v6.
- **Обоснование:** кэш-ключ = context_hash (включает PROMPT_TEMPLATE_VERSION/modelId/опции) — смена модели/шаблона честно инвалидирует; стейлс — отдельная механика (data_version сравнение) — резюме не перегенерируется само, только бейдж (решение SRS).

## 5. Объём

- **Включено:** миграция **v6** `ai_summary (id, profile_id, kind 'summary', period_start_utc, period_end_utc, context_hash, model_id, model_version, data_version, content_md, created_at_utc)` + индекс (profile_id, created_at_utc desc); порт `InsightRepository` + SQLite-адаптер (findByContextHash, save, latestForPeriod, deleteAll — для очистки); use case: (1) AiContextBuilder → ctx; (2) префильтр 086 → refusal → сохранить как резюме? РЕШЕНИЕ: отказ-резюме НЕ сохраняется (всегда свежий пересчёт — дёшево) → ответ-стрим из шаблона; (3) кэш findByContextHash → hit: вернуть из кэша + stale-расчёт (data_version); (4) miss: LlmEngine.ensureModel → complete(systemPrompt+userPrompt(ctx.text)) → агрегация стрима → токены-события (батчинг клиента 076) → done → ResponseGuard.check → пост-обработка: добавить период-подпись+дисклеймер (несъёмный — отдельно от content_md! поле текста: content_md + служебные поля disclaimerText/periodText — рендер всегда показывает оба) → save (data_version текущий); (5) cancel: signal → done(cancelled) → НЕ сохранять; канал `ai/summary/generate {profileId, period, includeNotes} → {requestId}` + стрим событиями + финал `ai/summary/result {requestId, summaryId?, cached, stale}`; портовые юнит-тесты на fake-engine; интеграционные (tmp-БД).
- **Не включено:** чат (089), UI (088), фоновая предгенерация.
- **Будущая работа:** регенерация частями (ускорение) — не планируется.

## 6. Файлы

- **Создать:** `shared/db/migrations/v6-ai-summary.ts`; `application/ports/insight-repository.ts`; `adapters/sqlite-insight-repository.ts`; `application/generate-summary.ts`; contracts `ai/summary`; `ipc/handlers/ai-summary.ts`; тесты (миграция, репо, use case на fake, интеграция).

## 7. Модель предметной области

`SummaryRecord {id, period, contextHash, modelId, modelVersion, dataVersion, contentMd, disclaimerText, periodText, createdAtUtc}`; `stale = record.dataVersion < repo.currentDataVersion()` — вычисляется при чтении (не хранится).

## 8. База данных

v6 DDL; удаление резюме — wipe покрывает (таблица в БД); «Очистить разборы» кнопка — deleteAll (088 — включить в тот UI: размещается на экране ИИ; объём 088).

## 9. Бэкенд

BusY-гвардия: генерация уже идёт → второй generate → AI/BUSY (UI блокирует, но серверная защита обязательна); cache-hit не запускает движок (spy-тест); сохранение только при done(ok) — cancelled/replace? Replace (guard) — сохраняется ЗАМЕНЁННЫЙ текст (пользователь видит отказ в истории резюме? РЕШЕНИЕ: replace-ответ не сохраняется как резюме тоже — это «не резюме»; в чат-истории останется (089), в резюме — нет; документируется).

## 10. Фронтенд

N/A (088).

## 11. API

`ai/summary/generate` (§5) + `ai/summary/result` финал; события `ai:token {requestId, delta}`, `ai:status {requestId, state}`.

## 12. Управление состоянием

Ключи renderer — 088; стейлс-бейдж: renderer сравнивает stats.data_version? Нет — бейдж из `ai/summary/latest {period}` запроса (мини-канал: latest по периоду с stale-флагом — включить в контракты: `ai/summary/latest {profileId, period} → {summary, stale}|undefined`).

## 13. Бизнес-логика

Кейсы: cache-hit без генерации; стейлс после мутации (add → version+1 → latest.stale=true, тест); cancelled → нет записи; guard-replace → нет записи + лог; отказ 086 → мгновенный стрим шаблона без сохранения; BUSY-второй.

## 14. Безопасность

Контекст/ответ не логируются (PHI); дисклеймер — несъёмный (отдельные поля — рендер обязан показывать: контрактное тест-замечание в DTO).

## 15. Производительность

Cache-hit <50 мс; полный путь замеряется (fake: <1 с).

## 16. Доступность

N/A (UI).

## 17. Интернационализация

disclaimerText/periodText — RU-константы main (LLM-слой), согласованы с каталогом (сверка-тест ключа и константы).

## 18. Телеметрия

Лог: генерации (модель, durationMs, tokens, cached, guard=replace?) без текста.

## 19. Стратегия тестирования

Юниты (fake engine, fake repo): miss→generate→save (все поля, data_version захвачен); hit→без engine-вызова (spy)+stale-флаги; мутация→stale; cancel→no-save; refusal→мгновенный шаблон, engine spy чист; replace→no-save; BUSY. Интеграция: tmp-БД → v6 → полный цикл с fake-engine.

## 20. Критерии приёмки

- [ ] Все кейсы §19 зелёные (таблица).
- [ ] Cache-hit: engine.complete spy = 0 вызовов; ответ с cached=true.
- [ ] После add-мутации latest.stale=true (сквозной тест).
- [ ] Cancel: записи нет, движок остановлен (событие done-cancelled).
- [ ] Guard-replace: резюме не сохранено; в логе replace-событие.
- [ ] Дисклеймер/период — отдельные поля, заполнены всегда (инвариант-тест).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Гонки «cancel vs done» — финализация идемпотентна (первое из done/cancelled фиксирует исход; тест).

## 23. Будущие соображения

Фоновая предгенерация ночного резюме — пост-MVP (электричество/шум не нужны).

## 24. Проверка

Автоматически: тесты зелёные. Ручная: fake-режим → сгенерировать резюме из DevTools-вызова. Откат: revert.
