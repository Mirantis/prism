/**
 * Slack thread classification — structured-output wiring.
 *
 * The classifier is the one `generateObject` caller in the runtime, and some
 * platforms reject the SDK's native structured-output path (bedrock-mantle
 * answers 400 "output_config.format: Extra inputs are not permitted";
 * Foundry-hosted Azure rejects by design). Which ones is the *provider's*
 * business — the adapter only forwards what the active provider asks for, and
 * these tests pin that indirection rather than any vendor's value.
 *
 * Worth testing at the request shape because the failure is invisible in
 * behavior: `classifyThreadMessage` swallows the error and falls back to
 * `respond`, so a regression just makes the bot answer every threaded message
 * and never react or ignore.
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

  it('forwards whatever structured-output options the active provider asks for', async () => {
    // A deliberately fictional vendor key: the point is that the adapter passes
    // the provider's answer through untouched, not that it knows about
    // Anthropic. Each provider's own value is asserted in its own test.
    mockGetClassificationRequest.mockReturnValue({
      model: 'mock-classification-model',
      providerOptions: { acme: { mode: 'widget' } },
    });

    await classify(TRANSCRIPT);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { acme: { mode: 'widget' } } }),
    );
  });

  it('sends an empty bag when the provider needs nothing special', async () => {
    await classify(TRANSCRIPT);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: {} }),
    );
  });

  it('passes the classification model and the provider-declared sampling params', async () => {
    await classify(TRANSCRIPT);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mock-classification-model', temperature: 0 }),
    );
  });

  it('omits temperature when the provider declares empty sampling params', async () => {
    mockGetClassificationRequest.mockReturnValue({
      model: 'mock-classification-model',
      providerOptions: {},
      samplingParams: {},
    });

    await classify(TRANSCRIPT);

    expect(mockGenerateObject.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('opts out of LLM tracing', async () => {
    // The prompt here is a transcript of a Slack channel, and a registered
    // telemetry integration traces every call that does not say otherwise. No
    // behavior of the bot changes if this opt-out goes missing — the messages
    // just start arriving in the trace store.
    await classify(TRANSCRIPT);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ experimental_telemetry: { isEnabled: false } }),
    );
  });

  it('returns the reaction emoji the model chose', async () => {
    mockGenerateObject.mockResolvedValue({ object: { action: 'react', emoji: 'thumbsup' } });

    await expect(classify(TRANSCRIPT)).resolves.toEqual({ action: 'react', emoji: 'thumbsup' });
  });

  it('defaults the emoji when the model omits it', async () => {
    mockGenerateObject.mockResolvedValue({ object: { action: 'react' } });

    await expect(classify(TRANSCRIPT)).resolves.toEqual({ action: 'react', emoji: 'eyes' });
  });

  it('falls back to respond when the call throws', async () => {
    // The fail-open path that made the mantle 400 invisible in the first place.
    mockGenerateObject.mockRejectedValue(new Error('output_config.format: Extra inputs'));

    await expect(classify(TRANSCRIPT)).resolves.toEqual({ action: 'respond' });
  });

  describe('failure telemetry', () => {
    it('emits `slack thread classification failed` with the active model and error shape', async () => {
      const err = Object.assign(new Error('output_config.format: Extra inputs'), {
        name: 'AI_APICallError',
        statusCode: 400,
      });
      mockGenerateObject.mockRejectedValue(err);

      await classify(TRANSCRIPT);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'slack thread classification failed',
        null,
        expect.objectContaining({
          'agent.id': 'agent-1',
          'llm.classification_model': 'anthropic.claude-haiku-4-5',
          'error.name': 'AI_APICallError',
          'error.status': '400',
        }),
      );
    });

    it('never puts the transcript or the error message in the event', async () => {
      // The whole point of the shape helper: a provider's error text can quote
      // the request back, and the transcript is user content.
      mockGenerateObject.mockRejectedValue(new Error('rejected: what broke the build?'));

      await classify(TRANSCRIPT);

      const props = JSON.stringify(mockTrackEvent.mock.calls[0][2]);
      expect(props).not.toContain('what broke the build');
      expect(props).not.toContain('rejected:');
    });

    it('omits error.status when the thrown value carries none', async () => {
      mockGenerateObject.mockRejectedValue(new Error('boom'));

      await classify(TRANSCRIPT);

      expect(mockTrackEvent.mock.calls[0][2]).not.toHaveProperty('error.status');
      expect(mockTrackEvent.mock.calls[0][2]).toMatchObject({ 'error.name': 'Error' });
    });

    it('emits nothing on a successful classification', async () => {
      await classify(TRANSCRIPT);

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('respond criteria', () => {
    it('names an approval a respond and tells the model to prefer respond when unsure', async () => {
      // An assertion on wording, deliberately: the classifier's verdict is not
      // traced, so the criteria the model is given are visible nowhere else,
      // and a message the gate drops leaves only an emoji behind.
      await classify(TRANSCRIPT);

      const { system } = mockGenerateObject.mock.calls[0][0];
      expect(system).toContain('an approval');
      expect(system).toContain(
        'When you are unsure whether the last message asks the bot for something, choose "respond".',
      );
    });
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
