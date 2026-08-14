/**
 * The OpenAI Realtime API session — the agent's voice and ears in a meeting.
 *
 * This is a speech-to-speech session: meeting audio goes in as pcm16 and the
 * model's speech comes back as pcm16. There is deliberately no transcript in the
 * conversation path — transcription is only ever used to decide whether the agent
 * was addressed (see `response-policy.ts`), never as the model's input.
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
   * The one word the transcript exists to find is the hardest one in it: a name
   * is arbitrary, often short, and unstressed in the vocative ("hey Emma, …"),
   * which is exactly where a speech model reaches for a common function word
   * instead. A live call rendered "Hey Emma, what's on the agenda" as "Hey,
   * **I'm** what's on the agenda" — the gate then correctly found no name and
   * stayed silent, having been asked a direct question. No amount of judgement
   * downstream recovers a word that never reached the text, so the fix belongs
   * here, in the decoder's prior.
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
  /**
   * Transcription so far for an utterance still being transcribed.
   *
   * Carries the text accumulated up to this point, not just the new fragment.
   * People put a name at the *start* of a sentence, so this usually settles the
   * question a good few hundred milliseconds before `transcript` would.
   */
  transcriptPartial: (itemId: string, textSoFar: string) => void;
  /** A participant's finished utterance, transcribed. */
  transcript: (itemId: string, text: string) => void;
  functionCall: (call: RealtimeFunctionCall) => void;
  responseDone: () => void;
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
   * Transcription accumulated per utterance while it is still being transcribed.
   *
   * Bounded by the conversation itself: an entry is added when an utterance starts
   * being transcribed and removed when it finishes, so at most a handful are live.
   */
  private readonly partialTranscripts = new Map<string, string>();
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
            // Only ever used to decide who was addressed — never fed back as the
            // model's input. On for every call, because the mode can change under
            // a live session as people join, and transcription cannot be turned on
            // retroactively for an utterance already past. It is billed per audio
            // minute, but at whisper-class rates that is a rounding error beside
            // the Realtime audio tokens the same minute costs.
            // `gpt-live-transcribe` is the streaming transcriber that also accepts
            // `keywords`. That pairing is what this path needs and only two models
            // offer it (`gpt-transcribe` is the same family without the live
            // streaming the early-verdict path reads from). The previous default,
            // `gpt-realtime-whisper`, supports neither `keywords` nor `prompt` in
            // GA Realtime sessions, so there was no way to tell it which word
            // mattered — see `agentName` above for what that cost.
            // Pinned to English rather than auto-detected. Left to itself the
            // transcriber drifts language mid-call — one real meeting came back
            // with German, Korean and Bulgarian renderings of English speech —
            // and a wrong language guess also mangles the agent's name, which is
            // the one word this transcript exists to find. Voice meetings are
            // English-only today, and the prompt says so to the model.
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

      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!itemId || !delta) return;
        const soFar = (this.partialTranscripts.get(itemId) ?? '') + delta;
        this.partialTranscripts.set(itemId, soFar);
        this.emitEvent('transcriptPartial', itemId, soFar);
        return;
      }

      // Transcription can fail outright. Nothing to judge, but the partial text
      // accumulated so far has to go, or it sits in the map for the rest of the call.
      //
      // `warn`, not `debug`: no transcript means no `transcript` event, so the
      // addressed gate is never consulted and the agent stays silent through an
      // utterance that may well have named it — the same outward symptom as a gate
      // that heard the sentence and judged it unaddressed, and the two need opposite
      // fixes. At `debug` this was invisible in production (the runtime defaults to
      // `info`), so a count of zero proved only that the level was too low to say.
      case 'conversation.item.input_audio_transcription.failed': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (itemId) this.partialTranscripts.delete(itemId);
        const err = event.error as { message?: string } | undefined;
        logger.warn(
          `[Meeting] Transcription failed for ${itemId || 'an utterance'}` +
            `${err?.message ? `: ${err.message}` : ''} — the gate never saw it`,
        );
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript;
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        this.partialTranscripts.delete(itemId);
        if (typeof transcript === 'string' && transcript.trim()) {
          this.emitEvent('transcript', itemId, transcript.trim());
          return;
        }
        // A success that carries nothing is the same silence as a failure — no
        // event, so no gate call — and it used to leave no trace at all.
        logger.warn(
          `[Meeting] Transcription came back empty for ${itemId || 'an utterance'} ` +
            `— the gate never saw it`,
        );
        return;
      }

      case 'response.created': {
        // Confirms the optimistic flag `requestResponse()` set on send. Setting it
        // here as well keeps the bookkeeping right for any response the server
        // opens that we did not ask for — with `create_response` off there should
        // be none, but colliding with one would wedge the session.
        this.responseActive = true;
        this.responseConfirmed = true;
        const created = event.response as { id?: string } | undefined;
        this.activeResponseId = created?.id ?? null;
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
        this.emitEvent('functionCall', { callId, name, argumentsJson });
        return;
      }

      case 'response.done':
        this.responseActive = false;
        this.responseConfirmed = false;
        this.emitEvent('responseDone');
        // Release a response that was requested while this one was still open.
        if (this.responsePending) {
          this.responsePending = false;
          this.requestResponse();
        }
        return;

      case 'error': {
        const err = event.error as { message?: string } | undefined;
        const message = err?.message ?? 'unknown Realtime API error';
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
      this.responsePending = true;
      return;
    }
    // Marked active on *send*, not on the server's `response.created`. Waiting for
    // confirmation leaves a round-trip-wide window in which a second request looks
    // legal, and the API answers that with "Conversation already has an active
    // response in progress" — after which the second answer is simply lost.
    this.responseActive = true;
    this.responseCreatedWatchdog();
    this.send({ type: 'response.create' });
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
    this.responsePending = false;
    if (this.responseActive) {
      this.send({ type: 'response.cancel' });
      this.responseActive = false;
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
    // 1000 = normal closure; anything else shows up as an error in OpenAI's logs.
    try {
      this.ws?.close(1000, 'meeting ended');
    } catch {
      this.ws?.terminate();
    }
  }
}
