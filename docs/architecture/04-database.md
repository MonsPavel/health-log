# 04. Проект базы данных

**Статус:** черновик v0.1 · 2026-09-24

---

## 1. Выбор хранилища

**D4: SQLite (WAL) + SQLCipher через better-sqlite3; доступ через Drizzle ORM (драйвер better-sqlite3); миграции — версионируемые SQL-миграции Drizzle.**

**Почему SQLite.** Встроенная, нулевое администрирование, ACID, WAL даёт устойчивость к сбою питания (NFR-3), файл = простая единица копии (FR-6.4), VACUUM INTO = безопасный снапшот. SQLCipher — прозрачное шифрование в покое (NFR-2) без ручной криптографии на уровне записей.

**Альтернативы.**
- *JSON/файлы:* нет транзакций/запросов/целостности — отвергнуто сразу.
- *LevelDB/RxDB/PouchDB:* NoSQL без декларативных агрегатов, нужных статистике и отчёту (средние/СКО/группировки пришлось бы писать вручную поверх JS — медленнее и ошибочнее).
- *PostgreSQL/сервер:* нарушение локальности продукта.
- *Шифрование на уровне приложения (шифровать поля):* легко ошибиться частично (индексы/поиск); SQLCipher шифрует файл целиком.

**Компромиссы.** better-sqlite3 — синхронный API: блокирует main на время запроса. Принято (объёмы ≤50k строк, индексы, тяжёлое — в воркерах, 03 §6). Нативный модуль требует пересборки под Electron ABI — решается electron-rebuild в CI. SQLCipher-сборка SQLite — кастомный билд better-sqlite3 (поддерживаемый сообществом пресет) — риск сопровождения отмечен, fallback: app-level шифрование файла БД целиком перед записью на диск (хуже по гранулярности, но рабоче).

## 2. Время

- Хранение: `taken_at_utc` (INTEGER, epoch ms) + `tz_offset_minutes` (INTEGER, смещение в момент измерения).
- «Настенное время» измерения = utc + offset → классификация утро/вечер и группировка по дням устойчивы к перелётам и DST (EC-06/07). Сортировки/периоды — по UTC.
- Часы приложения — порт `Clock` в kernel: домен не читает `Date.now()` напрямую → детерминированные тесты.

**Почему не «локальное время строкой»:** потеря сортируемости и дубль-логика; **почему не только UTC:** утро/вечер — категория настенного времени пользователя в момент измерения.

## 3. Схема (DDL, концептуально)

