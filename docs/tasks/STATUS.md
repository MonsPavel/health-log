# Реестр статусов реализации

Единственный источник истины о прогрессе реализации. Обновляется конвейером реализации (workflow `night-cycle`) — вручную не редактировать во время ночного прогона.

Статусы: `todo` — не начата · `in-progress` — ветка в работе (прогон прерван) · `done` — смержена в `main` · `blocked` — не прошла конвейер, ветка `task/task-XXX` сохранена, причина в примечании.

| ID | Статус | Ветка | Примечание |
|---|---|---|---|
| TASK-001 | done | | смержена |
| TASK-002 | done | | смержена |
| TASK-003 | done | | смержена |
| TASK-004 | done | | смержена |
| TASK-005 | done | | смержена |
| TASK-006 | done | | смержена |
| TASK-007 | done | | смержена |
| TASK-008 | done | | смержена |
| TASK-009 | done | | смержена |
| TASK-010 | done | | смержена |
| TASK-011 | done | | смержена |
| TASK-012 | done | | смержена |
| TASK-013 | done | | смержена |
| TASK-014 | done | | смержена |
| TASK-015 | done | | смержена |
| TASK-016 | done | | смержена |
| TASK-017 | done | | смержена |
| TASK-018 | done | | смержена |
| TASK-019 | done | | смержена |
| TASK-020 | done | | смержена |
| TASK-021 | done | | смержена |
| TASK-022 | done | | смержена |
| TASK-023 | done | | смержена |
| TASK-024 | done | | смержена |
| TASK-025 | done | | смержена |
| TASK-026 | done | | смержена |
| TASK-027 | done | | смержена |
| TASK-028 | done | | смержена |
| TASK-029 | done | | смержена |
| TASK-030 | done | | смержена |
| TASK-031 | done | | условно принята: автоприёмка ограничена ручными критериями §20 (хронометраж в живом Electron-рантайме), ручная приёмка отложена до готовности MVP |
| TASK-032 | done | | смержена |
| TASK-033 | done | | смержена |
| TASK-034 | done | | смержена |
| TASK-035 | done | | смержена (доделана вручную после сбоя shell-рантайма; e2e/§20/§24 зелёные) |
| TASK-036 | done | | смержена |
| TASK-037 | done | | смержена |
| TASK-038 | done | | смержена |
| TASK-039 | done | | смержена |
| TASK-040 | done | | смержена |
| TASK-041 | done | | смержена |
| TASK-042 | done | | смержена |
| TASK-043 | done | | смержена |
| TASK-044 | done | | смержена |
| TASK-045 | done | | смержена |
| TASK-046 | done | | смержена |
| TASK-047 | done | | смержена |
| TASK-048 | done | | смержена |
| TASK-049 | done | | смержена |
| TASK-050 | done | | смержена |
| TASK-051 | done | | смержена |
| TASK-052 | done | | смержена |
| TASK-053 | done | | смержена |
| TASK-054 | done | | смержена |
| TASK-055 | done | | смержена |
| TASK-056 | done | | смержена |
| TASK-057 | done | | смержена |
| TASK-058 | done | | смержена |
| TASK-059 | done | | смержена |
| TASK-060 | done | | смержена |
| TASK-061 | done | | смержена |
| TASK-062 | done | | смержена |
| TASK-063 | done | | смержена вручную после ручной Excel-проверки golden-CSV пользователем 29.09 |
| TASK-064 | done | | смержена |
| TASK-065 | done | | смержена |
| TASK-066 | done | | смержена |
| TASK-067 | done | | смержена |
| TASK-068 | done | | смержена вручную после ручной PDF-проверки golden-PDF пользователем 29.09 (pnpm export:golden-pdf) |
| TASK-069 | done | | смержена |
| TASK-070 | done | | смержена |
| TASK-071 | done | | смержена |
| TASK-072 | done | | смержена |
| TASK-073 | done | | смержена |
| TASK-074 | done | | смержена |
| TASK-075 | done | | смержена |
| TASK-076 | done | | смержена |
| TASK-077 | done | | смержена вручную после ручной приёмки §20 30.09 (GGUF скачаны пользователем: 1B Llama-3.2 и Qwen3-4B Q4_K_M; замеры §15 в docs/dev/local-llm.md; приёмка поймала баг стриминга — исправлен) |
| TASK-078 | done | | смержена |
| TASK-079 | done | | смержена |
| TASK-080 | done | | смержена |
| TASK-081 | done | | смержена |
| TASK-082 | done | | смержена |
| TASK-083 | done | | смержена |
| TASK-084 | done | | смержена |
| TASK-085 | done | | смержена |
| TASK-086 | done | | смержена |
| TASK-087 | done | | смержена |
| TASK-088 | done | | смержена вручную 01.10 после квота-остановки прогона 11 на фазе ревью: ревью дифа выполнено основным агентом, gate — typecheck + pnpm test 253 файла/2707 passed (+4 [model]-skip) + e2e зелёные (ai-summary fake-happy §20, visual-scales с обновлёнными базлайнами) |
| TASK-089 | done | | смержена |
| TASK-090 | done | | смержена |
| TASK-091 | done | | смержена вручную 01.10 после квота-остановки прогона 13 на фазе приёмки: ревью дифа выполнено основным агентом, gate — typecheck + pnpm test 267 файлов/2843 passed (+4 [model]-skip); AC5 — отчёт docs/dev/eval-reports (1B, 22/22 passed, exit 0) |
| TASK-092 | done | | смержена вручную 01.10 после блокировки приёмки (§20.1/20.2 — dispatch+кэш требуют workflow на ветке по умолчанию, физически пост-мердж): gate typecheck + pnpm test 270ф/2859+4skip в worktree. ЖИВАЯ приёмка ПРОЙДЕНА 01.10: первый прогон зелёный — модель по --id, sha256 манифеста сошёлся, eval 22/22 passed, артефакт eval-report + Job Summary; второй прогон — cache hit model-1b-v1, «скачивание пропущено», sha256 кэша перепроверен. НАХОДКА живого прогона: плейсхолдер манифеста 079 ловился первым → фикс 731c2c5: реальная запись llama-3.2-1b (bartowski, sha256 локальных копий) + детерминированный --id в workflow |
| TASK-093 | done | | смержена вручную 01.10: интегратор прогона 14 отчитался «смержена», но checkout/merge не выполнились (main reflog чист, push не прошёл) — merge доделан основным агентом; impl 37М токенов, приёмка 2 раунда зелёные; ветка task/TASK-093 (8 коммитов: kernel-коды VAULT/WRONG_PASSPHRASE|LOCKED, passphrase-crypto Argon2id+AES-256-GCM, vault-format v2+миграция, SafeStorageKeyVault v2, ленивое открытие БД) |
| TASK-094 | done | | смержена |
| TASK-095 | done | | смержена |
| TASK-096 | done | | смержена |
| TASK-097 | done | | смержена |
| TASK-098 | done | | смержена |
| TASK-099 | done | | смержена |
| TASK-100 | todo | | |
| TASK-101 | todo | | |
| TASK-102 | todo | | |
| TASK-103 | todo | | |
| TASK-104 | todo | | |
| TASK-105 | todo | | |
| TASK-106 | todo | | |
| TASK-107 | todo | | |
| TASK-108 | todo | | |
| TASK-109 | todo | | |
| TASK-110 | todo | | |
| TASK-111 | todo | | |
| TASK-112 | todo | | |
| TASK-113 | todo | | |
| TASK-114 | todo | | |
| TASK-115 | todo | | |
| TASK-116 | done | | смержена вручную 01.10: корневой tsc 137 ошибок → 0 (53 файла, type-only), счётчики тестов прежние (267ф/2843+4skip), gate+lint зелёные; отступление от §5 — 3 eslint-disable prefer-promise-reject-errors (прецедент llm-process-client, AppError не Error по TASK-006); НАХОДКА: зеркало типов classifier — домен шире пакета по code (string vs union ScaleCategoryCode), тест ослаблен до toExtend, решение о строгом зеркале — отдельно; follow-up 01.10: корневой tsc добавлен в `pnpm typecheck` (фон не накапливается, §23 спеки выполнено) |
| TASK-117 | done | | смержена 01.10: доменный ScaleCategoryCode переобъявлен union-зеркалом пакета, ScaleCategory.code сужен до него; тип-тест возвращён к toEqualTypeOf (дрейф ловится в обе стороны); импорта пакета в домене нет (domain-purity); gate+lint зелёные, счётчики тестов прежние |
| TASK-118 | done | | смержена 01.10: silentLogger() в shared/logger (полный HlLogger, покрывает узкие поверхности структурно), 8 тест-файлов переведены с инлайн-литералов; шпионы/собиратели (models-registry) не тронуты по §13; gate+lint зелёные, 268ф/2844 passed (+1 тест helper'а) |
