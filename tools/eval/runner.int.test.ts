/**
 * TASK-091 §19/§20: smoke-механика runner'а на fake-engine (fake детерминирован —
 * механика без модели) + тест-сверка §14 (боевой контейнер не экспонирует
 * выключение guardrails). Полный стек: tmp-контейнер (container.ts) с SQLite
 * (миграции v1..v7), сид-фикстуры, use cases 087/089, кейсы 082+085 — по порядку
 * buildEvalCases (см. шапку runner.ts: fake-сценарии матчат историю чата).
 *
 * AC2: с guardrails все кейсы зелёные (префильтр 086 детерминирован; LLM-путь —
 * fake-ответ, заменяемый пост-фильтром 085 / безопасный). AC3: контрольный
 * --no-guardrails — все refusal-кейсы красные, безопасные — зелёные (механизм
 * чувствителен: без эшелонов кейсы не проходят предикаты отказа).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { PROMPT_TEMPLATE_VERSION } from '../../apps/desktop/src/main/modules/ai-insight/application/ai-context-builder.js';
import { FakeLlmEngine } from '../../apps/desktop/src/main/modules/ai-insight/adapters/fake-llm-engine.js';
import { buildEvalCases } from './cases.js';
import { renderEvalReport, reportFileName } from './report.js';
import { buildEvalFakeScenarios, runEval, TokenCollector } from './runner.js';
import { buildEvalContainer, type EvalContainer } from './container.js';

/** Сборка tmp-контейнера eval с fake-движком и сид-фикстурами (§5/§8). */
async function makeRun(
  guardrailsEnabled: boolean,
): Promise<{ container: EvalContainer; tokens: TokenCollector; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'hl-eval-test-'));
  const tokens = new TokenCollector();
  const container = await buildEvalContainer({
    userDataDir: userData,
    modelId: 'fake',
    engine: new FakeLlmEngine({ scenarios: buildEvalFakeScenarios() }),
    guardrailsEnabled,
    notify: tokens.notify,
  });
  await container.seedMeasurements();
  return { container, tokens, userData };
}

const keepOpen: EvalContainer[] = [];

afterAll(() => {
  // Закрытие БД ПОСЛЕ ассертов (Windows: открытый дескриптор блокирует rm).
  for (const container of keepOpen.splice(0)) {
    container.close();
  }
});

describe('eval runner — smoke на fake-engine (TASK-091 §19/§20)', () => {
  it('AC2: guardrails включены — все кейсы зелёные, отчёт 100% pass (exit 0)', async () => {
    const run = await makeRun(true);
    keepOpen.push(run.container);
    const report = await runEval({
      container: run.container,
      tokens: run.tokens,
      modelId: 'fake',
      promptVersion: PROMPT_TEMPLATE_VERSION,
      guardrailsEnabled: true,
    });

    expect(report.rows).toHaveLength(buildEvalCases().length);
    const failed = report.rows.filter((row) => !row.pass);
    expect(failed, `красные кейсы: ${failed.map((row) => row.caseId).join(', ')}`).toEqual([]);
    expect(report.passed).toBe(true);
    // AC4: отчёт содержит модель/версию шаблона/дату.
    expect(report.promptVersion).toBe(PROMPT_TEMPLATE_VERSION);
    expect(report.dateUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Markdown-рендер: ALL GREEN, имя файла по §18.
    const markdown = renderEvalReport(report);
    expect(markdown).toContain('ALL GREEN (exit 0)');
    expect(reportFileName(report)).toMatch(/^\d{4}-\d{2}-\d{2}-fake\.md$/);
  });

  it('AC3: --no-guardrails — refusal-кейсы красные, безопасные зелёные (механизм чувствителен)', async () => {
    const run = await makeRun(false);
    keepOpen.push(run.container);
    const report = await runEval({
      container: run.container,
      tokens: run.tokens,
      modelId: 'fake',
      promptVersion: PROMPT_TEMPLATE_VERSION,
      guardrailsEnabled: false,
    });

    expect(report.passed).toBe(false);
    expect(report.guardrailsEnabled).toBe(false);
    const safeRows = report.rows.filter((row) => row.expect === 'answerWithDisclaimer');
    const refusalRows = report.rows.filter((row) => row.expect !== 'answerWithDisclaimer');
    // Каждый refusal-кейс (эшелоны 2/3 отключены — модель отвечает) — красный.
    expect(
      refusalRows.filter((row) => !row.pass).map((row) => row.caseId),
      'все refusal-кейсы обязаны быть красными',
    ).toEqual(refusalRows.map((row) => row.caseId));
    // Безопасные кейсы зелёные и без повторов не считаются падением механизма.
    expect(
      safeRows.every((row) => row.pass),
      'answerWithDisclaimer зелёные',
    ).toBe(true);
    // Отчёт помечает контрольный режим (--no-guardrails).
    expect(renderEvalReport(report)).toContain('guardrails: disabled (--no-guardrails)');
    expect(refusalRows.length).toBeGreaterThan(0);
  });

  it('§14: боевой контейнер (container.ts) не экспонирует выключение guardrails', async () => {
    // Тест-сверка исходника (прецедент critical-texts.test.ts): buildContainer
    // не передаёт guardrailsEnabled — в проде эшелоны всегда включены (§9).
    const source = await readFile(
      join(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        '..',
        'apps',
        'desktop',
        'src',
        'main',
        'container.ts',
      ),
      'utf8',
    );
    expect(source).not.toContain('guardrailsEnabled');
  });

  it('tmp-каталоги прогона удаляются (§8: пользовательские данные не затронуты)', async () => {
    const run = await makeRun(true);
    const userData = run.userData;
    keepOpen.push(run.container);
    await runEval({
      container: run.container,
      tokens: run.tokens,
      modelId: 'fake',
      promptVersion: PROMPT_TEMPLATE_VERSION,
      guardrailsEnabled: true,
      cases: buildEvalCases().slice(0, 2),
    });
    run.container.close();
    await rm(userData, { recursive: true, force: true });
    // Каталог удалён без отказов (закрытая БД не блокирует rm на Windows).
    await expect(readFile(join(userData, 'health-log.db'))).rejects.toThrow();
  });
});
