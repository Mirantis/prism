/**
 * Thread reply classifier — structured-output wiring, fail-open, telemetry.
 *
 * Some platforms reject the SDK's native structured-output path (bedrock-mantle
 * answers 400 "output_config.format: Extra inputs are not permitted";
 * Foundry-hosted Azure rejects by design). Which ones is the *provider's*
 * business: the classifier forwards what the active provider asks for, and
 * these tests pin that indirection rather than any vendor's value.
 *
 * Worth testing at the request shape because the failure is invisible in
 * behavior: a failed call answers `respond`, so a regression just makes the bot
 * answer every threaded message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockGenerateObject, mockGetClassificationRequest, mockTrackEvent } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  mockGetClassificationRequest: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

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

import { threadReplyClassifierService, ThreadLine } from '../thread-reply-classifier.service';

const TRANSCRIPT: ThreadLine[] = [
  { fromBot: false, author: 'U1', text: 'hey what broke the build?' },
  { fromBot: true, author: 'BOT1', text: 'A failing lint rule.' },
  { fromBot: false, author: 'U1', text: 'Approved - you can merge 194' },
];

function classify(lines: ThreadLine[] = TRANSCRIPT, platform: 'slack' | 'teams' = 'slack') {
  return threadReplyClassifierService.classify({ platform, agentId: 'agent-1', lines });
}

describe('threadReplyClassifierService', () => {
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

  describe('the request', () => {
    it('forwards whatever structured-output options the active provider asks for', async () => {
      // A deliberately fictional vendor key: the classifier passes the
      // provider's answer through untouched.
      mockGetClassificationRequest.mockReturnValue({
        model: 'mock-classification-model',
        providerOptions: { acme: { mode: 'widget' } },
      });

      await classify();

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({ providerOptions: { acme: { mode: 'widget' } } }),
      );
    });

    it('passes the classification model and the provider-declared sampling params', async () => {
      await classify();

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

      await classify();

      expect(mockGenerateObject.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    it('opts out of LLM tracing', async () => {
      // The prompt is a transcript of a chat channel, and a registered telemetry
      // integration traces every call that does not say otherwise.
      await classify();

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({ experimental_telemetry: { isEnabled: false } }),
      );
    });

    it('labels each line by author and ends on the judged message', async () => {
      await classify();

      const { prompt } = mockGenerateObject.mock.calls[0][0];
      expect(prompt.split('\n')).toEqual([
        '[User:U1]: hey what broke the build?',
        '[Bot]: A failing lint rule.',
        '[User:U1]: Approved - you can merge 194',
      ]);
    });

    it('reads the ten newest lines', async () => {
      const lines = Array.from({ length: 14 }, (_, i) => ({
        fromBot: false,
        author: 'U1',
        text: `message ${i}`,
      }));

      await classify(lines);

      const { prompt } = mockGenerateObject.mock.calls[0][0];
      expect(prompt.split('\n')).toHaveLength(10);
      expect(prompt.split('\n')[0]).toBe('[User:U1]: message 4');
    });

    it('names the platform the thread is on', async () => {
      await classify(TRANSCRIPT, 'teams');

      const { system } = mockGenerateObject.mock.calls[0][0];
      expect(system).toContain('You are a Microsoft Teams thread classifier');
    });

    it('names an approval a respond and tells the model to prefer respond when unsure', async () => {
      // An assertion on wording, deliberately: the classifier's verdict is not
      // traced, so the criteria the model is given are visible nowhere else.
      await classify();

      const { system } = mockGenerateObject.mock.calls[0][0];
      expect(system).toContain('an approval');
      expect(system).toContain('whoever in the thread asks it');
      expect(system).toContain(
        'When you are unsure whether the last message asks the bot for something, choose "respond".',
      );
    });
  });

  describe('the verdict', () => {
    it.each([
      ['respond', 'respond', { action: 'respond' }],
      ['no_reply', 'ignore', { action: 'no_reply' }],
    ] as const)('reads the model label %s as %s', async (_label, action, object) => {
      mockGenerateObject.mockResolvedValue({ object });

      await expect(classify()).resolves.toEqual({ action });
    });

    it('offers the model respond and no_reply only', async () => {
      // The label name is part of where the respond boundary falls.
      await classify();

      const { schema } = mockGenerateObject.mock.calls[0][0];
      expect(schema.shape.action.options).toEqual(['respond', 'no_reply']);
    });

    it('falls back to respond when the call throws', async () => {
      mockGenerateObject.mockRejectedValue(new Error('output_config.format: Extra inputs'));

      await expect(classify()).resolves.toEqual({ action: 'respond' });
    });
  });

  describe('failure telemetry', () => {
    it.each([
      ['slack', 'slack thread classification failed'],
      ['teams', 'teams thread classification failed'],
    ] as const)('emits the %s event with the active model and error shape', async (platform, event) => {
      const err = Object.assign(new Error('output_config.format: Extra inputs'), {
        name: 'AI_APICallError',
        statusCode: 400,
      });
      mockGenerateObject.mockRejectedValue(err);

      await classify(TRANSCRIPT, platform);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        event,
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
      // A provider's error text can quote the request back, and the transcript
      // is user content.
      mockGenerateObject.mockRejectedValue(new Error('rejected: what broke the build?'));

      await classify();

      const props = JSON.stringify(mockTrackEvent.mock.calls[0][2]);
      expect(props).not.toContain('what broke the build');
      expect(props).not.toContain('rejected:');
    });

    it('omits error.status when the thrown value carries none', async () => {
      mockGenerateObject.mockRejectedValue(new Error('boom'));

      await classify();

      expect(mockTrackEvent.mock.calls[0][2]).not.toHaveProperty('error.status');
      expect(mockTrackEvent.mock.calls[0][2]).toMatchObject({ 'error.name': 'Error' });
    });

    it('emits nothing on a successful classification', async () => {
      await classify();

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });
});
