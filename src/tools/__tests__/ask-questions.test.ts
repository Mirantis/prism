/** What the `ask_questions` tool accepts, and what it tells the agent. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../services/question-cards/question-card.service', () => ({
  questionCardService: { post: mockPost },
}));

import { ASK_QUESTIONS_RESULT, getAskQuestionsTools } from '../ask-questions';
import { askQuestionsInputSchema } from '../../services/question-cards/question-card-schema';

const option = (label: string) => ({ label });
const question = (over: Record<string, unknown> = {}) => ({ text: 'Which one?', options: [option('A'), option('B')], ...over });
const accepts = (input: unknown) => askQuestionsInputSchema.safeParse(input).success;

describe('ask_questions input', () => {
  it('defaults allowOther on and multiSelect off', () => {
    const parsed = askQuestionsInputSchema.parse({ questions: [question()] });
    expect(parsed.questions[0]).toMatchObject({ allowOther: true, multiSelect: false });
  });

  it.each([
    ['no questions', { questions: [] }],
    ['eight questions', { questions: Array.from({ length: 8 }, () => question()) }],
    ['one option', { questions: [question({ options: [option('A')] })] }],
    ['five options', { questions: [question({ options: ['A', 'B', 'C', 'D', 'E'].map(option) })] }],
    ['question text over 300', { questions: [question({ text: 'x'.repeat(301) })] }],
    ['a header over 40', { questions: [question({ header: 'x'.repeat(41) })] }],
    ['a label over 80', { questions: [question({ options: [option('x'.repeat(81)), option('B')] })] }],
    ['a detail over 200', { questions: [question({ options: [{ label: 'A', detail: 'x'.repeat(201) }, option('B')] })] }],
    ['an intro over 300', { intro: 'x'.repeat(301), questions: [question()] }],
    ['two options with one label', { questions: [question({ options: [option('A'), option('A')] })] }],
    ['a recommended option that is not offered', { questions: [question({ recommended: 'C' })] }],
  ])('refuses %s', (_name, input) => {
    expect(accepts(input)).toBe(false);
  });

  it('takes every field at its limit', () => {
    expect(
      accepts({
        intro: 'x'.repeat(300),
        questions: Array.from({ length: 7 }, () => ({
          text: 'x'.repeat(300),
          header: 'x'.repeat(40),
          options: [
            { label: 'a'.repeat(80), detail: 'x'.repeat(200) },
            { label: 'b'.repeat(80) },
            { label: 'c'.repeat(80) },
            { label: 'd'.repeat(80) },
          ],
          recommended: 'a'.repeat(80),
        })),
      }),
    ).toBe(true);
  });
});

describe('ask_questions', () => {
  const tools = () => getAskQuestionsTools('user', 'agent', 'thread', 'websocket', undefined);
  const run = (tool: Tool, input: unknown) => (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {});

  beforeEach(() => {
    mockPost.mockReset();
  });

  it('is not offered without a conversation to post in', () => {
    expect(getAskQuestionsTools('user', 'agent', undefined, 'websocket', undefined)).toEqual({});
  });

  it('tells the agent to put a lead-in in intro, which the card shows above the questions', () => {
    expect(tools().ask_questions.description).toContain('Put any lead-in in intro');
  });

  it('posts for its conversation and tells the agent to end the turn', async () => {
    mockPost.mockResolvedValue({});
    const input = askQuestionsInputSchema.parse({ questions: [question()] });
    await expect(run(tools().ask_questions, input)).resolves.toEqual(ASK_QUESTIONS_RESULT);
    expect(ASK_QUESTIONS_RESULT.message).toMatch(/End this turn/);
    expect(mockPost).toHaveBeenCalledWith(
      { userId: 'user', agentId: 'agent', threadId: 'thread', originChannel: 'websocket', originChannelId: undefined },
      input,
    );
  });
});
