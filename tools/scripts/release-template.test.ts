/**
 * TASK-114 §19/§20: контракт release notes — шаблон `.github/release-template.md`,
 * пример заполнения `docs/release/notes-example.md` и заливка шаблона в draft
 * релизным пайплайном (`.github/workflows/release.yml`, TASK-105).
 *
 * Пайплайн копирует шаблон в тело draft ДОСЛОВНО (`cp` без преобразований,
 * `body_path: release-notes.md`), поэтому автоматическая половина сверки §19 —
 * структурный контракт самого шаблона: draft-тело содержит все `{{}}`-плейсхолдеры
 * тогда и только тогда, когда они есть в шаблоне. Живая сверка в rc-прогоне —
 * ручной шаг раздела «Релиз» CONTRIBUTING (§24 спеки).
 *
 * Гард против пустого прохода: каждый список ожидаемых маркеров проверяется на
 * непустоту, чтение файла вне try — отсутствие шаблона валит весь файл (RED).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Корень монорепо от этого файла (tools/scripts → на 2 уровня вверх). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEMPLATE_PATH = `${REPO_ROOT}.github/release-template.md`;
const EXAMPLE_PATH = `${REPO_ROOT}docs/release/notes-example.md`;
const WORKFLOW_PATH = `${REPO_ROOT}.github/workflows/release.yml`;

/** CRLF рабочей копии Windows нормализуем (прецедент test-release-workflow.ts). */
function readRepoFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const template = readRepoFile(TEMPLATE_PATH);
const example = readRepoFile(EXAMPLE_PATH);
const workflow = readRepoFile(WORKFLOW_PATH);

/** §5: секции шаблона — ровно эти заголовки, в этом порядке сверху вниз. */
const TEMPLATE_SECTIONS: ReadonlyArray<string> = [
  '## Что нового',
  '## Исправлено',
  '## Версии внутри',
  '## Известные проблемы',
  '## Проверки',
  '## Обновление',
];

/**
 * §5: плейсхолдеры версий/ссылок. Полный набор — закрытый: любой новый
 * `{{...}}` в шаблоне обязан пройти через эту правку осознанно (незаполненный
 * плейсхолдер виден в draft — механизм «пропустить сложно», §4 спеки).
 * `{{model|«ИИ не входит»}}` — плейсхолдер с явным fallback'ом: сборка без ИИ.
 */
const EXPECTED_PLACEHOLDERS: ReadonlyArray<string> = [
  '{{app}}',
  '{{schema}}',
  '{{scale}}',
  '{{model|«ИИ не входит»}}',
  '{{audit}}',
  '{{perf}}',
  '{{dod}}',
];

/** Текст от заголовка до следующего заголовка/горизонтальной черты. */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) {
    return '';
  }
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## |\n---/);
  return next === -1 ? rest : rest.slice(0, next);
}

function sectionIndexes(text: string): number[] {
  return TEMPLATE_SECTIONS.map((heading) => text.indexOf(heading));
}

function collectPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{\{[^{}]*\}\}/g)].map((m) => m[0]).sort();
}

