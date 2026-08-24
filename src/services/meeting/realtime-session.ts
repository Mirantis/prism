/**
 * The OpenAI Realtime API session — the agent's voice and ears in a meeting.
 *
 * This is a speech-to-speech session: meeting audio goes in as pcm16 and the
 * model's speech comes back as pcm16. There is deliberately no transcript in the
 * conversation path — transcription exists only so a call can be read back in the
 * log, and nothing decides anything from it.
 *
 * The model carries the agent's real system prompt as session `instructions` and
 * the agent's real tools as Realtime function tools, so the participant in the
 * call *is* the Prism agent rather than a separate voice persona relaying to it.
 *
 * Wire protocol notes that shaped this file:
 * - WebSocket is the right transport for a server-side media pipeline (WebRTC is
 *   for browsers that capture audio themselves; SIP is for telephony).
 * - Audio is base64 pcm16 mono at 24 kHz in both directions.
 * - `interrupt_response` is left OFF: the server would kill the response on any
 *   detected speech, including a cough or an "mm-hm". Interruption is decided
 *   locally instead (see barge-in.ts) so backchannels don't cut the bot off.
 * - `create_response` is left OFF too, always. The server would answer every
 *   utterance in the room, and the room is a single mixed channel — so whether an
 *   utterance was aimed at the agent is a question only the client can ask (see
 *   `response-policy.ts`). Every response on this session is one we asked for.
 * - Truncation is the client's job on this transport. The server has no idea how
 *   much of its audio actually reached the room, so after an interruption we tell
 *   it via `conversation.item.truncate` — otherwise the model's context claims it
 *   said things nobody heard, and later turns get incoherent.
 * - The same session answers *two* kinds of question. Alongside the conversation it
 *   takes out-of-band probes (`requestOutOfBandText`) — a short text question about
 *   an utterance it has already heard, which is how "was that said to me?" is
 *   decided. Those responses never enter the conversation, and the bookkeeping that
 *   keeps them apart from the agent's own turns is the delicate part of this file.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { config } from '../../config';
import { logger } from '../../logger';
import { REALTIME_SAMPLE_RATE } from './resampler';
import type { PlaybackSnapshot } from './audio-playback';
import {
  buildRealtimeSocketOptions,
  resolveRealtimeEndpoint,
  type RealtimeEndpoint,
} from './openai-endpoint';

/**
 * How long to wait for `response.created` after asking for a response.
 *
 * Only a safety net for the optimistic active-response flag; see
 * `responseCreatedWatchdog`.
 */
const RESPONSE_CREATED_TIMEOUT_MS = 5_000;

/**
 * Slack added to the played duration before truncating, per OpenAI's own
 * server-side transport (`TwilioRealtimeTransport`).
 *
 * Truncating at exactly what was measured as heard makes the model repeat the last
 * word or two after an interruption: its context ends a fraction before the sound
 * the listener actually registered, so it resumes from there. Nudging the cut point
 * slightly *later* — always bounded by what was really sent to the device — trades a
 * few milliseconds the room may not have heard for speech that doesn't stutter.
 */
const TRUNCATE_SLACK_MS = 50;

/** A function tool offered to the model, already in JSON Schema form. */
export interface RealtimeFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The metadata key that marks a response as ours-and-out-of-band.
 *
 * Set by this class rather than by the caller, so recognising a probe on the way
 * back never depends on a convention a caller might get wrong. Its value is the
 * client `event_id` of the `response.create` that opened it, which is what ties a
 * verdict — or a rejection — back to the request that asked for it.
 */
const OUT_OF_BAND_MARKER = 'prism_oob';

/**
 * A question asked of the model *beside* the conversation rather than in it.
 *
 * `conversation: "none"` keeps the answer out of the session's conversation
 * state, so asking does not become part of what the agent has said. The reply is
 * text, and short: this exists for one-word judgements, not for speech.
 */
export interface OutOfBandRequest {
  /** Replaces the session prompt for this one response. */
  instructions: string;
  /**
   * The context for this response, in place of the conversation.
   *
   * An `{ type: 'item_reference', id }` entry points at an item the session already
   * holds, so referencing an utterance re-sends no audio — but the tokens are still
   * processed and still counted against the rate limit, so a reference saves
   * bandwidth rather than cost.
   *
   * **Pass it.** Omitting it inherits the entire conversation, which grows for the
   * length of the call: measured at 21,382 tokens on a live call against a 40,000
   * tokens-per-minute limit, which is under two responses a minute. It is also
   * ambiguous about *which* utterance is being judged, since the model can only be
   * told "the most recent one" and two turns can close while one verdict is in
   * flight. A bounded list ending on the item in question fixes both.
   */
  input?: unknown[];
  /** Merged into the frame's metadata; the marker key is added on top. */
  metadata?: Record<string, string>;
  /** After this, stop waiting and answer `null`. */
  deadlineMs: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort for this response alone. Omitted inherits the session's.
   *
   * Worth setting for anything that wants a short answer. The session runs at
   * `high` for the sake of the agent's own turns, and a probe inheriting it spends
   * its token budget thinking before it writes anything: measured against a live
   * session, a one-word question at `high` burned 36 reasoning tokens and took
   * 1401ms for an answer that needed five. At a budget of 16 it never got to the
   * word at all — the response came back `incomplete` with empty output, which for
   * a caller that treats no answer as a failure means silence every time.
   */
  reasoningEffort?: string;
}

