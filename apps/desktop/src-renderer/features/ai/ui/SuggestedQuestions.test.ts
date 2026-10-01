/**
 * TASK-090 §19: компонентные тесты чипов-подсказок empty-state:
 *  - ровно три чипа с текстами §5 («Как менялось давление?», «Чем отличаются
 *    утро и вечер?», «Были ли необычные значения?»);
 *  - клик — onPick с ТЕКСТОМ чипа (вставка в поле, НЕ отправка — решение §5).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { SuggestedQuestions } from './SuggestedQuestions';

afterEach(() => {
  cleanup();
});

describe('SuggestedQuestions — подсказки-примеры (§5 empty-state)', () => {
  it('три чипа с текстами спеки §5', () => {
    render(createElement(SuggestedQuestions, { onPick: () => undefined }));

    const chips = screen.getAllByTestId('chat-chip');
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Как менялось давление?',
      'Чем отличаются утро и вечер?',
      'Были ли необычные значения?',
    ]);
  });

  it('клик — onPick с текстом чипа (вставка в поле, не отправка)', () => {
    const onPick = vi.fn<(question: string) => void>();
    render(createElement(SuggestedQuestions, { onPick }));

    fireEvent.click(screen.getAllByTestId('chat-chip')[1] as HTMLElement);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('Чем отличаются утро и вечер?');
  });
});
