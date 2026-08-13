/**
 * The one tool a meeting offers in `delegate` mode: hand the request to the agent.
 *
 * The premise of the experiment is that picking a tool is a text model's job. In
 * `full` mode the Realtime model sees the whole catalog — dozens of
 * MCP tools plus every built-in — and has to choose one mid-sentence, while talking,
 * from a schema list it is holding in an audio context. It picks badly: the wrong
 * tool, plausible-looking arguments it invented, or a chain it abandons halfway. In
 * `delegate` mode it sees one tool and the choosing happens where there is no clock
 * and no microphone.
 *
 * What the delegate is: an ordinary `invoke()` turn in `subagent` mode, on the *same*
 * agent — same soul, same memory, nearly the same tools. `subagent` is deliberate
 * rather than a new mode, and what it withholds
 * (`lib/tool-collection.ts#filterToolsByMode`) is mostly what a delegated turn must
 * not have:
 *
 * - no meeting tools, so a delegated turn cannot hang up on the call that spawned it;
 * - no `Task`, so delegation cannot nest into an unbounded tree of turns;
 * - no `share_file`, which a meeting could not deliver anyway;
 * - no goal tools — which is the one real gap, since `meeting` mode keeps them. A
 *   spoken "set yourself a goal to track this" works in `full` mode and comes back
 *   as a refusal here. Reusing `subagent` is worth that while this is an experiment;
 *   making the two modes equal means giving the goal tools back to `subagent`
 *   generally, which is a change to every `Task` call and not this one's to make.
 *
 * What it is not: it is not the `Task` tool. `Task` delegates to a *different*
 * agent and only exists when subagents are configured, so it could not carry this.
 * The reusable part is the `Invoker` seam — the same injected function, so this
 * module never imports invoke.ts.
 *
 * What the delegate is *told* is the meeting itself. Handing over only the request
 * the voice model retyped put the whole experiment on the one thing that model is
 * worst at — writing down, mid-sentence, what it just heard — so the handoff carries
 * the call's transcript (`call-transcript.ts`) and the retyped request is demoted to
 * what it is good for: naming the ask at the end.
 *
 * The transcript rides as `InvokeRequest.cachedPrefix`, not as part of the prompt,
 * because a user message cannot be a cached prefix here: the system prompt's dynamic
 * part renders after the tools and system blocks and before the messages, and it
 * carries a per-call timestamp. So a call that delegates ten times pays for the
 * transcript roughly once — the log hands out a sealed part that only changes in
 * quanta and an open tail that is re-sent uncached.
 *
 * The delegate has no thread. `invoke()` persists nothing and this passes no
 * `threadId`, so a delegated turn reads no conversation history and leaves no
 * messages behind. That is on purpose: the thread that started the meeting holds a
 * text conversation, not the room's, so it would be tokens of unrelated context. The
 * room's history is the transcript, and it lives for the length of the call.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { logger } from '../../logger';
import { renderToolResult } from '../../lib/tool-output-limiter';
import type { Invoker } from '../../lib/task-tool';
import type { TranscriptLog } from './call-transcript';

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
 * What the delegate is told before the transcript.
 *
 * It was not in the room, and what it has instead is a transcription — imperfect,
 * unattributed, and silent about everything that was not said. It must be told that
 * plainly, or it answers as if it had been listening. And it must not ask clarifying
 * questions: there is no one on this side to answer them, and a question comes back
 * to the room as the agent's own reply.
 *
 * First in the cached prefix, so the bytes the transcript is appended to never move.
 */
