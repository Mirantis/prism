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

/** `classifyThreadMessage` is private; exercise it through the instance. */
function classify(
  messages: Array<{ user?: string; text?: string }>,
): Promise<{ action: string; emoji?: string }> {
  return (
    slackAdapterService as unknown as {
      classifyThreadMessage(
        m: Array<{ user?: string; text?: string }>,
        botUserId: string,
        agentId: string,
      ): Promise<{ action: string; emoji?: string }>;
    }
  ).classifyThreadMessage(messages, 'BOT1', 'agent-1');
}

const TRANSCRIPT = [
  { user: 'U1', text: 'hey <@BOT1> what broke the build?' },
  { user: 'BOT1', text: 'A failing lint rule.' },
];

describe('Slack thread classification', () => {
  beforeEach(() => {
    // `mockReset: true` in vitest.config wipes implementations between tests,
    // so the stubs are re-armed here rather than at declaration.
    mockGetClassificationRequest.mockReturnValue({
      model: 'mock-classification-model',
      providerOptions: {},
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

  it('passes the classification model and a deterministic temperature', async () => {
    await classify(TRANSCRIPT);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mock-classification-model', temperature: 0 }),
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
});
