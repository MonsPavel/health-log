# TASK-023: Реализовать KeyVault на safeStorage

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-023 |
| Название | Реализовать KeyVault на safeStorage |
| Фаза | P1 — Вертикальный срез журнала |
| Эпик | 1.2 — Хранилище: SQLCipher сразу |
| Веха | M-1.2 — Зашифрованное хранилище |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1–2 ч |
| Зависимости | TASK-007, TASK-022 |
| Блокирует | TASK-025, TASK-026, TASK-027, TASK-093 |
| Блокируется | TASK-022 |
| Исходная задача дорожной карты | T-1.2.2 (`docs/roadmap/02-phase-1.md`) |

## 2. Цель

Адаптер `KeyVault`: генерация 32-байтного ключа БД, обёртка через Electron `safeStorage` (DPAPI/Keychain), хранение wrapped-ключа в файле `userData/vault.key`, распаковка при старте; обработка потери/порчи файла ключа.

## 3. Бизнес-контекст

NFR-2: данные зашифрованы, ключ не лежит рядом открытым текстом. Пользователь не делает ничего (профиль «без пароля», MVP) — защита работает из коробки. Потеря ключа = невосстановимая потеря данных → сценарий должен быть предсказуем и честен (VAULT/KEY_MISSING → предложение восстановиться из копии, когда копии появятся — TASK-071).

## 4. Технический контекст

- **Архитектура:** security — `docs/architecture/08-security.md` §2 (профиль по умолчанию); крипто-инвентарь — §7.
- **Модуль:** `security` (`src/main/modules/security/adapters/`).
- **Обоснование:** safeStorage — встроенный механизм Electron (DPAPI на Windows, Keychain на macOS, kwallet/gnome-keyring на Linux): ноль своего крипто-кода. keytar устарел. Компромисс Linux: при недоступном keyring safeStorage падает — поведение: явная ошибка с инструкцией (документируется; Windows — целевая платформа MVP).

## 5. Объём

- **Включено:** интерфейс `KeyVault { ensureKey(): Promise<{keyHex: string; created: boolean}>; exportKeyForBackup(): Promise<WrappedKeyBlob>; }` + реализация `SafeStorageKeyVault`: файл `vault.key` = JSON `{v: 1, wrapped: base64, createdUtc}`; `ensureKey`: файла нет → `safeStorage.randomBytes`-генерация? (нет: ключ — `crypto.randomBytes(32)`), `safeStorage.encryptString(keyHex)` → записать; файл есть → decryptString → keyHex; валидация: isEncryptionAvailable() → иначе `VAULT/UNAVAILABLE` с платформенным пояснением; коды `VAULT/KEY_MISSING`, `VAULT/KEY_CORRUPT`; тесты (в том числе on tmp-каталог с mock/real safeStorage в зависимости от окружения — real на CI-ubuntu недоступен → тест с моком safeStorage-интерфейса + ручная real-проверка на Windows).
- **Не включено:** passphrase-обёртка (TASK-093), бэкап ключа наружу (exportKeyForBackup — интерфейс готов, UI в TASK-073 решит, показывать ли; MVP: не показываем).
- **Будущая работа:** ротация ключа (перешифрование БД) — не планируется в MVP.

## 6. Файлы

- **Создать:** `apps/desktop/src/main/modules/security/application/ports/key-vault.ts`; `apps/desktop/src/main/modules/security/adapters/safe-storage-key-vault.ts`; интеграционный тест; константа пути `vault.key` в shared.
- **Изменить:** `packages/kernel` коды VAULT/*; `apps/desktop/src/main/shared/logger` redact-список: `keyHex, wrapped, key`.

## 7. Модель предметной области

`KeyVault`-порт выше; `WrappedKeyBlob = {v: 1, wrappedB64: string, createdUtc: number}`. Инвариант: 32 байта ключа; hex 64 символа lowercase. `created`-флаг нужен для лога/будущего онбординга («хранилище создано»).

## 8. База данных

N/A (ключ потребляется openEncrypted — TASK-022; связь в контейнере TASK-027: vault.ensureKey() → openEncrypted(path, keyHex)).

## 9. Бэкенд

Порядок вызова в P1: контейнер вызывает ensureKey() единожды при старте. Файл ключа: права доступа по умолчанию ОС; на Windows DPAPI привязывает к пользователю — перенос файла на другую машину бессмыслен (это фича: ключ не крадётся вместе с файлом).

## 10. Фронтенд

N/A.

## 11. API

N/A (vault — внутренний; наружу торчат только ошибки VAULT/* через конверт, когда потрогают UI — TASK-095).

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Кейсы: (1) файла нет → создать ключ, записать, вернуть created=true; (2) файл есть и валиден → decrypt, created=false; (3) файл есть, safeStorage не может расшифровать (сменился Windows-пользователь/машина) → VAULT/KEY_CORRUPT; (4) файла нет после того, как БД существует → VAULT/KEY_MISSING (различать по наличию файла БД — параметр `dbExists` в ensureKey) — сообщение пользователю: восстановить из копии (TASK-101); (5) isEncryptionAvailable()=false → VAULT/UNAVAILABLE. Повторный ensureKey в сессии — кэшировать результат (один decrypt за старт).

## 14. Безопасность

Ключ никогда: не логируется (redact TASK-010), не передаётся в renderer, не пишется открытым текстом. `crypto.randomBytes` — CSPRNG. Тест-проверка: файл vault.key не содержит 64-hex-строку ключа (grep-тест на tmp).

## 15. Производительность

Decrypt once per start — наносекунды относительно старта.

## 16–17. Доступность / i18n

N/A (ключи текстов ошибок VAULT — появятся в TASK-095/101; коды стабильны с этого момента).

## 18. Телеметрия

Лог: `vault key ensured (created=false)` — факт, без ключа (redact-тест).

## 19. Стратегия тестирования

Мок `SafeStorageApi` (интерфейс encrypt/decryptString/isEncryptionAvailable) → детерминированные тесты кейсов 1–5 на tmp-каталоге; отдельный smoke с реальным safeStorage — помечен, запускается вручную на Windows (команда `pnpm test:vault-real`, документируется как локальная проверка).

## 20. Критерии приёмки

- [ ] Кейсы 1–5 (§13) зелёные на моках; коды ошибок точные.
- [ ] Grep-тест: wrapped-файл не содержит ключа открытым текстом.
- [ ] Повторный ensureKey в сессии — один decrypt (spy-счётчик).
- [ ] Redact: попытка залогировать keyHex → '[redacted]'.
- [ ] dbExists=true и файл ключа отсутствует → KEY_MISSING (не генерировать новый!).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Потеря ключа пользователем (снос userData) — неизбежная семантика шифрования; mitig: подсказка о копиях (TASK-074) и документация; в ADR-0002/комментарии vault — предупреждение.
- Linux-без-keyring — явная ошибка; целевая платформа MVP — Windows.

## 23. Будущие соображения

TASK-093 добавляет второй слой обёртки (passphrase) поверх той же схемы — порт KeyVault расширяем (метод setPassphrase появился в P6 без breaking).

## 24. Проверка

Автоматически: тесты кейсов зелёные. Ручная (Windows): dev-запуск дважды — второй старт переоткрывает БД без генерации нового ключа; удалить vault.key при существующей БД → при старте ожидаемая ошибка KEY_MISSING. Откат: revert; TASK-024 не начат.
