# Contributing — health-log

Единая точка входа по конвенциям: как собрать проект с нуля, какие команды
выполнять, как оформлять ветки/коммиты/PR, какие правила проверяются механически.
Документ читают, а не хранят — держим его коротким. Изменение команд
сборки/проверок обязано обновлять этот файл в том же PR (см. чек-лист PR).

Целевая платформа продукта — Windows; команды проверены в Git Bash на Windows.

## 1. Требования

- **Node ≥ 20** (`engines` корневого `package.json`). Фактический toolchain и CI —
  **Node 24**: dependency-cruiser 18 (TASK-005) требует `^22||^24||>=26`
  (примечание в `.github/workflows/pr.yml`).
- **pnpm 9** — через corepack; версия зафиксирована полем `packageManager`
  (`pnpm@9.15.9`):

  ```bash
  corepack enable
  corepack prepare pnpm@9.15.9 --activate
  ```

  Windows-нюанс: если Node установлен в `C:\Program Files\nodejs`, первый
  `corepack enable` требует прав администратора (запись shim'ов в каталог Node).

## 2. Быстрый старт

```bash
git clone <url репозитория> health-log
cd health-log
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` собирает `kernel`+`contracts`, поднимает Vite (`127.0.0.1:5183`) и
Electron; открылось окно приложения — окружение рабочее.

Перед отправкой изменений — тот же набор проверок, что и в CI (на свежем checkout
сначала сборка пакетов: typed-lint резолвит `@hl/*` через `dist`-типы, в CI это
шаг «Build packages» до Lint):

```bash
pnpm build
pnpm lint
pnpm check:i18n
pnpm typecheck
pnpm depcruise
pnpm test
```

### Команды корневого `package.json`

| Команда                      | Что делает                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm dev`                   | dev-режим desktop: сборка kernel+contracts, затем Vite + Electron конкурентно           |
| `pnpm build`                 | сборка всех пакетов монорепо (`pnpm -r build`: kernel, contracts, scales-data, desktop) |
| `pnpm build:renderer`        | сборка kernel+contracts, затем vite-сборка рендерера desktop                            |
| `pnpm test`                  | `vitest run` — один прогон всех тестов                                                  |
| `pnpm test:watch`            | vitest в watch-режиме                                                                   |
| `pnpm test:coverage`         | прогон тестов с покрытием (v8)                                                          |
| `pnpm lint`                  | eslint (`--max-warnings 0`, включая правила границ) + `prettier --check`                |
| `pnpm lint:fix`              | авто-исправление eslint + `prettier --write`                                            |
| `pnpm typecheck`             | `tsc -b` по tsconfig kernel, contracts, scales-data, desktop                            |
| `pnpm depcruise`             | dependency-cruiser по `.dependency-cruiser.cjs` — границы зависимостей                  |
| `pnpm check:i18n`            | сверка i18n-ключей исходников с каталогом `ru` (`tools/scripts/check-i18n.mjs`)         |
| `pnpm check-strict`          | фикстурный тест строгости TS: strict + `noUncheckedIndexedAccess` реально действуют     |
| `pnpm test:lint-rules`       | тест зонных правил ESLint на фикстурах (`tools/lint-fixtures`)                          |
| `pnpm test:depcruise-rules`  | тест правил dependency-cruiser на фикстурах (`tools/depcruise-fixtures`)                |
| `pnpm test:pr-workflow`      | тест структурного контракта `.github/workflows/pr.yml`                                  |
| `pnpm test:release-workflow` | тест структурного контракта `.github/workflows/release.yml` (TASK-105)                  |

Отдельно и вручную (Windows — целевая платформа): `pnpm test:vault-real` — real-smoke
KeyVault на безопасном хранилище ОС (Electron safeStorage / DPAPI): создание ключа,
grep-тест «ключа нет открытым текстом в vault.key», расшифровка повторным стартом,
экспорт wrapped-blob. В `pnpm test` и CI не входит: safeStorage на CI-ubuntu
недоступен (TASK-023 §19).

CI использует `pnpm install --frozen-lockfile` (воспроизводимость); локально
`pnpm install` достаточно.

## 3. Ветвление

Ветка от `main` на каждую задачу/фикс; одна ветка — одна задача. Префикс по типу
изменения: `feat/…`, `fix/…`, `docs/…`, `chore/…`. Для задач дорожной карты —
`task/TASK-XXX` (конвенция конвейера реализации; статусы — `docs/tasks/STATUS.md`).

## 4. Коммиты

Conventional Commits; тип — один из: `feat:`, `fix:`, `docs:`, `chore:`, `test:`,
`refactor:`; scope опционален (`fix(ci): …`). Описание на русском; в теле —
«почему», если из diff это не очевидно.

## 5. Pull Request

- Название: `<тип>(scope): TASK-XXX — суть`; в описании — ссылка на TASK-ID
  (`docs/tasks/TASK-XXX-….md`) и что проверено вручную.
- Merge — только при зелёном required check `PR pipeline` (раздел 8).
- Чек-лист PR — дословная копия DoD из `docs/tasks/_TEMPLATE.md` §21 (источник
  истины; правки вносятся там):

  - [ ] Реализация завершена по объёму (§5)
  - [ ] Тесты проходят (`pnpm test`)
  - [ ] Линтер без ошибок (`pnpm lint`, включая правила границ)
  - [ ] Типы без ошибок (`pnpm typecheck`)
  - [ ] Документация обновлена (если затронута)
  - [ ] Архитектура соблюдена (правила 03 §4; depcruise зелёный)
  - [ ] Производительность проверена (если применимо)
  - [ ] Безопасность проверена (если применимо)
  - [ ] Нет известных регрессий (полный тест-набор зелёный)
  - [ ] Готово к слиянию (PR по конвенциям CONTRIBUTING)

  Плюс один пункт-хвост этого репозитория (TASK-015 §22): команды
  сборки/проверок менялись → **`CONTRIBUTING.md` обновлён в этом же PR**.

## 6. Правила (проверяются механически)

### 6.1 Границы импортов

Источник истины — `docs/architecture/03-modules.md` §4. Выжимка: `kernel` и
`scales-data` не зависят ни от чего; `contracts` — только kernel; domain модуля —
kernel + типы contracts (type-only); application — свой domain; adapters — свои
порты и внешние npm; renderer — **только** contracts через preload-мост. Импорт
чужих `domain/`, `application/`, `adapters/` запрещён — только `index.ts` модуля
и события шины. Правило = тест: нарушение валит `pnpm lint`
(eslint-plugin-boundaries) и `pnpm depcruise`; сами правила покрыты тестами
`pnpm test:lint-rules` / `pnpm test:depcruise-rules`.

### 6.2 i18n

Тексты пользователя — только ключи каталога (`common.*`, `errors.*`), литералом
в `t()`; динамические ключи запрещены. `pnpm check:i18n` сверяет использованные
ключи с каталогом `ru`: отсутствующий ключ — ошибка, неиспользуемый ключ
`common` — тоже; `errors` вне unused-проверки (приходит динамически по
messageKey из contracts). Каталог — только `ru` (TD-4); EN — пост-MVP.

### 6.3 PHI в логах

Красный список полей (`apps/desktop/src/main/shared/logger/redact.ts`,
`PHI_KEYS`): `sys`, `dia`, `pulse`, `note`, `content`, `question`, `answer`,
`measurement`, `measurements` — и любые объекты с этими ключами на любой глубине
вложенности. В логи они не попадают никогда: logger цензурирует значение целиком
(`[redacted]`). Логируем операции и исходы, не содержимое:
`addMeasurement durationMs=12 flags=[typo] critical=false` — можно;
`addMeasurement 125/82 «болит голова»` — нельзя. Новое чувствительное поле
домена = правка `PHI_KEYS`/`PHI_REDACT_PATHS` + тест.

### 6.4 Сеть

Сейчас сети нет вовсе. С P5 (TASK-075) весь исходящий трафик — только через
**EgressGateway** (`docs/architecture/08-security.md` §5): операция из белого
списка, выданное согласие, запись в журнал; прямые `fetch`/`net` вне гейтвея
запрещены линтером. Телеметрия наружу запрещена всегда (FR-7.2).

### 6.5 Тесты

Обязательные уровни (`docs/architecture/10-delivery.md` §1):

- **домен** — всегда: property-тесты (fast-check) и golden-фикстуры, покрытие
  ≥90% (NFR-10);
- **use case** — всегда: на фейках портов, покрытие ≥85%;
- **UI** — критические пути (ввод измерения, диалоги подтверждения, флаги).

Плюс обязательны интеграции (SQLite, миграции, крипто-контур — во временных
каталогах) и контракты IPC (zod-схемы contracts).

### 6.6 Безопасность изменений (ключи / копии / сеть)

Чек-лист к PR, затрагивающим ключи, копии или сеть (TASK-022/023/070/071/075/093):

- [ ] roundtrip-тесты обязательны: ключ → обёртка/копия → восстановление читается;
- [ ] в логах и ошибках нет PHI (красный список — §6.3);
- [ ] сеть только через EgressGateway; есть тест «мимо гейтвея — нельзя».

## 7. Definition of Done задачи

Канонический DoD — `docs/tasks/_TEMPLATE.md` §21 (тот же список — в чек-листе
PR, раздел 5). Задача выполнена, только когда зелёный её раздел «Проверка» (§24
спеки задачи), а не «код написан» (правила карты — `docs/roadmap/README.md`).

## 8. Required checks main и правило исключений

- Required check ветки `main` (branch protection): **`PR pipeline`** — job из
  `.github/workflows/pr.yml` (lint → check:i18n → typecheck → depcruise →
  test:coverage → build:renderer; бюджет прогона ≤5 мин).
- Merge в `main` — только при зелёном `PR pipeline`: «зелёный main = всегда
  собираемый продукт» (`docs/architecture/10-delivery.md` §3).
- Исключение — **admin-merge только для починки самого CI**: сломанный пайплайн
  иначе блокирует собственный фикс; во всех остальных случаях — зелёный PR.
- Версии actions пинуются по мажорной; обновления — рекомендация dependabot
  (TASK-014 §22).

## 9. Карта документации

| Документ                        | О чём                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `docs/README.md`                | SRS (docs/01–10) и глоссарий терминов                                                           |
| `docs/architecture/01–10`       | архитектура; границы — `03-modules.md` §4, сеть — `08-security.md` §5, CI — `10-delivery.md` §3 |
| `docs/architecture/audits/`     | сетевой аудит релизов: шаблон `audit-template.md` + фактические отчёты (TASK-106)               |
| `docs/release/notes-example.md` | пример заполненных release notes по шаблону `.github/release-template.md` (TASK-114)            |
| `docs/a11y-keyboard.md`         | клавиатурная ревизия потоков (TASK-108) + чек-лист ручного прогона                              |
| `docs/a11y-nvda.md`             | NVDA-чеклист 7 сценариев + контраст-аудит токенов (TASK-109)                                    |
| `docs/roadmap/README.md`        | правила карты: новая работа вне карты = сначала ревизия карты                                   |
| `docs/tasks/_TEMPLATE.md`       | канонический шаблон задачи; §21 — DoD                                                           |
| `docs/tasks/STATUS.md`          | реестр статусов реализации                                                                      |
| `CONTRIBUTING.md`               | этот документ                                                                                   |

## 10. Релизный прогон (доступность — обязательный шаг)

Мажорный/минорный релиз включает ручной a11y-прогон ПО ДЖОЙНАМИ КОДА (NFR-6;
автоматизация скринридеров недостоверна — решение TASK-109 §5):

1. **NVDA-чеклист** — `docs/a11y-nvda.md` §12: 7 сценариев на фикстурных данных
   (ввод, история, динамика+таблица, ИИ-стримы, отчёты, копии, настройки+блокировка),
   обе темы, три масштаба; отметки PASS/FAIL — в PR релиза.
2. **Клавиатурный чек-лист** — `docs/a11y-keyboard.md` §10 (9 пунктов, человек
   только с клавиатурой).
3. **Контраст-гейт** — `node tools/scripts/contrast-audit.mjs`: exit 0
   («0 пар ниже порога», §20 AC1) на момент релизного тега.

Провал любого пункта — блокер релиза (исправление или строка в реестре отложенных
`docs/a11y-deferred.md` с обоснованием).

## 11. Релиз (тег-пайплайн, TASK-105)

Пайплайн — `.github/workflows/release.yml`, триггер — пуш тега `v*`
(Windows-runner): lint → typecheck → depcruise → unit/integration → сборка +
подпись установщика (секреты release-окружения — `docs/dev/certificates.md` §2.1)
→ самопроверка подписи → полный E2E (все спеки) → крэш-тест (N=10) → size-гейт
(≤200 МБ) → **draft release** с артефактами (установщик, `stable.yml` updater'а,
blockmap) и заготовкой notes. Протокол гейтов — таблица в Job Summary; от тега до
draft — без ручных шагов; полный eval на модели в пайплайн не входит (ручной
предрелизный чеклист; ночью 1B — `eval-nightly.yml`).

Шаги ПОСЛЕ draft (публикация — всегда ручная, арх. 10 §3):

1. Открыть draft в Releases и заполнить notes по шаблону
   `.github/release-template.md` (TASK-114; пример заполнения —
   `docs/release/notes-example.md`): «Что нового»/«Исправлено» — редактура
   changelog-коммитов (сгенерированы пайплайном) простым языком — notes не сырой
   git-лог; «Версии внутри» — из «О приложении» ЭТОЙ сборки (приложение/схема
   БД/шкала/модель — канал `app/meta`, TASK-100): источник правды — собранная
   сборка, не dev-машина; «Проверки» — ссылки на аудит/perf/DoD-документы;
   служебный чек-лист шаблона пройти и удалить перед публикацией.
2. **Сетевой аудит релизной сборки (AC-4.1, TASK-106)** — обязателен к каждому
   релизу: прогон сценариев S1–S4 по шаблону
   `docs/architecture/audits/audit-template.md` скриптом
   `node tools/scripts/net-audit.mjs --scenario <S1|S2|S3|S4>` (OS-мониторинг
   соединений + сверка с журналом «Приватности»); заполненный отчёт коммитится в
   `docs/architecture/audits/` (первый — `2026-Q1-mvp.md`), ссылка на него — в
   notes релиза. Расхождение «журнал ↔ факт» — блокер релиза.
   Локальные сборки для аудита (`electron-builder --dir --publish never`)
   сами получают `resources/app-update.yml` (TASK-120, наблюдение F3 аудита
   2026-Q1): afterPack-хук дописывает фид updater'а из publish-блока конфига,
   если builder его не записал (nsis-цель — пишет сам builder, хук не мешает) —
   добавлять файл вручную, как в аудите 2026-Q1, больше не нужно.
3. Приложить отчёты: perf-отчёт релиза (`docs/release/perf-mvp.md`, TASK-111) и
   DoD-чеклист выпуска (`docs/release/mvp-dod.md`, TASK-112) — обе ссылки
   попадают в секцию «Проверки» notes шага 1.
4. Прогнать ручные чек-листы (для мажорных/минорных релизов; провал любого —
   блокер): NVDA-чеклист (`docs/a11y-nvda.md` §12, TASK-109) и клавиатурный
   (`docs/a11y-keyboard.md` §10) — раздел 10; сетевой аудит — шаг 2.
5. Сверить артефакты: подпись `Valid` (`Get-AuthenticodeSignature`), версия
   установщика = тегу; пройти служебный чек-лист шаблона notes (полнота §13
   TASK-114: версии 4 строк, аудит-линк, дисклеймер, известные проблемы; гигиена
   §14: без путей пользователя/секретов/сырых логов); для мажорных/минорных —
   полный eval. Сверка draft с шаблоном (§19/§24 TASK-114) — скриптом:
   `node tools/scripts/verify-release-notes.mjs <тег>` — заготовка содержит все
   секции и `{{}}`-плейсхолдеры шаблона (шаблон обязан быть в коммите тега —
   иначе скрипт требует перевыставить тег, урок rc.0); после заполнения —
   `node tools/scripts/verify-release-notes.mjs <тег> --filled` перед
   «Publish release».
6. Опубликовать кнопкой «Publish release» — permalink «latest» update-feed'а
   (`electron-builder.yml` → publish.url) подхватит выпуск.
7. Гигиена тегов: после публикации стабильного релиза удалить его rc-теги
   (`git push origin --delete vX.Y.Z-rc.N` — теги rc-прогонов не оставляем рядом
   с финальным тегом); пробный тег после отладки удалить (§24 спеки — тег и
   rc-релиз); при устойчивом сбое workflow отключить (откат §24).

Reminder (календарный, TD-замечание 104): при каждом релизе сверять срок
действия сертификата подписи — напоминание за 60 дней до NotAfter
(`docs/dev/certificates.md` §6); истечение без продления = новые сборки не
подписываются, выпуск останавливается.

Контракт пайплайна проверяется локально: `pnpm test:release-workflow`; контракт
шаблона notes и примера — `tools/scripts/release-template.test.ts` (входит в
`pnpm test`).

### 11.1 Beta-канал (TASK-107)

Модель — **один артефакт, разные фиды**: каждая сборка кладёт в dist оба
канальных файла — `stable.yml` (первая запись `publish`) и `beta.yml` (вторая;
builder пишет её в `dist/generic/` — отдельный glob в release.yml). Боевой
`app-update.yml` собирается из ПЕРВОЙ записи: stable-клиент по умолчанию читает
`stable.yml`; beta-клиент (настройки → «Обновления» → канал `beta`) запрашивает
`beta.yml` (`updater.channel`; переключение применяется следующей проверкой,
авто-перепроверки нет). Подпись у каналов одна — тот же установщик (§14 107).

Порядок публикации с β-прогоном (пре-релизный тег `vX.Y.Z-beta.N`/`-rc.N`):

1. rc-тег → пайплайн §11 → draft; инструкционная проверка (§20-4 107): в assets
   draft'а есть `beta.yml` (и `stable.yml`) rc-версии.
2. Notes и сетевой аудит — как в шагах 1–2 §11 (β-релиз проходит те же гейты).
3. Опубликовать draft **как pre-release** (галка «Set as a pre-release»):
   permalink «latest» остаётся на прошлом стабильном релизе — stable-клиенты
   изолированы от beta (§5 «stable не видит beta»).
4. β-прогон: чтобы beta-клиенты увидели rc через permalink, добавить `beta.yml`
   и установщик rc ассетами **последнего полного релиза** (канальные файлы
   отдаются только «latest»-релизом; stable-клиенты того же релиза читают
   `stable.yml` и ничего не замечают). Для узкой β-группы допустимо раздать
   установщик вручную — шаг 4 тогда пропускается.
5. Promote в stable (проверка β-группой пройдена): снять галку pre-release у
   rc-релиза — он становится «latest», и его `stable.yml` (тот же артефакт!)
   начинает отдаваться всем; пере-подпись не нужна — меняется только фид.
   После promote `beta.yml` этого релиза = stable-версии (beta-клиент «догнал»).

Даунгрейд `beta`→`stable` на уже установленной rc-версии невозможен (updater не
откатывает) — UI предупреждает при переключении: возврат со следующим
стабильным релизом (§13 107).
