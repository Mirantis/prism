/**
 * Slack thread classification — the Slack side of the decision.
 *
 * The participation rule (`isBotInThread`) reads the thread from Slack and
 * builds the transcript that `classifyThreadMessage` hands to the shared
 * classifier. The classifier itself is tested in
 * `thread-reply-classifier.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockGenerateObject, mockGetClassificationRequest, mockTrackEvent } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  mockGetClassificationRequest: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

// Spread the real module: importing the Slack adapter pulls in `invoke.ts`,
// which needs `jsonSchema` and friends. Only `generateObject` is faked.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: mockGenerateObject,
}));
vi.mock('../../lib/classification', () => ({
  getClassificationRequest: mockGetClassificationRequest,
}));
vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));
vi.mock('../../lib/backend-client', () => ({ backendClient: {} }));
vi.mock('@slack/bolt', () => ({
  App: vi.fn(),
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

import { slackAdapterService } from '../slack-adapter.service';

type ThreadMessage = { user?: string; text?: string; ts?: string };
type ArrivingMessage = { user: string; text: string; ts: string };

/** `classifyThreadMessage` is private; exercise it through the instance. */
function classify(messages: ThreadMessage[]): Promise<{ action: string; emoji?: string }> {
  return (
    slackAdapterService as unknown as {
      classifyThreadMessage(
        m: ThreadMessage[],
        botUserId: string,
        agentId: string,
      ): Promise<{ action: string; emoji?: string }>;
    }
  ).classifyThreadMessage(messages, 'BOT1', 'agent-1');
}

/** `isBotInThread` is private too; same route. */
function gate(arriving: ArrivingMessage): Promise<{
  result: { action: string; emoji?: string };
  messages: ThreadMessage[];
}> {
  return (
    slackAdapterService as unknown as {
      isBotInThread(
        channelId: string,
        threadTs: string,
        teamId: string,
        arriving: ArrivingMessage,
      ): Promise<{ result: { action: string; emoji?: string }; messages: ThreadMessage[] }>;
    }
  ).isBotInThread('C1', '100.0', 'T1', arriving);
}

/** Install a fake Bolt app whose `conversations.replies` is `replies`. */
function armThread(replies: ReturnType<typeof vi.fn>): void {
  (slackAdapterService as unknown as { apps: Map<string, unknown> }).apps = new Map([
    ['T1', { app: { client: { conversations: { replies } } }, botUserId: 'BOT1' }],
  ]);
}

/** What the Slack read returns, oldest first. */
function reads(...messages: ThreadMessage[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ messages });
}

const TRANSCRIPT = [
  { user: 'U1', text: 'hey <@BOT1> what broke the build?' },
  { user: 'BOT1', text: 'A failing lint rule.' },
];

/** The thread the gate reads, oldest first. */
const PARENT = { user: 'U1', text: 'hey <@BOT1> can you open the PR?', ts: '100.0' };
const BOT_REPLY = { user: 'BOT1', text: 'Opened PR 194.', ts: '200.0' };

/** The message the gate has to judge. */
const ARRIVING: ArrivingMessage = { user: 'U1', text: 'Approved - you can merge 194', ts: '300.0' };

describe('Slack thread classification', () => {
  beforeEach(() => {
    // `mockReset: true` in vitest.config wipes implementations between tests,
    // so the stubs are re-armed here rather than at declaration.
    mockGetClassificationRequest.mockReturnValue({
      model: 'mock-classification-model',
      providerOptions: {},
      samplingParams: { temperature: 0 },
    });
    mockGenerateObject.mockResolvedValue({ object: { action: 'respond' } });
    // The shared config mock (test-utils/setup.ts) carries neither field.
    config.llmProvider = 'bedrock-mantle';
    config.classificationModelId = 'anthropic.claude-haiku-4-5';
  });

  describe('the transcript the gate judges', () => {
    it('appends the arriving message when the read has not caught up', async () => {
      armThread(reads(PARENT, BOT_REPLY));

      const { messages } = await gate(ARRIVING);

      expect(messages).toEqual([PARENT, BOT_REPLY, ARRIVING]);
    });

    it('hands the classifier a transcript ending on the arriving message', async () => {
      armThread(reads(PARENT, BOT_REPLY));

      const { messages } = await gate(ARRIVING);
      await classify(messages);

      const { prompt } = mockGenerateObject.mock.calls[0][0];
      expect(prompt.split('\n').at(-1)).toBe('[User:U1]: Approved - you can merge 194');
    });

    it('does not duplicate the arriving message when the read already holds it', async () => {
      armThread(reads(PARENT, BOT_REPLY, { ...ARRIVING }));

      const { messages } = await gate(ARRIVING);

      expect(messages).toHaveLength(3);
      expect(messages.filter((m) => m.ts === ARRIVING.ts)).toHaveLength(1);
    });

    it('cuts a message posted after the arriving one out of the transcript', async () => {
      // A second reply can land while this gate call is in flight. The caller
      // reacts to or answers the arriving message, so that is the one judged.
      armThread(
        reads(PARENT, BOT_REPLY, { ...ARRIVING }, { user: 'U2', text: 'wait', ts: '400.0' }),
      );

      const { messages } = await gate(ARRIVING);

      expect(messages.at(-1)).toEqual(ARRIVING);
    });

    it('counts the appended message as a non-bot message at the end of the thread', async () => {
      // The read ends on the bot's own reply. The scan has to find that reply
      // behind the appended message rather than at the end of the array.
      armThread(reads(PARENT, BOT_REPLY));

      await expect(gate(ARRIVING)).resolves.toMatchObject({ result: { action: 'respond' } });
    });

    it('ignores a thread the bot never posted in', async () => {
      armThread(reads({ user: 'U1', text: 'starting a thread', ts: '100.0' }));

      const { result, messages } = await gate(ARRIVING);

      expect(result).toEqual({ action: 'ignore' });
      expect(messages.at(-1)).toEqual(ARRIVING);
    });

    it('ignores the message when the workspace has no app', async () => {
      (slackAdapterService as unknown as { apps: Map<string, unknown> }).apps = new Map();

      await expect(gate(ARRIVING)).resolves.toEqual({ result: { action: 'ignore' }, messages: [] });
    });

    it('ignores the message when the thread read fails', async () => {
      armThread(vi.fn().mockRejectedValue(new Error('ratelimited')));

      await expect(gate(ARRIVING)).resolves.toEqual({ result: { action: 'ignore' }, messages: [] });
    });
  });

  describe('a conversation branched to another human', () => {
    it('does not react to a third-party tag in an earlier message', async () => {
      // The tag is history: the thread turned to UOTHER01 once, and the message
      // that arrived now is addressed to the bot.
      armThread(
        reads(PARENT, BOT_REPLY, { user: 'U2', text: 'cc <@UOTHER01> can you look?', ts: '250.0' }),
      );

      await expect(gate(ARRIVING)).resolves.toMatchObject({ result: { action: 'respond' } });
    });

    it('reacts when the arriving message tags somebody other than the bot', async () => {
      armThread(reads(PARENT, BOT_REPLY));

      const { result } = await gate({ user: 'U1', text: 'thanks <@UOTHER01>', ts: '300.0' });

      expect(result).toEqual({ action: 'react', emoji: 'eyes' });
    });

    it('does not read a tag of the bot itself as a branch', async () => {
      armThread(reads(PARENT, BOT_REPLY));

      const { result } = await gate({ user: 'U1', text: 'ping <@BOT1>', ts: '300.0' });

      expect(result).toEqual({ action: 'respond' });
    });
  });
});
