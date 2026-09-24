# TASK-076: Реализовать каркас llm-worker (UtilityProcess)

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-076 |
| Название | Реализовать каркас llm-worker: UtilityProcess + протокол MessagePort |
| Фаза | P5 — Локальный ИИ |
| Эпик | 5.2 — LLM-воркер |
| Веха | M-5.2 — LLM-воркер |
| Приоритет | Must (MVP) |
| Сложность | L |
| Оценка времени | 2,5–4 ч |
| Зависимости | TASK-007 |
| Блокирует | TASK-077, TASK-078 |
| Блокируется | нет |
| Исходная задача дорожной карты | T-5.2.1 (`docs/roadmap/06-phase-5.md`) |

## 2. Цель

Отдельный процесс `llm-worker` (Electron UtilityProcess) с MessagePort-протоколом `{load, unload, complete, cancel}` и стримингом токенов; main-side клиент с requestId, авто-перезапуском после краша воркера и событиями `ai:status`. Воркер не знает про llama.cpp (движок подключит TASK-077).

## 3. Бизнес-контекст

Нативный LLM-код может крашнуться и точно ест RAM: изоляция процессом защищает окно и данные (NFR-3/5, D5). Каркас протокола — до интеграции движка: интерфейс LlmEngine стабилен, движок сменяем.

## 4. Технический контекст

- **Архитектура:** D5, процессная модель — арх. 01 §1, 07 §1–2.
- **Модуль:** `main/llm-worker` (вход воркера) + `ai-insight/adapters/llm-client` (main-side).
- **Обоснование:** UtilityProcess (не worker_threads): нативный краш убивает процесс, не приложение; память возвращается ОС при exit. MessagePort — официальный транспорт UtilityProcess.

## 5. Объём

- **Включено:** протокол (contracts): `{type:'load', modelPath} | {type:'unload'} | {type:'complete', requestId, messages, params, maxTokens} | {type:'cancel', requestId}` → ответы `{type:'ready'|'unloaded'}`, `{type:'token', requestId, delta}`, `{type:'done', requestId, finishReason}`, `{type:'error', requestId|global, code}`; воркер: loop сообщений, реестр активных генераций, обработчик-заглушка `engine: not-configured` (мост для 077); main-side `LlmProcessClient`: spawn UtilityProcess (entry `llm-worker.js`), MessagePort handshake, методы load/unload/complete(requestId, …) с подписками token/done/error, cancel; автоматический перезапуск при exit (backoff 1с, максимум 3 подряд → событие status 'failed'); события в renderer: `ai:status {requestId?, state}`; env `HL_FAKE_WORKER_CRASH` тест-хук; тесты (fake-воркер-скрипт).
- **Не включено:** реальный движок (077), очередь генераций (одновременная генерация одна: второй complete → error BUSY — решение, UI блокирует кнопку; документируется).
- **Будущая работа:** очередь/приоритеты при мульти-запросах (не в MVP).

## 6. Файлы

- **Создать:** `apps/desktop/src/main/llm-worker/{main.ts,protocol.ts}`; `ai-insight/adapters/llm-process-client.ts`; contracts `ai/worker-protocol`; тесты: интеграционные с fake-worker entry (echo-движок: стримит N токенов), юниты клиента (мок MessagePort).

## 7. Модель предметной области

RequestId — uuid; состояния генерации: `queued→streaming→done|cancelled|error`; статусы воркера: `starting|ready|busy|restarting|failed`.

## 8. База данных

N/A.

## 9. Бэкенд

Клиент в контейнере — синглтон; cancel после done — no-op; complete при busy → error `AI/BUSY` (код в реестре).

## 10. Фронтенд

N/A (события потребляет 088).

## 11. API

События `ai:status/token` (карта HlEventMap расширяется; токены — отдельный канал доставки `hl:event` приемлем по частоте ≤20/с? Токены чаще → решение: токены батчатся клиентом (flush 50 мс) — деталь фиксирована).

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Краш во время генерации: клиент отклоняет активный requestId с `AI/WORKER_CRASHED`, перезапускает, статус-события; unload при отсутствии активных генераций; cancel идемпотентен.

## 14. Безопасность

Воркер без доступа к БД/ключам/файлам пользователя (только путь модели — параметр); путь модели валидируется существованием на main-стороне до передачи.

## 15. Производительность

Handshake spawn ≤500 мс; стрим-латентность (fake) ≤10 мс/токен; батчинг 50 мс — плавный UI.

## 16–17. Доступность / i18n

N/A (события статусов — тексты на 088).

## 18. Телеметрия

Лог: spawn/exit/crash/restart (категория ai), requestId-журнал генераций без содержимого.

## 19. Стратегия тестирования

Интеграционные с fake-worker entry (env-переменная выбора entry): полный цикл load→complete(stream 10 токенов)→done; cancel посреди — остановка потока, done(cancelled); краш воркера (fake-команда crash) → отклонение requestId, перезапуск, новая генерация успешна; BUSY на второй параллельной.

## 20. Критерии приёмки

- [ ] Полный цикл протокола зелёный (fake-воркер).
- [ ] Краш → отклонение активной генерации, автоперезапуск ≤3 попыток, следующая генерация работает.
- [ ] BUSY на второй параллельной генерации (код AI/BUSY).
- [ ] Токены батчатся (интервал-тест ≤50 мс группировка).
- [ ] Cancel идемпотентен; unload при активной генерации отклоняется.

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- MessagePort-API нюансы Electron — проверяются ранним smoke (первая половина задачи).
- Зависание воркера без exit — watchdog: нет done за N секунд + отсутствие токенов 30 с → kill+restart (параметр, тест).

## 23. Будущие соображения

Несколько моделей одновременно — нет (одна загрузка; переключение = unload+load).

## 24. Проверка

Автоматически: интеграционные тесты зелёные. Ручная: smoke статусов в событийном логе при fake-генерации. Откат: revert (AI-модуль не виден UI).
