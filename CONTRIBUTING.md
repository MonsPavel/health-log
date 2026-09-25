# Contributing — health-log

Минимальный контрибьюторский минимум. Развёрнутые конвенции — TASK-015; этот
файл пока фиксирует только CI-контракт пайплайна (TASK-014 §5/§20.5).

## CI: PR-пайплайн

Workflow: `.github/workflows/pr.yml` (имя — «PR»), триггеры `pull_request` +
`workflow_dispatch`; один job **`PR pipeline`** на `ubuntu-latest`.

Шаги строго в порядке:

1. Checkout
2. Setup Node 24 (см. примечание ниже) + Enable corepack (pnpm 9 — `packageManager`)
3. Get pnpm store path → Cache pnpm store (ключ по `hashFiles('pnpm-lock.yaml')`)
4. Fetch dependencies (`pnpm fetch`) → Install dependencies (`--frozen-lockfile`)
5. Build packages (typed-lint резолвит `@hl/*` через `dist/*.d.ts`)
6. Lint → Check i18n → Typecheck → Dependency cruiser
7. Test with coverage (`vitest run --coverage`, + junit-репортер)
8. Build renderer
9. Upload coverage (lcov) и Upload vitest report (junit) — `if: always()`

### Required checks для main

Настройка ветки main (branch protection): обязательный статус-чек —

- **`PR pipeline`** (имя job'а — оно же имя check-run).

Merge в main возможен только при зелёном `PR pipeline` (правило «зелёный main =
всегда собираемый продукт», арх. 10 §3). Контрольные красные PR (§20.1/§20.2
спеки TASK-014) закрываются без merge.

### Примечания

- Node 24, а не Node 20 из §5 спеки: `dependency-cruiser` 18 (TASK-005)
  поддерживает node `^22||^24||>=26`; `engines` монорепо — `>=20`.
- Бюджет прогона ≤5 минут (AC); аварийный предел job'а — `timeout-minutes: 15`.
- Re-run всегда полный: кэш pnpm-store не даёт «зелёного по кэшу» — install
  идёт по lockfile всегда (`--frozen-lockfile`).
