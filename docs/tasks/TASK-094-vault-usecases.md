# TASK-094: Реализовать use cases vault и rate limit

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-094 |
| Название | Реализовать use cases Unlock/Lock/SetPassphrase + rate limit |
| Фаза | P6 — Безопасность и надёжность |
| Эпик | 6.1 — Локальный вход и блокировка |
| Веха | M-6.1 — Локальный вход |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1,5–2,5 ч |
| Зависимости | TASK-093, TASK-074 (JobScheduler для автоблока) |
| Блокирует | TASK-095 |
| Блокируется | TASK-093 |
| Исходная задача дорожной карты | T-6.1.2 (`docs/roadmap/07-phase-6.md`) |

## 2. Цель

Сессионная механика входа: use cases `vault/status|unlock|lock|set-passphrase` + IPC-каналы; экспоненциальный rate-limit неудачных попыток; автоблок по простою (5/15/60 мин/выкл); события `lock:engaged|required` для UI; БД не открывается до unlock при passphrase-режиме.

## 3. Бизнес-контекст

UC-защита «подошёл и посмотрел» (FR-7.5): заблокированное приложение скрывает всё; rate-limit делает перебор пароля непрактичным даже автоматикой. Фоновые задачи уважают locked-состояние (ничего не читают БД).

## 4. Технический контекст

- **Архитектура:** VaultState агрегат — арх. 02 §3.7; события — 05 §4.
- **Обоснование:** rate-limit в памяти сессии (не persist): перезагрузка приложения сбрасывает — принятый компромисс (persist позволил бы «вечную блокировку» как атаку на пользователя); экспонента: N-я неудача → задержка 2^(N−3) сек (1,2,4,8…), максимум 60 с.

## 5. Объём

- **Включено:** `VaultService`: state machine `locked→unlocked`, `attempts`, `backoffUntil`; каналы: `vault/status {} → {mode, locked, backoffSec?}`, `vault/unlock {pass} → {ok}|{error, backoffSec}`, `vault/lock {}`, `vault/set-passphrase {pass|old+new|remove}`; неудача → attempts++ → backoff (до успешного unlock сброс); автоблок: JobScheduler-задача `session.autolock` (проверка idle: время последнего пользовательского действия — main считает по любому IPC-вызову, интервал проверки 30 с; порог из prefs `autoLockMin: 5|15|60|0-выкл`); события `lock:engaged` (БД закрывается! checkpoint+close — полная защита) и `lock:required` (просто блок UI без закрытия? РЕШЕНИЕ: engaged = БД закрыта — честная защита; повторный unlock открывает); тесты с FixedClock.
- **Не включено:** persist попыток между перезапусками (§4), биометрия/Windows Hello (пост-MVP).
- **Будущая работа:** Windows Hello через safeStorage-биометрию — пост-MVP.

## 6. Файлы

- **Создать:** `main/modules/security/application/vault-service.ts`; `ipc/handlers/vault.ts`; тесты.
- **Изменить:** `container.ts` (ленивое открытие БД — если ещё не; регистрации каналов; idle-трекер: обёртка registerChannel обновляет lastActivity), `prefs`-схема (autoLockMin), `contracts` (каналы+события).

## 7. Модель предметной области

`VaultState {mode, locked, attempts, backoffUntilUtcMs, lastActivityUtcMs}`; инвариант: при mode=passphrase и locked — repository-операции возвращают `VAULT/LOCKED` (гвардия в хендлерах всех БД-каналов: декоратор requireUnlocked — включить в объём, обёртка над registerChannel).

## 8. База данных

Lock → checkpoint+close (файлы -wal исчезают); unlock → ensureKey → open+migrate (уже v-актуально) — путь повторного открытия тестируется.

## 9. Бэкенд

Idle-трекер: любой вызов window.hl.* обновляет lastActivity (централизованно в registerChannel — один патч); autolock-job: locked уже → no-op; unlocked + idle>порог → lock (событие).

## 10. Фронтенд

N/A (095); события — триггер оверлея.

## 11. API

Каналы §5; гвардия: все measurements/stats/ai/report/backup каналы обёрнуты requireUnlocked (при locked → VAULT/LOCKED) — ЕДИНЫЙ патч каркаса registerChannel (flag secure: true в реестре каналов — флаговая система контрактов расширяется).

## 12. Управление состоянием

Renderer: событие → экран блокировки (095); status-запрос при старте.

## 13. Бизнес-логика

Кейсы: 3 неудачи → backoff 1 с, 4-я попытка в backoff → отказ с backoffSec; успех → сброс; lock вручную → БД закрыта (тест: файл -wal исчез); unlock после lock → БД открыта, данные читаются; autolock 5 мин: активность продлевает (tick-тесты на FixedClock).

## 14. Безопасность

Гвардия requireUnlocked — единая точка (обход = ревью-блокер); backoff серверный (не доверять UI-таймеру); событие failed — лог с attempts (без пароля).

## 15. Производительность

Unlock: Argon2id ~0,5 с + открытие БД ~100 мс — UX с индикатором (095).

## 16. Доступность

N/A (095).

## 17. Интернационализация

N/A; backoffSec — params для текста «Подождите N с».

## 18. Телеметрия

Лог: unlock fail/success, lock (manual/autolock), attempts счётчик при backoff.

## 19. Стратегия тестирования

Юниты (FixedClock): backoff-экспонента, сброс при успехе, autolock-пороги (5/15/60/0), активность продлевает. Интеграция: lock → -wal исчез → БД-канал → VAULT/LOCKED → unlock → данные читаются; set-passphrase поток через каналы (консистентность с 093).

## 20. Критерии приёмки

- [ ] Backoff-таблица (2-я/3-я/5-я неудача) зелёная с точными сек.
- [ ] Успешный unlock сбрасывает attempts (тест).
- [ ] Lock: -wal/-shm удалены после checkpoint (тест ФС); БД-каналы → VAULT/LOCKED.
- [ ] Autolock: 5 мин бездействия → lock; активность на 4:59 продлевает (FixedClock-тесты).
- [ ] Гвардия: ЕДИНАЯ обёртка в registerChannel — grep: ни одного БД-хендлера без secure-флага (тест-инвентарь каналов).
- [ ] События lock:engaged доставлены renderer (тест моста).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Autolock раздражает при длинном чтении без действий — порог 60 мин/выкл в настройках; пассивное чтение без IPC-активности — редкость (скролл не IPC… решение: renderer шлёт лёгкий heartbeat-канал на пользовательские события ввода — включить в 095 объём).

## 23. Будущие соображения

Windows Hello — пост-MVP; persist-блокировка при подозрении — никогда (вектор атаки на пользователя).

## 24. Проверка

Автоматически: тесты зелёные. Ручная: включить пароль+автоблок 5 мин → уйти → экран блокировки → unlock → данные на месте. Откат: revert.