/**
 * Whether a conversation item is somebody's turn in the room.
 *
 * The agent's own speech qualifies; so does a participant's audio. What does *not*
 * is a message this runtime wrote into the conversation itself — `sendContext()`
 * creates `role: 'user'` items carrying `input_text` for things nobody said out
 * loud ("you have just been admitted", "the people in the call are now…"). Those
 * would otherwise fill a probe's context window with the runtime's own notes and
 * change whether the latest utterance looks like it continues an exchange.
 *
 * Judged on content rather than role for that reason: role alone cannot tell a
 * spoken turn from an injected one.
 */
function isSpokenTurn(item: { role?: string; content?: { type?: string }[] }): boolean {
  if (item.role === 'assistant') return true;
  if (item.role !== 'user') return false;
  return (item.content ?? []).some((part) => part.type === 'input_audio');
}

/** The out-of-band send id carried in a response's metadata, if any. */
function readMarker(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.[OUT_OF_BAND_MARKER];
  return typeof value === 'string' && value ? value : undefined;
}

/** A probe on the wire, waiting for the model to answer it. */
interface PendingProbe {
  sendId: string;
  settle: (text: string | null) => void;
  timer: NodeJS.Timeout;
  /** Accumulated `output_text` deltas, used when `response.done` carries no output. */
  text: string;
}

/** A `response.create` the server has not acknowledged yet. */
interface PendingCreate {
  /** The client `event_id` sent with it, so a rejection can remove the right one. */
  eventId: string;
  /** Set when a probe asked for this one; absent means the conversation did. */
  probeSendId?: string;
  at: number;
}

/**
 * How long a response id stays recognisable as a probe's after it was opened.
 *
 * Not a count. Capping the *number* trades a few hundred bytes for the chance of
 * forgetting a response that is still generating, after which its audio would be
 * played into the room and — far worse — a tool call on it would reach the bridge
 * and execute for real. An age bound cannot do that: no response outlives this, and
 * an entry is normally removed the moment its `response.done` arrives.
 */
const PROBE_RESPONSE_TTL_MS = 120_000;

/**
 * Spoken turns kept for a probe to draw context from.
 *
 * Comfortably more than any window asks for, so the cap here is only a guard
 * against an hour-long call growing a list forever.
 */
const CONVERSATION_ITEM_LIMIT = 40;

export interface RealtimeSessionOptions {
  /** The agent's system prompt — Soul, User, Agent Guide, memory, and the rest. */
  instructions: string;
  tools: RealtimeFunctionTool[];
  /** Overrides `OPENAI_REALTIME_MODEL`. */
  model?: string;
  voice?: string;
  /**
   * What the room calls the agent, handed to the transcriber as a keyword.
   *
   * Names are the words a transcript gets wrong most: arbitrary, often short, and
   * unstressed in the vocative ("hey Emma, …"), which is exactly where a speech
   * model reaches for a common function word instead — a live call rendered "Hey
   * Emma, what's on the agenda" as "Hey, **I'm** what's on the agenda".
   *
   * This no longer decides anything: nothing is judged from the transcript any
   * more. It is kept because a log nobody can read the names in is a log that
   * cannot be used to work out why a call went wrong.
   */
  agentName?: string;
  /** Injected in tests so they can point at a local mock server. */
  endpointOverride?: RealtimeEndpoint;
}

/** Emitted when the model calls one of the agent's tools. */
export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON text as streamed by the model; may be malformed. */
  argumentsJson: string;
}

/**
 * Typed event surface. Consumers listen rather than passing a callback bag so the
 * session can be driven by more than one collaborator (playback, barge-in policy,
 * the service's telemetry) without threading callbacks through each of them.
 */
export interface RealtimeSessionEvents {
  /** Model speech, pcm16 mono @24 kHz, tagged with the item it belongs to. */
  audio: (pcm: Buffer, itemId: string) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  /**
   * The turn detector closed an utterance and added it to the conversation.
   *
   * Earlier than `transcript` by however long transcription takes, and the only
   * signal available before any words exist — which is what lets a one-to-one
   * call answer as promptly as it did when the server created responses itself.
   */
  utteranceCommitted: (itemId: string) => void;
  /** A participant's finished utterance, transcribed. */
  transcript: (itemId: string, text: string) => void;
  functionCall: (call: RealtimeFunctionCall) => void;
  responseDone: () => void;
  /**
   * A conversation response ended without producing anything.
   *
   * The agent decided to speak and the room heard silence — a rate limit, a server
   * error, an exhausted token budget. Indistinguishable from never having been
   * asked unless it is counted, which is what made this take two rounds to explain
   * the first time it happened.
   */
  responseFailed: (status: string) => void;
  /** A protocol-level error from the API; the socket usually stays open. */
  apiError: (message: string) => void;
  closed: (reason: string) => void;
}

