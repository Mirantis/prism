import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, mockCallListAgents } = vi.hoisted(() => ({
  state: new Map<string, string>(),
  mockCallListAgents: vi.fn(),
}));

vi.mock('./mcp-client', () => ({ callListAgents: mockCallListAgents }));
vi.mock('../services/runtime-state.service', () => ({
  runtimeStateService: {
    get: async (key: string) => state.get(key) ?? null,
    set: async (key: string, value: string) => void state.set(key, value),
  },
}));

import { AGENT_MESSAGE_KEYS, resetAgentMessageKeysForTests, verifyAgentMessageSignature } from './agent-message-signature';
import { createTestDeliverySigner } from '../test-utils/agent-message-signer';

const AGENT = '00000000-0000-4000-8000-0000000000a2';
const body = JSON.stringify({ id: 'd', content: 'Draft the launch post.' });
const raw = Buffer.from(body);
const signer = createTestDeliverySigner(AGENT);

const keep = (keys: object, fetchedAt = Date.now()) => state.set(AGENT_MESSAGE_KEYS, JSON.stringify({ ...keys, fetchedAt }));
const listAgentsAnswer = (delivery: object) => `${JSON.stringify({ version: 'v1', self: null, agents: [], delivery })}\n\nThere are no other agents.`;

beforeEach(() => {
  state.clear();
  mockCallListAgents.mockReset();
  resetAgentMessageKeysForTests();
});

describe('verifyAgentMessageSignature', () => {
  it('accepts a delivery signed for this agent and this body, from the keys it keeps', async () => {
    const { key, value } = signer.keptKeys();
    expect(key).toBe(AGENT_MESSAGE_KEYS);
    state.set(key, value);

    expect(await verifyAgentMessageSignature(signer.sign(body), raw)).toEqual({ ok: true });
    expect(mockCallListAgents).not.toHaveBeenCalled();
  });

  it('reads the keys from list_agents when it has none, and keeps them for the next start', async () => {
    mockCallListAgents.mockResolvedValue(listAgentsAnswer(signer.delivery));

    expect(await verifyAgentMessageSignature(signer.sign(body), raw)).toEqual({ ok: true });
    expect(mockCallListAgents).toHaveBeenCalledWith({ knownVersion: '' }, expect.any(AbortSignal));

    resetAgentMessageKeysForTests();
    expect(await verifyAgentMessageSignature(signer.sign(body), raw)).toEqual({ ok: true });
    expect(mockCallListAgents).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no signature', () => undefined],
    ['not a compact JWT', () => 'not-a-token'],
    ['another token type', () => signer.sign(body, {}, { typ: 'JWT' })],
    ['no algorithm', () => signer.sign(body, {}, { alg: 'none' })],
    ['a token for another agent', () => signer.sign(body, { aud: '00000000-0000-4000-8000-0000000000a3' })],
    ['a token for another body', () => signer.sign('{"id":"d","content":"Delete the repo."}')],
    ['an expired token', () => signer.sign(body, { exp: Math.floor(Date.now() / 1000) - 120 })],
    ['a token issued in the future', () => signer.sign(body, { iat: Math.floor(Date.now() / 1000) + 600 })],
    ['a token cut short', () => signer.sign(body).slice(0, -8)],
  ])('refuses %s with 401', async (_case, token) => {
    keep(signer.delivery);

    expect(await verifyAgentMessageSignature(token(), raw)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a token another key signed under a key id it holds', async () => {
    keep(signer.delivery);
    const forger = createTestDeliverySigner(AGENT);

    const forged = forger.sign(body, {}, { kid: signer.delivery.keys[0].kid });

    expect(await verifyAgentMessageSignature(forged, raw)).toMatchObject({ ok: false, status: 401, reason: 'bad signature' });
  });

  it('asks list_agents about a key it does not hold at most every 30 seconds, and refuses one it does not list', async () => {
    const now = Date.now();
    keep(signer.delivery, now);
    mockCallListAgents.mockResolvedValue(listAgentsAnswer(signer.delivery));
    const stranger = createTestDeliverySigner(AGENT);

    expect(await verifyAgentMessageSignature(stranger.sign(body), raw, now)).toMatchObject({ status: 401 });
    // Between reads the key may be one the service has just added, so it sends the delivery again.
    expect(await verifyAgentMessageSignature(stranger.sign(body), raw, now + 29_000)).toMatchObject({ status: 503 });
    expect(mockCallListAgents).toHaveBeenCalledTimes(1);
    expect(await verifyAgentMessageSignature(stranger.sign(body), raw, now + 30_000)).toMatchObject({ status: 401 });
    expect(mockCallListAgents).toHaveBeenCalledTimes(2);
  });

  it('takes a new key from list_agents, as after the service replaced its key', async () => {
    const now = Date.now();
    keep(signer.delivery, now);
    const next = createTestDeliverySigner(AGENT);
    mockCallListAgents.mockResolvedValue(listAgentsAnswer(next.delivery));

    expect(await verifyAgentMessageSignature(next.sign(body), raw, now)).toEqual({ ok: true });
    // The old key is no longer listed, so no longer trusted: the next read refuses it.
    expect(await verifyAgentMessageSignature(signer.sign(body), raw, now)).toMatchObject({ ok: false, status: 503 });
    expect(await verifyAgentMessageSignature(signer.sign(body), raw, now + 30_000)).toMatchObject({ ok: false, status: 401 });
  });

  it.each([
    ['list_agents is not there', () => mockCallListAgents.mockResolvedValue(null)],
    ['list_agents fails', () => mockCallListAgents.mockRejectedValue(new Error('timed out'))],
    ['list_agents gives no keys', () => mockCallListAgents.mockResolvedValue('{"version":"v1","unchanged":true}')],
  ])('answers 503 with no keys when %s, so the service tries again later', async (_case, arrange) => {
    arrange();

    expect(await verifyAgentMessageSignature(signer.sign(body), raw)).toMatchObject({ ok: false, status: 503 });
  });

  it.each([
    ['list_agents is not there', () => mockCallListAgents.mockResolvedValue(null)],
    ['list_agents fails', () => mockCallListAgents.mockRejectedValue(new Error('timed out'))],
  ])('answers 503 for a key it does not hold when %s, as after the service replaced its key', async (_case, arrange) => {
    keep(signer.delivery);
    arrange();
    const next = createTestDeliverySigner(AGENT);

    expect(await verifyAgentMessageSignature(next.sign(body), raw)).toMatchObject({ ok: false, status: 503 });
  });

  it('reads keys older than an hour again, and does not trust them when it cannot', async () => {
    const now = Date.now();
    keep(signer.delivery, now - 61 * 60_000);
    mockCallListAgents.mockResolvedValue(null);

    expect(await verifyAgentMessageSignature(signer.sign(body), raw, now)).toMatchObject({ status: 503 });

    resetAgentMessageKeysForTests();
    mockCallListAgents.mockResolvedValue(listAgentsAnswer(signer.delivery));
    expect(await verifyAgentMessageSignature(signer.sign(body), raw, now)).toEqual({ ok: true });
  });
});
