/**
 * The work behind a voice session: each request the voice hands over becomes one agent
 * run, and its answer goes back to the voice to say.
 *
 * The voice delegates with no task in the event, so the request is read from the
 * session's transcript. Each run gets the transcript so far and a line for each earlier
 * answer, both bounded, in its user message; the session's rules go in the system prompt,
 * which stays the same for every run of the session and so keeps its cached prefix.
 * Pictures a run takes stay inside that run, so a long session does not collect them.
 *
 * Runs are served one at a time, in the order they were handed over. They share one
 * desktop and one shell, and the voice API answers one request at a time as well.
 */

import { logger } from '../../logger';
import type { InvokeRequest, InvokeStep, StepUsage } from '../../types';
import { foldStepUsage } from '../../lib/step-usage';
import { computerHelpService } from '../computer/computer-help.service';
import { computerHelpNotices } from '../../prompts/computer-prompt';

/** The transcript a run is given, newest last. Older lines are dropped first. */
const TRANSCRIPT_MAX_CHARS = 12_000;
/** How many earlier answers a run is reminded of. */
const EARLIER_ANSWERS = 10;
/** One earlier answer in that reminder is cut at this length. */
const EARLIER_ANSWER_MAX_CHARS = 400;
/**
 * How long a run waits after the voice hands a request over before it reads the
 * transcript. The last words of the request can arrive just after the delegation.
 */
const TRANSCRIPT_GRACE_MS = 500;
/**
 * What the voice is handed to say: one context append, which takes 500 tokens. Cut at a
 * sentence near this length, since two appends would read as two answers.
 */
const ANSWER_MAX_CHARS = 1_600;
/** How often the voice hears that a long run is still at work. */
const PROGRESS_INTERVAL_MS = 8_000;
/** A pause this long between fragments on one side starts a new line of the transcript. */
const LINE_GAP_MS = 2_000;
/** What the voice says for a run that failed. Details stay in the log; a call is a room. */
const FAILED_ANSWER = "That didn't work: something went wrong on my side before I could finish.";

/** Where the backend's words go: the voice's context. */
export interface VoiceBackendOutput {
  /** Something for the voice to say, as the answer to a delegation or on its own. */
  commentary(text: string, delegationId: string | null): void;
  /** Something the voice should know without saying it now. */
  thinking(text: string, delegationId: string | null): void;
}

export interface VoiceBackendOptions {
  userId: string;
  agentId: string;
  /** The session's backend rules, fixed for the session. */
  sessionInstructions: string;
  /** Whether the session has the agent's computer. A voice chat without one does not. */
  computer: boolean;
  output: VoiceBackendOutput;
  /** Injected in tests; the runtime's `invokeStream` otherwise. */
  run?: (request: InvokeRequest) => AsyncIterable<InvokeStep>;
}

/** Counters the owner reports as telemetry when the session ends. */
export interface VoiceBackendStats {
  delegations: number;
  toolCalls: number;
  backendInputTokens: number;
  backendOutputTokens: number;
}

/** One piece of work: a delegation from the voice, or a request of the runtime's own. */
interface Job {
  delegationId: string | null;
  /** Where on the session timeline the voice handed it over. */
  offsetMs: number | null;
  /** The request in words, for work the runtime asks for itself. */
  request?: string;
  images?: Array<{ data: string; mediaType: string }>;
}

interface Line {
  side: 'input' | 'output';
  text: string;
  startMs: number | null;
  /** Where the line's latest fragment starts. */
  lastMs: number | null;
}

export class VoiceBackend {
  private readonly lines: Line[] = [];
  private readonly answers: Array<{ atMs: number | null; text: string }> = [];
  private readonly queue: Job[] = [];
  private running = false;
  private readonly abort = new AbortController();
  private readonly usages: StepUsage[] = [];
  private delegations = 0;
  private toolCalls = 0;

  constructor(private readonly options: VoiceBackendOptions) {}

  /** A fragment of the transcript: what the call said, or what the voice said. */
  hear(side: 'input' | 'output', delta: string, startMs: number | null): void {
    const last = this.lines[this.lines.length - 1];
    const paused = startMs !== null && last?.lastMs != null && startMs - last.lastMs > LINE_GAP_MS;
    if (last && last.side === side && !paused) {
      last.text += delta;
      last.lastMs = startMs ?? last.lastMs;
    } else {
      this.lines.push({ side, text: delta, startMs, lastMs: startMs });
    }
    this.trimTranscript();
  }

  /** The voice handed a request over. */
  delegate(delegationId: string, offsetMs: number | null): void {
    this.delegations += 1;
    this.enqueue({ delegationId, offsetMs });
  }

  /**
   * Work the runtime asks for itself, answered to the voice with no delegation: a screen
   * recording to look at, or a help request the user finished.
   */
  ask(request: string, images?: Array<{ data: string; mediaType: string }>): void {
    this.enqueue({ delegationId: null, offsetMs: null, request, images });
  }

  /** Stop the run in progress and drop the queue. The session is over. */
  stopAll(): void {
    this.queue.length = 0;
    this.abort.abort();
  }