const DELEGATE_PREAMBLE = [
  'You are handling a request that someone spoke out loud in a live voice meeting.',
  '',
  'You were not in the room. What you have is the call transcribed as it happened,',
  'below, and that is all: transcription mishears words, cannot always tell one',
  'speaker from another, and holds nothing that was not said out loud. Read it, then',
  'do what is being asked at the end.',
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

/**
 * What introduces the transcript.
 *
 * The labels need explaining once: the room is one mixed audio channel, so a line
 * attributed to "Room" is whoever was loudest, and the agent's own speech is never
 * transcribed — the `You:` lines are the answers this tool sent back, which the voice
 * read out. Without that the delegate reads its own past answers as someone else's
 * claims.
 */
const TRANSCRIPT_HEADING = [
  '--- The call so far, as transcribed ---',
  '"Room:" is what was said out loud, on one mixed channel that cannot reliably tell',
  'speakers apart. "You:" is an answer you already sent back through this tool, which',
  'the voice then read out in the room. Anything the voice answered by itself, without',
  'asking you, is not in here — so a question with no answer after it may already have',
  'been answered out loud.',
].join('\n');

/**
 * Split the standing part of the handoff from the part that has changed since the
 * last one.
 *
 * `text` is what gets the cache breakpoint, so everything in it has to be stable
 * between delegations in a call: the preamble, the heading, and the sealed transcript
 * — which the log only ever changes in ~4,000-character quanta. `open` is the lines
 * said since the last seal, re-sent uncached. It carries its own leading newline
 * because the two arrive as adjacent content blocks, with nothing between them.
 */
function buildCachedPrefix(transcript?: TranscriptLog): { text: string; open?: string } {
  const chunks = transcript?.chunks();
  if (!chunks || (!chunks.sealed && !chunks.open)) {
    // Nothing said yet (or no log wired in): a heading over an empty transcript reads
    // as if the call had been silent, which is not the same as having no record of it.
    return { text: DELEGATE_PREAMBLE };
  }

  const text = [
    DELEGATE_PREAMBLE,
    '',
    TRANSCRIPT_HEADING,
    ...(chunks.sealed ? ['', chunks.sealed] : []),
  ].join('\n');

  return { text, ...(chunks.open ? { open: `\n${chunks.open}` } : {}) };
}

/**
 * How one delegated turn went, reported to whoever is counting.
 *
 * `status` is the room's view of it, not the turn's: `timeout` means the room was
 * told to wait rather than given an answer, `empty` that the turn came back with
 * nothing sayable, `abandoned` that the call ended first (so nobody heard either
 * way). Counts and durations only — the request and the answer never leave here,
 * both being whatever a participant said out loud.
 */
export interface DelegationOutcome {
  status: 'answered' | 'timeout' | 'empty' | 'error' | 'abandoned';
  /** Wall-clock the room waited, which is the number the experiment is about. */
  ms: number;
  /** Whether the answer had to be cut to fit `DELEGATED_RESULT_MAX_CHARS`. */
  truncated: boolean;
  /**
   * Transcript characters this handoff carried, and how many of them were in the
   * cached part — the pair that says whether the caching this design is built around
   * is actually happening. A size, not the text.
   */
  transcriptChars: number;
  transcriptCachedChars: number;
}

export interface DelegationToolInput {
  userId: string;
  agentId: string;
  /** Runs the delegated turn; injected so this module never imports invoke.ts. */
  invoker: Invoker;
  /**
   * The call's running transcript, shared with the conversation that writes the room's
   * speech into it. Every handoff carries it, and the tool writes its own answers back
   * so the next one knows what the room was already told.
   *
   * Optional so the tool stands alone in a test — without it the delegate is handed
   * the request and nothing else, which is what this mode used to do.
   */
  transcript?: TranscriptLog;
  /**
   * Called exactly once per delegation, whatever happens to it.
   *
   * The tool reports rather than emits: a per-request telemetry event in a call
   * that delegates every sentence would be a flood, and `meeting ended` already
   * owns the call's metrics. Optional so the tool stands alone in a test.
   */
  onOutcome?: (outcome: DelegationOutcome) => void;
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
      'It comes back with the answer, which you then say out loud. The transcript of ' +
      'this call goes with it, so do not retell the conversation — just say what is ' +
      'being asked now.',
    inputSchema: z.object({
      request: z
        .string()
        .describe(
          'What is being asked, right now, in a sentence or two. The call transcript ' +
            'travels with this, so do not recap it — name the thing to be done. If the ' +
            'ask only makes sense together with something said earlier, say which part.',
        ),
    }),
    execute: async (args, options) => {
      const { request } = args as { request: string };
      const started = Date.now();

      // Read once, so what is reported is the transcript this handoff actually carried
      // — the tool appends to the same log on its way out.
      const cachedPrefix = buildCachedPrefix(input.transcript);
      const stats = input.transcript?.stats();
      const transcriptCachedChars = stats?.sealedChars ?? 0;
      const transcriptChars = stats?.chars ?? 0;

      // One report per delegation, on whichever path gets there first, so a count
      // of delegations and a sum of their durations can never disagree.
      let reported = false;
      const report = (status: DelegationOutcome['status'], truncated = false): void => {
        if (reported) return;
        reported = true;
        input.onOutcome?.({
          status,
          ms: Date.now() - started,
          truncated,
          transcriptChars,
          transcriptCachedChars,
        });
      };

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
        // The whole of what varies between one handoff and the next, and therefore the
        // only part that cannot be cached. Everything else — preamble, transcript — is
        // in the prefix above.
        const prompt = `Right now they are asking: ${request}`;

        logger.info(
          `[Meeting:Delegate] handling a spoken request (${request.length} chars) with ` +
            `${transcriptCachedChars} cached + ${transcriptChars - transcriptCachedChars} ` +
            'open transcript chars',
        );

        const result = await input.invoker({
          userId: input.userId,
          agentId: input.agentId,
          mode: 'subagent',
          prompt,
          cachedPrefix,
          abortSignal: inner.signal,
        });

        const elapsed = Date.now() - started;

        // An aborted turn resolves rather than rejecting — `invokeStream` closes the
        // channel quietly on its own signal — so a timeout arrives here looking like
        // a short or empty answer. The flag is what distinguishes it.
        if (timedOut) {
          logger.warn(`[Meeting:Delegate] deadline hit after ${elapsed}ms`);
          report('timeout');
          // Not "it's still running": the turn was aborted, and promising a result that
          // no longer exists is the unkeepable promise the prompt's own rules forbid.
          return 'That took longer than I can hold the line for, so I stopped it — tell ' +
            'them that and offer to start it again.';
        }
        if (callSignal?.aborted) {
          // Nobody is listening; the bridge drops this either way.
          report('abandoned');
          return 'The meeting ended before this finished.';
        }

        // `invoke()` does not reject when the model call fails: `invokeStream` turns the
        // failure into a friendly step plus this structured tag (`lib/llm-errors.ts`),
        // which is the same signal the cron gate routes on. Read it, or a throttle or an
        // exhausted spending limit arrives here looking like an answer — counted as one
        // and spoken as one.
        if (result.error) {
          logger.warn(`[Meeting:Delegate] turn failed (${result.error.type}) after ${elapsed}ms`);
          report('error');
          return 'I hit a problem doing that and could not finish it — say so briefly, ' +
            'and offer to try again.';
        }

        const text = result.response?.trim();
        if (!text) {
          logger.warn(`[Meeting:Delegate] empty answer after ${elapsed}ms`);
          report('empty');
          return 'I came back with nothing usable on that — say so, and offer to try it ' +
            'a different way.';
        }

        const rendered = renderToolResult(text, {
          maxChars: DELEGATED_RESULT_MAX_CHARS,
          toolName: DELEGATION_TOOL_NAME,
          extraGuidance:
            'Say the part that answers the question and offer to go into the rest out loud.',
        });
        // A cut answer is the delegate writing for a reader rather than a listener,
        // which is the failure mode this mode's prompt is trying to prevent — worth
        // counting, since the room hears a sentence that stops mid-thought.
        const truncated = rendered !== text;
        logger.info(
          `[Meeting:Delegate] answered in ${elapsed}ms with ${result.toolCalls.length} ` +
            `tool call(s), ${text.length} chars${truncated ? ' (cut to fit)' : ''}`,
        );
        report('answered', truncated);
        // Into the log, so the next handoff knows what the room was already told — the
        // agent's own speech is never transcribed, so this is the only way an answer
        // reaches the transcript. The rendered text, being what the voice was handed.
        //
        // Only the answered path: every other return above is an instruction to the
        // voice ("say so briefly, and offer to try again"), not a sentence the room
        // heard, and writing those down would have the next delegate read them as
        // things the agent said.
        input.transcript?.append(rendered, 'agent');
        return rendered;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[Meeting:Delegate] failed after ${Date.now() - started}ms: ${message}`);
        report('error');
        return `I couldn't get that done — ${message}. Say that out loud, briefly.`;
      } finally {
        clearTimeout(timer);
        callSignal?.removeEventListener('abort', onCallEnded);
      }
    },
  });
}
