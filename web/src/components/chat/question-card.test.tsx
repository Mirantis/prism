// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const next = () => screen.getByRole('button', { name: 'Next' });
/** The card's own status region, which follows the own-answer field's. */
const cardStatus = () => screen.getAllByRole('status').at(-1)!;
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
    it('shows the first question with nothing chosen, Skip, and Next disabled', () => {
      show(BLOCK);
      expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
      expect(screen.getAllByRole('radio').some((input) => (input as HTMLInputElement).checked)).toBe(false);
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect((next() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
      expect(status()).toBe('');
    });

    it('shows a single question with no step, no Skip and Send disabled', () => {
      show(ONE);
      expect(screen.getByRole('heading', { name: 'Question' })).toBeTruthy();
      expect(screen.queryByTestId('question-card-status')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Question 1/ })).toBeNull();
      expect((send('Send answer') as HTMLButtonElement).disabled).toBe(true);
    });

    it('names the question group after the card title', () => {
      show(BLOCK);
      expect(screen.getByRole('group', { name: 'Question 1 of 2' }).contains(radio(/Over €500/))).toBe(true);
    });

    it('names Recommended with the option and describes it by its detail', () => {
      show(BLOCK);
      const recommended = radio('Under €500, Recommended');
      expect(recommended.getAttribute('aria-describedby')).toBeTruthy();
      expect(document.getElementById(recommended.getAttribute('aria-describedby')!)?.textContent).toBe('fits the current plan');
    });

    it('names the question by its text, and shows no header label', () => {
      show(BLOCK);
      expect(screen.getByRole('group', { name: 'How much can we spend?' })).toBeTruthy();
      expect(screen.queryByText('Budget')).toBeNull();
    });

    it('numbers the options from 1', () => {
      show(BLOCK);
      expect(screen.getAllByTestId('question-card-option').map((row) => row.textContent)).toEqual([
        '1Under €500Recommendedfits the current plan',
        '2Over €500',
      ]);
    });

    it('moves to the next question when a single-select option is chosen, and focuses it', () => {
      show(BLOCK);
      fireEvent.pointerDown(radio(/Over €500/));
      fireEvent.click(radio(/Over €500/));
      expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
      expect(document.activeElement?.textContent).toBe('Which channels? Choose any');
      expect(screen.getByRole('button', { name: 'Question 1, answered' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Question 2' }).getAttribute('aria-current')).toBe('step');
    });

    it('stays on the question when an arrow key moves the choice', () => {
      show(BLOCK);
      const option = radio(/Over €500/);
      option.focus();
      fireEvent.keyDown(option, { key: 'ArrowDown' });
      fireEvent.click(option);
      expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
      expect(document.activeElement).toBe(option);
      expect((next() as HTMLButtonElement).disabled).toBe(false);
    });

    it('chooses an option with its number key and moves on', () => {
      show(BLOCK);
      fireEvent.keyDown(screen.getByRole('group', { name: 'How much can we spend?' }), { key: '2' });
      expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
      fireEvent.keyDown(document.activeElement!, { key: '2' });
      expect((checkbox('Webinar') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
      expect(status()).toBe('2 of 2 answered');
    });

    it('ignores a held number key, so the next questions keep their own answers', () => {
      show(BLOCK);
      fireEvent.keyDown(radio(/Over €500/), { key: '1' });
      fireEvent.keyDown(document.activeElement!, { key: '1', repeat: true });
      expect((checkbox('Newsletter') as HTMLInputElement).checked).toBe(false);
    });

    it('moves focus to the option a number key toggles in place', () => {
      show(BLOCK);
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      const back = screen.getByRole('button', { name: 'Back' });
      back.focus();
      fireEvent.keyDown(back, { key: '1' });
      expect((checkbox('Newsletter') as HTMLInputElement).checked).toBe(true);
      expect(document.activeElement).toBe(checkbox('Newsletter'));
    });

    it('changes nothing on a number key while sending', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockReturnValue(new Promise(() => {}));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('button', { name: 'Sending…' });
      fireEvent.keyDown(checkbox('Newsletter'), { key: '1' });
      expect((checkbox('Newsletter') as HTMLInputElement).checked).toBe(false);
    });

    it('moves on when a chosen option is clicked again, but not on an arrow key', () => {
      show(BLOCK);
      const option = radio(/Over €500/);
      fireEvent.keyDown(option, { key: 'ArrowDown' });
      fireEvent.click(option);
      expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
      fireEvent.keyDown(option, { key: ' ' });
      fireEvent.click(option);
      expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
    });

    it('keeps focus on the option of a single question, which has no next question', () => {
      show(ONE);
      const option = radio(/Over €500/);
      option.focus();
      fireEvent.click(option);
      expect(document.activeElement).toBe(option);
      expect((send('Send answer') as HTMLButtonElement).disabled).toBe(false);
    });

    it('ignores number keys typed in the own-answer field, with a modifier, or past the last option', () => {
      show(BLOCK);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: '1' });
      fireEvent.keyDown(radio(/Over €500/), { key: '1', metaKey: true });
      fireEvent.keyDown(radio(/Over €500/), { key: '3' });
      expect(screen.getAllByRole('radio').some((input) => (input as HTMLInputElement).checked)).toBe(false);
      expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
    });

    it('skips a question, and Back returns to it', () => {
      show(BLOCK);
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
      expect(status()).toBe('0 of 2 answered');
      expect((send() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
      expect(document.activeElement?.textContent).toBe('How much can we spend?');
    });

    it('keeps a choice when the person goes back, and the step buttons move between questions', () => {
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      fireEvent.click(checkbox('Webinar'));
      fireEvent.click(screen.getByRole('button', { name: 'Question 1, answered' }));
      expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
      fireEvent.click(next());
      expect((checkbox('Webinar') as HTMLInputElement).checked).toBe(true);
    });

    it('shows the count and Send on the last question, Send enabled from one answer', () => {
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      expect(status()).toBe('1 of 2 answered');
      expect((send() as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    });

    it('marks a multi-select question and uses checkboxes for it', () => {
      show(BLOCK);
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      expect(screen.getByRole('group', { name: 'Which channels? Choose any' })).toBeTruthy();
      expect(checkbox('Newsletter')).toBeTruthy();
    });

    it('shows Clear once the question has an answer, and Clear empties it', () => {
      show(BLOCK);
      expect(screen.queryByRole('button', { name: 'Clear answer to question 1' })).toBeNull();
      fireEvent.click(radio(/Over €500/));
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear answer to question 1' }));
      expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(false);
      expect((next() as HTMLButtonElement).disabled).toBe(true);
    });

    it.each([
      ['single-select', 0, /Over €500/, 'radio', 'Under €500, Recommended', 'Clear answer to question 1'],
      ['multi-select', 1, 'Webinar', 'checkbox', 'Newsletter', 'Clear answer to question 2'],
    ] as const)('moves focus to the first option after Clear on a %s question', (_name, step, choose, role, first, clear) => {
      show(BLOCK);
      fireEvent.click(screen.getByRole('button', { name: `Question ${step + 1}` }));
      const option = screen.getByRole(role, { name: choose });
      fireEvent.keyDown(option, { key: 'ArrowDown' });
      fireEvent.click(option);
      const button = screen.getByRole('button', { name: clear });
      button.focus();
      fireEvent.click(button);
      expect(document.activeElement).toBe(screen.getByRole(role, { name: first }));
      expect(screen.queryByRole('button', { name: clear })).toBeNull();
    });

    describe('the own-answer field', () => {
      const field = () => screen.getByRole('textbox', { name: 'Your answer to question 1' }) as HTMLTextAreaElement;
      const type = (value: string) => fireEvent.change(field(), { target: { value } });

      it('sits under the options where the question allows it, and nowhere else', () => {
        show(BLOCK);
        expect(field().placeholder).toBe('Or write your own response');
        expect(field().maxLength).toBe(500);
        expect(screen.queryByText('Other…')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(screen.queryByRole('textbox')).toBeNull();
      });

      it('keeps the chosen option when only whitespace is typed, and sends no own answer', async () => {
        const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED });
        show(ONE);
        fireEvent.click(radio(/Over €500/));
        type('   ');
        expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(true);
        pressSend('Send answer');
        await waitFor(() => expect(call).toHaveBeenCalledWith('card-1', [{ options: [1] }]));
      });

      it('sends only the own answer of a single-select question once text replaces the option', async () => {
        const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED });
        show(ONE);
        fireEvent.click(radio(/Over €500/));
        type('As little as we can');
        pressSend('Send answer');
        await waitFor(() => expect(call).toHaveBeenCalledWith('card-1', [{ options: [], other: 'As little as we can' }]));
      });

      it('counts as an answer only with text', () => {
        show(BLOCK);
        type('   ');
        expect((next() as HTMLButtonElement).disabled).toBe(true);
        type('As little as we can');
        expect((next() as HTMLButtonElement).disabled).toBe(false);
      });

      it('clears the chosen option on a single-select question, and an option clears the text', () => {
        show(BLOCK);
        const option = radio(/Over €500/);
        fireEvent.keyDown(option, { key: 'ArrowDown' });
        fireEvent.click(option);
        type('As little as we can');
        expect((radio(/Over €500/) as HTMLInputElement).checked).toBe(false);
        fireEvent.keyDown(radio(/Over €500/), { key: 'ArrowDown' });
        fireEvent.click(radio(/Over €500/));
        expect(field().value).toBe('');
      });

      it('keeps the options of a multi-select question beside the text', async () => {
        const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED });
        show({ ...ONE, questions: [{ ...BLOCK.questions[1], allowOther: true }] });
        fireEvent.click(checkbox('Webinar'));
        type('A podcast');
        expect((checkbox('Webinar') as HTMLInputElement).checked).toBe(true);
        pressSend('Send answer');
        await waitFor(() => expect(call).toHaveBeenCalledWith('card-1', [{ options: [1], other: 'A podcast' }]));
      });

      it('moves on with Enter once answered, and Enter never sends', () => {
        const call = vi.spyOn(runtimeApi, 'answerQuestionCard');
        show(BLOCK);
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
        type('mine');
        fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
        expect(screen.getByRole('heading', { name: 'Question 1 of 2' })).toBeTruthy();
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(screen.getByRole('heading', { name: 'Question 2 of 2' })).toBeTruthy();
        cleanup();
        show(ONE);
        type('mine');
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(call).not.toHaveBeenCalled();
      });
    });
  });

  describe('intro', () => {
    const INTRO = 'A few decisions before I draft the plan.';
    const intro = () => screen.queryByTestId('question-card-intro');
    const follows = (first: Element, second: Element) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('shows the intro under the title and above the question', () => {
      show({ ...BLOCK, intro: INTRO });
      const title = screen.getByRole('heading', { name: 'Question 1 of 2' });
      expect(intro()?.textContent).toBe(INTRO);
      expect(follows(title, intro()!)).toBe(true);
      expect(follows(intro()!, screen.getByRole('group', { name: 'How much can we spend?' }))).toBe(true);
    });

    it('stays on every question', () => {
      show({ ...BLOCK, intro: INTRO });
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      expect(intro()?.textContent).toBe(INTRO);
    });

    it('leads in the foreground colour of an agent message', () => {
      show({ ...BLOCK, intro: INTRO });
      expect(intro()?.className).toContain('text-foreground');
    });

    it('renders nothing for no intro or an empty one', () => {
      for (const block of [BLOCK, { ...BLOCK, intro: '' }]) {
        const { unmount } = show(block);
        expect(intro()).toBeNull();
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
      fireEvent.click(screen.getByRole('button', { name: /^Show questions/ }));
      expect(intro()?.textContent).toBe(INTRO);
      expect(follows(intro()!, screen.getByText(/How much can we spend\?/))).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: /^Hide questions/ }));
      expect(intro()).toBeNull();
    });
  });

  describe('the own-answer character count', () => {
    const typed = (length: number) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(length) } });
      return screen.queryByTestId('question-card-count');
    };

    it('appears when fewer than 50 characters remain, and describes the field', () => {
      show(BLOCK);
      expect(typed(450)).toBeNull();
      const count = typed(451);
      expect(count?.textContent).toBe('49 characters left');
      expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe(count?.id);
    });

    it('announces once at 20 and once at 0, and not on the keys between', () => {
      show(BLOCK);
      const region = screen.getByTestId('question-card-count-announcement');
      expect(region.getAttribute('role')).toBe('status');
      expect(region.textContent).toBe('');
      typed(479);
      expect(region.textContent).toBe('');
      typed(480);
      expect(region.textContent).toBe('20 characters left');
      typed(481);
      expect(region.textContent).toBe('');
      typed(499);
      expect(region.textContent).toBe('');
      typed(500);
      expect(region.textContent).toBe('0 characters left');
    });

    it('uses the singular for one and shows zero at the limit', () => {
      show(BLOCK);
      expect(typed(499)?.textContent).toBe('1 character left');
      expect(typed(500)?.textContent).toBe('0 characters left');
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
      expect((checkbox('Newsletter') as HTMLInputElement).matches(':disabled')).toBe(true);
      expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Question 1, answered' }) as HTMLButtonElement).disabled).toBe(true);

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

    it('sends a trimmed answer of the person’s own', async () => {
      const call = vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED });
      show(BLOCK);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '  mine  ' } });
      fireEvent.click(next());
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
      expect(status()).toBe('1 of 2 answered');
      expect(document.activeElement).toBe(send());
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

    it('says a reload is needed when the card is gone', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('gone', {}, 404));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Couldn’t send these answers. Reload the page to see the current questions.');
      expect(status()).toBe('1 of 2 answered');
    });

    it('uses the standard failure line for a 400', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('does not fit', {}, 400));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Couldn’t send your answers. Check your connection, then try again.',
      );
    });

    it('stays quiet when the socket closes the card during this person’s own send', async () => {
      const nobody: Viewer = { id: null, name: null };
      const closed: QuestionCardBlock = { ...ANSWERED, answeredBy: null };
      let finish = (_value: { card: QuestionCardBlock }) => {};
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const { rerender } = show(BLOCK, nobody);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('button', { name: 'Sending…' });

      rerender(<QuestionCard block={closed} viewer={nobody} />);

      expect(screen.getByRole('heading', { name: 'Answered' })).toBeTruthy();
      expect(screen.queryByTestId('question-card-notice')).toBeNull();
      expect(cardStatus().textContent).toBe('');

      finish({ card: closed });
      await waitFor(() => expect(screen.getByTestId('question-card').getAttribute('aria-busy')).toBe('false'));
      expect(screen.queryByTestId('question-card-notice')).toBeNull();
    });

    it('shows the card answered and says the reply is pending on a 202', async () => {
      const line = 'Your answers are saved. The reply is delayed.';
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockResolvedValue({ card: ANSWERED, replyPending: true });
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('heading', { name: 'Answered by Grace Example' });
      expect(screen.getByTestId('question-card-notice').textContent).toBe(line);
      expect(cardStatus().textContent).toBe(line);
    });

    it('treats a 409 with no stored card as a failed send', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('closed', {}, 409, {}));
      show(BLOCK);
      fireEvent.click(radio(/Over €500/));
      pressSend();
      expect(await screen.findByRole('alert')).toBeTruthy();
    });
  });

  describe('in forced-colours mode', () => {
    it('gives the buttons and the own-answer field the transparent outline the rows have', () => {
      show(BLOCK);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });
      const first = [next(), screen.getByRole('button', { name: 'Clear answer to question 1' }), screen.getByRole('textbox')];
      fireEvent.click(next());
      for (const control of [...first, send(), screen.getByRole('button', { name: 'Back' }), screen.getByRole('button', { name: 'Question 1, answered' })]) {
        expect(control.className).toContain('outline-hidden');
        expect(control.className).not.toContain('outline-none');
      }
    });
  });

  describe('the status region', () => {
    const LINE = 'Grace Example answered first. Your choices weren’t sent.';

    it('is on the waiting card, empty, and is the same element that holds the line after a 409', async () => {
      vi.spyOn(runtimeApi, 'answerQuestionCard').mockRejectedValue(new ApiError('closed', {}, 409, { card: ANSWERED }));
      show(BLOCK);
      const region = cardStatus();
      expect(region.textContent).toBe('');

      fireEvent.click(radio(/Over €500/));
      pressSend();
      await screen.findByRole('heading', { name: 'Answered by Grace Example' });

      expect(cardStatus()).toBe(region);
      expect(region.textContent).toBe(LINE);
      expect(screen.getByTestId('question-card-notice').getAttribute('aria-hidden')).toBe('true');
    });

    it('holds the line when a live update closes the card', () => {
      const { rerender } = show(BLOCK);
      const region = cardStatus();
      fireEvent.click(radio(/Over €500/));
      rerender(<QuestionCard block={ANSWERED} viewer={ADA} />);
      expect(cardStatus()).toBe(region);
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
      const { rerender } = show(ONE);
      const input = radio(/Over €500/);
      input.focus();
      fireEvent.click(input);
      input.blur();
      expect(document.activeElement).toBe(document.body);
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

      update(rerender, { ...ANSWERED, questions: ONE.questions, answers: [{ options: [0] }] });

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

    it('says another answer arrived first when the card names nobody', () => {
      const { rerender } = show(BLOCK, { id: null, name: null });
      fireEvent.click(radio(/Over €500/));
      rerender(<QuestionCard block={{ ...ANSWERED, answeredBy: null }} viewer={{ id: null, name: null }} />);
      expect(screen.getByRole('heading', { name: 'Answered' })).toBeTruthy();
      expect(screen.getByTestId('question-card-notice').textContent).toBe(
        'Another answer arrived first. Your choices weren’t sent.',
      );
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
      fireEvent.click(screen.getByRole('button', { name: /^Show questions/ }));
      expect(screen.getByRole('button', { name: /^Hide questions/ })).toBeTruthy();
      expect(screen.getByText(/How much can we spend\?/)).toBeTruthy();
      expect(screen.getByText('Under €500')).toBeTruthy();
      expect(screen.getByText('No answer')).toBeTruthy();
      expect(screen.queryByRole('radio')).toBeNull();
    });

    it('lists several choices on separate lines and numbers each question once', () => {
      show({ ...ANSWERED, answers: [{ options: [0], other: 'Yes, as little as we can' }, { options: [] }] });
      fireEvent.click(screen.getByRole('button', { name: /^Show questions/ }));
      expect(screen.getByText('Under €500').tagName).toBe('P');
      expect(screen.getByText('Yes, as little as we can').tagName).toBe('P');
      expect(screen.queryByRole('list')).toBeNull();
      expect(screen.getAllByText(/^1\. How much can we spend/)).toHaveLength(1);
    });

    it('names the disclosure with the card title and keeps the visible text', () => {
      show(ANSWERED);
      const disclosure = screen.getByRole('button', { name: 'Show questions, Answered by Grace Example' });
      expect(disclosure.textContent).toBe('Show questions');
    });

    it('adds no group around the title, so the title is spoken once', () => {
      show(ANSWERED);
      expect(screen.queryByRole('group')).toBeNull();
      expect(screen.queryByRole('region')).toBeNull();
    });

    it('shows the Other text as typed', () => {
      show({ ...ANSWERED, answers: [{ options: [], other: 'As little as we can' }, { options: [] }] });
      fireEvent.click(screen.getByRole('button', { name: /^Show questions/ }));
      expect(screen.getByText('As little as we can')).toBeTruthy();
    });

    it('reads Answered when nobody was named, and for a viewer with no identity', () => {
      show({ ...ANSWERED, answeredBy: null }, { id: null, name: null });
      expect(screen.getByRole('heading', { name: 'Answered' })).toBeTruthy();
    });

    it('shows no count when every question has an answer', () => {
      show({ ...ANSWERED, answers: [{ options: [0] }, { options: [1] }] });
      expect(screen.queryByText(/of 2 answered/)).toBeNull();
    });

    it('shows no count for a single question', () => {
      show({ ...ONE, status: 'answered', answers: [{ options: [0] }], answeredBy: null });
      expect(screen.queryByText(/of 1 answered/)).toBeNull();
    });

    it('shows Answered in chat, with the questions only', () => {
      show({ ...BLOCK, status: 'answered_in_chat' });
      expect(screen.getByRole('heading', { name: 'Answered in chat' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Show questions/ }));
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
    ['a header that is an object', { ...BLOCK, questions: [{ ...BLOCK.questions[0], header: { a: 1 } }] }],
    ['a recommended option that is an object', { ...BLOCK, questions: [{ ...BLOCK.questions[0], recommended: {} }] }],
    [
      'an option detail that is an object',
      { ...BLOCK, questions: [{ ...BLOCK.questions[0], options: [{ label: 'A', detail: {} }, { label: 'B' }] }] },
    ],
    ['a sender name that is an object', { ...ANSWERED, answeredBy: { id: 'x', name: {} } }],
    ['a sender with no id', { ...ANSWERED, answeredBy: { name: 'Grace Example' } }],
    ['an Other answer that is not text', { ...ANSWERED, answers: [{ options: [], other: {} }, { options: [] }] }],
    ['an answer index that is not a number', { ...ANSWERED, answers: [{ options: ['0'] }, { options: [] }] }],
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

  it('renders the text instead of throwing on an object-valued header', () => {
    renderMessage([{ ...BLOCK, questions: [{ ...BLOCK.questions[0], header: { a: 1 } }] }]);
    expect(screen.queryByTestId('question-card')).toBeNull();
    expect(screen.getByText('The questions as plain text.')).toBeTruthy();
  });

  it('falls back to the text for a malformed card', () => {
    renderMessage([{ type: 'question_card', id: 'x', status: 'waiting' }]);
    expect(questionCardBlocks(message([{ type: 'question_card' }]))).toEqual([]);
    expect(screen.queryByTestId('question-card')).toBeNull();
    expect(screen.getByText('The questions as plain text.')).toBeTruthy();
  });
});