```sql
-- Профили: в MVP один seeded-профиль; схема готова к FR-11 без миграции данных
CREATE TABLE profile (
  id          TEXT PRIMARY KEY,            -- uuid v7
  name        TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL
);

CREATE TABLE bp_measurement (
  id               TEXT PRIMARY KEY,       -- uuid v7 (сортируем по времени создания)
  profile_id       TEXT NOT NULL REFERENCES profile(id),
  taken_at_utc     INTEGER NOT NULL,
  tz_offset_minutes INTEGER NOT NULL,
  sys              INTEGER NOT NULL CHECK (sys BETWEEN 50 AND 300),
  dia              INTEGER NOT NULL CHECK (dia BETWEEN 20 AND 200),
  pulse            INTEGER CHECK (pulse IS NULL OR pulse BETWEEN 20 AND 300),
  irregular_pulse  INTEGER NOT NULL DEFAULT 0,           -- флаг аритмии тонометра
  arm              TEXT NOT NULL CHECK (arm IN ('left','right')),
  note             TEXT,                                 -- ≤500 симв., проверка в домене
  source           TEXT NOT NULL DEFAULT 'manual',       -- manual|import
  created_at_utc   INTEGER NOT NULL,
  updated_at_utc   INTEGER NOT NULL
);
CREATE INDEX idx_bp_profile_time ON bp_measurement (profile_id, taken_at_utc);

-- Полнотекстовый поиск по заметкам (FR-2.2); триггеры синхронизации
CREATE VIRTUAL TABLE bp_measurement_fts USING fts5(note, content='bp_measurement', content_rowid='rowid');

-- Версионированные справочные шкалы (FR-4.5): активна одна версия на код
CREATE TABLE reference_scale (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,              -- 'bp_office_esc2018'
  version      TEXT NOT NULL,
  source_label TEXT NOT NULL,
  data_json    TEXT NOT NULL,              -- таблица категорий + примечания
  activated_at_utc INTEGER,
  UNIQUE (code, version)
);

-- Кэш ИИ-резюме (FR-5.7)
CREATE TABLE ai_summary (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profile(id),
  kind            TEXT NOT NULL CHECK (kind IN ('summary')),
  period_start_utc INTEGER NOT NULL,
  period_end_utc   INTEGER NOT NULL,
  context_hash     TEXT NOT NULL,         -- см. 07 §5
  model_id         TEXT NOT NULL,
  model_version    TEXT NOT NULL,
  data_version     INTEGER NOT NULL,      -- счётчик на момент генерации (стейлс)
  content_md       TEXT NOT NULL,
  created_at_utc   INTEGER NOT NULL
);

-- Локальная история чата (UC-04), очищается пользователем
CREATE TABLE chat_message (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profile(id),
  role  TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL
);

-- Настройки (FR-8) и консенты сети (FR-7.3)
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,                    -- 'prefs', 'net.consents', 'flags.overrides'
  value_json TEXT NOT NULL,
  updated_at_utc INTEGER NOT NULL
);

-- Локальная продуктовая аналитика БЕЗ телеметрии (09 §9) и журнал сети (FR-7.1)
CREATE TABLE app_event    (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, at_utc INTEGER NOT NULL);
CREATE TABLE network_event(id TEXT PRIMARY KEY, kind TEXT NOT NULL, endpoint TEXT NOT NULL,
                           status TEXT NOT NULL, bytes INTEGER, at_utc INTEGER NOT NULL);

-- Служебные метаданные
CREATE TABLE meta (
  key TEXT PRIMARY KEY,                    -- 'schema_version', 'data_version'
  value TEXT NOT NULL
);
```

**Почему отдельные таблицы под тип показателя (bp_measurement), а не универсальная EAV-таблица «measurement(metric, value)»:** EAV убивает типовую безопасность, индексы и простоту агрегатов; vision health-log (вес/сон) добавит таблицы `weight_measurement` и т.п. с общим паттерном (taken_at, tz, note, profile_id) и read-model композицией. Generic-слой появится, когда будет ≥2 типа показателей (правило «трижды перед обобщением»). **Компромисс:** при добавлении второго показателя потребуется общая read-model проекция — заложена граница модуля measurement.

## 4. `data_version` — счётчик изменений

Единый монотонный счётчик в `meta`, увеличивается в той же транзакции, что и любая мутация данных. Назначение: дешёвая проверка стейлса резюме (FR-5.7) и инвалидация кэшей UI (broadcast `data:versionBumped`). **Альтернатива** (хешировать все затронутые строки при каждом запросе) дороже и хрупче.

## 5. Миграции

- Вперёд-только, версионируемые (`schema_version` в meta); каждый релиз может повышать версию.
- **Перед миграцией — автоматическая копия БД** (VACUUM INTO + шифрование): история отката = восстановление файла (R-4, EC-25). Down-миграции не пишутся.
- Миграции выполняются до открытия UI, ошибки миграции → экран восстановления из копии (EC-14).

## 6. Шифрование и ключи (интеграция; детали — 08 §2)

- Ключ БД: случайные 32 байта; хранится обёрнутым: (а) по умолчанию — через Electron `safeStorage` (DPAPI/Keychain); (б) с паролем — Argon2id(passphrase) обёртка поверх.
- Файл БД на диске — только SQLCipher; -wal/-shm не переживают корректное закрытие; wipe удаляет db/-wal/-shm/ключ/логи (FR-6.5).
- Копия (FR-6.4): снапшот → шифрованный контейнер + манифест (schemaVersion, appVersion, sha256) — восстановимость между версиями приложения.

## 7. Жизненный цикл и обслуживание

- FTS-синхронизация триггерами; периодический `PRAGMA optimize` + integrity-проверка при старте (NFR-3, EC-14); `VACUUM` — по расписанию простоя.
- Очистка: ai_summary и chat_message — по команде пользователя; app_event — ротация 180 дней; network_event — 90 дней (журнал FR-7.1 сохраняет смысл, размер ограничен).
- Ретеншн измерений не предусмотрен: пользовательские данные живут, пока не удалит пользователь.
