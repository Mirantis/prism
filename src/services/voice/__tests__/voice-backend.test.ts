/**
 * The work behind a voice: each delegation is one agent run, and its answer goes back to
 * the voice. The run is a fake `invokeStream`, so a test sees the request each run was
 * given and controls what it answers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvokeRequest, InvokeStep } from '../../../types';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../computer/computer-help.service', () => ({
  computerHelpService: { list: vi.fn(async () => []) },
}));

const { VoiceBackend } = await import('../voice-backend');

/** A run the test finishes by hand: it yields `steps`, then waits for `release()`. */
function controlledRun(steps: InvokeStep[]) {
  const requests: InvokeRequest[] = [];
  const releases: Array<() => void> = [];
  const run = (request: InvokeRequest): AsyncIterable<InvokeStep> => {
    requests.push(request);
    return (async function* () {
      for (const step of steps) {
        request.onToolEvent?.({ type: 'started', toolName: 'computer_click' });
        yield step;
      }
      await new Promise<void>((resolve) => releases.push(resolve));
    })();
  };
  return { run, requests, release: () => releases.shift()?.() };
}

function step(text: string, inputTokens = 0, outputTokens = 0): InvokeStep {
  return {
    text,
    toolCalls: [],
    usage: inputTokens
      ? {
          model: 'm',
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          noCacheTokens: inputTokens,
        }
      : undefined,
  };
}

let output: { commentary: ReturnType<typeof vi.fn>; thinking: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  output = { commentary: vi.fn(), thinking: vi.fn() };
});

function backend(run: (request: InvokeRequest) => AsyncIterable<InvokeStep>) {
  return new VoiceBackend({ userId: 'u1', agentId: 'a1', sessionInstructions: 'call rules', computer: true, output, run });
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
}

