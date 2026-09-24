# Спецификации реализации — реестр задач

**Статус:** v0.1 · 2026-09-24 · ветка `docs/planning`

Эта папка — исполняемый слой между дорожной картой (`docs/roadmap/`) и кодом. Одна дорожная задача = один файл `TASK-NNN-<имя>.md`, самодостаточная спецификация по шаблону `_TEMPLATE.md`.

## Как работать с реестром

1. **Генерация спецификаций идёт батчами** по фазам (см. §Протокол). Реестр ниже фиксирует соответствие «дорожная задача → TASK-ID → файл» для всех 115 задач; ничего не пропускается и не переупорядочивается.
2. **Кодирующий агент** берёт файл TASK-*, реализует по разделам 1–24, проверяет по §24 и DoD (§21).
3. **Имена файлов — ASCII-транслит** (решение: кроссплатформенная безопасность шелл-скриптов и CI-логов; компромисс против кириллицы из примера ТЗ — принят сознательно).

## Фиксированные решения реализации (источник ответов на «какой библиотекой?»)

Все спецификации исходят из этих решений; смена любого пункта = ревизия затронутых TASK-файлов.

| Область | Решение |
|---|---|
| Рантайм | Node 20 LTS, pnpm 9, Electron 30+ (актуальная стабильная мажорная), TypeScript 5.x strict |
| UI | React 18, Vite 5+, Tailwind 3 (rem-токены), Radix UI, react-router 6 (HashRouter) |
| Состояние | @tanstack/react-query 5, zustand 4 |
| Данные | better-sqlite3 11 (SQLCipher-сборка), Drizzle ORM (драйвер better-sqlite3), миграции Drizzle-конвенцией, forward-only |
| Контракты | zod 3 (валидация IPC), пакет `@hl/contracts` |
| Логи | pino + ротация (pino-roll), редакция PHI в сериализаторе |
| ИИ | node-llama-cpp (llama.cpp), UtilityProcess, GGUF Q4-модели 3–4B |
| PDF | @react-pdf/renderer (worker-пул), шрифты с кириллицей — встроенные TTF |
| Тесты | vitest 2, fast-check (property), Playwright (`_electron`), axe-core |
| Сборка | electron-builder (NSIS), electron-updater (GitHub Releases, opt-in) |
| Прочее | react-i18next + ICU, uuid v7, аргонид — `argon2` (nan), хеши — node:crypto |

## Протокол генерации батчей

Каждый батч = все TASK-файлы одной фазы. Батч генерируется по алгоритму: (1) взять файл фазы `docs/roadmap/0N-…`, (2) каждую задачу T-… развернуть в TASK-документ по `_TEMPLATE.md`, (3) ID и соответствие взять из реестра ниже, (4) пройтись по чек-листу самопроверки (ниже), (5) отметить статус в реестре. Порядок задач внутри фазы менять запрещено (зависимости). Батчи независимы между собой и генерируются по запросу: «сгенерируй батч B» и т.д.

**Чек-лист самопроверки батча:** все задачи фазы развёрнуты 1:1; нет дублей ID; каждый AC измерим; каждый документ самодостаточен (не требует чтения других TASK-файлов); N/A-разделы обоснованы; никакой реализации-кода.

## Матрица соответствия (все 115 задач)

Статус: ✅ спецификация готова · ⬜ ждёт генерации батча.

