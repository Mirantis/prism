/** The two texts of a card, against the formats the design gives. */

import { describe, expect, it } from 'vitest';
import type { QuestionCardQuestion } from '../../protocol/chat-protocol';
import { answerMessageText, questionCardText } from './question-card-text';

const question = (over: Partial<QuestionCardQuestion>): QuestionCardQuestion => ({
  text: 'Pick one?',
  options: [{ label: 'A' }, { label: 'B' }],
  allowOther: true,
  multiSelect: false,
  ...over,
});

const BUDGET = question({
  text: 'How much can we spend each month?',
  header: 'Budget',
  options: [
    { label: 'Under €500', detail: 'fits the current plan' },
    { label: '€500 to €2,000' },
    { label: 'Over €2,000' },
  ],
  recommended: 'Under €500',
});
const CHANNELS = question({
  text: 'Which channels should Lina use?',
  options: [{ label: 'LinkedIn' }, { label: 'Newsletter' }],
  multiSelect: true,
});

describe('questionCardText', () => {
  it('numbers the questions, letters the options and marks the recommended one', () => {
    expect(questionCardText([BUDGET, CHANNELS], 'A few decisions first.')).toBe(
      [
        'A few decisions first.',
        '',
        '1. Budget: How much can we spend each month?',
        '   a) Under €500 – fits the current plan (recommended)',
        '   b) €500 to €2,000',
        '   c) Over €2,000',
        '2. Which channels should Lina use? Choose any.',
        '   a) LinkedIn',
        '   b) Newsletter',
        '',
        'Reply with 1a, 2b… or in your own words.',
      ].join('\n'),
    );
  });

  it('starts at the first question with no intro, and numbers a single question too', () => {
    expect(questionCardText([question({})])).toBe(
      '1. Pick one?\n   a) A\n   b) B\n\nReply with 1a, 2b… or in your own words.',
    );
  });
});

describe('answerMessageText', () => {
  const LAUNCH = question({ text: 'When?', header: 'Launch', options: [{ label: 'Soon' }, { label: 'After the summer' }] });
  const TONE = question({ text: 'Which tone?', header: 'Tone' });

  it('writes one line per question, with a blank as no answer', () => {
    expect(
      answerMessageText(
        [BUDGET, CHANNELS, LAUNCH, TONE],
        [{ options: [0] }, { options: [0, 1] }, { options: [1] }, { options: [] }],
      ),
    ).toBe(
      [
        '1. Budget: Under €500',
        '2. Which channels should Lina use? LinkedIn, Newsletter',
        '3. Launch: After the summer',
        '4. Tone: no answer',
      ].join('\n'),
    );
  });

  it('adds Other as typed, after the chosen options and without quotes', () => {
    expect(answerMessageText([CHANNELS], [{ options: [1], other: 'a stand at the fair' }])).toBe(
      '1. Which channels should Lina use? Newsletter, a stand at the fair',
    );
  });

  it('keeps each question on one line when its header, text or option holds a line break', () => {
    const broken = question({
      header: 'Bud\nget',
      options: [{ label: 'First\r\n  part' }, { label: 'B' }],
    });
    const plain = question({ text: 'Pick\none?' });
    expect(answerMessageText([broken, plain], [{ options: [0] }, { options: [1] }])).toBe('1. Bud get: First part\n2. Pick one? B');
  });

  it('adds a colon after a question text with no end punctuation', () => {
    expect(answerMessageText([question({ text: 'Pick a colour' })], [{ options: [0] }])).toBe('1. Pick a colour: A');
  });
});