describe('a delegation', () => {
  it('runs as a voice run with the conversation, and says only the last answer', async () => {
    const fake = controlledRun([step('Let me look at the screen.'), step('You have two tasks.', 900, 20)]);
    const voice = backend(fake.run);
    voice.hear('input', 'Prism, what is ', 600);
    voice.hear('input', 'scheduled?', 900);
    voice.hear('output', 'One sec.', 1800);

    voice.delegate('item_1', 1500);
    await settle();
    fake.release();
    await settle();

    const request = fake.requests[0]!;
    expect(request).toMatchObject({ mode: 'voice', userId: 'u1', agentId: 'a1', sessionInstructions: 'call rules', computer: true });
    expect(request.threadId).toBeUndefined();
    expect(request.prompt).toContain('[0:00] Them: Prism, what is scheduled?');
    expect(request.prompt).toContain('[0:01] You: One sec.');
    expect(request.prompt).toContain('at 0:01');
    // The request comes last, in the words it was asked in.
    expect(request.prompt.endsWith('The last thing they said: "Prism, what is scheduled?"')).toBe(true);
    // The words before the last step are the backend thinking aloud, not the answer.
    expect(output.thinking).toHaveBeenCalledWith('Let me look at the screen.', 'item_1');
    expect(output.commentary).toHaveBeenCalledOnce();
    expect(output.commentary).toHaveBeenCalledWith('You have two tasks.', 'item_1');
    expect(voice.statistics).toEqual({ delegations: 1, toolCalls: 2, backendInputTokens: 900, backendOutputTokens: 20 });
  });

  it('reminds a later run of the earlier answers', async () => {
    const fake = controlledRun([step('Opened the blog.')]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    await settle();
    fake.release();
    await settle();
    voice.delegate('item_2', 5000);
    await settle();

    expect(fake.requests[1]!.prompt).toContain('What you answered earlier in this session');
    expect(fake.requests[1]!.prompt).toContain('Opened the blog.');
  });

  it('serves delegations one at a time, and tells the voice the next one waits', async () => {
    const fake = controlledRun([step('Done.')]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    await settle();
    voice.delegate('item_2', 2000);
    await settle();

    expect(fake.requests).toHaveLength(1);
    expect(output.thinking).toHaveBeenCalledWith(expect.stringContaining('this one is next'), 'item_2');

    fake.release();
    await settle();
    expect(fake.requests).toHaveLength(2);
  });

  it('cuts a long answer at a sentence to fit one append', async () => {
    const long = `${'This sentence is part of a long answer. '.repeat(60)}`;
    const fake = controlledRun([step(long)]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    await settle();
    fake.release();
    await settle();

    const spoken = output.commentary.mock.calls[0]![0] as string;
    expect(spoken.length).toBeLessThanOrEqual(1_600);
    expect(spoken.endsWith('.')).toBe(true);
  });

  it('keeps the transcript it hands over bounded, dropping the oldest lines', async () => {
    const fake = controlledRun([step('Ok.')]);
    const voice = backend(fake.run);
    voice.hear('input', 'the first thing said', 0);
    for (let i = 0; i < 40; i += 1) {
      voice.hear(i % 2 ? 'input' : 'output', 'x'.repeat(500), i * 1000);
    }

    voice.delegate('item_1', 40_000);
    await settle();

    expect(fake.requests[0]!.prompt).not.toContain('the first thing said');
    expect(fake.requests[0]!.prompt.length).toBeLessThan(14_000);
  });

  it('tells the voice how far a long run has got, at most every few seconds', async () => {
    const run = (request: InvokeRequest): AsyncIterable<InvokeStep> =>
      (async function* () {
        for (let i = 0; i < 4; i += 1) {
          request.onToolEvent?.({ type: 'started', toolName: 'computer_click' });
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        yield step('Accepted the invite.');
      })();
    const voice = backend(run);

    voice.delegate('item_1', 1000);
    await vi.advanceTimersByTimeAsync(15_000);

    const progress = output.thinking.mock.calls.filter(([text]) => String(text).includes('tool calls so far'));
    expect(progress).toEqual([['Your backend is still working on the request: 4 tool calls so far.', 'item_1']]);
    expect(output.commentary).toHaveBeenCalledWith('Accepted the invite.', 'item_1');
  });

  it('says so when a run ends with nothing to say', async () => {
    const fake = controlledRun([step('')]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    await settle();
    fake.release();
    await settle();

    expect(output.commentary).toHaveBeenCalledWith('I have nothing to report on that.', 'item_1');
  });

  it("speaks a short failure instead of the run's own error text", async () => {
    const fake = controlledRun([
      { text: 'I encountered an error while processing your request: 400 from bedrock', toolCalls: [], error: { type: 'generic' } },
    ]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    await settle();
    fake.release();
    await settle();

    expect(output.commentary).toHaveBeenCalledWith(expect.stringContaining("didn't work"), 'item_1');
    expect(output.commentary.mock.calls[0]![0]).not.toContain('bedrock');
  });

  it('answers a delegation whose run threw before it started', async () => {
    const run = (): AsyncIterable<InvokeStep> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('SQLITE_BUSY')) }),
    });
    const voice = backend(run);

    voice.delegate('item_1', 1000);
    await settle();

    expect(output.commentary).toHaveBeenCalledWith(expect.stringContaining("didn't work"), 'item_1');
  });

  it('starts a new transcript line after a pause, so the request has its own time', async () => {
    const fake = controlledRun([step('Ok.')]);
    const voice = backend(fake.run);
    voice.hear('input', 'We should ship on Friday.', 1_000);
    voice.hear('input', 'Prism, open the release board.', 60_000);

    voice.delegate('item_1', 62_000);
    await settle();

    expect(fake.requests[0]!.prompt).toContain('[0:01] Them: We should ship on Friday.\n[1:00] Them: Prism, open the release board.');
  });
});

describe('work the runtime asks for', () => {
  it('runs with the pictures and answers the voice with no delegation', async () => {
    const fake = controlledRun([step('You were renaming the cluster.')]);
    const voice = backend(fake.run);

    voice.ask('Your user recorded their screen.', [{ data: 'AAAA', mediaType: 'image/jpeg' }]);
    await settle();
    fake.release();
    await settle();

    expect(fake.requests[0]!.promptImages).toEqual([{ data: 'AAAA', mediaType: 'image/jpeg' }]);
    expect(fake.requests[0]!.prompt).toContain('from the runtime rather than from anyone speaking');
    expect(output.commentary).toHaveBeenCalledWith('You were renaming the cluster.', null);
    expect(voice.statistics.delegations).toBe(0);
  });
});

describe('stopping', () => {
  it('aborts the run in progress, drops the queue and says nothing more', async () => {
    const fake = controlledRun([step('Half done.')]);
    const voice = backend(fake.run);

    voice.delegate('item_1', 1000);
    voice.delegate('item_2', 2000);
    await settle();
    voice.stopAll();
    fake.release();
    await settle();

    expect(fake.requests[0]!.abortSignal?.aborted).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(output.commentary).not.toHaveBeenCalled();
  });
});
