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

| Команда                     | Что делает                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm dev`                  | dev-режим desktop: сборка kernel+contracts, затем Vite + Electron конкурентно           |
| `pnpm build`                | сборка всех пакетов монорепо (`pnpm -r build`: kernel, contracts, scales-data, desktop) |
| `pnpm build:renderer`       | сборка kernel+contracts, затем vite-сборка рендерера desktop                            |
| `pnpm test`                 | `vitest run` — один прогон всех тестов                                                  |
| `pnpm test:watch`           | vitest в watch-режиме                                                                   |
| `pnpm test:coverage`        | прогон тестов с покрытием (v8)                                                          |
| `pnpm lint`                 | eslint (`--max-warnings 0`, включая правила границ) + `prettier --check`                |
| `pnpm lint:fix`             | авто-исправление eslint + `prettier --write`                                            |
| `pnpm typecheck`            | `tsc -b` по tsconfig kernel, contracts, scales-data, desktop                            |
| `pnpm depcruise`            | dependency-cruiser по `.dependency-cruiser.cjs` — границы зависимостей                  |
| `pnpm check:i18n`           | сверка i18n-ключей исходников с каталогом `ru` (`tools/scripts/check-i18n.mjs`)         |
| `pnpm check-strict`         | фикстурный тест строгости TS: strict + `noUncheckedIndexedAccess` реально действуют     |
| `pnpm test:lint-rules`      | тест зонных правил ESLint на фикстурах (`tools/lint-fixtures`)                          |
| `pnpm test:depcruise-rules` | тест правил dependency-cruiser на фикстурах (`tools/depcruise-fixtures`)                |
| `pnpm test:pr-workflow`     | тест структурного контракта `.github/workflows/pr.yml`                                  |

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

| Документ                  | О чём                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `docs/README.md`          | SRS (docs/01–10) и глоссарий терминов                                                           |
| `docs/architecture/01–10` | архитектура; границы — `03-modules.md` §4, сеть — `08-security.md` §5, CI — `10-delivery.md` §3 |
| `docs/roadmap/README.md`  | правила карты: новая работа вне карты = сначала ревизия карты                                   |
| `docs/tasks/_TEMPLATE.md` | канонический шаблон задачи; §21 — DoD                                                           |
| `docs/tasks/STATUS.md`    | реестр статусов реализации                                                                      |
| `CONTRIBUTING.md`         | этот документ                                                                                   |
