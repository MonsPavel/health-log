/**
 * TASK-006 §5: реестр кодов ошибок. Начальный состав — три кода из §5; расширяется
 * последующими задачами: код добавляется в массив, строковый union выводится из него
 * автоматически (единственный источник истины). Формат кода: ДОМЕН/ПОДКОД.
 */
export const ERROR_CODES = [
  'APP/INTERNAL',
  'APP/NOT_IMPLEMENTED',
  'VALIDATION/FAILED',
  // TASK-016 §5: домен Measurement — VO давления/пульса (диапазоны; sys ≤ dia).
  'MEASUREMENT/INVALID_RANGE',
  'MEASUREMENT/SYS_LE_DIA',
  // TASK-017 §5: домен Measurement — агрегат BpMeasurement (время не в будущем;
  // заметка длиннее 500 символов).
  'MEASUREMENT/FUTURE_TIME',
  'MEASUREMENT/NOTE_TOO_LONG',
  // TASK-021 §5/§7: порт репозитория измерений — update/delete несуществующего id
  // (ошибка значением Result, не throw).
  'MEASUREMENT/NOT_FOUND',
  // TASK-022 §7/§13: SQLCipher-стек, открытие БД — неверный ключ (маппинг
  // SQLITE_NOTADB), файл занят другим процессом (SQLITE_BUSY/LOCKED; защита —
  // single-instance TASK-012), повреждение (PRAGMA quick_check при старте;
  // полный сценарий восстановления — TASK-100/101).
  'STORAGE/BAD_KEY',
  'STORAGE/LOCKED',
  'STORAGE/CORRUPT',
  // TASK-023 §5/§13: хранилище ключа БД (KeyVault на safeStorage): файла ключа нет при
  // существующей БД — потеря данных, восстановление из копии (TASK-101); файл есть, но
  // safeStorage не может расшифровать (сменился Windows-пользователь/машина) или файл
  // повреждён; шифрование ОС-хранилища недоступно (Linux без keyring — явная ошибка).
  'VAULT/KEY_MISSING',
  'VAULT/KEY_CORRUPT',
  'VAULT/UNAVAILABLE',
  // TASK-093 §5/§13/§19: двойная обёртка ключа (Argon2id + AES-256-GCM) — неверный
  // пароль детектируется по auth-tag GCM (БД не открывается); обращение к БД vault-а
  // в режиме passphrase до unlock — состояние locked (§9/§12; управление — TASK-094).
  'VAULT/WRONG_PASSPHRASE',
  'VAULT/LOCKED',
  // TASK-024 §5/§20: migration runner — сбой миграции (rollback, схема осталась на
  // предыдущей версии; params {version}); БД записана более новой версией приложения
  // (schema_version > известного) — явная ошибка «обновите приложение» (EC-25).
  'STORAGE/MIGRATION_FAILED',
  'STORAGE/DB_NEWER_THAN_APP',
  // TASK-026 §5/§9: SQLite-адаптер репозитория измерений — нарушение ограничений БД
  // (SQLITE_CONSTRAINT_*: UNIQUE/NOT NULL/FK/CHECK) и прочие ошибки выполнения SQL
  // (наружу только код, детали в cause — §14).
  'STORAGE/CONSTRAINT',
  'STORAGE/FAILED',
  // TASK-070 §5/§13: Data Care — создание копии: сбой операции (VACUUM INTO,
  // шифрование, запись контейнера — например, исчерпание диска; детали в cause)
  // и отмена пользователем (отказ диалога сохранения — ожидаемый исход, §13).
  'BACKUP/FAILED',
  'BACKUP/CANCELED',
  // TASK-071 §5/§13: Data Care — восстановление из копии: копия создана более новой
  // схемой БД, чем текущая (миграций «назад» нет — «обновите приложение», EC-25);
  // неверный пароль копии (GCM-неудача криптографически неотличима от порчи —
  // текст сообщения покрывает обе причины, §14 backup-crypto); отказ целостности —
  // контейнер не разбирается (магия/манифест) или sha256 снапшота не сошёлся (AC-4).
  'BACKUP/DB_NEWER',
  'BACKUP/WRONG_PASSPHRASE',
  'BACKUP/INTEGRITY',
  // TASK-072 §5/§11: Data Care — полное удаление данных: сбой операции (в т.ч.
  // частичный unlink — что осталось, в params/cause: наружу счётчик, полный список
  // remaining в памяти main), отказ двухшаговости (execute без plan) и расхождение
  // состояния с моментом plan.
  'WIPE/FAILED',
  // TASK-063 §5/§9: use case ExportCsv (модуль reporting) — неуспех сборки выгрузки
  // (сбой чтения журнала при обходе пачками; причина — в cause, наружу только код).
  'EXPORT/FAILED',
  // TASK-068 §5/§7: use case BuildPdfReport (модуль reporting) — пустой период не
  // формируется (count=0, §9) и отказ рендера/сборки payload (воркер/чтение read
  // models; причина — в cause, наружу только код).
  'REPORT/EMPTY_PERIOD',
  'REPORT/RENDER_FAILED',
  // TASK-075 §5/§9/§13: EgressGateway — операция вне белого списка EgressPolicy
  // или без согласия пользователя (prefs.netConsents): БЫСТРЫЙ отказ ДО сети
  // (params {op}), blocked-запись в журнале network_event. Видимый, не тихий (D11,
  // арх. 08 §5).
  'NET/BLOCKED_BY_POLICY',
  // TASK-076 §9/§13/§14/§5: llm-worker (UtilityProcess) — вторая генерация при активной
  // (BUSY, §9 «код в реестре»); краш/зависание воркера во время генерации — активный
  // requestId отклоняется клиентом (§13); заглушка движка до TASK-077 (§5 «engine:
  // not-configured» — мост для 077); файла модели нет (§14 — путь валидируется на
  // main-стороне ДО передачи воркеру).
  'AI/BUSY',
  'AI/WORKER_CRASHED',
  'AI/ENGINE_NOT_CONFIGURED',
  'AI/MODEL_NOT_FOUND',
  // TASK-080 §5/§9/§13: ModelStore — недостаток места на диске (sizeBytes + 100 МБ
  // запас; проверка до старта и перед финальным rename), расхождение sha256 после
  // полной загрузки (.part удаляется — недокачанное не притворяется готовым, §3),
  // вторая загрузка при активной (одна активная загрузка, §9).
  'AI/DISK_FULL',
  'AI/HASH_MISMATCH',
  'AI/DOWNLOAD_BUSY',
] as const;

/** Машинный код ошибки приложения (§7). */
export type ErrorCode = (typeof ERROR_CODES)[number];
