# 03. Модули, структура папок и пакетов

**Статус:** черновик v0.1 · 2026-09-24

---

## 1. Диаграмма модулей (главный процесс)

```
                        ┌───────────────────────────────────────────────────┐
                        │                main/app (bootstrap)               │
                        │   container (composition root) · lifecycle ·      │
                        │   single-instance lock · ipc-регистрация          │
                        └───┬──────────┬──────────┬──────────┬─────────────┘
                            │          │          │          │
      ┌─────────────┐  ┌────▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼──────────┐
      │ ipc/        │  │measure- │ │analytics│ │ai-     │ │reporting     │
      │ (тонкие     │  │ment     │ │         │ │insight │ │              │
      │  хендлеры)  │  └────┬────┘ └───┬────┘ └───┬────┘ └───┬──────────┘
      └─────────────┘       │          │          │          │
                            ▼          ▼          ▼          ▼
                     [module-internal: domain → application → adapters]
                            │          │          │          │
      ┌─────────────┐  ┌────▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼──────────┐
      │ events/     │◀─│data-care│ │settings│ │security│ │platform-     │
      │ (шина +     │  │         │ │&profile│ │        │ │services      │
      │  broadcast) │  └─────────┘ └────────┘ └────────┘ │(egress,jobs, │
      └─────────────┘                                    │ updates,flags│
                        ┌────────────────────┐           └──────────────┘
                        │ llm-worker/        │  отдельный UtilityProcess
                        │ (UtilityProcess)   │  общается только с ai-insight
                        └────────────────────┘  через MessagePort
```

Стрелки = разрешённые зависимости (сверху вниз/к портам). Любая перекрёстная связь между модулями — только через публичный `index.ts` модуля или события шины.

## 2. Модули и их публичные интерфейсы

| Модуль | Публикует (для других модулей/UI) | Скрывает |
|---|---|---|
| measurement | use cases: AddMeasurement, UpdateMeasurement, DeleteMeasurement, ListMeasurements; read model ListByPeriod; события changed | схему таблиц, эвристики опечаток |
| analytics | use cases: GetPeriodStatistics, GetTrendSeries; read models | формулы, классификатор, кэш шкал |
| ai-insight | use cases: GenerateSummary (stream), AskChat, CancelGeneration, ListModels, DownloadModel, DeleteInsights; события token/status | LLM-воркер, промпты, пост-фильтры, ModelStore |
| reporting | use cases: BuildPdfReport, ExportCsv, ExportJson | шаблоны PDF, рабочий пул |
| data-care | use cases: CreateBackup, RestoreBackup, WipeAllData, (пост-MVP ImportCsv) | криптоконтейнер копии, VACUUM INTO |
| settings&profile | use cases: Get/UpdatePreferences, GetProfile, (пост-MVP CRUD профилей) | способ хранения настроек |
| security | use cases: Unlock, SetPassphrase, LockNow, GetVaultState; события lock | KeyVault, Argon2id, обёртка ключа |
| platform-services | use cases: CheckUpdates, GetPrivacyJournal, Get/SetFlags; события update/net | EgressGateway, планировщик, electron-updater |

## 3. Структура пакетов (monorepo, pnpm workspaces)

```
health-log/
├─ apps/
│  └─ desktop/                     # Electron-приложение
│     ├─ src/
│     │  ├─ main/                  # главный процесс
│     │  │  ├─ app/                #   bootstrap, lifecycle, single-instance
│     │  │  ├─ ipc/                #   регистрация хендлеров (валидация + делегирование)
│     │  │  ├─ events/             #   шина событий + broadcast в рендерер
│     │  │  └─ container.ts        #   composition root (ручной DI)
│     │  ├─ modules/               # модули = контексты (см. §2)
│     │  │  ├─ measurement/
│     │  │  │  ├─ domain/          #   сущности, VO, инварианты, сервисы
│     │  │  │  ├─ application/     #   use cases + порты (интерфейсы)
│     │  │  │  ├─ adapters/        #   sqlite-репозиторий, эвристики-инфра
│     │  │  │  └─ index.ts         #   публичный API модуля
│     │  │  ├─ analytics/          #   (та же внутренняя структура)
│     │  │  ├─ ai-insight/
│     │  │  ├─ reporting/
│     │  │  ├─ data-care/
│     │  │  ├─ settings-profile/
│     │  │  ├─ security/
│     │  │  └─ platform-services/
│     │  ├─ llm-worker/            # входная точка UtilityProcess (тонкая)
│     │  └─ shared/                # Result, AppError, EventBus, logger-интерфейс
│     ├─ src-renderer/             # React-приложение (см. 06)
│     └─ tests/e2e/                # Playwright Electron
├─ packages/
│  ├─ kernel/                      # Instant, Result, AppError, константы (порог «мало данных»)
│  ├─ contracts/                   # IPC DTO + zod-схемы + коды ошибок + типы событий
│  └─ scales-data/                 # версионируемые справочные шкалы (данные, не код)
├─ tools/
│  ├─ eval/                        # «красный набор» AI-вопросов + сценарии оценки
│  └─ scripts/                     # сборка, аудит размера, генерация диагпакета
├─ docs/
└─ pnpm-workspace.yaml
```

## 4. Правила зависимостей между пакетами

| Пакет/слой | Может импортировать |
|---|---|
| kernel | ничего |
| scales-data | ничего (чистые данные) |
| contracts | kernel |
| module/domain | kernel, (типы contracts — type-only) |
| module/application | свой domain, kernel |
| module/adapters | свои application-порты, kernel, внешние npm-библиотеки |
| main/app | application + adapters модулей, contracts, shared |
| renderer | **только** contracts (через preload-мост) |
| llm-worker | kernel, contracts (свои сообщения) |

**Межмодульные запреты:** импорт чужого `domain/`, `application/`, `adapters/` запрещён — только `index.ts` и события. **Проверка механическая:** eslint-plugin-boundaries + dependency-cruiser в CI (правило = тест). **Почему это критично:** границы монолита, которые не проверяются, не существуют (см. 01 §4).

## 5. Композиция и DI

**D13: ручной DI.** `container.ts` создаёт адаптеры, внедряет их в use case'ы, регистрирует IPC-хендлеры. Один файл видит весь граф зависимостей.

**Почему без DI-фреймворка (InversifyJS/tsyringe):** граф мал и статичен; фреймворк добавил бы декораторы в домен/application и магию рефлексии. **Компромисс:** при росте числа модулей container.ts растёт линейно — приемлемо до ~десятка модулей, дальше можно пересмотреть без изменения кода модулей (порты не меняются).

## 6. Изоляция тяжёлых вычислений

| Задача | Где выполняется | Почему |
|---|---|---|
| SQL-запросы, агрегаты ≤50k строк | главный процесс (better-sqlite3, синхронно) | объёмы малы, запросы индексированы; асинхронность дала бы лишнюю сложность |
| LLM-генерация | **UtilityProcess** llm-worker (D5) | изоляция сбоев нативного кода; RAM освобождается выгрузкой модели; main не блокируется (NFR-5) |
| PDF-рендер, экспорт 50k CSV, большие тренды | пул из 2 `worker_threads` | не блокировать main на секунды (NFR-4); пул общего назначения, задачи — через порты reporting/analytics |

**Альтернатива** (всё в main): проще, но долгая генерация PDF/CSV подвешивала бы IPC для всех окон; отклонено по NFR-4/5.