### Фаза P0 — Фундамент (батч A) — TASK-001…015

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-001 | T-0.1.1 | Инициализировать pnpm-монорепо и скелет пакетов | `TASK-001-init-pnpm-monorepo.md` | ✅ |
| TASK-002 | T-0.1.2 | Ввести единый строгий TypeScript-конфиг | `TASK-002-strict-ts-config.md` | ✅ |
| TASK-003 | T-0.1.3 | Настроить ESLint, правила границ и Prettier | `TASK-003-eslint-boundaries-prettier.md` | ✅ |
| TASK-004 | T-0.1.4 | Настроить Vitest в монорепо | `TASK-004-vitest-monorepo.md` | ✅ |
| TASK-005 | T-0.1.5 | Настроить dependency-cruiser | `TASK-005-dependency-cruiser.md` | ✅ |
| TASK-006 | T-0.1.6 | Реализовать пакет kernel (Result, AppError, Instant, Clock) | `TASK-006-kernel-package.md` | ✅ |
| TASK-007 | T-0.2.1 | Запустить Electron + React с изоляцией процессов | `TASK-007-electron-react-shell.md` | ✅ |
| TASK-008 | T-0.2.2 | Реализовать preload-мост и конверты IPC | `TASK-008-preload-ipc-envelope.md` | ✅ |
| TASK-009 | T-0.2.3 | Реализовать шину событий и broadcast | `TASK-009-event-bus-broadcast.md` | ✅ |
| TASK-010 | T-0.2.4 | Настроить логгер с редакцией PHI | `TASK-010-logger-phi-redaction.md` | ✅ |
| TASK-011 | T-0.2.5 | Реализовать глобальную обработку ошибок | `TASK-011-global-error-handling.md` | ✅ |
| TASK-012 | T-0.2.6 | Включить single-instance lock | `TASK-012-single-instance-lock.md` | ✅ |
| TASK-013 | T-0.2.7 | Построить каркас UI: роутер, layout, темы, i18n | `TASK-013-ui-scaffold-i18n-theming.md` | ✅ |
| TASK-014 | T-0.3.1 | Настроить PR-пайплайн GitHub Actions | `TASK-014-ci-pr-pipeline.md` | ✅ |
| TASK-015 | T-0.3.2 | Написать CONTRIBUTING и конвенции | `TASK-015-contributing-conventions.md` | ✅ |

### Фаза P1 — Вертикальный срез журнала (батч B) — TASK-016…036

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-016 | T-1.1.1 | Реализовать VO BloodPressure, Pulse, Arm | `TASK-016-bp-value-objects.md` | ✅ |
| TASK-017 | T-1.1.2 | Реализовать агрегат BpMeasurement | `TASK-017-bp-measurement-aggregate.md` | ✅ |
| TASK-018 | T-1.1.3 | Реализовать TypoHeuristic | `TASK-018-typo-heuristic.md` | ✅ |
| TASK-019 | T-1.1.4 | Реализовать DuplicateDetector | `TASK-019-duplicate-detector.md` | ✅ |
| TASK-020 | T-1.1.5 | Реализовать CriticalValuePolicy | `TASK-020-critical-value-policy.md` | ✅ |
| TASK-021 | T-1.1.6 | Определить порт репозитория измерений и in-memory fake | `TASK-021-measurement-repo-port.md` | ✅ |
| TASK-022 | T-1.2.1 | Собрать SQLCipher-стек better-sqlite3 | `TASK-022-sqlcipher-stack.md` | ✅ |
| TASK-023 | T-1.2.2 | Реализовать KeyVault на safeStorage | `TASK-023-key-vault.md` | ✅ |
| TASK-024 | T-1.2.3 | Реализовать migration runner с автокопией | `TASK-024-migration-runner.md` | ✅ |
| TASK-025 | T-1.2.4 | Написать миграцию v1 (profile + bp_measurement) | `TASK-025-migration-v1.md` | ✅ |
| TASK-026 | T-1.2.5 | Реализовать SQLite-адаптер репозитория измерений | `TASK-026-sqlite-measurement-repo.md` | ✅ |
| TASK-027 | T-1.2.6 | Собрать composition root | `TASK-027-composition-root.md` | ✅ |
| TASK-028 | T-1.3.1 | Определить contracts: каналы измерений | `TASK-028-contracts-measurement.md` | ✅ |
| TASK-029 | T-1.3.2 | Реализовать use case AddMeasurement | `TASK-029-add-measurement-usecase.md` | ✅ |
| TASK-030 | T-1.3.3 | Реализовать ListMeasurements и хендлеры | `TASK-030-list-measurements-handlers.md` | ✅ |
| TASK-031 | T-1.3.4 | Реализовать форму ввода измерения | `TASK-031-measurement-form.md` | ✅ |
| TASK-032 | T-1.3.5 | Реализовать диалоги подтверждений ввода | `TASK-032-input-confirmation-dialogs.md` | ✅ |
| TASK-033 | T-1.3.6 | Реализовать экран истории с группировкой | `TASK-033-history-list.md` | ✅ |
| TASK-034 | T-1.4.1 | Настроить electron-builder для Windows | `TASK-034-electron-builder-windows.md` | ✅ |
| TASK-035 | T-1.4.2 | Написать Playwright Electron smoke | `TASK-035-playwright-smoke.md` | ✅ |
| TASK-036 | T-1.4.3 | Реализовать скрипт аудита размера | `TASK-036-size-audit-script.md` | ✅ |

