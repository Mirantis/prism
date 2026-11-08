// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import { isQuestionCard, questionCardBlocks, type QuestionCardBlock } from '@/types';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';
import type { Viewer } from '@/lib/chat-socket/protocol';
import ChatMessage from './ChatMessage';
import { QuestionCard } from './question-card';

const ADA: Viewer = { id: 'ada-id', name: 'Ada Example' };

const BLOCK: QuestionCardBlock = {
  type: 'question_card',
  id: 'card-1',
  status: 'waiting',
  otherMaxLength: 500,
  questions: [
    {
      text: 'How much can we spend?',
      header: 'Budget',
      options: [{ label: 'Under €500', detail: 'fits the current plan' }, { label: 'Over €500' }],
      recommended: 'Under €500',
      allowOther: true,
      multiSelect: false,
    },
    {
      text: 'Which channels?',
      options: [{ label: 'Newsletter' }, { label: 'Webinar' }],
      allowOther: false,
      multiSelect: true,
    },
  ],
};

const ONE: QuestionCardBlock = { ...BLOCK, questions: [BLOCK.questions[0]] };
const ANSWERED: QuestionCardBlock = {
  ...BLOCK,
  status: 'answered',
  answers: [{ options: [0] }, { options: [] }],
  answeredBy: { id: 'grace-id', name: 'Grace Example' },
};

const radio = (name: RegExp | string) => screen.getByRole('radio', { name });
const checkbox = (name: RegExp | string) => screen.getByRole('checkbox', { name });
const send = (name = 'Send answers') => screen.getByRole('button', { name });
const status = () => screen.getByTestId('question-card-status').textContent;
/** Focus and press Send, as a keyboard or pointer does in a browser. */
const pressSend = (name = 'Send answers') => {
  const button = send(name);
  button.focus();
  fireEvent.click(button);
};
const show = (block: QuestionCardBlock, viewer: Viewer | undefined = ADA) => render(<QuestionCard block={block} viewer={viewer} />);

