/**
 * The model call that decides whether a nameless sentence was aimed at the agent.
 *
 * The prompt's judgement is not testable here — that is what the live call is for.
 * What is worth pinning down is the call shape and, above all, which way it fails:
 * this runs on every unmatched utterance, so an outage is systematic rather than
 * one-off, and failing open would mean answering an entire room.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../../config';
import { logger } from '../../../logger';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateText(...a) }));

const getGateRequest = vi.fn();
vi.mock('../../../lib/classification', () => ({
  getGateRequest: () => getGateRequest(),
}));

const langfuseTelemetry = vi.fn();
vi.mock('../../../lib/telemetry', () => ({
  langfuseTelemetry: (...a: unknown[]) => langfuseTelemetry(...a),
}));

const { classifyAddressed } = await import('../addressed-classifier');

beforeEach(() => {
  vi.clearAllMocks();
  langfuseTelemetry.mockReturnValue({});
  getGateRequest.mockReturnValue({
    model: { id: 'haiku' },
    providerOptions: {},
    samplingParams: { temperature: 0 },
  });
});

afterEach(() => {
  // By hand: `clearAllMocks` and vitest's `restoreMocks` put spies back, not a plain
  // property assigned on the mocked config object.
  vi.mocked(config).meetingTranscriptLogging = 'off';
});

describe('classifyAddressed', () => {
  it('treats YES as addressed', async () => {
    generateText.mockResolvedValue({ text: 'YES' });
    expect(await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' })).toBe(true);
  });

  it('keeps the latency-tuned 8-token cap where the vendor allows it', async () => {
    generateText.mockResolvedValue({ text: 'YES' });
    await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' });
    expect(generateText.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 8 });
  });

  it("respects the provider's output-token floor (OpenAI rejects caps under 16)", async () => {
    getGateRequest.mockReturnValue({
      model: { id: 'gpt-5.6-luna' },
      providerOptions: { openai: { reasoningEffort: 'none' } },
      minOutputTokens: 16,
    });
    generateText.mockResolvedValue({ text: 'YES' });
    await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' });
    expect(generateText.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 16 });
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

  it('hands the failure to the logger whole, rather than flattening it into text', async () => {
    // The failure is an SDK error carrying the request it was made from — which is
    // this prompt plus the sentence someone said. Passed as `err` it goes through the
    // global serializer that drops those fields; interpolated into the message string
    // it would bypass the serializer entirely, so the shape of this call is the fix.
    const failure = new Error('bedrock unavailable');
    generateText.mockRejectedValue(failure);

    await classifyAddressed({ transcript: 'add apples', agentName: 'Prism', stage: 'final' });

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      { err: failure },
      expect.stringContaining('[Meeting:Gate]'),
    );
  });

  it('keeps the sentence out of the trace store on the same terms as the log', async () => {
    // Langfuse is the other place this call's prompt can land, and the prompt *is*
    // what someone said. A trace is a durable record on another host, so a call the
    // log deliberately does not record must not arrive there in full either —
    // otherwise `off` would move the room's speech rather than withhold it.
    generateText.mockResolvedValue({ text: 'NO' });
    await classifyAddressed({ transcript: 'Isaac, can you look?', agentName: 'Prism', stage: 'final' });

    expect(langfuseTelemetry).toHaveBeenCalledWith('meeting-addressed-gate', undefined, {
      recordContent: false,
    });

    // Turned on, the sentence is already being written down, so the trace may hold it
    // too — a verdict is far easier to explain with the call that produced it.
    vi.mocked(config).meetingTranscriptLogging = 'full';
    await classifyAddressed({ transcript: 'Isaac, can you look?', agentName: 'Prism', stage: 'final' });

    expect(langfuseTelemetry).toHaveBeenLastCalledWith('meeting-addressed-gate', undefined, {
      recordContent: true,
    });
  });

  it("leaves the model's own words off the line unless they were asked for", async () => {
    // Its clearest refusals name people — "NO, the speaker addresses Isaac" — so the
    // reasoning leaked attendee names on the same terms as the transcript, and is
    // gated on the same setting. The verdict, the stage and the elapsed time are
    // written either way: that time is silence in a room, and the one number worth
    // reading back from production.
    generateText.mockResolvedValue({ text: 'NO, the speaker addresses Isaac' });
    await classifyAddressed({ transcript: 'Isaac, can you look?', agentName: 'Prism', stage: 'final' });

    const line = String(vi.mocked(logger.info).mock.calls.at(-1)?.[0]);
    expect(line).not.toContain('Isaac');
    expect(line).toContain('addressed=false');
    expect(line).toMatch(/final, \d+ms/);

    vi.mocked(config).meetingTranscriptLogging = 'full';
    await classifyAddressed({ transcript: 'Isaac, can you look?', agentName: 'Prism', stage: 'final' });

    // Eight output tokens is the cheapest explanation of a verdict there is, and by
    // this point the sentence itself is already being written down.
    expect(String(vi.mocked(logger.info).mock.calls.at(-1)?.[0])).toContain(
      'NO, the speaker addresses Isaac',
    );
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
