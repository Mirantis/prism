/**
 * Webhook Service Tests
 *
 * Covers prompt template rendering (hermes semantics), event-type resolution
 * and filtering, generic sender verification, deliver-only vs agent-mode
 * handling, scoped vs broadcast delivery, and the budget/error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInvoke,
  mockPublishToLatestThread,
  mockPublish,
  mockGetOrCreateLatestThread,
  mockGetOrCreateThreadByExternalId,
  mockGetAgent,
  mockGetMainChannel,
  mockGetTeamsMainChannel,
  mockSubscriptionFindUnique,
  mockSlackMappingFindFirst,
  mockTeamsMappingFindFirst,
  mockTrackEvent,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockPublishToLatestThread: vi.fn(),
  mockPublish: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetOrCreateThreadByExternalId: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetMainChannel: vi.fn(),
  mockGetTeamsMainChannel: vi.fn(),
  mockSubscriptionFindUnique: vi.fn(),
  mockSlackMappingFindFirst: vi.fn(),
  mockTeamsMappingFindFirst: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToLatestThread: mockPublishToLatestThread,
    publish: mockPublish,
  },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
    getOrCreateThreadByExternalId: mockGetOrCreateThreadByExternalId,
  },
}));

vi.mock('./agent-workspace.service', () => ({
  agentWorkspaceService: {
    getAgent: mockGetAgent,
  },
}));

vi.mock('./slack-mapping.service', () => ({
  slackMappingService: {
    getMainChannel: mockGetMainChannel,
  },
}));

vi.mock('./teams/teams-mapping.service', () => ({
  teamsMappingService: {
    getMainChannel: mockGetTeamsMainChannel,
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    webhookSubscription: {
      findUnique: mockSubscriptionFindUnique,
    },
    slackMapping: {
      findFirst: mockSlackMappingFindFirst,
    },
    teamsMapping: {
      findFirst: mockTeamsMappingFindFirst,
    },
  },
}));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import {
  webhookService,
  renderWebhookPrompt,
  resolveEventType,
  parseEventsList,
  normalizeWebhookName,
  isValidDeliverTo,
  WEBHOOK_MAX_PENDING,
} from './webhook.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT = { id: 'agent-1', userId: 'user-1', webhooksEnabled: true };

function createSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    agentId: 'agent-1',
    name: 'alerts',
    description: null,
    events: null,
    prompt: null,
    deliverTo: 'all',
    deliverOnly: false,
    isActive: true,
    authType: 'none',
    authHeader: null,
    authPrefix: null,
    authAlgorithm: 'sha256',
    authEncoding: 'hex',
    secret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function invokeResult(text: string, overrides: Record<string, unknown> = {}) {
  return {
    response: text,
    toolCalls: [],
    steps: [{ text, toolCalls: [] }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue(AGENT);
  mockGetOrCreateLatestThread.mockResolvedValue({ id: 'thread-1' });
  // Default: no Slack/Teams destination linked. Scoped tests override these.
  mockSlackMappingFindFirst.mockResolvedValue(null);
  mockGetMainChannel.mockResolvedValue(null);
  mockTeamsMappingFindFirst.mockResolvedValue(null);
  mockGetTeamsMainChannel.mockResolvedValue(null);
  mockGetOrCreateThreadByExternalId.mockImplementation((_u, _a, ext) =>
    Promise.resolve({ id: `thread-for-${ext}` }),
  );
});

// ---------------------------------------------------------------------------
// renderWebhookPrompt
// ---------------------------------------------------------------------------

describe('renderWebhookPrompt', () => {
  it('dumps the raw payload with an event/route lead-in when template is empty', () => {
    const out = renderWebhookPrompt('', { status: 'firing' }, 'unknown', 'alerts');
    expect(out).toContain("Webhook event 'unknown' on route 'alerts'");
    expect(out).toContain('"status": "firing"');
    expect(out).toContain('```json');
  });

  it('resolves dot-path keys into nested payloads', () => {
    const payload = { pull_request: { title: 'Fix bug', user: { login: 'octocat' } } };
    const out = renderWebhookPrompt(
      'PR: {pull_request.title} by {pull_request.user.login}',
      payload,
      'pull_request',
      'gh',
    );
    expect(out).toBe('PR: Fix bug by octocat');
  });

  it('replaces {__raw__} with the full pretty-printed payload', () => {
    const out = renderWebhookPrompt('Payload:\n{__raw__}', { a: 1 }, 'unknown', 'r');
    expect(out).toContain('"a": 1');
  });

  it('leaves unresolvable keys literal', () => {
    const out = renderWebhookPrompt('Missing: {nope.deep}', { other: 1 }, 'unknown', 'r');
    expect(out).toBe('Missing: {nope.deep}');
  });

  it('serializes object values as JSON', () => {
    const out = renderWebhookPrompt('Labels: {commonLabels}', { commonLabels: { a: 'b' } }, 'unknown', 'r');
    expect(out).toContain('"a": "b"');
  });

  it('truncates the raw dump to the cap', () => {
    const big = { data: 'x'.repeat(10_000) };
    const out = renderWebhookPrompt('', big, 'unknown', 'r');
    // lead-in + fenced block wrapper around a 4000-char JSON slice
    expect(out.length).toBeLessThan(4200);
  });
});

// ---------------------------------------------------------------------------
// resolveEventType / parseEventsList
// ---------------------------------------------------------------------------

describe('resolveEventType', () => {
  it('prefers the GitHub header, then GitLab, then payload event_type, then unknown', () => {
    expect(
      resolveEventType({ 'x-github-event': 'push', 'x-gitlab-event': 'mr' }, { event_type: 'e' }),
    ).toBe('push');
    expect(resolveEventType({ 'x-gitlab-event': 'Merge Request Hook' }, {})).toBe('Merge Request Hook');
    expect(resolveEventType({}, { event_type: 'incident' })).toBe('incident');
    expect(resolveEventType({}, {})).toBe('unknown');
  });

  it('handles array-valued headers', () => {
    expect(resolveEventType({ 'x-github-event': ['issues'] }, {})).toBe('issues');
  });
});

describe('parseEventsList', () => {
  it('splits and trims, dropping empties', () => {
    expect(parseEventsList(' push, pull_request ,,')).toEqual(['push', 'pull_request']);
    expect(parseEventsList(null)).toEqual([]);
    expect(parseEventsList('')).toEqual([]);
  });
});

describe('validation helpers', () => {
  it('normalizes names like hermes (trim, lowercase, spaces → hyphens)', () => {
    expect(normalizeWebhookName('  GitHub Push ')).toBe('github-push');
    expect(normalizeWebhookName(42)).toBe('');
  });

  it('accepts only known deliver targets', () => {
    expect(isValidDeliverTo('all')).toBe(true);
    expect(isValidDeliverTo('chat')).toBe(true);
    expect(isValidDeliverTo('slack')).toBe(true);
    expect(isValidDeliverTo('log')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleInbound — gates
// ---------------------------------------------------------------------------

describe('handleInbound gates', () => {
  it('rejects when the receiver is disabled', async () => {
    mockGetAgent.mockResolvedValue({ ...AGENT, webhooksEnabled: false });
    const result = await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    expect(result).toEqual({ status: 'receiver_disabled' });
    expect(mockSubscriptionFindUnique).not.toHaveBeenCalled();
  });

  it('404s unknown subscription names', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(null);
    const result = await webhookService.handleInbound('nope', {}, {}, 'run-1');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('rejects disabled subscriptions', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ isActive: false }));
    const result = await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    expect(result).toEqual({ status: 'subscription_disabled' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('ignores events not in the allowlist without invoking', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ events: 'pull_request,issues' }));
    const result = await webhookService.handleInbound(
      'alerts',
      {},
      { 'x-github-event': 'push' },
      'run-1',
    );
    expect(result).toEqual({ status: 'ignored', event: 'push' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });

  it('accepts allowlisted events', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ events: 'push' }));
    mockInvoke.mockResolvedValue(invokeResult('done'));
    const result = await webhookService.handleInbound(
      'alerts',
      {},
      { 'x-github-event': 'push' },
      'run-1',
    );
    expect(result).toEqual({ status: 'accepted', event: 'push' });
  });
});

// ---------------------------------------------------------------------------
// handleInbound — sender verification
// ---------------------------------------------------------------------------

describe('handleInbound sender verification', () => {
  const BODY = '{"status":"firing"}';
  const rawBody = Buffer.from(BODY, 'utf8');
  const signature = crypto.createHmac('sha256', 'shhh').update(rawBody).digest('hex');
  const hmacSub = (overrides: Record<string, unknown> = {}) =>
    createSubscription({
      authType: 'hmac',
      authHeader: 'X-Signature',
      secret: 'shhh',
      ...overrides,
    });

  it('accepts a correctly signed delivery', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub());
    mockInvoke.mockResolvedValue(invokeResult('done'));
    const result = await webhookService.handleInbound(
      'alerts',
      JSON.parse(BODY),
      { 'x-signature': signature },
      'run-1',
      rawBody,
    );
    expect(result).toEqual({ status: 'accepted', event: 'unknown' });
  });

  it('rejects a tampered signature without invoking or delivering', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub());
    const result = await webhookService.handleInbound(
      'alerts',
      JSON.parse(BODY),
      { 'x-signature': 'sha256-nonsense' },
      'run-1',
      rawBody,
    );
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects an unsigned delivery', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub());
    const result = await webhookService.handleInbound('alerts', {}, {}, 'run-1', rawBody);
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
  });

  it('rejects when the raw body was not captured, so nothing can be verified', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub());
    const result = await webhookService.handleInbound(
      'alerts',
      JSON.parse(BODY),
      { 'x-signature': signature },
      'run-1',
      undefined,
    );
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
  });

  it('rejects a subscription that demands verification but stores no secret', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub({ secret: null }));
    const result = await webhookService.handleInbound(
      'alerts',
      JSON.parse(BODY),
      { 'x-signature': signature },
      'run-1',
      rawBody,
    );
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('verifies before the event filter, so probes cannot map the allowlist', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(hmacSub({ events: 'push' }));
    const result = await webhookService.handleInbound(
      'alerts',
      {},
      { 'x-github-event': 'issues' },
      'run-1',
      rawBody,
    );
    // 'ignored' would tell the caller its event type was understood.
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
  });

  it('verifies before a deliver-only publish', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(
      hmacSub({ deliverOnly: true, prompt: 'Alert: {status}' }),
    );
    const result = await webhookService.handleInbound(
      'alerts',
      JSON.parse(BODY),
      {},
      'run-1',
      rawBody,
    );
    expect(result).toEqual({ status: 'unauthorized', authType: 'hmac' });
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });

  it('accepts a shared token in the configured header', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(
      createSubscription({
        authType: 'token',
        authHeader: 'Authorization',
        authPrefix: 'Bearer ',
        secret: 'shhh',
        deliverOnly: true,
        prompt: 'ok',
      }),
    );
    const result = await webhookService.handleInbound(
      'alerts',
      {},
      { authorization: 'Bearer shhh' },
      'run-1',
    );
    expect(result).toEqual({ status: 'delivered', event: 'unknown' });
  });

  it("leaves authType 'none' subscriptions unverified", async () => {
    mockSubscriptionFindUnique.mockResolvedValue(
      createSubscription({ deliverOnly: true, prompt: 'ok' }),
    );
    const result = await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    expect(result).toEqual({ status: 'delivered', event: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// handleInbound — deliver-only
// ---------------------------------------------------------------------------

describe('handleInbound deliver-only', () => {
  it('publishes the rendered template directly without invoking the LLM', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(
      createSubscription({ deliverOnly: true, prompt: 'Alert: {commonLabels.alertname}' }),
    );
    const result = await webhookService.handleInbound(
      'alerts',
      { commonLabels: { alertname: 'HighMemory' } },
      {},
      'run-1',
    );
    expect(result).toEqual({ status: 'delivered', event: 'unknown' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockPublishToLatestThread).toHaveBeenCalledWith(
      'agent-1',
      'user-1',
      'Alert: HighMemory',
      'WEBHOOK',
      undefined,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'webhook processed',
      'user-1',
      expect.objectContaining({ 'webhook.status': 'delivered_direct', 'webhook.run_id': 'run-1' }),
    );
  });

  it('scopes deliver-only chat delivery via channelContext', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(
      createSubscription({ deliverOnly: true, deliverTo: 'chat', prompt: 'ping' }),
    );
    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'thread-1',
      'ping',
      'WEBHOOK',
      expect.objectContaining({
        channelContext: { channel: 'websocket', threadId: 'thread-1' },
      }),
    );
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleInbound — agent mode
// ---------------------------------------------------------------------------

describe('handleInbound agent mode', () => {
  it('returns accepted immediately and delivers the final response when the run finishes', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription());
    let resolveInvoke!: (v: unknown) => void;
    mockInvoke.mockReturnValue(new Promise((r) => (resolveInvoke = r)));

    const result = await webhookService.handleInbound('alerts', { status: 'firing' }, {}, 'run-1');
    expect(result).toEqual({ status: 'accepted', event: 'unknown' });
    // Fire-and-forget: nothing delivered while the run is in flight.
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();

    resolveInvoke(invokeResult('All clear — noise alert.'));
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalled());

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'webhook', userId: 'user-1', agentId: 'agent-1' }),
    );
    expect(mockPublishToLatestThread).toHaveBeenCalledWith(
      'agent-1',
      'user-1',
      '**Webhook: alerts**\n\nAll clear — noise alert.',
      'WEBHOOK',
      expect.objectContaining({}),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'webhook processed',
      'user-1',
      expect.objectContaining({ 'webhook.status': 'completed' }),
    );
  });

  it('personal mode: stores slack-scoped output in the DM thread (keyed by dmChannelId), hidden from web', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'slack' }));
    mockSlackMappingFindFirst.mockResolvedValue({ dmChannelId: 'D123' });
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

    // Keyed on the DM channel id → the same DATABASE thread the DM chat uses,
    // hidden from web Recents by the listThreads externalThreadId filter.
    expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith('user-1', 'agent-1', 'D123');
    expect(mockGetMainChannel).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'thread-for-D123',
      '**Webhook: alerts**\n\nhandled',
      'WEBHOOK',
      expect.objectContaining({
        channelContext: { channel: 'slack', threadId: 'thread-for-D123' },
      }),
    );
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });

  it('team mode: stores slack-scoped output in a thread keyed by the main channel id', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'slack' }));
    mockSlackMappingFindFirst.mockResolvedValue(null); // no DM link
    mockGetMainChannel.mockResolvedValue('C_MAIN');
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

    expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith('user-1', 'agent-1', 'C_MAIN');
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'thread-for-C_MAIN',
      '**Webhook: alerts**\n\nhandled',
      'WEBHOOK',
      expect.objectContaining({ channelContext: { channel: 'slack', threadId: 'thread-for-C_MAIN' } }),
    );
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });

  it('no Slack linked: falls back to the web latest thread and warns', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'slack' }));
    mockSlackMappingFindFirst.mockResolvedValue(null);
    mockGetMainChannel.mockResolvedValue(null);
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalled());

    expect(mockGetOrCreateThreadByExternalId).not.toHaveBeenCalled();
    expect(mockPublishToLatestThread).toHaveBeenCalledWith(
      'agent-1',
      'user-1',
      '**Webhook: alerts**\n\nhandled',
      'WEBHOOK',
      expect.objectContaining({}),
    );
  });

  it('personal mode: stores teams-scoped output in the DM-conversation thread, hidden from web', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'teams' }));
    mockTeamsMappingFindFirst.mockResolvedValue({ dmConversationId: 'a:dm-1' });
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

    expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith('user-1', 'agent-1', 'a:dm-1');
    expect(mockGetTeamsMainChannel).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'thread-for-a:dm-1',
      '**Webhook: alerts**\n\nhandled',
      'WEBHOOK',
      expect.objectContaining({
        channelContext: { channel: 'teams', threadId: 'thread-for-a:dm-1' },
      }),
    );
    expect(mockPublishToLatestThread).not.toHaveBeenCalled();
  });

  it('team mode: stores teams-scoped output in a thread keyed by the main channel conversation id', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'teams' }));
    mockTeamsMappingFindFirst.mockResolvedValue(null); // no DM link
    mockGetTeamsMainChannel.mockResolvedValue('19:main@thread.tacv2');
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

    expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith(
      'user-1',
      'agent-1',
      '19:main@thread.tacv2',
    );
    // A channel destination MUST carry channelId: a Teams channelContext
    // without one is DM-scoped in the adapter and would deliver nothing in
    // Team Mode (no DM link).
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'thread-for-19:main@thread.tacv2',
      '**Webhook: alerts**\n\nhandled',
      'WEBHOOK',
      expect.objectContaining({
        channelContext: {
          channel: 'teams',
          channelId: '19:main@thread.tacv2',
          threadId: 'thread-for-19:main@thread.tacv2',
        },
      }),
    );
  });

  it('no Teams linked: falls back to the web latest thread and warns', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription({ deliverTo: 'teams' }));
    mockInvoke.mockResolvedValue(invokeResult('handled'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalled());

    expect(mockGetOrCreateThreadByExternalId).not.toHaveBeenCalled();
  });

  it('delivers a friendly budget note when the run hits the spending limit', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription());
    mockInvoke.mockResolvedValue(
      invokeResult('', { error: { type: 'budget_exceeded', detail: 'monthly cap' } }),
    );

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalled());

    const [, , content] = mockPublishToLatestThread.mock.calls[0];
    expect(content).toContain('spending limit');
    expect(content).toContain('monthly cap');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'webhook processed',
      'user-1',
      expect.objectContaining({ 'webhook.status': 'budget_exceeded' }),
    );
  });

  it('delivers a failure notice when the run throws (the sender will not retry)', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription());
    mockInvoke.mockRejectedValue(new Error('bedrock down'));

    await webhookService.handleInbound('alerts', {}, {}, 'run-1');
    await vi.waitFor(() =>
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'webhook processed',
        'user-1',
        expect.objectContaining({ 'webhook.status': 'error' }),
      ),
    );
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalled());
    const [, , content] = mockPublishToLatestThread.mock.calls[0];
    expect(content).toContain('**Webhook: alerts**');
    expect(content).toContain('bedrock down');
  });

  it('queues concurrent deliveries and runs them serially, dropping nothing', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription());
    const resolvers: Array<(v: unknown) => void> = [];
    mockInvoke.mockImplementation(() => new Promise((r) => resolvers.push(r)));

    // Two distinct events arrive back-to-back — both are accepted.
    const first = await webhookService.handleInbound('alerts', { n: 1 }, {}, 'run-1');
    const second = await webhookService.handleInbound('alerts', { n: 2 }, {}, 'run-2');
    expect(first).toEqual({ status: 'accepted', event: 'unknown' });
    expect(second).toEqual({ status: 'accepted', event: 'unknown' });

    // Serial execution: the second run does not start until the first finishes.
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    resolvers[0](invokeResult('first done'));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    resolvers[1](invokeResult('second done'));

    // Both events produced a delivered message — nothing was dropped.
    await vi.waitFor(() => expect(mockPublishToLatestThread).toHaveBeenCalledTimes(2));
    const contents = mockPublishToLatestThread.mock.calls.map((c) => c[2]);
    expect(contents).toContain('**Webhook: alerts**\n\nfirst done');
    expect(contents).toContain('**Webhook: alerts**\n\nsecond done');
  });

  it('rejects deliveries once the per-subscription queue is full', async () => {
    mockSubscriptionFindUnique.mockResolvedValue(createSubscription());
    let resolveFirst!: (v: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((r) => (resolveFirst = r)));

    // One in flight + WEBHOOK_MAX_PENDING queued — all accepted.
    const inFlight = await webhookService.handleInbound('alerts', {}, {}, 'run-0');
    expect(inFlight.status).toBe('accepted');
    for (let i = 0; i < WEBHOOK_MAX_PENDING; i++) {
      const queued = await webhookService.handleInbound('alerts', {}, {}, `run-${i + 1}`);
      expect(queued.status).toBe('accepted');
    }

    // The next one overflows the cap.
    const overflow = await webhookService.handleInbound('alerts', {}, {}, 'run-overflow');
    expect(overflow).toEqual({ status: 'busy' });

    // Unwind so the queued runs don't leak into other tests.
    mockInvoke.mockResolvedValue(invokeResult('done'));
    resolveFirst(invokeResult('done'));
    await vi.waitFor(() =>
      expect(mockPublishToLatestThread).toHaveBeenCalledTimes(WEBHOOK_MAX_PENDING + 1),
    );
  });
});