describe('TASK-114: шаблон .github/release-template.md — секции §5', () => {
  it('содержит все шесть секций §5 в порядке «Что нового → … → Обновление»', () => {
    const indexes = sectionIndexes(template);
    for (const [i, heading] of TEMPLATE_SECTIONS.entries()) {
      expect(indexes[i], `секция не найдена: ${heading}`).toBeGreaterThan(-1);
    }
    const ordered = [...indexes].every((at, i) => i === 0 || at > indexes[i - 1]!);
    expect(ordered, `секции вне порядка: ${TEMPLATE_SECTIONS.join(' → ')}`).toBe(true);
  });

  it('версии внутри — все 4 строки §5 (приложение/схема/шкала/модель) в секции «Версии внутри»', () => {
    const versions = sectionOf(template, '## Версии внутри');
    for (const marker of ['Приложение:', 'Схема БД:', 'Справочная шкала:', 'ИИ-модель:']) {
      expect(versions, `строка версий не найдена: ${marker}`).toContain(marker);
    }
  });

  it('плейсхолдеры {{}} — ровно ожидаемый набор §5, без чужих', () => {
    const found = collectPlaceholders(template);
    expect(found.length, 'каждый плейсхолдер встречается ровно один раз').toBe(new Set(found).size);
    expect(found).toEqual([...EXPECTED_PLACEHOLDERS].sort());
  });

  it('секция «Обновление» — инструкция авто-обновления и ручной установки', () => {
    const update = sectionOf(template, '## Обновление');
    expect(update).toMatch(/авто[- ]обновлени/iu);
    expect(update).toMatch(/вручную/iu);
    expect(update).toMatch(/Assets|установщик/iu);
  });

  it('дисклеймер «не медсовет» — строка в шаблоне (каждая версия, §5)', () => {
    expect(template).toContain('не является медицинской консультацией');
  });

  it('«Известные проблемы» — предписывает явную пустую формулировку (§13)', () => {
    const known = sectionOf(template, '## Известные проблемы');
    expect(known).toContain('Существенных известных проблем нет');
  });

  it('чек-лист полноты §13 — версии 4 типов, аудит-линк, дисклеймер, известные проблемы', () => {
    const checklist = sectionOf(template, 'СЛУЖЕБНЫЙ ЧЕК-ЛИСТ');
    expect(checklist).not.toBe('');
    const items = [...checklist.matchAll(/^- \[ \] (.+)$/gmu)].map((m) => m[1] ?? '');
    expect(items.length, 'чек-лист не пуст').toBeGreaterThan(0);
    const joined = items.join('\n');
    for (const [marker, label] of [
      ['4', 'версии всех 4 типов'],
      ['аудит', 'аудит-линк'],
      ['исклеймер', 'дисклеймер'],
      ['вестные проблемы', 'известные проблемы'],
    ] as const) {
      expect(
        items.some((item) => item.includes(marker)),
        `чек-лист §13 без пункта: ${label}`,
      ).toBe(true);
      expect(joined.length, label).toBeGreaterThan(0);
    }
  });

  it('гигиена §14 — пункт «без путей пользователя, секретов, сырых логов»', () => {
    const checklist = sectionOf(template, 'СЛУЖЕБНЫЙ ЧЕК-ЛИСТ');
    expect(checklist).toMatch(/путей пользователя/u);
    expect(checklist).toMatch(/секретов/u);
    expect(checklist).toMatch(/логов/u);
  });
});

describe('TASK-114: пример docs/release/notes-example.md — заполненные notes', () => {
  it('зеркалит все секции шаблона в том же порядке', () => {
    const indexes = sectionIndexes(example);
    for (const [i, heading] of TEMPLATE_SECTIONS.entries()) {
      expect(indexes[i], `в примере нет секции: ${heading}`).toBeGreaterThan(-1);
    }
    const ordered = [...indexes].every((at, i) => i === 0 || at > indexes[i - 1]!);
    expect(ordered, 'секции примера вне порядка шаблона').toBe(true);
  });

  it('заполнен: ни одного незакрытого {{}}-плейсхолдера (это пример заполнения)', () => {
    expect(collectPlaceholders(example)).toEqual([]);
  });

  it('версии заполнены фактическими значениями сборки rc-прогона 105', () => {
    const versions = sectionOf(example, '## Версии внутри');
    expect(versions).toMatch(/Приложение: \S+/u);
    expect(versions).toMatch(/Схема БД: \d+/u);
    expect(versions).toMatch(/Справочная шкала: \S+ /u);
    expect(versions).toMatch(/ИИ-модель: /u);
  });

  it('пустые известные проблемы сформулированы явно (§13), дисклеймер на месте', () => {
    expect(sectionOf(example, '## Известные проблемы')).toContain(
      'Существенных известных проблем нет',
    );
    expect(example).toContain('не является медицинской консультацией');
  });

  it('секция «Проверки» ссылается на аудит/perf/DoD-документы репозитория', () => {
    const checks = sectionOf(example, '## Проверки');
    expect(checks).toContain('docs/architecture/audits/');
    expect(checks).toContain('docs/release/perf-mvp.md');
    expect(checks).toContain('docs/release/mvp-dod.md');
  });

  it('помечен как пример (не путать с публикуемыми notes)', () => {
    expect(example).toMatch(/Пример/u);
  });
});

describe('TASK-114: пайплайн 105 заливает шаблон в draft дословно (§19)', () => {
  it('«Prepare release notes» копирует .github/release-template.md без преобразований', () => {
    expect(workflow).toContain('.github/release-template.md');
    expect(workflow).toContain('cp "$template" "$out"');
  });

  it('draft берёт тело из release-notes.md (body_path) + автоген changelog ниже', () => {
    expect(workflow).toContain('body_path: release-notes.md');
    expect(workflow).toMatch(/^ {10}generate_release_notes: true$/mu);
  });
});