  get statistics(): VoiceBackendStats {
    const usage = foldStepUsage(this.usages);
    return {
      delegations: this.delegations,
      toolCalls: this.toolCalls,
      backendInputTokens: usage?.inputTokens ?? 0,
      backendOutputTokens: usage?.outputTokens ?? 0,
    };
  }

  private enqueue(job: Job): void {
    if (this.abort.signal.aborted) return;
    if (this.running) {
      this.options.output.thinking(
        'Your backend is still on the previous request; this one is next.',
        job.delegationId,
      );
    }
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const failed = job;
        await this.runJob(job).catch((err: unknown) => {
          logger.error({ err }, '[Voice] A backend run failed');
          if (!this.abort.signal.aborted) this.options.output.commentary(FAILED_ANSWER, failed.delegationId);
        });
        if (this.abort.signal.aborted) return;
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    if (job.delegationId) await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_GRACE_MS));
    if (this.abort.signal.aborted) return;

    const run = this.options.run ?? (await import('../../invoke')).invokeStream;
    const help = await computerHelpService.list(this.options.agentId, this.options.userId).catch(() => []);
    let toolCalls = 0;
    let lastProgressAt = Date.now();
    let answer = '';
    let failed = false;

    const stream = run({
      userId: this.options.userId,
      agentId: this.options.agentId,
      mode: 'voice',
      prompt: this.prompt(job),
      promptImages: job.images,
      sessionInstructions: this.options.sessionInstructions,
      computer: this.options.computer,
      runtimeNotices: computerHelpNotices(help),
      abortSignal: this.abort.signal,
      onToolEvent: (event) => {
        if (event.type !== 'started') return;
        toolCalls += 1;
        this.toolCalls += 1;
        if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = Date.now();
        this.options.output.thinking(
          `Your backend is still working on the request: ${toolCalls} tool calls so far.`,
          job.delegationId,
        );
      },
    });

    for await (const step of stream) {
      if (step.usage) this.usages.push(step.usage);
      // The run's own error text names providers and limits, which is not for a room.
      if (step.error) failed = true;
      const text = step.text.trim();
      if (!text || step.error) continue;
      // A step's words before the last are the backend thinking aloud between tools.
      if (answer) this.options.output.thinking(cut(answer), job.delegationId);
      answer = text;
    }

    if (this.abort.signal.aborted) return;
    const spoken = failed ? FAILED_ANSWER : answer ? cut(answer) : 'I have nothing to report on that.';
    this.answers.push({ atMs: job.offsetMs, text: spoken });
    if (this.answers.length > EARLIER_ANSWERS) this.answers.shift();
    this.options.output.commentary(spoken, job.delegationId);
  }

  /**
   * The run's user message: the earlier answers, the conversation, then the request. The
   * request goes last, with the words it was asked in, since the last part of the message
   * is what the risk gate and the memory recall read most closely.
   */
  private prompt(job: Job): string {
    const conversation = this.lines
      .map((line) => `${stamp(line.startMs)}${line.side === 'input' ? 'Them' : 'You'}: ${line.text.trim()}`)
      .join('\n');
    const earlier = this.answers
      .map((a) => `- ${stamp(a.atMs)}${a.text.slice(0, EARLIER_ANSWER_MAX_CHARS)}`)
      .join('\n');
    const asked = [...this.lines].reverse().find((line) => line.side === 'input')?.text.trim();
    const request = job.request
      ? `The request, from the runtime rather than from anyone speaking: ${job.request}`
      : `Your voice handed over a request${job.offsetMs !== null ? ` at ${clock(job.offsetMs)}` : ''}: ` +
        'the last thing asked of you in the conversation above. Lines after that were said ' +
        'while this ran. Do what was asked, then write what your voice should say.' +
        (asked ? `\n\nThe last thing they said: "${asked.slice(-EARLIER_ANSWER_MAX_CHARS)}"` : '');

    return [
      ...(earlier ? ['What you answered earlier in this session, oldest first:', earlier] : []),
      'The conversation so far, oldest first. "Them" is what the other side said, "You" is ' +
        'what your voice said.',
      conversation || '(nothing said yet)',
      request,
    ].join('\n\n');
  }

  private trimTranscript(): void {
    let total = this.lines.reduce((sum, line) => sum + line.text.length, 0);
    while (total > TRANSCRIPT_MAX_CHARS && this.lines.length > 1) {
      total -= this.lines.shift()!.text.length;
    }
  }
}

/** `[1:05] ` for a known time on the session timeline, nothing otherwise. */
function stamp(ms: number | null): string {
  return ms === null ? '' : `[${clock(ms)}] `;
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** An answer that fits one context append, cut at a sentence where it has to be cut. */
function cut(text: string): string {
  if (text.length <= ANSWER_MAX_CHARS) return text;
  logger.warn({ chars: text.length }, '[Voice] A backend answer was cut to fit the voice');
  const head = text.slice(0, ANSWER_MAX_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  return end > ANSWER_MAX_CHARS / 2 ? head.slice(0, end + 1) : head;
}
