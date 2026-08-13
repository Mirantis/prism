/**
 * The one tool a meeting offers in `delegate` mode: hand the request to the agent.
 *
 * The premise of the experiment (AGENT-135) is that picking a tool is a text
 * model's job. In `full` mode the Realtime model sees the whole catalog — dozens of
 * MCP tools plus every built-in — and has to choose one mid-sentence, while talking,
 * from a schema list it is holding in an audio context. It picks badly: the wrong
 * tool, plausible-looking arguments it invented, or a chain it abandons halfway. In
 * `delegate` mode it sees one tool and the choosing happens where there is no clock
 * and no microphone.
 *
 * What the delegate is: an ordinary `invoke()` turn in `subagent` mode, on the *same*
 * agent — same soul, same memory, same tools minus the three a delegated turn must
 * not have. `subagent` is deliberate rather than a new mode, and it closes three
 * doors at once (`lib/tool-collection.ts#filterToolsByMode`):
 *
 * - no meeting tools, so a delegated turn cannot hang up on the call that spawned it;
 * - no `Task`, so delegation cannot nest into an unbounded tree of turns;
 * - no `share_file`, which a meeting could not deliver anyway.
 *
 * What it is not: it is not the `Task` tool. `Task` delegates to a *different*
 * agent and only exists when subagents are configured, so it could not carry this.
 * The reusable part is the `Invoker` seam — the same injected function, so this
 * module never imports invoke.ts.
 *
 * The delegate has no thread. `invoke()` persists nothing and this passes no
 * `threadId`, so a delegated turn reads no conversation history and leaves no
 * messages behind. That is on purpose: the thread that started the meeting holds a
 * text conversation, not the room's audio, so it would be tokens of unrelated
 * context — and the room's own history lives in the Realtime session, which is the
 * only place it can.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { logger } from '../../logger';
import { renderToolResult } from '../../lib/tool-output-limiter';
import type { Invoker } from '../../lib/task-tool';

export const DELEGATION_TOOL_NAME = 'handle_request';

/**
 * How long the room will wait before the agent has to say something instead.
 *
 * A delegated turn is a whole agent turn — it can run tools, retry, loop up to the
 * step limit — so left alone it can take minutes, and in `delegate` mode it is the
 * *only* tool, so every request is exposed to that. Thirty seconds is about the
 * outer edge of what a person will hold a pause for after being told "let me check";
 * past that, saying "this is taking a while" is a better answer than more silence.
 *
 * The work is aborted, not abandoned: the turn stops rather than running on to
 * produce an answer nobody is waiting for any more.
 */
export const DELEGATION_DEADLINE_MS = 30_000;

/**
 * Cap on the delegate's answer, well under the 12,000 a `full`-mode tool result
 * gets (`tool-bridge.ts`).
 *
 * A delegated result is prose written to be spoken, not a payload to be read, so a
 * long one is a symptom rather than something to preserve: ~2,000 characters is
 * already half a minute of talking. Note nothing *summarizes* here — the compression
 * is this cap plus the instruction below asking for a spoken-length answer. If the
 * delegate writes an essay it gets cut, with the same INCOMPLETE notice every other
 * truncated tool result carries.
 */
export const DELEGATED_RESULT_MAX_CHARS = 2_000;

/**
 * What the delegate is told before the request.
 *
 * It did not hear the call: it gets this string and nothing else, no audio, no
 * transcript, no participant list. So it must be told that plainly, or it answers
 * as if it had context it does not have ("as we discussed…"), and it must not ask
 * clarifying questions — there is no one on this side to answer them, and a question
 * comes back to the room as the agent's own reply.
 */
const DELEGATE_PREAMBLE = [
  'You are handling a request that someone spoke out loud in a live voice meeting.',
  '',
  'You did not hear it. Everything you know about it is written below — there is no',
  'audio, no transcript and no participant list beyond that. Work with what is there.',
  '',
  'Do the work: pick the tools, run them, and answer. Then write the answer the way',
  'you would say it, because that is what happens to it — another model reads it out',
  'in the room. A few sentences. No markdown, no bullet lists, no code blocks, no',
  'links: none of that survives being spoken.',
  '',
  'Do not ask a clarifying question. Nobody here can answer one, and it would be read',
  'aloud as your reply. If the request is ambiguous, take the most likely reading, do',
  'that, and say in one clause what you took it to mean. If you could not do it, say',
  'what stopped you.',
].join('\n');

