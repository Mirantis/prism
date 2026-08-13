/**
 * The one tool `delegate` mode offers, and the four ways it can end.
 *
 * Everything here is about what the *room* gets. A delegated turn is an ordinary
 * agent turn, so it can reject, run past any pause a person will hold, or come back
 * with nothing — and in a live call none of those has an error surface other than
 * the agent's own mouth. So the invariant under test is that every path returns a
 * sentence the voice can say, and nothing throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Tool } from 'ai';
import type { InvokeRequest, InvokeResponse } from '../../../types';
import {
  createDelegationTool,
  DELEGATION_DEADLINE_MS,
  DELEGATED_RESULT_MAX_CHARS,
  DELEGATION_TOOL_NAME,
} from '../delegation-tool';

/** The AI SDK's second argument to `execute`. */
const callOptions = (abortSignal?: AbortSignal) => ({
  toolCallId: 'call-1',
  messages: [],
  abortSignal: abortSignal ?? new AbortController().signal,
});

const answer = (response: string): InvokeResponse => ({
  response,
  toolCalls: [],
  steps: [],
});

/** `execute` is optional on `Tool`; every path here needs it. */
const run = async (
  tool: Tool,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<string> => {
  if (typeof tool.execute !== 'function') throw new Error('the delegation tool must be executable');
  return (await tool.execute(args, callOptions(abortSignal))) as string;
};

let invoker: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoker = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the request handed to the agent', () => {
  it('runs as an ordinary subagent turn on the same agent', async () => {
    invoker.mockResolvedValue(answer('Three pods are restarting in staging.'));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const output = await run(tool, { request: 'Check the staging cluster for restarts' });

    expect(output).toBe('Three pods are restarting in staging.');
    const request = invoker.mock.calls[0][0] as InvokeRequest;
    // `subagent`, not a new mode: it is what drops the meeting tools (so a delegated
    // turn cannot hang up on the call that spawned it), `Task` (so delegation cannot
    // nest) and `share_file` (which a meeting could not deliver).
    expect(request.mode).toBe('subagent');
    expect(request.agentId).toBe('a1');
    expect(request.userId).toBe('u1');
    // No thread: a delegated turn reads no conversation history and writes none.
    expect(request.threadId).toBeUndefined();
  });

  it('tells the handler it did not hear the call, and passes the request in full', async () => {
    invoker.mockResolvedValue(answer('ok'));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    await run(tool, {
      request: 'Restart the api deployment in staging',
      context: 'They mentioned the staging cluster earlier',
    });

    const { prompt } = invoker.mock.calls[0][0] as InvokeRequest;
    expect(prompt).toContain('You did not hear it');
    expect(prompt).toContain('Restart the api deployment in staging');
    expect(prompt).toContain('They mentioned the staging cluster earlier');
    // It must not come back with a question: nobody on this side can answer one, and
    // it would be read out in the room as the agent's own reply.
    expect(prompt).toContain('Do not ask a clarifying question');
  });

  it('omits the context line when there is none, rather than sending an empty one', async () => {
    invoker.mockResolvedValue(answer('ok'));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    await run(tool, { request: 'What time is standup' });

    const { prompt } = invoker.mock.calls[0][0] as InvokeRequest;
    expect(prompt).not.toContain('Context from the meeting');
  });
});

describe('an answer the room cannot use', () => {
  it('turns a rejected turn into something sayable', async () => {
    invoker.mockRejectedValue(new Error('bedrock throttled the request'));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const output = await run(tool, { request: 'Check the cluster' });

    // A throw here would leave the model with no tool result at all, which in a live
    // call is a silence nobody can explain.
    expect(output).toContain('bedrock throttled the request');
  });

  it('turns an empty answer into something sayable', async () => {
    invoker.mockResolvedValue(answer('   '));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const output = await run(tool, { request: 'Check the cluster' });

    expect(output).toContain('nothing usable');
  });

  it('cuts an answer too long to be spoken, and says it was cut', async () => {
    invoker.mockResolvedValue(answer('x'.repeat(20_000) + 'TAIL'));
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const output = await run(tool, { request: 'Summarize the incident' });

    expect(output.length).toBeLessThan(20_000);
    expect(output.length).toBeGreaterThan(DELEGATED_RESULT_MAX_CHARS);
    // Same shape as every other truncated tool result: head, tail, and a notice that
    // says outright the output is incomplete — nothing summarizes here, so a silent
    // cut would have the model state a partial list as the whole of it.
    expect(output).toContain('INCOMPLETE OUTPUT');
    expect(output.endsWith('TAIL')).toBe(true);
  });
});

describe('a handoff the room is waiting on', () => {
  it('gives up at the deadline and aborts the turn', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    invoker.mockImplementation(async (request: InvokeRequest) => {
      seen = request.abortSignal ?? null;
      // Resolves only once aborted — an aborted invoke resolves rather than
      // rejecting, which is exactly why the tool tracks the timeout itself.
      await new Promise<void>((resolve) =>
        request.abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return answer('too late to matter');
    });
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const pending = run(tool, { request: 'Read every log in the cluster' });
    await vi.advanceTimersByTimeAsync(DELEGATION_DEADLINE_MS + 1);
    const output = await pending;

    expect(seen!.aborted).toBe(true);
    // Not the answer that arrived after the deadline: the room has been holding a
    // pause, and "still running" is the useful thing to say.
    expect(output).not.toContain('too late to matter');
    expect(output).toContain('still running');
  });

  it('stops when the call ends, and says so rather than answering an empty room', async () => {
    const call = new AbortController();
    invoker.mockImplementation(async (request: InvokeRequest) => {
      await new Promise<void>((resolve) =>
        request.abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return answer('nobody is left to hear this');
    });
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    const pending = run(tool, { request: 'Check the cluster' }, call.signal);
    call.abort();
    const output = await pending;

    // The meeting's signal has to reach the turn, or leaving the room leaves a full
    // agent turn running for it.
    expect((invoker.mock.calls[0][0] as InvokeRequest).abortSignal?.aborted).toBe(true);
    expect(output).toContain('meeting ended');
  });
});

describe('what the Realtime model is shown', () => {
  it('names the tool and asks for a request that stands on its own', () => {
    const tool = createDelegationTool({ userId: 'u1', agentId: 'a1', invoker });

    expect(DELEGATION_TOOL_NAME).toBe('handle_request');
    // The one thing the voice model has to get right in this mode is writing the
    // request down completely — it is the only thing the handler will ever see.
    expect(tool.description).toContain('in full');
  });
});
