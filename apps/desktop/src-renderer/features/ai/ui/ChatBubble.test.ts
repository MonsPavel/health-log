/**
 * TASK-090 §19: компонентные тесты бабла чата (презентационный — состояния в
 * пропах, прецедент SummaryView):
 *  - user — data-kind="user" (визуально справа/акцент — класс-ассерт), assistant —
 *    data-kind="assistant" (нейтрал);
 *  - отказ (refusalClass присутствует) — data-kind="refusal" + info-иконка (§5
 *    «отказ-ответы стилем системного сообщения»); у обычного ответа иконки нет;
 *  - подписи ролей для скринридера (§16): sr-only «Вы:» / «Помощник:»;
 *  - контент — как есть (без markdown-рендера, §5 «не включено»).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import '../../../i18n';
import { ChatBubble } from './ChatBubble';

afterEach(() => {
  cleanup();
});

describe('ChatBubble — визуальные роли ленты (§5/§10)', () => {
  it('user-бабл: data-kind="user", sr-only подпись «Вы:», текст как есть', () => {
    render(createElement(ChatBubble, { role: 'user', content: 'Как менялось давление?' }));

    const bubble = screen.getByTestId('chat-bubble');
    expect(bubble.getAttribute('data-kind')).toBe('user');
    expect(bubble.textContent).toContain('Как менялось давление?');
    expect(screen.getByText('Вы:')).toBeDefined();
  });

  it('assistant-бабл: data-kind="assistant", sr-only подпись «Помощник:», info-иконки нет', () => {
    render(
      createElement(ChatBubble, {
        role: 'assistant',
        content: 'Давление стабильное.\n\nЭто не является медицинской консультацией.',
      }),
    );

    const bubble = screen.getByTestId('chat-bubble');
    expect(bubble.getAttribute('data-kind')).toBe('assistant');
    expect(bubble.textContent).toContain('Это не является медицинской консультацией.');
    expect(screen.getByText('Помощник:')).toBeDefined();
    expect(screen.queryByTestId('chat-refusal-icon')).toBeNull();
  });

  it('отказ (refusalClass) — data-kind="refusal" + info-иконка (§5/§13)', () => {
    render(
      createElement(ChatBubble, {
        role: 'assistant',
        content: 'Я не советую препараты.\n\nЭто не является медицинской консультацией.',
        refusalClass: 'treatment',
      }),
    );

    const bubble = screen.getByTestId('chat-bubble');
    expect(bubble.getAttribute('data-kind')).toBe('refusal');
    expect(screen.getByTestId('chat-refusal-icon')).toBeDefined();
    expect(screen.getByText('Помощник:')).toBeDefined();
  });

  it('классы выравнивания: user — акцент справа (ml-auto), assistant — нейтрал слева', () => {
    const first = render(createElement(ChatBubble, { role: 'user', content: 'вопрос' }));
    const userBubble = screen.getByTestId('chat-bubble');
    expect(userBubble.className).toContain('ml-auto');
    expect(userBubble.className).toContain('bg-accent');
    first.unmount();

    render(createElement(ChatBubble, { role: 'assistant', content: 'ответ' }));
    const assistantBubble = screen.getByTestId('chat-bubble');
    expect(assistantBubble.className).not.toContain('ml-auto');
    expect(assistantBubble.className).toContain('bg-neutral-100');
  });

  it('стрим (TASK-109 §13): busy → aria-busy на бабле — дельты не озвучиваются внутри polite-ленты; без busy атрибута нет', () => {
    const streaming = render(
      createElement(ChatBubble, { role: 'assistant', content: 'частичный текст', busy: true }),
    );
    expect(screen.getByTestId('chat-bubble').getAttribute('aria-busy')).toBe('true');
    streaming.unmount();

    render(createElement(ChatBubble, { role: 'assistant', content: 'финальный текст' }));
    expect(screen.getByTestId('chat-bubble').getAttribute('aria-busy')).toBeNull();
  });
});
