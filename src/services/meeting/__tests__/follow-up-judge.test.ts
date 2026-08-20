/**
 * The decision on whether an utterance inside an open exchange is for the agent.
 *
 * What is worth pinning down is the question it asks, the context it is given and the
 * direction it fails in. The question, because the obvious version of this — reusing the
 * addressed gate — decides nothing: that gate asks whether the agent was called by name, and
 * a follow-up has no name in it by construction. The context, because that is what took
 * acceptance of ordinary meeting speech from 59.3% to 6.7%. The direction, because a failed
 * call must cost a shortcut rather than an answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { judgeFollowUp } from '../follow-up-judge';

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
    model: { id: 'nova' },
    providerOptions: {},
    samplingParams: { temperature: 0 },
  });
});

const LINES = [
  { speaker: 'Mario Sarcher', text: 'Iris, how far along is the rollout?' },
  { speaker: 'Iris', text: '(answered)' },
  { speaker: 'Mario Sarcher', text: 'And staging?' },
];

const sentPrompt = () => generateText.mock.calls[0][0] as { system: string; messages: [{ content: string }] };

describe('judgeFollowUp', () => {
  it('answers an utterance the model reads as a continuation', async () => {
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    expect(await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' })).toBe(true);
  });

  it('declines one it reads as the room talking among itself', async () => {
    generateText.mockResolvedValue({ text: 'MOVED_ON' });
    expect(await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' })).toBe(false);
  });

  it('takes the verdict out of an answer that overran', async () => {
    // Asked for one word, the model sometimes starts explaining and the token budget cuts it
    // off mid-sentence.
    generateText.mockResolvedValue({ text: 'MOVED_ON\n\nThe speaker turns to' });
    expect(await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' })).toBe(false);
  });

  it('shows the model the transcript, speaker labels and all', async () => {
    // The whole reason this is a model call rather than a rule: "And staging?" is a
    // follow-up when it lands on the agent's answer and an aside between colleagues
    // otherwise, and the words are identical. Only the labels separate them.
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' });

    expect(sentPrompt().messages[0].content).toBe(
      'Mario Sarcher: Iris, how far along is the rollout?\nIris: (answered)\nMario Sarcher: And staging?',
    );
  });

  it('asks whether the last line is for the agent, and names the agent when it asks', async () => {
    // Measured with the name in the prompt, which is also what ties the transcript's
    // "Iris: (answered)" line to the sentence that follows it. Nothing here asks whether a
    // name was *said* — that is the addressed gate's question, and it would answer no to
    // every follow-up there is.
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' });

    const { system } = sentPrompt();
    expect(system).toMatch(/An AI assistant called Iris is/);
    expect(system).toMatch(/Is that last line aimed at Iris/);
    expect(system).toMatch(/CONTINUE or MOVED_ON/);
    expect(system).not.toMatch(/by name/i);
  });

  it('tells the model most of a meeting is not addressed to it', async () => {
    // The paragraph that did most of the work: with it, acceptance of ordinary meeting
    // speech fell from 38.0% to 6.7% on the same 150 utterances.
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' });

    expect(sentPrompt().system).toMatch(/said between the people, not to Iris/);
  });

  it('tells the model who else is in the call', async () => {
    // An exchange with the agent is exactly where a question for somebody else looks most
    // like a continuation, and a speaker label says who *spoke*, never who was spoken to.
    // Measured on 120 utterances of real meeting speech: wrong accepts fell from 7 to 3.
    generateText.mockResolvedValue({ text: 'MOVED_ON' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1', roster: ['Mario Sarcher', 'Prismith'] });

    const { system } = sentPrompt();
    expect(system).toMatch(/Also in the call: Mario Sarcher, Prismith/);
    // Because one of them may be another agent, which is when this went wrong live.
    expect(system).toMatch(/another AI\s+assistant/);
    expect(system).toMatch(/Naming somebody else is decisive/);
  });

  it('claims nobody else is there when the roster has not been read', async () => {
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' });

    expect(sentPrompt().system).not.toMatch(/Also in the call/);
  });

  it('declines when the call fails', async () => {
    // Closed, like the addressed gate. The utterance still reaches that gate, so this costs
    // a follow-up its shortcut rather than costing the speaker an answer.
    generateText.mockRejectedValue(new Error('429'));
    expect(await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' })).toBe(false);
  });

  it('declines when the model answered something else entirely', async () => {
    generateText.mockResolvedValue({ text: 'I am not sure' });
    expect(await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' })).toBe(false);
  });

  it('makes no call at all with nothing to show it', async () => {
    expect(await judgeFollowUp({ agentName: 'Iris', lines: [], itemId: 'i1' })).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('keeps the room out of a trace store unless the log is already carrying it', async () => {
    // Same rule as every other line a call produces: this prompt is several sentences the
    // room said, and a trace outlives the log.
    generateText.mockResolvedValue({ text: 'CONTINUE' });
    await judgeFollowUp({ agentName: 'Iris', lines: LINES, itemId: 'i1' });

    expect(langfuseTelemetry).toHaveBeenCalledWith('meeting-follow-up-judge', undefined, {
      recordContent: false,
    });
  });
});
