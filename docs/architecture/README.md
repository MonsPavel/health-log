# Health Log — архитектура системы

**Статус:** черновик v0.1 · 2026-09-24 · ветка `docs/planning` · базируется на SRS v0.1 (`docs/01–10`)

Это проектная документация архитектуры. Здесь нет задач по реализации и кода — только решения, структуры, контракты и потоки.

## Карта документов

| Файл | Содержание |
|---|---|
| [01-high-level.md](01-high-level.md) | Высокоуровневая архитектура, модель процессов, ключевые решения D1–D5, потоки данных |
| [02-domain-model.md](02-domain-model.md) | DDD: ограниченные контексты, агрегаты, сущности, VO, инварианты, карта контекстов |
| [03-modules.md](03-modules.md) | Диаграмма модулей, правила зависимостей, структура папок и пакетов (monorepo) |
| [04-database.md](04-database.md) | Проект БД: схема, миграции, время, шифрование, жизненный цикл данных |
| [05-api-ipc.md](05-api-ipc.md) | Стратегия API: IPC-контракт, конверты, стриминг, таксономия ошибок, версионирование |
| [06-frontend.md](06-frontend.md) | Архитектура фронтенда: React, состояние, роутинг, i18n, доступность, графики |
| [07-ai-integration.md](07-ai-integration.md) | Интеграция ИИ: воркер, сборка контекста, guardrails, жизненный цикл моделей, кэш |
| [08-security.md](08-security.md) | Модель безопасности: ключи, локальный вход, модель угроз, сетевая политика |
| [09-platform.md](09-platform.md) | Фоновые задачи, уведомления, кэширование, флаги, конфигурация, окружения, логи/мониторинг/аналитика, ошибки, офлайн |
| [10-delivery.md](10-delivery.md) | CI/CD, стратегия и архитектура развёртывания, архитектура тестирования |

## Соответствие разделам запроса

| Раздел | Где |
|---|---|
| High-Level Architecture | 01 |
| Module Diagram, Domain Model | 02, 03 |
| Database Design | 04 |
| API Strategy, API Design | 05 |
| Frontend / Backend Architecture | 06 / 01 §3 (главный процесс = «бэкенд») |
| Authentication / Authorization | 08 §2–3 |
| Event Flow | 01 §5, 05 §4 |
| State Management | 06 §3 |
| Background Jobs, Notifications | 09 §1–2 |
| AI Integration | 07 |
| Third-party Integrations | 01 §6, 09 §6 |
| Caching | 09 §3 |
| Monitoring / Logging / Analytics | 09 §7–9 |
| Feature Flags / Configuration / Environments | 09 §4–6 |
| Deployment Strategy / CI/CD | 10 §2–3 |
| Testing Strategy / Testing Architecture | 10 §4 |
| Error Handling / Offline Strategy | 09 §10–11 |
| Internationalization / Accessibility | 06 §6–7 |
| Folder / Package Structure | 03 §3–4 |

## Реестр архитектурных решений (ADR-сводка)

| ID | Решение | Статус |
|---|---|---|
| D1 | Electron + React + TypeScript как рантайм десктопа | принято (альтернатива: Tauri 2 — см. 01 §2) |
| D2 | Модульный монолит в одном процессе; микросервисы не обоснованы | принято (01 §4) |
| D3 | Clean Architecture: domain / application / adapters + composition root | принято (02, 03) |
| D4 | SQLite + WAL + SQLCipher, Drizzle ORM, время = UTC + смещение | принято (04) |
| D5 | LLM: llama.cpp (node-llama-cpp) в отдельном UtilityProcess | принято (07) |
| D6 | Единственный API — типизированный IPC-контракт (пакет contracts, zod) | принято (05) |
| D7 | Состояние рендерера: TanStack Query + Zustand; истина — только в БД | принято (06) |
| D8 | Без аккаунтов; опциональный локальный вход; изоляция профилей в репозиториях | принято (08) |
| D9 | PDF — @react-pdf/renderer в рабочем пуле; CSV/JSON — чистый TS | принято (01 §6) |
| D10 | События — типизированный шина в главном процессе + broadcast в рендерер; стейлс резюме — через data_version | принято (01 §5, 07 §5) |
| D11 | Сеть только через единый контролируемый EgressGateway с белым списком и журналом | принято (08 §5) |
| D12 | Телеметрии нет; мониторинг — локальные логи + диагностический пакет по явному действию | принято (09 §7–9) |
| D13 | Ручной DI (composition root), без DI-фреймворка | принято (03 §5) |
| D14 | Vitest + Playwright (Electron) + fast-check; ночные AI-оценки | принято (10) |
| D15 | Обновления — electron-updater по GitHub Releases, проверка только с согласия | принято (10 §2) |

Каждое решение в документах сопровождается «Почему / Альтернативы / Компромиссы».