### Фаза P2 — Полнота журнала (батч C) — TASK-037…049

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-037 | T-2.1.1 | Реализовать use cases Update/Delete измерения | `TASK-037-update-delete-usecases.md` | ✅ |
| TASK-038 | T-2.1.2 | Реализовать UI правки и удаления | `TASK-038-edit-delete-ui.md` | ✅ |
| TASK-039 | T-2.1.3 | Реализовать восстановление черновика ввода | `TASK-039-draft-recovery.md` | ✅ |
| TASK-040 | T-2.1.4 | Реализовать умную вставку «120/80» | `TASK-040-smart-paste.md` | ✅ |
| TASK-041 | T-2.2.1 | Реализовать панель критических значений | `TASK-041-critical-panel.md` | ✅ |
| TASK-042 | T-2.2.2 | Реализовать флаги записей в журнале | `TASK-042-record-flags-ui.md` | ✅ |
| TASK-043 | T-2.2.3 | Написать E2E пограничных вводов | `TASK-043-edge-input-e2e.md` | ✅ |
| TASK-044 | T-2.3.1 | Реализовать фильтры списка | `TASK-044-list-filters.md` | ✅ |
| TASK-045 | T-2.3.2 | Реализовать FTS-поиск по заметкам | `TASK-045-fts-note-search.md` | ✅ |
| TASK-046 | T-2.3.3 | Реализовать произвольный период | `TASK-046-custom-date-range.md` | ✅ |
| TASK-047 | T-2.4.1 | Реализовать хранилище настроек и экран настроек | `TASK-047-settings-store-screen.md` | ✅ |
| TASK-048 | T-2.4.2 | Реализовать крупный режим текста | `TASK-048-large-text-mode.md` | ✅ |
| TASK-049 | T-2.4.3 | Реализовать простой/продвинутый режим | `TASK-049-simple-mode.md` | ✅ |

### Фаза P3 — Аналитика и графики (батч D) — TASK-050…062

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-050 | T-3.1.1 | Создать пакет scales-data (ESC/ESH) | `TASK-050-scales-data-package.md` | ✅ |
| TASK-051 | T-3.1.2 | Реализовать хранилище шкал и ScaleService | `TASK-051-scale-service.md` | ✅ |
| TASK-052 | T-3.2.1 | Реализовать read model PeriodStatistics | `TASK-052-period-statistics.md` | ✅ |
| TASK-053 | T-3.2.2 | Реализовать Classifier и примечания порогов | `TASK-053-bp-classifier.md` | ✅ |
| TASK-054 | T-3.2.3 | Реализовать канал stats/period и «мало данных» | `TASK-054-stats-channel.md` | ✅ |
| TASK-055 | T-3.3.1 | Провести спайк и ADR по чарт-библиотеке | `TASK-055-chart-library-adr.md` | ✅ |
| TASK-056 | T-3.3.2 | Реализовать read model trend/series | `TASK-056-trend-series.md` | ✅ |
| TASK-057 | T-3.3.3 | Реализовать экран «Динамика» | `TASK-057-dashboard-chart-screen.md` | ✅ |
| TASK-058 | T-3.3.4 | Реализовать представление ЧСС | `TASK-058-pulse-view.md` | ✅ |
| TASK-059 | T-3.3.5 | Реализовать таблицу-альтернативу и a11y-резюме | `TASK-059-table-alternative-a11y.md` | ✅ |
| TASK-060 | T-3.3.6 | Реализовать пустые состояния графиков | `TASK-060-chart-empty-states.md` | ✅ |
| TASK-061 | T-3.4.1 | Реализовать домашний экран-сводку | `TASK-061-dashboard-summary.md` | ✅ |
| TASK-062 | T-3.4.2 | Написать bench графика на 10k точек | `TASK-062-chart-bench.md` | ✅ |

