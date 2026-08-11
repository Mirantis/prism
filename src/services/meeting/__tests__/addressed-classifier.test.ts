/**
 * The model call that decides whether a nameless sentence was aimed at the agent.
 *
 * The prompt's judgement is not testable here — that is what the live call is for.
 * What is worth pinning down is the call shape and, above all, which way it fails:
 * this runs on every unmatched utterance, so an outage is systematic rather than
 * one-off, and failing open would mean answering an entire room.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateText(...a) }));

const getClassificationModel = vi.fn();
vi.mock('../../../lib/classification', () => ({
  getClassificationModel: () => getClassificationModel(),
}));

vi.mock('../../../lib/telemetry', () => ({ langfuseTelemetry: () => ({}) }));

const { classifyAddressed } = await import('../addressed-classifier');

beforeEach(() => {
  vi.clearAllMocks();
  getClassificationModel.mockReturnValue({ id: 'haiku' });
});

describe('classifyAddressed', () => {
  it('treats YES as addressed', async () => {
    generateText.mockResolvedValue({ text: 'YES' });
    expect(await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' })).toBe(true);
  });

  it('treats anything else as not addressed', async () => {
    generateText.mockResolvedValue({ text: 'NO' });
    expect(await classifyAddressed({ transcript: 'ship on Friday', agentName: 'Prism', stage: 'final' })).toBe(
      false,
    );
  });

  it('tolerates the model being chatty about it', async () => {
    generateText.mockResolvedValue({ text: '  yes, clearly.\n' });
    expect(await classifyAddressed({ transcript: 'and staging?', agentName: 'Prism', stage: 'partial' })).toBe(true);
  });

  it('reads the verdict out of an explanation the token budget cut off', async () => {
    // Seen on a live call: asked for one word, the model wrote "NO\n\nThis is a"
    // and ran out of budget mid-sentence. Reading only the first characters would
    // make the answer depend on which word happened to come first.
    generateText.mockResolvedValue({ text: 'NO\n\nThis is a' });
    expect(await classifyAddressed({ transcript: 'ship on Friday', agentName: 'Prism', stage: 'final' })).toBe(
      false,
    );

    generateText.mockResolvedValue({ text: 'This is a request, so YES' });
    expect(await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' })).toBe(true);
  });

  it('stays quiet when the model answers with neither word', async () => {
    generateText.mockResolvedValue({ text: 'I am not sure about that one' });
    expect(await classifyAddressed({ transcript: 'hmm', agentName: 'Prism', stage: 'final' })).toBe(false);
  });

  it('stays quiet when the call fails', async () => {
    // Fails *closed*, unlike the heartbeat and cron gates. This runs on every
    // utterance in a group call, so an outage is systematic — failing open would
    // answer a whole room, which is the bug the gate exists to prevent. The cost is
    // real and worth stating: while the model is unavailable the agent is mute in a
    // group call, because nothing else can reach it.
    generateText.mockRejectedValue(new Error('bedrock unavailable'));
    expect(await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' })).toBe(false);
  });

  it('asks only whether the agent was named, not whether it sounds like a request', async () => {
    generateText.mockResolvedValue({ text: 'NO' });
    await classifyAddressed({
      transcript: 'Pritham, what about lunch?',
      agentName: 'Prism',
      stage: 'final',
    });

    const call = generateText.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Prism');
    expect(call.messages[0].content).toContain('Pritham');
    // The room is one mixed channel, so "sounds like a request for an assistant"
    // is unanswerable — it reads the same said to the person in the next chair.
    // Being named is the only signal there is, so it is the only one asked about.
    expect(call.system).toMatch(/by name/i);
    expect(call.system).toMatch(/mishearing/i);
    expect(call.system).toMatch(/talking \*about\* rather than who they are talking/i);
    // Cheap and deterministic: this sits in front of most utterances in a call.
    expect(call.temperature).toBe(0);
    // Tight on purpose. Asked for one word the model writes a sentence anyway, and
    // every extra token is latency on the path whose whole purpose is speed — a
    // wider cap measured ~700ms slower per call. Enough for the verdict plus a few
    // words, not enough to fund an explanation.
    expect(call.maxOutputTokens).toBeLessThanOrEqual(12);
  });

  it('keeps every agent name out of the system prompt', async () => {
    // The name is arbitrary and can change at any time, so an example written
    // around one real name is wrong for every other agent and stale for this one
    // the moment it is renamed. It also keeps user-settable text out of the system
    // prompt, where a name chosen to read as an instruction would carry weight.
    generateText.mockResolvedValue({ text: 'NO' });
    await classifyAddressed({ transcript: 'anything', agentName: 'Atlas', stage: 'final' });

    const call = generateText.mock.calls[0][0];
    expect(call.system).not.toMatch(/prism/i);
    expect(call.system).not.toMatch(/atlas/i);
    // It reaches the model as data instead.
    expect(call.messages[0].content).toContain('Atlas');
  });
});
