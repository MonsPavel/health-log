# TASK-025: Написать миграцию v1 (profile + bp_measurement)

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-025 |
| Название | Написать миграцию v1: profile + bp_measurement + meta |
| Фаза | P1 — Вертикальный срез журнала |
| Эпик | 1.2 — Хранилище: SQLCipher сразу |
| Веха | M-1.2 — Зашифрованное хранилище |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1–1,5 ч |
| Зависимости | TASK-024 |
| Блокирует | TASK-026 |
| Блокируется | TASK-024 |
| Исходная задача дорожной карты | T-1.2.4 (`docs/roadmap/02-phase-1.md`) |

## 2. Цель

DDL-миграция v1: таблицы `profile` (с одним seeded-профилем) и `bp_measurement` (с CHECK-ограничениями и индексом), инициализация `meta.data_version = 1`.

## 3. Бизнес-контекст

Схема из арх. 04 §3. `profile_id` присутствует с первого дня при одном профиле — дешёвая страховка пост-MVP мультипрофилей (FR-11) без миграции данных. CHECK-ограничения дублируют доменные границы (TASK-016) — защита от багов вне домена (прямой SQL, будущий импорт).

## 4. Технический контекст

- **Архитектура:** схема — `docs/architecture/04-database.md` §3 (DDL-источник); инварианты — TASK-016.
- **Модуль:** `shared/db/migrations`.
- **Обоснование:** отдельная таблица bp_measurement, а не EAV — фикс. решение арх. 04 §3 (второй тип показателей добавит sibling-таблицу). UUID v7 строкой — сортируемость по времени создания.

## 5. Объём

- **Включено:** миграция v1: DDL обеих таблиц + индекс + seed одного профиля + `meta.data_version='1'`; тесты: применение к свежей БД, сверка структуры, CHECK срабатывает, seed существует, idempotent-запрет повторного применения (runner не даст — тест).
- **Не включено:** FTS (TASK-045, v2), другие таблицы арх. 04 (появляются со своими фазами: reference_scale v3, ai_summary v4, chat v5, network_event v6).
- **Будущая работа:** rename/расширения полей — новые миграции, не правка v1 (v1 неизменяема после релиза).

## 6. Файлы

- **Создать:** `apps/desktop/src/main/shared/db/migrations/v1-initial-schema.ts`; регистрация в `migrations/index.ts`; интеграционный тест `v1.int.test.ts`.

## 7. Модель предметной области

N/A (маппинг агрегата TASK-017 → колонки описан там; здесь — DDL-сторона).

## 8. База данных

DDL v1 (полная спецификация, сверка с арх. 04 §3):

- `profile (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at_utc INTEGER NOT NULL)` + seed: `('seed-profile-0001', 'Основной', <now из Clock-инъекции миграции? НЕТ: seed created_at_utc = константа времени запуска миграции — Date.now() допустим в миграции (однократно), задокументировать>`.
- `bp_measurement (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profile(id), taken_at_utc INTEGER NOT NULL, tz_offset_minutes INTEGER NOT NULL, sys INTEGER NOT NULL CHECK(sys BETWEEN 50 AND 300), dia INTEGER NOT NULL CHECK(dia BETWEEN 20 AND 200), pulse INTEGER NULL CHECK(pulse IS NULL OR pulse BETWEEN 20 AND 300), irregular_pulse INTEGER NOT NULL DEFAULT 0 CHECK(irregular_pulse IN (0,1)), arm TEXT NOT NULL CHECK(arm IN ('left','right')), note TEXT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','import')), created_at_utc INTEGER NOT NULL, updated_at_utc INTEGER NOT NULL)`.
- `CREATE INDEX idx_bp_profile_time ON bp_measurement(profile_id, taken_at_utc)`.
- CHECK-числа дублируют `BP_LIMITS` (TASK-016) — комментарий в DDL: «синхронно с domain/constants.ts».

## 9. Бэкенд

N/A (используют TASK-026).

## 10–12. Фронтенд / API / Состояние

N/A.

## 13. Бизнес-логика

Ограничения целостности (уровень БД): FK на profile (включён foreign_keys=ON — TASK-022), CHECK-диапазоны, допустимые значения arm/source/irregular_pulse. note без CHECK длины (доменная валидация ≤500 — уровень приложения; БД не ограничивает — задокументированное решение: длина проверяется на входе, БД доверяет домену; alternative CHECK(length(note)<=500) отвергнута: импорт post-MVP может хотеть длиннее без доменных ограничений… НЕТ — принято решение БЕЗ CHECK длины, но с комментарием).

## 14. Безопасность

Таблицы внутри шифрованной БД (TASK-022) — ничего дополнительно.

## 15. Производительность

Индекс (profile_id, taken_at_utc) покрывает главный запрос listByPeriod и агрегаты статистики (P3); без индекса 50k записей — полноэкранный скан.

## 16–17. Доступность / i18n

N/A (имя seeded-профиля «Основной» — RU-строка в данных; при EN-локализации пост-MVP — переименование пользователем; допустимо, задокументировано).

## 18. Телеметрия

N/A.

## 19. Стратегия тестирования

Интеграционный тест: применить v1 к tmp-БД → (1) таблицы существуют (sqlite_master), (2) seeded-профиль читается, (3) вставка sys=999 → CHECK-ошибка, (4) вставка без profile_id → FK-ошибка, (5) индекс существует, (6) data_version='1'.

## 20. Критерии приёмки

- [ ] Тесты (1)–(6) §19 зелёные.
- [ ] DDL поимённо совпадает с арх. 04 §3 (таблицы/колонки/индекс).
- [ ] Повторное применение v1 невозможно (runner-защита — тест через runner).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Неизменяемость v1: любые изменения схемы — только v2+ (правило в комментарии файла; нарушение = потеря совместимости копий).

## 23. Будущие соображения

Колонки под структурированные теги/лекарства (post-MVP) — ALTER TABLE в v-next, не сейчас.

## 24. Проверка

Автоматически: `pnpm test -- v1.int` зелёный. Ручная: `pnpm dev` → приложение стартует, БД создаётся, schema_version=1 (через временный лог — TASK-027 добавит постоянный). Откат: revert (восстанавливается empty-реестр миграций; тестовая БД в tmp не в репо).