### Фаза P4 — Данные и отчёты (батч E) — TASK-063…074

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-063 | T-4.1.1 | Реализовать CSV-экспорт | `TASK-063-csv-export.md` | ✅ |
| TASK-064 | T-4.1.2 | Реализовать JSON-слепок (мастер-формат) | `TASK-064-json-snapshot.md` | ✅ |
| TASK-065 | T-4.1.3 | Реализовать save dialog и UI экспорта | `TASK-065-export-ui.md` | ✅ |
| TASK-066 | T-4.2.1 | Реализовать worker pool | `TASK-066-worker-pool.md` | ✅ |
| TASK-067 | T-4.2.2 | Реализовать шаблон PDF-отчёта | `TASK-067-pdf-template.md` | ✅ |
| TASK-068 | T-4.2.3 | Реализовать BuildPdfReport и предпросмотр | `TASK-068-pdf-report-usecase.md` | ✅ |
| TASK-069 | T-4.2.4 | Написать bench PDF | `TASK-069-pdf-bench.md` | ✅ |
| TASK-070 | T-4.3.1 | Реализовать CreateBackup | `TASK-070-create-backup.md` | ✅ |
| TASK-071 | T-4.3.2 | Реализовать RestoreBackup | `TASK-071-restore-backup.md` | ✅ |
| TASK-072 | T-4.3.3 | Реализовать WipeAllData | `TASK-072-wipe-all-data.md` | ✅ |
| TASK-073 | T-4.3.4 | Реализовать UI копий и удаления | `TASK-073-data-care-ui.md` | ✅ |
| TASK-074 | T-4.3.5 | Реализовать JobScheduler и подсказку о копии | `TASK-074-job-scheduler.md` | ✅ |

### Фаза P5 — Локальный ИИ (батч F) — TASK-075…092

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-075 | T-5.1.1 | Реализовать EgressGateway и журнал сети | `TASK-075-egress-gateway.md` | ✅ |
| TASK-076 | T-5.2.1 | Реализовать каркас llm-worker (UtilityProcess) | `TASK-076-llm-worker-shell.md` | ✅ |
| TASK-077 | T-5.2.2 | Интегрировать node-llama-cpp в воркер | `TASK-077-llama-integration.md` | ✅ |
| TASK-078 | T-5.2.3 | Определить порт LlmEngine и fake-движок | `TASK-078-llm-engine-port.md` | ✅ |
| TASK-079 | T-5.3.1 | Создать манифест моделей | `TASK-079-models-manifest.md` | ✅ |
| TASK-080 | T-5.3.2 | Реализовать ModelStore с докачкой | `TASK-080-model-store.md` | ✅ |
| TASK-081 | T-5.3.3 | Реализовать UI выбора и загрузки моделей | `TASK-081-models-ui.md` | ✅ |
| TASK-082 | T-5.4.1 | Реализовать GuardrailPolicy (домен) | `TASK-082-guardrail-policy.md` | ✅ |
| TASK-083 | T-5.4.2 | Реализовать AiContextBuilder и context_hash | `TASK-083-ai-context-builder.md` | ✅ |
| TASK-084 | T-5.4.3 | Реализовать system prompt (версионируемый) | `TASK-084-system-prompt.md` | ✅ |
| TASK-085 | T-5.4.4 | Реализовать ResponseGuard | `TASK-085-response-guard.md` | ✅ |
| TASK-086 | T-5.4.5 | Реализовать отказ-шаблоны без LLM | `TASK-086-refusal-templates.md` | ✅ |
| TASK-087 | T-5.5.1 | Реализовать GenerateSummary use case | `TASK-087-generate-summary.md` | ✅ |
| TASK-088 | T-5.5.2 | Реализовать UI резюме | `TASK-088-summary-ui.md` | ✅ |
| TASK-089 | T-5.6.1 | Реализовать chat use cases и миграцию v5 | `TASK-089-chat-usecases.md` | ✅ |
| TASK-090 | T-5.6.2 | Реализовать UI чата | `TASK-090-chat-ui.md` | ✅ |
| TASK-091 | T-5.7.1 | Реализовать runner «красного набора» (eval) | `TASK-091-eval-runner.md` | ✅ |
| TASK-092 | T-5.7.2 | Настроить ночной CI-прогон eval | `TASK-092-eval-nightly-ci.md` | ✅ |

