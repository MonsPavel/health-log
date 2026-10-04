# Подпись Windows-сборок и секреты подписи (TASK-104)

Установщик и updater: неподписанный exe — паника антивирусов/SmartScreen и блокировка
автообновлений (updater проверяет подпись издателя — NFR-11). Решение по типу
сертификата (OV против EV) — ADR-0005
(`docs/architecture/adr/0005-code-signing.md`); здесь — рабочий процесс.

## 1. Что покупаем

- **Тип:** Code Signing Certificate, класс **OV** (Organization/Individual Validation),
  без токена — выдаётся файлом `.pfx` (PKCS#12). Сравнение с EV — в ADR-0005.
- **Где купить (любой из аккредитованных CA; цена ориентировочно 20–120 €/год):**
  - Certum — «Open Source Code Signing» (простая проверка личности, дружелюбен к
    индивидуальным разработчикам);
  - SSL.com / Sectigo / DigiCert — OV individual/organization через онлайн-проверку
    (документы: удостоверение личности, для organization — регистрация компании).
- **Срок выпуска:** от нескольких минут (Certum OSS) до 3–5 рабочих дней (OV org).
- **Срок действия:** 1–3 года (см. «Продление», §6).
- **Формат выдачи:** `.pfx`-файл + пароль от него (задаётся при выпуске). Если CA
  отдаёт только токен/HSM — это меняет пайплайн на подпись-сервис, см. ADR-0005
  (рисковая заметка) — такой вариант в MVP не используется.

## 2. Куда положить секреты

Секреты подписи: `.pfx` + пароль. В конфиге их НЕТ и быть не должно (тест
`update-feed.test.ts → «секреты подписи не в конфиге»` это сторожит) — только env.

electron-builder (26.x) читает env сам:

| Переменная | Значение |
|---|---|
| `WIN_CSC_LINK` | путь к `.pfx` ИЛИ его base64 (data) — для CI кладём base64 |
| `WIN_CSC_KEY_PASSWORD` | пароль `.pfx` |

Без этих переменных сборка продолжается **неподписанной** (поведение TASK-034) —
локальная dev-сборка `pnpm dist` не требует секретов. Пароль никогда не попадает в
логи (electron-builder печатает только факт подписи и имя сертификата).

### 2.1 CI (GitHub — секреты в release-окружении, TASK-105)

1. `base64 -w0 certificate.pfx > certificate.pfx.b64` (Git Bash; без переносов строк).
2. Репозиторий → Settings → Environments → **release** (создаётся автоматически
   первым прогоном `.github/workflows/release.yml` по тегу; при необходимости —
   вручную) → Add environment secret:
   - Имя `WIN_CSC_LINK`, значение — содержимое `certificate.pfx.b64`;
   - Имя `WIN_CSC_KEY_PASSWORD`, значение — пароль `.pfx`.
3. Секреты живут только в release-окружении job'а релизного workflow
   (`environment: release`, TASK-105 §14) — пайплайн подписи изолирован туда;
   триггер workflow — только пуш тега `v*`, PR-workflow секреты не получает
   (OWASP CI/CD: код PR не исполняется в привилегированном контексте).
4. Самопроверка пайплайна (§14 TASK-105): шаг «Sign self-check» гоняет
   `Get-AuthenticodeSignature` по установщику ДО attach — `NotSigned`/
   `HashMismatch` → красный гейт, draft не создаётся. `NotTrusted` допускается
   только для пробных тегов с test-cert (§4 ниже); боевой релиз обязан быть
   `Valid` (пункт предрелизного чеклиста, TASK-114). Публикация всегда ручная:
   electron-builder вызывается с `--publish never` — черновик создаёт
   release.yml, выпуск — кнопкой в Releases. Нюанс test-cert в CI (урок
   прогона 6 живой приёмки): на чистом раннере цепочка самоподписанного корня
   даёт `UnknownError` (ревокационная проверка падает раньше, чем «untrusted
   root»), поэтому шаг самопроверки при наличии секретов сам импортирует
   публичную часть test-PFX в `LocalMachine\Root` (admin-контекст раннера —
   без диалога crypt32, который показывается на `CurrentUser\Root` локально,
   §4) — и статус становится `Valid`, как в локальном прецеденте §20-1 104.
5. `.pfx`/base64-файл после загрузки в секреты удалить; в git они не попадают —
   корневой `.gitignore` исключает `*.pfx`, `*.pem`.

### 2.2 Локально (контрольная подпись перед релизом)

Env-файл **вне git** — соглашение репозитория `*.local` (уже в `.gitignore`):

```bash
# apps/desktop/cert.env.local  (создать вручную, НЕ коммитить)
export WIN_CSC_LINK='D:/secrets/health-log-codesign.pfx'   # или base64 одной строкой
export WIN_CSC_KEY_PASSWORD='…'
```

Контрольная подпись:

```bash
source apps/desktop/cert.env.local && pnpm dist
```

Локальная сборка (в т.ч. `--dir --publish never` для аудитов) сама получает
`resources/app-update.yml` (TASK-120): если builder его не записал (нет nsis-цели),
afterPack-хук дописывает фид updater'а из publish-блока конфига — содержимое
совпадает с builder-написанным файлом байт-в-байт (юнит:
`scripts/after-pack-app-update.test.mjs`). Раньше файл добавляли вручную
(наблюдение F3 аудита 2026-Q1, §11 CONTRIBUTING).

## 3. Контрольная подпись после получения сертификата (§13, шаг 3)

1. **publisherName** в `apps/desktop/electron-builder.yml` (два места —
   `publish.publisherName` и `win.signtoolOptions.publisherName`) должен совпадать с
   Subject DN нового сертификата. Посмотреть DN:
   `powershell (Get-PfxCertificate path\to\cert.pfx).Subject` →
   привести к виду `CN=…, O=…, C=…` (порядок компонентов не важен — updater сравнивает
   как набор). Обновить оба места; конфиг-тест
   `update-feed.test.ts → «publisherName задан и совпадает…»` проверит паритет.
2. `source apps/desktop/cert.env.local && pnpm dist` — в логе electron-builder ищем
   `signing` (имя сертификата) и вызов signtool с **`/fd sha256`** и
   **`/tr http://timestamp.digicert.com`** (RFC3161-timestamp — контроль §13:
   наличие tsa-URL в вызове; подпись с ним переживает истечение сертификата).
3. Проверка штатной проверкой Windows:

   ```powershell
   Get-AuthenticodeSignature "dist/Health Log Setup <версия>.exe"
   # Status: Valid; SignerCertificate.Subject = publisherName из конфига
   ```

4. Обновить сводку в ADR-0005 (фактический CA, DN, срок действия).

## 4. Test-cert: локальная механика до получения боевого сертификата

Механика проверена самоподписанным сертификатом (без закупки): тест
`apps/desktop/tests/e2e/helpers/update-feed.test.ts` создаёт CodeSigningCert
(New-SelfSignedCertificate), подписывает фикстуру (signtool /fd sha256), проверяет
Get-AuthenticodeSignature и гоняет **боевой NsisUpdater** по локальному http-фиду.

- Автоматически (без шага доверия): позитив фида (downloadUpdate → update-downloaded,
  §20-3), подмена байта → `ERR_CHECKSUM_MISMATCH` (§20-4), неподписанный exe →
  `ERR_UPDATER_INVALID_SIGNATURE` (§14).

  ```bash
  pnpm exec vitest run apps/desktop/tests/e2e/helpers/update-feed.test.ts --project desktop-e2e
  ```

- **§20-1 (подпись = Valid)**: Windows требует интерактивного подтверждения на импорт
  тестового корня в `Cert:\CurrentUser\Root` — защита от тихой установки корней
  заложена в саму crypt32: диалог показывают ВСЕ пути записи в Root —
  `Import-Certificate`, `certutil -user -addstore` и даже прямой API-вызов
  `CertAddCertificateContextToStore` (проверено на этой границе; реестровые
  обходные пути игнорируются движком доверия). Шаг не автоматизируется —
  одна команда в присутствии человека:

  ```bash
  pnpm test:cert
  ```

  На диалог «Security Warning» ответить **Да**; тест очистит хранилища после
  прогона и напечатает в лог строку-доказательство вида

  ```
  [TASK-104 §20-1] test-cert подпись: Status=0 (Valid), Subject=CN=…, file=…
  ```

  — её в PR-описание (§20-1 «лог проверки в PR-описании»). Без человека тест
  честно `skip` с этой же инструкцией. Если в хранилище остался мусор от
  прерванного прогона — удалить:
  `certmgr.msc → Личное/Доверенные корневые → CN=Health Log Test Signing <pid>`.

## 5. signtool вручную (если нужен вне electron-builder)

electron-builder находит signtool Windows SDK сам; при необходимости указать свой:
env `SIGNTOOL_PATH` (та же переменная читает и electron-builder). Вызов с
обязательными флагами:

```bash
signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com \
  /f cert.pfx /p "$WIN_CSC_KEY_PASSWORD" "dist/Health Log Setup <версия>.exe"
```

## 6. Продление

- Сертификат истекает — НОВЫЕ сборки перестанут подписываться; уже выпущенные
  подписи остаются валидными благодаря RFC3161-timestamp (§13). Календарное
  напоминание за 60 дней до NotAfter — в release-процессе (TASK-114).
- Продлённый сертификат (новый файл/DN) → повторить §3 (подмена секрета,
  publisherName по DN, контрольная подпись, сводка в ADR-0005).
- Истечение/отзыв боевого сертификата при работающих у пользователей сборках:
  пользователи с включёнными обновлениями получат последний валидный релиз;
  выпуск после истечения без продления невозможен.