export interface DelegationToolInput {
  userId: string;
  agentId: string;
  /** Runs the delegated turn; injected so this module never imports invoke.ts. */
  invoker: Invoker;
}

/**
 * Build the single delegation tool.
 *
 * Never throws and never rejects: every failure — a rejected turn, the deadline, an
 * empty answer — comes back as a sentence the voice can say. A live call has no
 * error surface other than the agent's own mouth.
 */
export function createDelegationTool(input: DelegationToolInput): Tool {
  return tool({
    description:
      'Hand a request to yourself — the rest of you, the part with all the tools. ' +
      'Use this for anything that needs real work: looking something up, checking a ' +
      'system, reading or changing a file, remembering something, scheduling something. ' +
      'It comes back with the answer, which you then say out loud. Pass the request in ' +
      'full: it did not hear the meeting and knows only what you write here.',
    inputSchema: z.object({
      request: z
        .string()
        .describe(
          'The request, in full and in your own words. Write it as a complete ' +
            'instruction someone could act on with no other information — not a ' +
            'fragment, not "the thing they asked about".',
        ),
      context: z
        .string()
        .optional()
        .describe(
          'Anything from the conversation needed to make sense of the request: what ' +
            'was being discussed, a name or number mentioned earlier, what was already ' +
            'tried in this call.',
        ),
    }),
    execute: async (args, options) => {
      const { request, context } = args as { request: string; context?: string };
      const started = Date.now();

      // Two ways this stops early, and they need different answers, so the tool
      // tracks which fired rather than reading `signal.aborted` after the fact.
      const inner = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        inner.abort();
      }, DELEGATION_DEADLINE_MS);
      // The meeting's signal (aborted when the call ends, see `tool-bridge.ts`).
      // Without this, leaving the room would leave a full agent turn running.
      const callSignal = options?.abortSignal;
      const onCallEnded = () => inner.abort();
      callSignal?.addEventListener('abort', onCallEnded, { once: true });

      try {
        const prompt = [
          DELEGATE_PREAMBLE,
          '',
          `Request: ${request}`,
          ...(context ? ['', `Context from the meeting: ${context}`] : []),
        ].join('\n');

        logger.info(`[Meeting:Delegate] handling a spoken request (${request.length} chars)`);

        const result = await input.invoker({
          userId: input.userId,
          agentId: input.agentId,
          mode: 'subagent',
          prompt,
          abortSignal: inner.signal,
        });

        const elapsed = Date.now() - started;

        // An aborted turn resolves rather than rejecting — `invokeStream` closes the
        // channel quietly on its own signal — so a timeout arrives here looking like
        // a short or empty answer. The flag is what distinguishes it.
        if (timedOut) {
          logger.warn(`[Meeting:Delegate] deadline hit after ${elapsed}ms`);
          return "That's taking longer than I can hold the line for — tell them it's " +
            'still running and offer to come back to it.';
        }
        if (callSignal?.aborted) {
          // Nobody is listening; the bridge drops this either way.
          return 'The meeting ended before this finished.';
        }

        const text = result.response?.trim();
        if (!text) {
          logger.warn(`[Meeting:Delegate] empty answer after ${elapsed}ms`);
          return 'I came back with nothing usable on that — say so, and offer to try it ' +
            'a different way.';
        }

        logger.info(
          `[Meeting:Delegate] answered in ${elapsed}ms with ${result.toolCalls.length} ` +
            `tool call(s), ${text.length} chars`,
        );
        return renderToolResult(text, {
          maxChars: DELEGATED_RESULT_MAX_CHARS,
          toolName: DELEGATION_TOOL_NAME,
          extraGuidance:
            'Say the part that answers the question and offer to go into the rest out loud.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[Meeting:Delegate] failed after ${Date.now() - started}ms: ${message}`);
        return `I couldn't get that done — ${message}. Say that out loud, briefly.`;
      } finally {
        clearTimeout(timer);
        callSignal?.removeEventListener('abort', onCallEnded);
      }
    },
  });
}