export class RealtimeSession extends EventEmitter {
  /** Typed `on`, so a listener's arguments are checked against the event. */
  override on<E extends keyof RealtimeSessionEvents>(
    event: E,
    listener: RealtimeSessionEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /** Typed `emit`. Private: only this class raises its own events. */
  private emitEvent<E extends keyof RealtimeSessionEvents>(
    event: E,
    ...args: Parameters<RealtimeSessionEvents[E]>
  ): void {
    super.emit(event, ...args);
  }

  private ws: WebSocket | null = null;
  /**
   * Spoken turns the conversation holds, oldest first, bounded.
   *
   * What a gate probe's context window is drawn from. Bounded because a call runs
   * for an hour and a probe only ever wants the recent few — and because an
   * unbounded list is how the probe came to re-read the whole call and trip the
   * token rate limit.
   */
  private readonly conversationItems: string[] = [];
  private closed = false;
  /** The audio item currently being spoken, for targeted truncation. */
  private currentItemId: string | null = null;
  private responseActive = false;
  /** True once the server has actually opened the response we asked for. */
  private responseConfirmed = false;
  private responseWatchdog: NodeJS.Timeout | null = null;
  /** A `response.create` deferred until the open response finishes. */
  private responsePending = false;
  /**
   * Responses we have given up on, whose remaining audio must be discarded.
   *
   * An interrupt cannot un-send what is already in flight: deltas for the abandoned
   * response keep arriving for as long as the socket takes to drain. Forwarding them
   * would restart playback *over the person who interrupted*.
   *
   * Keyed by response rather than item on purpose: one turn can emit several audio
   * items (a native preamble, then the answer), so an item-keyed set would happily
   * play a *later* item of a response we already cancelled. This is also what
   * OpenAI's own server-side transport does.
   */
  private abandonedResponseIds = new Set<string>();
  /** Response each audio item belongs to, so an item can be matched to its turn. */
  private itemResponseIds = new Map<string, string>();
  /**
   * Audio the server actually generated per item, in ms.
   *
   * The hard ceiling for `audio_end_ms`: the API rejects a truncate beyond an item's
   * real duration. Our played-ms is derived from the same deltas so it should never
   * exceed this, but "should never" is not a guarantee worth betting a live call on —
   * a resampler rounding a few samples the wrong way would turn a barge-in into a
   * protocol error. OpenAI's own SDK caps the same way.
   */
  private generatedMsByItem = new Map<string, number>();
  /** The response currently generating, for attributing a barge-in. */
  private activeResponseId: string | null = null;
  /**
   * Out-of-band probes that have been sent but not yet answered, by send id.
   *
   * Bounded by the deadline every probe carries: each entry removes itself when it
   * settles, and a probe the server never answers settles on its own timer.
   */
  private readonly probesBySendId = new Map<string, PendingProbe>();
  /**
   * Probe send ids by the response id the server gave them.
   *
   * Kept until that response finishes, not until the probe settles — a probe that
   * gave up on its deadline may still have a response generating behind it, and
   * anything arriving on that response has to stay recognisable as *not the
   * conversation's*. Bounded like `abandonedResponseIds`, since a response that
   * never finishes would otherwise leave an entry for the rest of the call.
   */
  private readonly probeIdsByResponse = new Map<string, { sendId: string; at: number }>();
  private probeCounter = 0;
  private mainCreateCounter = 0;
  /**
   * Every `response.create` on the wire that the server has not opened yet, oldest
   * first, each knowing whether a probe asked for it.
   *
   * This is what lets `response.created` be attributed without relying on the
   * server echoing `metadata` — documented for `response.done`, but not for
   * `response.created`, and reported missing on at least one deployment. It has to
   * be a queue rather than a flag: `created` events arrive in the order their
   * requests were sent, and with a probe request and a conversation request both
   * un-acked, a flag cannot say which of the two is opening. Getting that wrong
   * swaps them — the probe claims the conversation's slot and never releases it,
   * and the call goes mute for good.
   */
  private readonly pendingCreates: PendingCreate[] = [];

  constructor(private readonly options: RealtimeSessionOptions) {
    super();
  }

  /** Open the socket and configure the session. Resolves once configured. */
  async connect(): Promise<void> {
    const endpoint = this.options.endpointOverride ?? resolveRealtimeEndpoint(this.options.model);
    const socketOptions = await buildRealtimeSocketOptions(endpoint);

    const ws = new WebSocket(endpoint.url, socketOptions as WebSocket.ClientOptions);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(new Error(`Realtime connection failed: ${err.message}`));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    ws.on('message', (data) => this.handleMessage(data));
    ws.on('error', (err) => {
      // Post-handshake socket errors: report, then let the close handler run.
      logger.error({ err }, '[Meeting] Realtime socket error');
      this.emitEvent('apiError', err.message);
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      // Settled here rather than only in `close()`: this is the *common* way a call
      // ends from the session's point of view, and by the time teardown calls
      // `close()` the `closed` flag is already set, so its own settling loop never
      // runs. Without this a caller waits out its whole deadline after the socket
      // is already gone.
      this.settleAllProbes();
      this.emitEvent('closed', reason.toString() || `code ${code}`);
    });

    this.configureSession();
  }

  /** Send the session configuration: instructions, audio formats, tools, VAD. */
  private configureSession(): void {
    const pcm = { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE };

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.options.instructions,
        output_modalities: ['audio'],
        // Read from config rather than threaded through as an option, the same
        // way the transcription model below is: it is a deployment-wide setting,
        // not something a single join decides. Omitted entirely when config says
        // so, which hands the level back to the API's own default of `low`.
        ...(config.openaiRealtimeReasoningEffort
          ? { reasoning: { effort: config.openaiRealtimeReasoningEffort } }
          : {}),
        audio: {
          input: {
            format: pcm,
            // Semantic VAD judges whether a speaker is *done* rather than just
            // whether the line went quiet — meetings are full of mid-thought
            // pauses that energy-based VAD reads as a finished turn. `low`
            // eagerness waits longest before deciding, which is what a room full
            // of humans needs.
            turn_detection: {
              type: 'semantic_vad',
              // `low` waits longest before deciding a speaker has finished, which
              // reads as a pause before every single answer — and in `addressed`
              // mode it is spent *before* the transcript and the name check even
              // begin. `medium` still judges meaning rather than silence, so a
              // mid-thought pause is not mistaken for the end of a turn the way an
              // energy-based detector would; it just stops being maximally patient
              // about it. Barge-in covers the remaining case: if it does start
              // early, the speaker talking on takes the floor straight back.
              eagerness: 'medium',
              // The model never answers on its own. Whether an utterance in a
              // mixed room channel was aimed at the agent is a judgement only the
              // client can make; `response-policy.ts` makes it and asks for the
              // response. Detection of the turn *boundary* still belongs here.
              create_response: false,
              // Off for the same family of reasons: interruption is decided
              // locally so a backchannel ("mm-hm") doesn't cut the agent off
              // mid-sentence.
              interrupt_response: false,
            },
            // `far_field` reads like the right fit for a meeting, but it describes
            // the *humans'* microphones rather than this input: what arrives here is
            // Meet's mixed output, already suppressed, echo-cancelled and levelled per
            // participant. Reducing it again is a second pass over a cleaned mix, and
            // it cost a live agent minutes of not hearing a person in the room. `off`
            // omits the whole key rather than sending a null one, which the API
            // rejects — that would end the call instead of disabling the filter.
            ...(config.noiseReduction === 'off'
              ? {}
              : { noise_reduction: { type: config.noiseReduction } }),
            // For the log, and nothing else. Whether the agent was addressed is
            // judged from the audio now (`addressed-audio-gate.ts`), so no decision
            // waits on these words and a transcription that fails or comes back
            // empty costs a log line rather than an answer. It is kept because
            // reading a call back beside its verdicts is how every wrong verdict so
            // far has been diagnosed, and it is billed per audio minute — at
            // whisper-class rates a rounding error beside the Realtime audio tokens
            // the same minute costs. `MEETING_TRANSCRIPT_LOGGING` decides whether
            // any of it is written down; this only decides whether it exists.
            // `gpt-live-transcribe` accepts `keywords`, which is how the agent's
            // name and the room's roster are given to it. The previous default,
            // `gpt-realtime-whisper`, supports neither `keywords` nor `prompt` in GA
            // Realtime sessions, so there was no way to tell it which word mattered.
            // Pinned to English rather than auto-detected. Left to itself the
            // transcriber drifts language mid-call — one real meeting came back
            // with German, Korean and Bulgarian renderings of English speech.
            // Voice meetings are English-only today, and the prompt says so.
            transcription: {
              model: config.openaiTranscriptionModel,
              language: 'en',
              ...(this.options.agentName
                ? { keywords: [this.options.agentName] }
                : {}),
            },
          },
          output: {
            format: pcm,
            ...(this.options.voice ? { voice: this.options.voice } : {}),
          },
        },
        ...(this.options.tools.length > 0
          ? {
              tools: this.options.tools.map((t) => ({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
              tool_choice: 'auto',
            }
          : {}),
      },
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch {
      logger.warn('[Meeting] Unparseable Realtime frame');
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        return;

      // GA renamed the audio output events to the `response.output_audio.*`
      // family; the older `response.audio.*` names are accepted too so a model
      // snapshot that still emits them doesn't go silent.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = event.delta;
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        const responseId = typeof event.response_id === 'string' ? event.response_id : this.activeResponseId;
        if (typeof delta !== 'string' || delta.length === 0) return;
        // A probe asks for text only, so audio on one is a contract violation
        // rather than something to play into the room.
        if (responseId && this.isProbeResponse(responseId)) return;
        // Tail of a turn we already yielded the floor on — see
        // `abandonedResponseIds`. Dropped before it can restart playback.
        if (responseId && this.abandonedResponseIds.has(responseId)) return;
        const pcm = Buffer.from(delta, 'base64');
        if (itemId) {
          this.currentItemId = itemId;
          if (responseId) this.itemResponseIds.set(itemId, responseId);
          // pcm16 mono at the session rate: two bytes per sample.
          const ms = (pcm.length / 2 / REALTIME_SAMPLE_RATE) * 1000;
          this.generatedMsByItem.set(itemId, (this.generatedMsByItem.get(itemId) ?? 0) + ms);
        }
        this.emitEvent('audio', pcm, itemId);
        return;
      }

      case 'input_audio_buffer.speech_started':
        this.emitEvent('speechStarted');
        return;

      case 'input_audio_buffer.speech_stopped':
        this.emitEvent('speechStopped');
        return;

      // The turn detector decided the speaker was finished and committed the
      // audio as a conversation item. With `create_response` off this is where a
      // response *would* have been created, so it is the moment to decide whether
      // to ask for one.
      case 'input_audio_buffer.committed': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        this.emitEvent('utteranceCommitted', itemId);
        return;
      }

      // Every item the conversation gains, which is what a gate probe's context
      // window is drawn from. Only spoken turns are kept: a `function_call_output`
      // can be 12,000 characters of tool result (`tool-bridge.ts`) — measured at
      // ~2,900 tokens for one — and says nothing about who was addressed, so
      // including it would make each probe cost more than the room does.
      case 'conversation.item.added':
      case 'conversation.item.created': {
        const item = event.item as
          | { id?: string; type?: string; role?: string; content?: { type?: string }[] }
          | undefined;
        if (item?.id && item.type === 'message' && isSpokenTurn(item)) {
          this.rememberConversationItem(item.id);
        }
        return;
      }

      // Transcription can fail outright. Nothing reads these words any more, so this
      // costs a log line rather than a verdict — but it is still worth `warn`: a
      // room whose transcripts fail cannot be read back at all, and that is the
      // difference between diagnosing a bad verdict and guessing at it.
      case 'conversation.item.input_audio_transcription.failed': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        const err = event.error as { message?: string } | undefined;
        logger.warn(
          `[Meeting] Transcription failed for ${itemId || 'an utterance'}` +
            `${err?.message ? `: ${err.message}` : ''} — it will not appear in the log`,
        );
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript;
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (typeof transcript === 'string' && transcript.trim()) {
          this.emitEvent('transcript', itemId, transcript.trim());
          return;
        }
        logger.warn(
          `[Meeting] Transcription came back empty for ${itemId || 'an utterance'} ` +
            `— it will not appear in the log`,
        );
        return;
      }

      case 'response.created': {
        const created = event.response as
          | { id?: string; metadata?: Record<string, unknown> }
          | undefined;
        // An out-of-band probe does not occupy the conversation's response slot, so
        // none of the slot bookkeeping below may run for one. In particular it must
        // not set `responseConfirmed`: a dropped conversation request followed by a
        // probe opening would otherwise satisfy the watchdog that exists to undo it,
        // and the agent would go mute for the rest of the call.
        const probeSendId = this.attributeCreatedToProbe(created);
        if (probeSendId) {
          if (created?.id) this.rememberProbeResponse(created.id, probeSendId);
          return;
        }
        // Confirms the optimistic flag `requestResponse()` set on send. Setting it
        // here as well keeps the bookkeeping right for any response the server
        // opens that we did not ask for — with `create_response` off there should
        // be none, but colliding with one would wedge the session.
        this.responseActive = true;
        this.responseConfirmed = true;
        this.activeResponseId = created?.id ?? null;
        logger.info(`[Meeting:Resp] Conversation response ${this.activeResponseId ?? '?'} opened`);
        return;
      }

      case 'response.function_call_arguments.done': {
        const callId = typeof event.call_id === 'string' ? event.call_id : '';
        const name = typeof event.name === 'string' ? event.name : '';
        const argumentsJson = typeof event.arguments === 'string' ? event.arguments : '{}';
        if (!callId || !name) {
          logger.warn('[Meeting] Function call event missing call_id or name');
          return;
        }
        // A probe must never reach the tool bridge. Every probe is sent with
        // `tools: []` and `tool_choice: 'none'`, so this should be unreachable —
        // but the session's tools are the agent's real ones, including shell and
        // its own configuration, and a tool call is executed for real. Two
        // independent guards, because one of them silently not applying is exactly
        // the kind of thing that only shows up in a live call.
        //
        // This one depends on the event naming its response: attribution is
        // genuinely impossible without it, and unlike the audio path there is no
        // safe fallback — guessing the conversation would execute the call, and
        // guessing a probe would drop a real one. It has always been present in
        // practice.
        const responseId = typeof event.response_id === 'string' ? event.response_id : '';
        if (this.isProbeResponse(responseId)) {
          logger.warn(
            `[Meeting] Ignored a tool call (${name}) on an out-of-band response — ` +
              'probes carry no tools',
          );
          return;
        }
        this.emitEvent('functionCall', { callId, name, argumentsJson });
        return;
      }

      // GA streams a text-only response as `response.output_text.*`; the older
      // `response.text.*` names are accepted too. Only probes ask for text, so
      // these deltas are theirs — the conversation's responses are audio.
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const responseId = typeof event.response_id === 'string' ? event.response_id : '';
        const probe = this.probeFor(responseId);
        if (probe && typeof event.delta === 'string') probe.text += event.delta;
        return;
      }

      case 'response.done': {
        const done = event.response as
          | {
              id?: string;
              metadata?: Record<string, unknown>;
              status?: string;
              status_details?: unknown;
              output?: { content?: { text?: string; transcript?: string }[] }[];
            }
          | undefined;
        // A probe finishing must release nothing: the conversation's own response
        // may still be generating, and clearing the slot here would both fire a
        // deferred duplicate and count the probe as something the room heard.
        const probeSendId = this.probeSendIdFor(done);
        if (probeSendId) {
          const probe = this.probesBySendId.get(probeSendId);
          if (done?.id) this.probeIdsByResponse.delete(done.id);
          // The send queue entry has to go too. When this probe was matched by its
          // marker rather than by an id recorded at `response.created` — because
          // that event was missed — its entry is still queued, and the next bare
          // conversation `created` would take it, be classified out-of-band, have
          // its audio discarded and never release the slot. That is a mute call for
          // the rest of the meeting.
          this.dropCreate(probeSendId);
          if (probe) {
            const fromOutput = (done?.output ?? [])
              .flatMap((item) => item.content ?? [])
              .map((part) => part.text ?? part.transcript ?? '')
              .join(' ')
              .trim();
            probe.settle(fromOutput || probe.text.trim() || null);
          }
          return;
        }
        this.responseActive = false;
        this.responseConfirmed = false;
        // Cleared with the response it names. Left set, the next `requestResponse()`
        // has a window before its own `response.created` lands in which `interrupt()`
        // would cancel and abandon *this* finished response instead — so the new one
        // is neither cancelled nor marked abandoned, and carries on speaking over the
        // person who interrupted.
        this.activeResponseId = null;
        const queued = this.responsePending ? ' — releasing the queued request' : '';
        if (done?.status && done.status !== 'completed') {
          // The room heard nothing. Deliberately **not** retried: the API's own
          // suggested delay for a rate limit was 26 seconds, and answering a
          // question the room asked half a minute ago is worse than not answering
          // it — the same reason a stale verdict is dropped. Someone repeating
          // themselves recovers this; a queue of late answers arriving together
          // does not. So it is reported loudly and counted instead, and the real
          // fix is not needing to retry.
          logger.warn(
            `[Meeting:Resp] Conversation response ${done.id ?? '?'} produced nothing ` +
              `(status=${done.status}, details=${JSON.stringify(done.status_details ?? {})})` +
              `${queued}`,
          );
          this.emitEvent('responseFailed', done.status);
        } else {
          logger.info(
            `[Meeting:Resp] Conversation response ${done?.id ?? '?'} done ` +
              `status=${done?.status ?? 'unknown'}${queued}`,
          );
        }
        this.emitEvent('responseDone');
        // Release a response that was requested while this one was still open.
        if (this.responsePending) {
          this.responsePending = false;
          this.requestResponse();
        }
        return;
      }

      case 'error': {
        const err = event.error as { message?: string; event_id?: string } | undefined;
        const message = err?.message ?? 'unknown Realtime API error';
        // A rejected `response.create` never opens a response, so metadata never
        // comes back for it — the client `event_id` echoed here is the only thing
        // that says which request failed. Settle that probe and touch no slot
        // state: a probe rejected with "already has an active response" must not
        // set `responsePending`, or the rejection queues a phantom answer that
        // speaks unprompted when the open response finishes.
        //
        // The id lives on `error.event_id`, **not** the top level. This event has
        // two: the outer one is the server's id for the error itself, and the inner
        // one names the client event that caused it. Reading the outer one matches
        // nothing, so every rejection fell through to the regex branches below —
        // which is precisely the phantom-response path the paragraph above claims
        // to prevent, and a test written against the same wrong shape passed.
        const failedSendId = typeof err?.event_id === 'string' ? err.event_id : '';
        if (failedSendId) this.dropCreate(failedSendId);
        const failedProbe = this.probesBySendId.get(failedSendId);
        if (failedProbe) {
          logger.warn(`[Meeting] Out-of-band request rejected: ${message}`);
          failedProbe.settle(null);
          return;
        }
        // Two opposite errors mention an active response, and confusing them wedges
        // the session: matching them loosely once meant a failed *cancel* was read
        // as "a response is running", after which every later request deferred
        // forever and the bot went mute for the rest of the call.
        if (/already has an active response/i.test(message)) {
          // The server is mid-response and dropped our request. Remember it so the
          // answer goes out when that one finishes instead of being lost.
          this.responseActive = true;
          this.responseConfirmed = true;
          this.responsePending = true;
          logger.warn('[Meeting] Response request arrived too early; queued behind the open one');
          return;
        }
        if (/no active response/i.test(message)) {
          // We cancelled something already finished — a barge-in landing just as the
          // model stopped. The response is over, so release the flags rather than
          // leaving them set on a response that no longer exists.
          this.responseActive = false;
          this.responseConfirmed = false;
          logger.debug('[Meeting] Cancelled a response that had already finished');
          if (this.responsePending) {
            this.responsePending = false;
            this.requestResponse();
          }
          return;
        }
        logger.error(`[Meeting] Realtime API error: ${message}`);
        this.emitEvent('apiError', message);
        return;
      }

      default:
        return;
    }
  }

  /** Append captured meeting audio (pcm16 mono @24 kHz) to the input buffer. */
  sendAudio(pcm24k: Buffer): void {
    if (pcm24k.length === 0) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
  }

  /**
   * Ask the model to respond now (addressed-only mode drives turns this way).
   *
   * Deferred while a response is still generating: the API rejects a second
   * `response.create` and the request would simply be lost. This matters most for
   * tool results — `response.function_call_arguments.done` arrives *before* the
   * `response.done` of the response that made the call, so a tool that answers
   * quickly (a cache hit, or a rejected argument) gets here while the previous
   * response is still open. Without the deferral its answer would never be spoken
   * until some later turn happened to trigger a response.
   */
  requestResponse(): void {
    if (this.responseActive) {
      // Only one can be queued. A second request while one is already waiting is
      // dropped here, silently — which is invisible without this line, and reads in
      // the room as the agent ignoring something it was asked.
      logger.info(
        `[Meeting:Resp] Deferred a request — response ${this.activeResponseId ?? '(unconfirmed)'} ` +
          `is still open${this.responsePending ? ', and one was already queued' : ''}`,
      );
      this.responsePending = true;
      return;
    }
    // Marked active on *send*, not on the server's `response.created`. Waiting for
    // confirmation leaves a round-trip-wide window in which a second request looks
    // legal, and the API answers that with "Conversation already has an active
    // response in progress" — after which the second answer is simply lost.
    this.responseActive = true;
    this.responseCreatedWatchdog();
    // Given an id of its own so that a rejection — which echoes it — can remove
    // this request from the queue rather than leaving it to misplace a later
    // `response.created`.
    const eventId = `main_${++this.mainCreateCounter}`;
    this.noteCreateSent(eventId);
    this.send({ type: 'response.create', event_id: eventId });
  }

  /**
   * Ask the model a question beside the conversation and wait for its text.
   *
   * Resolves `null` when there is no answer to be had — the socket is shut, the
   * request was rejected, the deadline passed, or the model returned nothing. The
   * caller decides what silence means; this only reports it.
   *
   * Deliberately *not* routed through `requestResponse()`. That method guards the
   * conversation's single response slot, and a probe does not compete for it: going
   * through it would defer the probe behind whatever the agent is saying, which is
   * the opposite of what a "should I answer this?" question is for.
   */
  requestOutOfBandText(request: OutOfBandRequest): Promise<string | null> {
    if (!this.isOpen) return Promise.resolve(null);

    const sendId = `oob_${++this.probeCounter}`;
    return new Promise<string | null>((resolve) => {
      const settle = (text: string | null): void => {
        if (!this.probesBySendId.has(sendId)) return;
        this.probesBySendId.delete(sendId);
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => {
        logger.warn(`[Meeting] Out-of-band request ${sendId} went unanswered`);
        settle(null);
      }, request.deadlineMs);
      timer.unref?.();

      this.probesBySendId.set(sendId, { sendId, settle, timer, text: '' });
      this.noteCreateSent(sendId, sendId);
      this.send({
        type: 'response.create',
        event_id: sendId,
        response: {
          // Keeps the answer out of the conversation, so asking is not something
          // the agent has said.
          conversation: 'none',
          output_modalities: ['text'],
          instructions: request.instructions,
          metadata: { ...request.metadata, [OUT_OF_BAND_MARKER]: sendId },
          // Not inherited from the session: the agent's real tools are live in a
          // meeting, and a probe reading an untrusted utterance must not be able
          // to reach them. See the guard in `response.function_call_arguments.done`.
          tools: [],
          tool_choice: 'none',
          ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
          ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
          ...(request.input ? { input: request.input } : {}),
        },
      });
    });
  }

  /**
   * Whether a response id is a probe's rather than the conversation's.
   *
   * Deliberately independent of whether that probe is still waiting: a probe can
   * give up on its deadline while the server keeps generating, and anything
   * arriving on such a response is still not the conversation's — least of all a
   * tool call, which would otherwise be executed for real.
   */
  private isProbeResponse(responseId: string): boolean {
    return responseId !== '' && this.probeIdsByResponse.has(responseId);
  }

  /** Note a spoken turn, evicting the oldest past the cap. */
  private rememberConversationItem(itemId: string): void {
    if (this.conversationItems.includes(itemId)) return;
    this.conversationItems.push(itemId);
    while (this.conversationItems.length > CONVERSATION_ITEM_LIMIT) {
      this.conversationItems.shift();
    }
  }

  /**
   * The most recent spoken turns, oldest first — the context a probe can draw on.
   *
   * Tool calls and their output are deliberately absent: one tool result can be
   * 12,000 characters, measured at ~2,900 tokens, and it says nothing about who was
   * addressed. Including them is what made a probe cost more than the room did.
   */
  recentConversationItems(limit: number): string[] {
    return limit <= 0 ? [] : this.conversationItems.slice(-limit);
  }

  /**
   * Give up on every probe still waiting.
   *
   * Nobody is going to answer them once the socket is gone. Settling rather than
   * leaving them pending is what stops a caller awaiting a verdict for the whole
   * length of its deadline after the call has already ended.
   */
  private settleAllProbes(): void {
    for (const probe of [...this.probesBySendId.values()]) probe.settle(null);
  }

  /** The probe still waiting on a response id, if one is. */
  private probeFor(responseId: string): PendingProbe | undefined {
    const entry = responseId ? this.probeIdsByResponse.get(responseId) : undefined;
    return entry ? this.probesBySendId.get(entry.sendId) : undefined;
  }

  /**
   * Remember a response as a probe's, dropping only entries too old to be live.
   *
   * Deliberately never evicts by count: an entry forgotten while its response is
   * still generating is one whose tool calls stop being recognised as a probe's.
   */
  private rememberProbeResponse(responseId: string, sendId: string): void {
    const cutoff = Date.now() - PROBE_RESPONSE_TTL_MS;
    for (const [id, entry] of this.probeIdsByResponse) {
      if (entry.at < cutoff) this.probeIdsByResponse.delete(id);
    }
    this.probeIdsByResponse.set(responseId, { sendId, at: Date.now() });
  }

  /** Note a `response.create` on the wire, so its `response.created` can be placed. */
  private noteCreateSent(eventId: string, probeSendId?: string): void {
    this.pendingCreates.push({ eventId, probeSendId, at: Date.now() });
  }

  /** Forget a request the server rejected — no `response.created` is coming for it. */
  private dropCreate(eventId: string): void {
    const index = this.pendingCreates.findIndex((c) => c.eventId === eventId);
    if (index >= 0) this.pendingCreates.splice(index, 1);
  }

  /**
   * Which request a bare `response.created` belongs to.
   *
   * Oldest first, because the server opens responses in the order it received the
   * requests. Anything older than the watchdog's patience is discarded first: a
   * request the API dropped silently gets no `created`, and leaving it at the head
   * of the queue would misplace every later one.
   */
  private takeCreate(): PendingCreate | undefined {
    const cutoff = Date.now() - RESPONSE_CREATED_TIMEOUT_MS;
    while (this.pendingCreates.length > 0 && (this.pendingCreates[0]?.at ?? 0) < cutoff) {
      this.pendingCreates.shift();
    }
    return this.pendingCreates.shift();
  }

  /**
   * Which probe a finished response belongs to — by the id recorded when it opened,
   * or failing that by the marker the server echoes on `response.done`.
   */
  private probeSendIdFor(
    done: { id?: string; metadata?: Record<string, unknown> } | undefined,
  ): string | undefined {
    const byId = done?.id ? this.probeIdsByResponse.get(done.id)?.sendId : undefined;
    return byId ?? readMarker(done?.metadata);
  }

  /**
   * Decide whether a newly opened response is a probe's, and which.
   *
   * The marker settles it when the server echoes metadata, and is trusted even if
   * that probe has already given up — a response we know is out-of-band must never
   * be allowed to claim the conversation's slot, because nothing would then
   * release it. Otherwise the send queue decides, in order.
   */
  private attributeCreatedToProbe(
    created: { id?: string; metadata?: Record<string, unknown> } | undefined,
  ): string | undefined {
    const marked = readMarker(created?.metadata);
    if (marked) {
      this.dropCreate(marked);
      return marked;
    }
    return this.takeCreate()?.probeSendId;
  }

  /**
   * Undo an optimistic `responseActive` if the server never opens the response.
   *
   * Without this, a `response.create` that the API drops (a rejected tool argument,
   * a transient error) would leave the flag set and every later request deferred
   * forever — the bot goes permanently mute, which is far worse than one duplicate.
   */
  private responseCreatedWatchdog(): void {
    if (this.responseWatchdog) clearTimeout(this.responseWatchdog);
    this.responseWatchdog = setTimeout(() => {
      this.responseWatchdog = null;
      if (this.responseActive && !this.responseConfirmed) {
        logger.warn('[Meeting] No response.created arrived; clearing the active-response flag');
        // The queue entry for the dropped request is not removed here: it ages out
        // on the same timeout inside `takeCreate()`, which is also what covers a
        // request dropped without any watchdog running.
        this.responseActive = false;
        if (this.responsePending) {
          this.responsePending = false;
          this.requestResponse();
        }
      }
    }, RESPONSE_CREATED_TIMEOUT_MS);
    this.responseWatchdog.unref?.();
  }

  /**
   * Abandon the in-flight response and tell the model how much of it was
   * actually heard, so its context matches the room's experience.
   *
   * `playedMs` must be what reached the meeting, not what was received — audio
   * deltas arrive far faster than real time.
   */
  interrupt(items: PlaybackSnapshot[]): void {
    // A response queued behind this one is abandoned with it: the human now has
    // the floor, and their speech is what should decide the next turn. (Any tool
    // result already sits in the conversation, so nothing is lost.)
    if (this.responsePending) {
      logger.info('[Meeting:Resp] Dropped a queued request — a human took the floor');
    }
    this.responsePending = false;
    if (this.responseActive) {
      // Named explicitly so a probe in flight cannot be the thing that gets
      // cancelled. Without an id the API cancels "an in-progress response in the
      // default conversation", which is also what we want — but only the id makes
      // that a guarantee rather than a documented default, and the id is unknown
      // only in the round trip before `response.created` lands.
      this.send({
        type: 'response.cancel',
        ...(this.activeResponseId ? { response_id: this.activeResponseId } : {}),
      });
      this.responseActive = false;
      // The send queue is deliberately left alone: cancelling does not stop the
      // `response.created` for a request already on the wire, so dropping its
      // entry here would misplace that event when it lands.
    }

    items.forEach(({ itemId, playedMs, sentMs }, index) => {
      // OpenAI's transport formula: nudge the cut point past what was measured as
      // heard, bounded by what actually reached the device — and truncate an item
      // that never started at 0 so its transcript still leaves the context.
      const generated = this.generatedMsByItem.get(itemId) ?? sentMs;
      const ceiling = Math.min(sentMs, generated);
      const audioEndMs =
        index === 0 || playedMs > 0
          ? Math.max(0, Math.floor(Math.min(ceiling, playedMs + TRUNCATE_SLACK_MS)))
          : 0;
      this.send({
        type: 'conversation.item.truncate',
        item_id: itemId,
        content_index: 0,
        audio_end_ms: audioEndMs,
      });
      const responseId = this.itemResponseIds.get(itemId);
      if (responseId) this.abandonedResponseIds.add(responseId);
      this.itemResponseIds.delete(itemId);
      this.generatedMsByItem.delete(itemId);
    });
    if (this.activeResponseId) this.abandonedResponseIds.add(this.activeResponseId);

    // Bounded: only recent turns matter, and a long call would otherwise grow this
    // set for every interruption.
    while (this.abandonedResponseIds.size > 32) {
      this.abandonedResponseIds.delete(this.abandonedResponseIds.values().next().value as string);
    }
    this.currentItemId = null;
  }

  /** Return a tool result to the model and let it continue speaking. */
  sendFunctionOutput(callId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // The model does not resume on its own after a tool result — even with
    // automatic turn detection, a function_call_output needs an explicit
    // response.create or the answer never gets spoken.
    this.requestResponse();
  }

  /**
   * Inject context the model should know but nobody said out loud (e.g. "you
   * have just been admitted to the meeting").
   */
  sendContext(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /**
   * Tell the transcriber which names to expect, mid-call.
   *
   * The roster changes while the call runs — people join and leave — and the whole
   * value of these hints is that they name the *current* room. Sent as a partial
   * `session.update`, which merges rather than replacing, so nothing else about the
   * session has to be restated here (restating it would risk resetting turn
   * detection under a live conversation).
   *
   * Silently a no-op before the socket opens; the connect-time config already
   * carries the agent's own name, which is the one that matters most.
   */
  setTranscriptionKeywords(keywords: string[]): void {
    if (!this.isOpen || keywords.length === 0) return;
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            transcription: {
              model: config.openaiTranscriptionModel,
              language: 'en',
              keywords,
            },
          },
        },
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleAllProbes();
    // 1000 = normal closure; anything else shows up as an error in OpenAI's logs.
    try {
      this.ws?.close(1000, 'meeting ended');
    } catch {
      this.ws?.terminate();
    }
  }
}
