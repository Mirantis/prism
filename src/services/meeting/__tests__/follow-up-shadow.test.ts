/**
 * The after-the-fact check on an answered follow-up.
 *
 * Nothing waits for this call and no answer depends on it, so what is worth pinning down is
 * the question it asks and the way it fails. The question matters because the obvious
 * version of this feature — shadowing the addressed gate — measures nothing: that gate asks
 * whether the assistant was called by name, and a follow-up has no name in it by
 * construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { judgeFollowUp } from '../follow-up-shadow';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateText(...a) }));

const getGateRequest = vi.fn();
vi.mock('../../../lib/classification', () => ({ getGateRequest: () => getGateRequest() }));

const langfuseTelemetry = vi.fn();
vi.mock('../../../lib/telemetry', () => ({
  langfuseTelemetry: (...a: unknown[]) => langfuseTelemetry(...a),
}));

beforeEach(() => {
  langfuseTelemetry.mockReturnValue({});
  getGateRequest.mockReturnValue({
    model: { id: 'haiku' },
    providerOptions: {},
    samplingParams: { temperature: 0 },
  });
});

describe('judgeFollowUp', () => {
  it('reads a continuation', async () => {
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    expect(await judgeFollowUp({ transcript: 'and staging?', agentName: 'Iris' })).toBe('continue');
  });

  it('reads a speaker who has moved on', async () => {
    generateText.mockResolvedValue({ text: 'MOVED_ON' });
    expect(await judgeFollowUp({ transcript: 'right, next topic', agentName: 'Iris' })).toBe('moved_on');
  });

  it('takes the verdict out of an answer that overran', async () => {
    // Asked for one word, the model sometimes starts explaining and the token budget cuts
    // it off mid-sentence.
    generateText.mockResolvedValue({ text: 'MOVED_ON\n\nThe speaker turns to' });
    expect(await judgeFollowUp({ transcript: 'Tom, any idea?', agentName: 'Iris' })).toBe('moved_on');
  });

  it('asks whether the exchange continued, not whether a name was said', async () => {
    // The distinction this whole module exists for. A prompt about the name would answer no
    // to every follow-up and the disagreement rate would sit near 100% regardless.
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ transcript: 'and staging?', agentName: 'Iris' });

    const system = String((generateText.mock.calls[0][0] as { system: string }).system);
    expect(system).toMatch(/follow-up aimed at the assistant/i);
    expect(system).toMatch(/CONTINUE or MOVED_ON/);
    expect(system).not.toMatch(/by name/i);
  });

  it('records no judgement rather than a wrong one when the call fails', async () => {
    // A metric that counts outages as agreement looks best exactly when it is least
    // trustworthy.
    generateText.mockRejectedValue(new Error('429'));
    expect(await judgeFollowUp({ transcript: 'and staging?', agentName: 'Iris' })).toBeNull();
  });

  it('records no judgement when the model answered something else entirely', async () => {
    generateText.mockResolvedValue({ text: 'I am not sure' });
    expect(await judgeFollowUp({ transcript: 'and staging?', agentName: 'Iris' })).toBeNull();
  });
});