describe('QuestionCard', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  describe('waiting', () => {
    it('shows every question with nothing chosen and Send disabled', () => {
      show(BLOCK);
      expect(screen.getByRole('heading', { name: '2 questions' })).toBeTruthy();
      expect(screen.getByText('Choose your answers, then send them. You can skip any question.')).toBeTruthy();
      expect(screen.getAllByRole('radio').some((input) => (input as HTMLInputElement).checked)).toBe(false);
      expect(screen.getAllByRole('checkbox').some((input) => (input as HTMLInputElement).checked)).toBe(false);
      expect((send() as HTMLButtonElement).disabled).toBe(true);
      expect(status()).toBe('0 of 2 answered');
    });

    it('words a single question in the singular and shows no count or number', () => {
      show(ONE);
      expect(screen.getByRole('heading', { name: '1 question' })).toBeTruthy();
      expect(screen.getByText('Choose an answer, then send it.')).toBeTruthy();
      expect(screen.queryByTestId('question-card-status')).toBeNull();
      expect(screen.getByRole('group', { name: /How much can we spend\?/ }).querySelector('legend')?.textContent).not.toMatch(/1\./);
      expect(send('Send answer')).toBeTruthy();
    });

    it('names the group of questions after the card title', () => {
      show(BLOCK);
      expect(screen.getByRole('group', { name: '2 questions' }).contains(radio(/Over €500/))).toBe(true);
    });

    it('names Recommended with the option and describes it by its detail', () => {
      show(BLOCK);
      const recommended = radio('Under €500, Recommended');
      expect(recommended.getAttribute('aria-describedby')).toBeTruthy();
      expect(document.getElementById(recommended.getAttribute('aria-describedby')!)?.textContent).toBe('fits the current plan');
    });

    it('marks a multi-select question and uses checkboxes for it', () => {
      show(BLOCK);
      expect(screen.getByText('Choose any')).toBeTruthy();
      expect(checkbox('Newsletter')).toBeTruthy();
    });

    it('offers Other last, only where the question allows it', () => {
      show(BLOCK);
      const group = within(screen.getByRole('group', { name: /How much can we spend/ }));
      expect(group.getAllByRole('radio').at(-1)).toBe(group.getByRole('radio', { name: 'Other…' }));
      expect(screen.getAllByText('Other…')).toHaveLength(1);
    });

    it('counts an answer, enables Send and shows Clear only then', () => {
      show(BLOCK);
      expect(screen.queryByRole('button', { name: 'Clear answer to question 1' })).toBeNull();
      fireEvent.click(radio(/Over €500/));
      expect(status()).toBe('1 of 2 answered');
      expect((send() as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Clear answer to question 1' }));
      expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(false);
      expect(status()).toBe('0 of 2 answered');
    });

    it.each([
      ['single-select', /Over €500/, 'radio', 'Under €500, Recommended', 'Clear answer to question 1'],
      ['multi-select', 'Webinar', 'checkbox', 'Newsletter', 'Clear answer to question 2'],
    ] as const)('moves focus to the first option after Clear on a %s question', (_name, choose, role, first, clear) => {
      show(BLOCK);
      fireEvent.click(screen.getByRole(role, { name: choose }));
      const button = screen.getByRole('button', { name: clear });
      button.focus();
      fireEvent.click(button);
      expect(document.activeElement).toBe(screen.getByRole(role, { name: first }));
      expect(screen.queryByRole('button', { name: clear })).toBeNull();
    });

    it('opens the Other field, counts it only with text, and keeps the text when another option is chosen', () => {
      show(BLOCK);
      fireEvent.click(radio('Other…'));
      const field = screen.getByRole('textbox', { name: 'Your answer to question 1' }) as HTMLTextAreaElement;
      expect(field.placeholder).toBe('Type your answer');
      expect(field.maxLength).toBe(500);
      expect(status()).toBe('0 of 2 answered');
      fireEvent.change(field, { target: { value: 'As little as we can' } });
      expect(status()).toBe('1 of 2 answered');
      fireEvent.click(radio(/Over €500/));
      expect(screen.queryByRole('textbox')).toBeNull();
      fireEvent.click(radio('Other…'));
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('As little as we can');
    });
  });

  describe('intro', () => {
    const INTRO = 'A few decisions before I draft the plan.';
    const intro = () => screen.queryByTestId('question-card-intro');
    const follows = (first: Element, second: Element) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('shows the intro directly under the title and above the first question', () => {
      show({ ...BLOCK, intro: INTRO });
      const title = screen.getByRole('heading', { name: '2 questions' });
      expect(intro()?.textContent).toBe(INTRO);
      expect(title.nextElementSibling).toBe(intro());
      expect(follows(intro()!, screen.getByRole('group', { name: /How much can we spend/ }))).toBe(true);
    });

    it('uses the secondary text colour of the helper line', () => {
      show({ ...BLOCK, intro: INTRO });
      expect(intro()?.className).toContain('text-muted-foreground');
    });

    it('renders nothing for no intro or an empty one, so the helper line follows the title', () => {
      for (const block of [BLOCK, { ...BLOCK, intro: '' }]) {
        const { unmount } = show(block);
        expect(intro()).toBeNull();
        expect(screen.getByRole('heading', { name: '2 questions' }).nextElementSibling?.textContent).toBe(
          'Choose your answers, then send them. You can skip any question.',
        );
        unmount();
      }
    });

    it('shows Markdown and links as plain text', () => {
      const text = 'See **this** [link](https://example.com)';
      show({ ...BLOCK, intro: text });
      expect(intro()?.textContent).toBe(text);
      expect(intro()?.querySelector('a, strong')).toBeNull();
    });

    it('shows the whole of a 300-character intro and wraps it', () => {
      const text = 'x'.repeat(300);
      show({ ...BLOCK, intro: text });
      expect(intro()?.textContent).toBe(text);
      expect(intro()?.className).toContain('break-words');
      expect(intro()?.className).not.toMatch(/truncate|line-clamp/);
    });

    it.each([
      ['answered', { ...ANSWERED, intro: INTRO }],
      ['answered in chat', { ...BLOCK, status: 'answered_in_chat' as const, intro: INTRO }],
    ])('folds away on a card %s, and Show questions brings it back above the first question', (_name, block) => {
      show(block);
      expect(intro()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show questions' }));
      expect(intro()?.textContent).toBe(INTRO);
      expect(follows(intro()!, screen.getByText(/How much can we spend\?/))).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Hide questions' }));
      expect(intro()).toBeNull();
    });
  });

  describe('sending', () => {
    it('sends the choices, marks the card busy and disables the controls meanwhile', async () => {
      let finish = (_value: { card: QuestionCardBlock }) => {};
      const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockReturnValue(new Promise((resolve) => (finish = resolve)));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      fireEvent.click(checkbox('Webinar'));
      pressSend();

      await screen.findByRole('button', { name: 'Sending…' });
      expect(call).toHaveBeenCalledWith('card-1', [{ options: [1] }, { options: [1] }]);
      expect(screen.getByTestId('question-card').getAttribute('aria-busy')).toBe('true');
      expect((radio(/Under €500/) as HTMLInputElement).matches(':disabled')).toBe(true);

      finish({ card: { ...ANSWERED, answeredBy: { id: 'ada-id', name: 'Ada Example' } } });
      await screen.findByRole('heading', { name: 'Answered by you' });
      expect(screen.getByTestId('question-card').getAttribute('aria-busy')).toBe('false');
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Answered by you' }));
      expect(screen.queryByTestId('question-card-notice')).toBeNull();
    });

    it('leaves focus in the composer when the person moved there during a slow send', async () => {
      const composer = document.body.appendChild(document.createElement('textarea'));
      let finish = (_value: { card: QuestionCardBlock }) => {};
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockReturnValue(new Promise((resolve) => (finish = resolve)));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('button', { name: 'Sending…' });
      composer.focus();

      finish({ card: ANSWERED });
      await screen.findByRole('heading', { name: 'Answered by Grace Example' });

      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    it('sends a trimmed Other, and no Other when its field is closed', async () => {
      const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED });
      show(BLOCK);
      fireEvent.click(radio('Other…'));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '  mine  ' } });
      pressSend();
      await waitFor(() => expect(call).toHaveBeenCalledWith('card-1', [{ options: [], other: 'mine' }, { options: [] }]));
    });

    it('shows the error line and keeps the choices when the send fails', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new TypeError('Failed to fetch'));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Couldn’t send your answers. Check your connection, then try again.');
      expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(true);
      expect((send() as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the stored card from a 409, with who answered first', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('closed', {}, 409, { card: ANSWERED }));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      const title = await screen.findByRole('heading', { name: 'Answered by Grace Example' });
      expect(screen.getByTestId('question-card-notice').textContent).toBe(
        'Grace Example answered first. Your choices weren’t sent.',
      );
      expect(document.activeElement).toBe(title);
    });

    it.each([400, 404])('says a %i cannot be fixed by trying again', async (status) => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('refused', {}, status));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Couldn’t send these answers. Reload the page to see the current questions.');
      expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(true);
    });

    it('shows the card answered and says the reply is pending on a 202', async () => {
      const line = 'Your answers are saved. The agent will reply after its next restart.';
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED, replyPending: true });
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('heading', { name: 'Answered by Grace Example' });
      expect(screen.getByTestId('question-card-notice').textContent).toBe(line);
      expect(screen.getByRole('status').textContent).toBe(line);
    });

    it('treats a 409 with no stored card as a failed send', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('closed', {}, 409, {}));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      expect(await screen.findByRole('alert')).toBeTruthy();
    });
  });

  describe('the status region', () => {
    const LINE = 'Grace Example answered first. Your choices weren’t sent.';

    it('is on the waiting card, empty, and is the same element that holds the line after a 409', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('closed', {}, 409, { card: ANSWERED }));
      show(BLOCK);
      const region = screen.getByRole('status');
      expect(region.textContent).toBe('');

      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('heading', { name: 'Answered by Grace Example' });

      expect(screen.getByRole('status')).toBe(region);
      expect(region.textContent).toBe(LINE);
      expect(screen.getByTestId('question-card-notice').getAttribute('aria-hidden')).toBe('true');
    });

    it('holds the line when a live update closes the card', () => {
      const { rerender } = show(BLOCK);
      const region = screen.getByRole('status');
      fireEvent.click(radio(/Over €500/));
      rerender(<QuestionCard block={ANSWERED} viewer={ADA} />);
      expect(screen.getByRole('status')).toBe(region);
      expect(region.textContent).toBe(LINE);
    });
  });

  describe('a live update', () => {
    const update = (rerender: (ui: React.ReactElement) => void, block: QuestionCardBlock) =>
      rerender(<QuestionCard block={block} viewer={ADA} />);

    it('closes the card and says the choices were not sent', () => {
      const { rerender } = show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      update(rerender, ANSWERED);
      expect(screen.getByRole('heading', { name: 'Answered by Grace Example' })).toBeTruthy();
      expect(screen.getByTestId('question-card-notice')).toBeTruthy();
    });

    it('moves focus to the title only when focus was inside the card', () => {
      const { rerender } = show(BLOCK);
      const input = radio(/Over €500/);
      input.focus();
      fireEvent.focus(input);
      update(rerender, ANSWERED);
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Answered by Grace Example' }));
    });

    it('leaves focus alone after a click on a row and then on blank page space', () => {
      const { rerender } = show(BLOCK);
      const input = radio(/Over €500/);
      input.focus();
      fireEvent.click(input);
      input.blur();
      expect(document.activeElement).toBe(document.body);
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

      update(rerender, ANSWERED);

      expect(document.activeElement).toBe(document.body);
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('leaves focus alone when it was elsewhere', () => {
      const outside = document.body.appendChild(document.createElement('button'));
      outside.focus();
      const { rerender } = show(BLOCK);
      update(rerender, ANSWERED);
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });

    it('says nothing about unsent choices when none were made', () => {
      const { rerender } = show(BLOCK);
      update(rerender, ANSWERED);
      expect(screen.queryByTestId('question-card-notice')).toBeNull();
    });

    it('says nothing about another device of the same person', () => {
      const { rerender } = show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      update(rerender, { ...ANSWERED, answeredBy: { id: 'ada-id', name: 'Ada Example' } });
      expect(screen.getByRole('heading', { name: 'Answered by you' })).toBeTruthy();
      expect(screen.queryByTestId('question-card-notice')).toBeNull();
    });
  });

  describe('closed', () => {
    it('folds to one line and opens read-only with the answers', () => {
      show(ANSWERED);
      expect(screen.getByRole('heading', { name: 'Answered by Grace Example' })).toBeTruthy();
      expect(screen.getByText('1 of 2 answered')).toBeTruthy();
      expect(screen.queryByText(/How much can we spend\?/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show questions' }));
      expect(screen.getByRole('button', { name: 'Hide questions' })).toBeTruthy();
      expect(screen.getByText(/How much can we spend\?/)).toBeTruthy();
      expect(screen.getByText('Under €500')).toBeTruthy();
      expect(screen.getByText('No answer')).toBeTruthy();
      expect(screen.queryByRole('radio')).toBeNull();
    });

    it('shows the Other text as typed', () => {
      show({ ...ANSWERED, answers: [{ options: [], other: 'As little as we can' }, { options: [] }] });
      fireEvent.click(screen.getByRole('button', { name: 'Show questions' }));
      expect(screen.getByText('As little as we can')).toBeTruthy();
    });

    it('reads Answered when nobody was named, and for a viewer with no identity', () => {
      show({ ...ANSWERED, answeredBy: null }, { id: null, name: null });
      expect(screen.getByRole('heading', { name: 'Answered' })).toBeTruthy();
    });

    it('shows no count for a single question', () => {
      show({ ...ONE, status: 'answered', answers: [{ options: [0] }], answeredBy: null });
      expect(screen.queryByText(/of 1 answered/)).toBeNull();
    });

    it('shows Answered in chat, with the questions only', () => {
      show({ ...BLOCK, status: 'answered_in_chat' });
      expect(screen.getByRole('heading', { name: 'Answered in chat' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Show questions' }));
      expect(screen.getByText(/How much can we spend\?/)).toBeTruthy();
      expect(screen.queryByText('No answer')).toBeNull();
    });
  });
});

describe('isQuestionCard', () => {
  it('takes a whole card', () => {
    expect(isQuestionCard(BLOCK)).toBe(true);
    expect(isQuestionCard(ANSWERED)).toBe(true);
  });

  it.each([
    ['another block', { type: 'computer_help', id: 'x' }],
    ['no questions', { ...BLOCK, questions: [] }],
    ['an unknown status', { ...BLOCK, status: 'expired' }],
    ['a malformed question', { ...BLOCK, questions: [{ text: 'q' }] }],
    ['an intro that is not text', { ...BLOCK, intro: 3 }],
    ['answers that do not match the questions', { ...BLOCK, answers: [{ options: [] }] }],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(isQuestionCard(value)).toBe(false);
  });
});

describe('ChatMessage with a question card', () => {
  afterEach(cleanup);

  const message = (blocks: unknown[]): TranscriptMessage => ({
    id: 'message-1',
    threadId: 'thread-1',
    role: 'AGENT',
    content: 'The questions as plain text.',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: blocks as TranscriptMessage['blocks'],
    isCompacted: false,
    createdAt: '2026-11-08T08:38:51.086Z',
    attachments: null,
    senderId: null,
    senderName: null,
  });
  const renderMessage = (blocks: unknown[]) =>
    render(<ChatMessage message={message(blocks)} agentName="Prism" viewer={ADA} onOpenComputerHelp={vi.fn()} onRetry={vi.fn()} onEdit={vi.fn()} />);

  it('draws the card in place of the text', () => {
    renderMessage([BLOCK]);
    expect(screen.getByTestId('question-card')).toBeTruthy();
    expect(screen.queryByText('The questions as plain text.')).toBeNull();
  });

  it('falls back to the text for a malformed card', () => {
    renderMessage([{ type: 'question_card', id: 'x', status: 'waiting' }]);
    expect(questionCardBlocks(message([{ type: 'question_card' }]))).toEqual([]);
    expect(screen.queryByTestId('question-card')).toBeNull();
    expect(screen.getByText('The questions as plain text.')).toBeTruthy();
  });
});
