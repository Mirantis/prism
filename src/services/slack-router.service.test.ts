/**
 * Slack router service tests, over HTTP on the `slack` listener: the ingress
 * header, the envelope checks, the answer the router gets for each outcome, and
 * what each kind of envelope does before and after that answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';

const { mockPendingWork, shutdown } = vi.hoisted(() => ({
  mockPendingWork: {
    claim: vi.fn(),
    finish: vi.fn(),
    end: vi.fn(),
  },
  shutdown: { aborted: false },
}));

vi.mock('./pending-work.service', () => ({
  pendingWorkService: {
    ...mockPendingWork,
    get shutdownSignal() {
      return { aborted: shutdown.aborted };
    },
  },
}));
vi.mock('../config', () => ({ config: { slackPort: 0, host: '127.0.0.1' } }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { slackRouterService, type SlackRouterHandlers } from './slack-router.service';

const TEAM = 'T0EXAMPLE';

function handlers(): { [K in keyof SlackRouterHandlers]: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    link: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(true),
    handle: vi.fn().mockResolvedValue(undefined),
  };
}

let eventCount = 0;

function message(overrides: Record<string, unknown> = {}) {
  eventCount += 1;
  return {
    version: 1,
    kind: 'slack',
    eventId: `evt-${eventCount}`,
    sentAt: new Date().toISOString(),
    teamId: TEAM,
    route: 'mention',
    person: { id: 'person-1' },
    payloadType: 'event',
    payload: { type: 'message', channel: 'C0EXAMPLE', user: 'U0ALICE', text: 'hi', ts: '1761732000.000100' },
    ...overrides,
  };
}

let h: ReturnType<typeof handlers>;
let url: string;

async function post(body: unknown, headers: Record<string, string> = { 'x-nexus-webhook-verified': '1' }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Slack router listener', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPendingWork.claim.mockResolvedValue(true);
    h = handlers();
    await slackRouterService.start(h);
    const { port } = (slackRouterService as unknown as { server: { address(): AddressInfo } }).server.address();
    url = `http://127.0.0.1:${port}/agents/slack/router`;
  });

  afterEach(async () => {
    await slackRouterService.stop();
  });

  it('refuses a request the ingress did not verify', async () => {
    expect(await post(message(), {})).toEqual({ status: 401, body: { ok: false, error: 'not_verified' } });
    expect(await post(message(), { 'x-nexus-webhook-verified': '0' })).toMatchObject({ status: 401 });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON, and an envelope that fails the schema', async () => {
    expect(await post('{not json')).toEqual({ status: 400, body: { ok: false, error: 'invalid_envelope' } });
    expect(await post({ ...message(), version: 2 })).toMatchObject({ status: 400 });
    expect(await post({ ...message(), surplus: 1 })).toMatchObject({ status: 400 });
  });

  it('accepts a Slack event, records it, and handles it after the answer', async () => {
    const envelope = message();
    let finishHandling!: () => void;
    h.handle.mockImplementation(() => new Promise<void>((resolve) => (finishHandling = resolve)));

    expect(await post(envelope)).toEqual({ status: 200, body: { ok: true } });

    expect(mockPendingWork.claim).toHaveBeenCalledWith('routed-event', envelope.eventId, envelope);
    expect(h.handle).toHaveBeenCalledWith(envelope, expect.any(Function));
    expect(mockPendingWork.end).not.toHaveBeenCalled();
    finishHandling();
    await settle();
    expect(mockPendingWork.end).toHaveBeenCalledWith('routed-event', envelope.eventId);
  });

  it('ends the record at the hand-off, also during a shutdown', async () => {
    const envelope = message();
    h.handle.mockImplementation(async (_envelope, handOff: () => void) => handOff());

    await post(envelope);
    await settle();

    expect(mockPendingWork.finish).toHaveBeenCalledWith('routed-event', envelope.eventId);
    expect(mockPendingWork.end).not.toHaveBeenCalled();
  });

  it('answers a repeated event id without handling it again', async () => {
    const envelope = message();

    await post(envelope);
    expect(await post({ ...envelope, sentAt: new Date().toISOString() })).toEqual({ status: 200, body: { ok: true } });

    expect(h.handle).toHaveBeenCalledTimes(1);
  });

  it('answers a retry sent during the first attempt with that attempt\'s outcome', async () => {
    const envelope = message();
    let finishReady!: (ready: boolean) => void;
    h.ready.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishReady = resolve)));

    const first = post(envelope);
    await vi.waitFor(() => expect(h.ready).toHaveBeenCalledTimes(1));
    const retry = post({ ...envelope, sentAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishReady(false);

    expect(await first).toMatchObject({ status: 503 });
    expect(await retry).toMatchObject({ status: 503 });
    expect(h.ready).toHaveBeenCalledTimes(1);
    expect(mockPendingWork.claim).not.toHaveBeenCalled();

    expect(await post(envelope)).toMatchObject({ status: 200 });
    expect(h.handle).toHaveBeenCalledTimes(1);
  });

  it('answers a retry sent during an attempt that fails with the failure', async () => {
    const envelope = message();
    let failClaim!: (error: Error) => void;
    mockPendingWork.claim.mockImplementationOnce(() => new Promise((_resolve, reject) => (failClaim = reject)));

    const first = post(envelope);
    await vi.waitFor(() => expect(mockPendingWork.claim).toHaveBeenCalledTimes(1));
    const retry = post(envelope);
    await new Promise((resolve) => setTimeout(resolve, 20));
    failClaim(new Error('database is locked'));

    expect(await first).toMatchObject({ status: 500 });
    expect(await retry).toMatchObject({ status: 500 });
    expect(await post(envelope)).toMatchObject({ status: 200 });
    expect(h.handle).toHaveBeenCalledTimes(1);
  });

  it('answers an event recorded before a restart without handling it again', async () => {
    mockPendingWork.claim.mockResolvedValue(false);

    expect(await post(message())).toEqual({ status: 200, body: { ok: true } });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('answers an envelope sent more than five minutes from this clock without applying it', async () => {
    const sentAt = new Date(Date.now() - 6 * 60_000).toISOString();

    expect(await post(message({ sentAt }))).toEqual({ status: 200, body: { ok: true } });
    expect(await post({ version: 1, kind: 'disconnected', eventId: 'evt-old', sentAt, teamId: TEAM })).toMatchObject({ status: 200 });

    expect(mockPendingWork.claim).not.toHaveBeenCalled();
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('asks the router to retry an event for a workspace with no app, and takes the retry', async () => {
    const envelope = message();
    h.ready.mockResolvedValueOnce(false);

    expect(await post(envelope)).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
    expect(mockPendingWork.claim).not.toHaveBeenCalled();

    expect(await post(envelope)).toMatchObject({ status: 200 });
    expect(h.handle).toHaveBeenCalledTimes(1);
  });

  it('applies a link before it answers', async () => {
    const link = { op: 'add', type: 'channel', channelId: 'C0EXAMPLE', personId: 'person-1' };

    const answer = await post({ version: 1, kind: 'link', eventId: 'evt-link', sentAt: new Date().toISOString(), teamId: TEAM, link });

    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(h.link).toHaveBeenCalledWith(TEAM, link);
    expect(mockPendingWork.claim).not.toHaveBeenCalled();
  });

  it('answers 500 when a link cannot be applied, and applies the retry', async () => {
    const envelope = {
      version: 1,
      kind: 'link',
      eventId: 'evt-link-retry',
      sentAt: new Date().toISOString(),
      teamId: TEAM,
      link: { op: 'remove', type: 'dm', slackUserId: 'U0ALICE', dmChannelId: 'D0ALICE', personId: 'person-1' },
    };
    h.link.mockRejectedValueOnce(new Error('database is locked'));

    expect(await post(envelope)).toEqual({ status: 500, body: { ok: false, error: 'internal_error' } });
    expect(await post(envelope)).toMatchObject({ status: 200 });
    expect(h.link).toHaveBeenCalledTimes(2);
  });

  it('connects on `connected`, and asks for a retry while the workspace is not bound', async () => {
    const connected = {
      version: 1,
      kind: 'connected',
      eventId: 'evt-connected',
      sentAt: new Date().toISOString(),
      teamId: TEAM,
      workspace: { teamId: TEAM, teamName: 'Example', botUserId: 'U0BOT', botId: 'B0BOT' },
    };
    h.connect.mockResolvedValueOnce(false);

    expect(await post(connected)).toMatchObject({ status: 503 });
    expect(await post(connected)).toMatchObject({ status: 200 });
    expect(h.connect).toHaveBeenCalledWith(TEAM);
  });

  it('refuses envelopes once a shutdown has started', async () => {
    shutdown.aborted = true;
    try {
      expect(await post(message())).toMatchObject({ status: 503 });
      expect(h.handle).not.toHaveBeenCalled();
    } finally {
      shutdown.aborted = false;
    }
  });
});

describe('Slack router resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await slackRouterService.stop();
  });

  it('handles the events a restart interrupted, and ends the ones it cannot read', async () => {
    const h2 = handlers();
    await slackRouterService.start(h2);
    const envelope = message();

    await slackRouterService.resume([
      { key: envelope.eventId, payload: envelope, attempts: 1, createdAt: new Date() },
      { key: 'evt-broken', payload: { kind: 'slack' }, attempts: 1, createdAt: new Date() },
    ]);
    await settle();

    expect(h2.handle).toHaveBeenCalledWith(envelope, expect.any(Function));
    expect(mockPendingWork.end).toHaveBeenCalledWith('routed-event', 'evt-broken');
  });

  it('ends every event when the runtime is not routed any more', async () => {
    await slackRouterService.resume([{ key: 'evt-1', payload: message(), attempts: 1, createdAt: new Date() }]);

    expect(mockPendingWork.end).toHaveBeenCalledWith('routed-event', 'evt-1');
  });
});
