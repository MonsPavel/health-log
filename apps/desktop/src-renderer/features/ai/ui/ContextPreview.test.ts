/**
 * TASK-088 §5/§10: превью «Что передаётся ИИ» — точный текст проекции (не
 * абстрактное «ваши данные»): моноширинный блок, текст КАК ЕСТЬ (без md-рендера —
 * решение §5), свёрнут до 10 строк с «Показать всё»; короткий текст — без кнопки
 * (сворачивать нечего).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextPreview } from './ContextPreview';

afterEach(cleanup);

/** 11 строк — ровно на одну больше лимита свёртки. */
const ELEVEN_LINES = Array.from({ length: 11 }, (_, index) => `строка ${index + 1}`).join('\n');

describe('ContextPreview — свёртка до 10 строк (TASK-088 §5)', () => {
  it('длинный текст: первые 10 строк видны, хвост скрыт; «Показать всё» раскрывает и сворачивает', () => {
    render(createElement(ContextPreview, { text: ELEVEN_LINES }));

    const pre = screen.getByTestId('ai-context-preview');
    expect(pre.textContent).toContain('строка 10');
    expect(pre.textContent).not.toContain('строка 11');

    fireEvent.click(screen.getByTestId('ai-context-preview-toggle'));
    expect(pre.textContent).toContain('строка 11');

    // Повторный клик — сворачивание обратно (переключатель, §10).
    fireEvent.click(screen.getByTestId('ai-context-preview-toggle'));
    expect(pre.textContent).not.toContain('строка 11');
  });

  it('короткий текст (≤10 строк) — переключателя нет (§16: элемент без действия не показывается)', () => {
    render(createElement(ContextPreview, { text: 'a\nb\nc' }));

    expect(screen.getByTestId('ai-context-preview').textContent).toContain('c');
    expect(screen.queryByTestId('ai-context-preview-toggle')).toBeNull();
  });

  it('моноширинный блок: текст как есть, маркеры markdown не рендерятся (решение §5 «без md-парсера»)', () => {
    render(createElement(ContextPreview, { text: '# Заголовок\n**жирный**' }));

    const pre = screen.getByTestId('ai-context-preview');
    expect(pre.textContent).toContain('# Заголовок');
    expect(pre.textContent).toContain('**жирный**');
  });
});