### Фаза P6 — Безопасность и надёжность (батч G) — TASK-093…103

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-093 | T-6.1.1 | Реализовать двойную обёртку ключа (Argon2id) | `TASK-093-passphrase-key-wrapping.md` | ✅ |
| TASK-094 | T-6.1.2 | Реализовать use cases vault и rate limit | `TASK-094-vault-usecases.md` | ✅ |
| TASK-095 | T-6.1.3 | Реализовать экран блокировки | `TASK-095-lock-screen-ui.md` | ✅ |
| TASK-096 | T-6.2.1 | Интегрировать electron-updater за согласием | `TASK-096-updater-consent.md` | ✅ |
| TASK-097 | T-6.2.2 | Реализовать UI обновлений | `TASK-097-updates-ui.md` | ✅ |
| TASK-098 | T-6.3.1 | Реализовать хендлеры privacy/journal | `TASK-098-privacy-handlers.md` | ✅ |
| TASK-099 | T-6.3.2 | Реализовать экран «Приватность» | `TASK-099-privacy-screen.md` | ✅ |
| TASK-100 | T-6.4.1 | Реализовать startup self-check и «О приложении» | `TASK-100-selfcheck-about.md` | ✅ |
| TASK-101 | T-6.4.2 | Реализовать восстановление при повреждении | `TASK-101-corruption-recovery.md` | ✅ |
| TASK-102 | T-6.4.3 | Написать крэш-тест потери питания | `TASK-102-crash-safety-test.md` | ✅ |
| TASK-103 | T-6.4.4 | Реализовать диагностический пакет | `TASK-103-diag-bundle.md` | ✅ |

### Фаза P7 — Релиз MVP (батч H) — TASK-104…115

| TASK | Roadmap | Название | Файл | Статус |
|---|---|---|---|---|
| TASK-104 | T-7.1.1 | Настроить подпись Windows и update feed | `TASK-104-signing-update-feed.md` | ⬜ |
| TASK-105 | T-7.1.2 | Настроить тег-пайплайн релиза | `TASK-105-release-pipeline.md` | ⬜ |
| TASK-106 | T-7.1.3 | Реализовать процедуру сетевого аудита | `TASK-106-network-audit.md` | ⬜ |
| TASK-107 | T-7.1.4 | Настроить beta-канал | `TASK-107-beta-channel.md` | ⬜ |
| TASK-108 | T-7.2.1 | Провести axe-аудит и клавиатурные маршруты | `TASK-108-axe-keyboard-audit.md` | ⬜ |
| TASK-109 | T-7.2.2 | Провести NVDA-чеклист и аудит контраста | `TASK-109-nvda-contrast.md` | ⬜ |
| TASK-110 | T-7.2.3 | Провести ревизию текстов RU | `TASK-110-ru-copy-review.md` | ⬜ |
| TASK-111 | T-7.3.1 | Выполнить полный perf-прогон | `TASK-111-perf-run.md` | ⬜ |
| TASK-112 | T-7.3.2 | Выполнить финальный прогон DoD | `TASK-112-dod-checklist.md` | ⬜ |
| TASK-113 | T-7.4.1 | Написать руководство пользователя | `TASK-113-user-guide.md` | ⬜ |
| TASK-114 | T-7.4.2 | Настроить процесс release notes | `TASK-114-release-notes.md` | ⬜ |
| TASK-115 | T-7.5.1 | Подготовить Release Candidate | `TASK-115-release-candidate.md` | ⬜ |

## Чек-лист самопроверки комплекта

- [ ] Каждая из 115 задач дорожной карты имеет TASK-файл (матрица полная, дублей нет).
- [ ] Порядок и зависимости TASK совпадают с дорожной картой.
- [ ] Каждый AC измерим (число/команда/наблюдаемое событие).
- [ ] Каждый документ самодостаточен и проверяем в изоляции.
- [ ] Архитектура (docs/architecture) не противоречится ни в одном документе.
