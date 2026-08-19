/**
 * The conversation itself: meeting audio in, agent speech out.
 *
 * Wires the five collaborators into one loop and owns nothing else — the browser,
 * the audio devices and the meeting's lifecycle all belong to the service above:
 *
 *     capture (48k) → Downsampler → RealtimeSession → Upsampler → AudioPlayback
 *                                        │
 *                                   ResponsePolicy (open room, or gate it?)
 *                                        │
 *                                   AddressedAudioGate (was that said to me?)
 *                                        │
 *                                   BargeInPolicy (yields the floor to humans)
 *                                        │
 *                                   ToolBridge (runs the agent's real tools)
 *
 * Every response on this session is one asked for here: the server is configured
 * never to answer on its own, so an utterance becomes speech only if this decides
 * it was aimed at the agent.
 *
 * That decision happens in exactly one place — when the turn detector closes an
 * utterance. It is both the earliest moment the audio can be pointed at and the
 * earliest the agent should speak, so there is no verdict to hold back for a later
 * boundary and no second path that could answer the same sentence twice. An earlier
 * design judged a partial transcript as well, to hide a text classifier's latency
 * behind the rest of the sentence, and most of the machinery here existed to
 * reconcile the two verdicts that produced.
 *
 * The one subtlety left is the ordering between a new utterance and a pending pause.
 * When the model starts speaking again while a barge-in pause is still undecided,
 * the stale audio has to be dropped *before* the new audio queues, or the two get
 * spliced into one garbled utterance. Hence `commitIfPending()` ahead of the
 * enqueue rather than after.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { Downsampler, Upsampler } from './resampler';
import { RealtimeSession, type RealtimeSessionOptions } from './realtime-session';
import { AudioPlayback, type PlaybackSink } from './audio-playback';
import { BargeInPolicy } from './barge-in';
import { ResponsePolicy, type EffectiveMode, type ResponseMode } from './response-policy';
import { judgeAddressed, ADDRESSED_DEADLINE_MS } from './addressed-audio-gate';
import { formatTranscript } from './transcript-log';
import type { SpeakerReading } from './meeting-provider.interface';

/**
 * How long a speaker reading stays worth believing.
 *
 * The poll adds up to a second and a gate verdict about 1.3 more, so a reading is already
 * a couple of seconds old when an utterance's words arrive — that part is expected and
 * fine. What this bounds is the other end: the meters go still when nobody has spoken for
 * a while, and a read then names nobody at all. Holding the last name indefinitely would
 * keep naming somebody who stopped talking a minute ago.
 *
 * Six seconds is comfortably past the lag and well short of a conversational pause.
 */
const SPEAKER_FRESHNESS_MS = 6_000;

/**
 * Most names handed to the transcriber at once.
 *
 * These are decoding hints, and a long list is not free: every name biases the
 * recognizer toward hearing it, so a thirty-person roster would make near-misses on
 * *all* of them likelier — including the agent's own name, where a false hit is the
 * failure this feature exists to prevent.
 */
const KEYWORD_LIMIT = 12;
import type { PreparedMeetingTools } from './tool-bridge';

export interface VoiceConversationOptions {
  instructions: string;
  tools: PreparedMeetingTools;
  /** Written with 48 kHz pcm16 — `pacat`'s stdin in production. */
  sink: PlaybackSink;
  /** `auto` follows the participant count; see response-policy.ts. */
  responseMode: ResponseMode;
  /** The name the agent answers to — the same one the room hears it introduce. */
  agentName: string;
  model?: string;
  voice?: string;
  endpointOverride?: RealtimeSessionOptions['endpointOverride'];
  /**
   * The session died on its own — the agent has no voice and no ears any more.
   *
   * Only fired for a close we did not ask for: `stop()` sets `stopped` before it
   * closes the socket, so a teardown-initiated close is already distinguishable.
   * The owner is expected to end the call, because everything that makes the bot a
   * participant is gone while the browser is still sitting in the room.
   */
  onSessionLost?: (reason: string) => void;
}

/** Counters the service reports as telemetry when the meeting ends. */
export interface VoiceConversationStats {
  responses: number;
  toolCalls: number;
  interruptions: number;
  /** Utterances the room produced, and how they were handled. */
  utterances: number;
  suppressed: number;
  addressedMatches: number;
  modeSwitches: number;
  /**
   * How the "was I addressed" question went.
   *
   * `gateCalls` is how many utterances were put to the model, `gateFailed` how many
   * of those came back with no verdict at all. The second number is the one that
   * matters most in production: the gate fails closed, so a failing gate and a
   * quiet room look identical from outside, and only this distinguishes an agent
   * that was deaf from one that was simply not spoken to. `gateLatencyMs` is the
   * total across all calls, so a mean can be taken without this holding a list.
   */
  gateCalls: number;
  gateFailed: number;
  gateLatencyMs: number;
  /**
   * Verdicts thrown away because a newer utterance had closed first.
   *
   * The conservative half of a deliberate trade: the agent never answers a turn
   * nothing judged, at the price of occasionally missing one it was asked. A high
   * count means the room is busy enough that the price is being paid often.
   */
  gateSuperseded: number;
  /**
   * Answers the agent decided to give that the room never heard.
   *
   * A response can end without producing audio — a rate limit, a server error. The
   * gate said yes, the request went out, and the room got silence, which is
   * indistinguishable from never having been addressed unless it is counted here.
   */
  responsesFailed: number;
  /**
   * How many closed utterances had a speaker attached, and how many did not.
   *
   * The reason this is measured at all: attribution is read off Meet's participants
   * panel, so it stops working when Google moves the UI, and it stops working
   * *silently* — the call carries on, just anonymously. A rate that falls off a cliff
   * between releases is the only signal that has happened.
   */
  attributedUtterances: number;
  unattributedUtterances: number;
}

export class VoiceConversation {
  private readonly session: RealtimeSession;
  private readonly playback: AudioPlayback;
  private readonly bargeIn: BargeInPolicy;
  private readonly responsePolicy: ResponsePolicy;
  private readonly downsampler = new Downsampler();
  private readonly upsampler = new Upsampler();
  private responses = 0;
  private toolCalls = 0;
  private interruptions = 0;
  private gateCalls = 0;
  private gateFailed = 0;
  private gateLatencyMs = 0;
  private gateSuperseded = 0;
  private responsesFailed = 0;
  /**
   * The newest utterance the turn detector has closed.
   *
   * A verdict names the utterance it judged, but the response that follows does
   * not: `requestResponse()` asks the model to answer the conversation as it now
   * stands. So a yes for one utterance, arriving after a later one has closed,
   * would make the agent answer the later one — which nothing judged. Compared
   * before speaking so that cannot happen.
   */
  private newestItemId: string | null = null;
  private attributedUtterances = 0;
  private unattributedUtterances = 0;
  /**
   * The last speaker Meet showed, and when it was read.
   *
   * Kept rather than replaced on a failed or empty read, and aged out by
   * `SPEAKER_FRESHNESS_MS` instead — see `setCurrentSpeaker`.
   */
  private speaker: { reading: SpeakerReading; at: number } | null = null;
  /** Who the answer being spoken is for — see `answeringSpeaker`. */
  private answering: SpeakerReading | null = null;
  private currentItemId: string | null = null;
  /**
   * When the room last fell silent, and why the agent is about to break it.
   *
   * Latency is the whole experience of talking to something in a meeting, and until
   * now nothing measured the part people actually feel: the gap between finishing a
   * sentence and hearing a reply start. The gate's own elapsed time is not that
   * number — a verdict reached while the speaker was still talking costs the room
   * nothing, and one reached after they stopped costs all of it.
   */
  private silenceSince: number | null = null;
  private pendingAnswer: { at: number; via: string } | null = null;
  /** Last keyword list sent, so the poll doesn't resend an unchanged roster. */
  private keywordSignature: string | null = null;
  /**
   * Everyone else the room currently holds, agent excluded.
   *
   * Handed to the gate on every judgement, because "Prism, ask Emma about the
   * cluster" and "Emma, ask Prism about the cluster" are the same words in a
   * different order and only one of them is the agent's to answer. Empty until the
   * first successful roster read, which the gate is told about rather than left to
   * infer from an empty list.
   *
   * Read by `meeting_speaker` too, through `roster`, so the model can answer "who is
   * in this call?" from the same list the gate is judged against.
   */
  private rosterNames: string[] = [];
  private stopped = false;

  constructor(private readonly options: VoiceConversationOptions) {
    this.session = new RealtimeSession({
      instructions: options.instructions,
      tools: options.tools.declarations,
      model: options.model,
      voice: options.voice,
      agentName: options.agentName,
      endpointOverride: options.endpointOverride,
    });

    this.responsePolicy = new ResponsePolicy({ mode: options.responseMode });

    this.playback = new AudioPlayback(options.sink);

    this.bargeIn = new BargeInPolicy({
      pausePlayback: () => this.playback.pause(),
      resumePlayback: () => this.playback.resume(),
      isSpeaking: () => this.playback.isSpeaking,
      commitInterrupt: () => {
        // Drop what hasn't been heard, then tell the model exactly how far each
        // item actually got — otherwise its context claims words the room never
        // heard. A turn can hold several audio items (a native preamble, then the
        // answer), so every one of them is reported.
        const items = this.playback.flush();
        this.session.interrupt(items);
        this.interruptions += 1;
        const heard = items.reduce((n, i) => n + i.playedMs, 0);
        logger.info(
          `[Meeting] Yielded the floor after ${Math.round(heard)}ms of speech ` +
            `across ${items.length} item(s)`,
        );
      },
    });

    this.wireSession();
  }

  private wireSession(): void {
    this.session.on('audio', (pcm24k, itemId) => {
      // The first audio of a response is the moment the silence actually ends —
      // asking for a response is not the same as the room hearing one, and the model
      // takes its own time to start. Reported separately so the part we control (the
      // decision) stays distinguishable from the part we don't (the model).
      //
      // The reasoning effort is on this line because it is the number effort moves:
      // thinking harder shows up here and nowhere else, so two calls at different
      // levels are only comparable if the level is written down beside the figure.
      if (this.pendingAnswer) {
        const { at, via } = this.pendingAnswer;
        this.pendingAnswer = null;
        const total = this.silenceSince === null ? null : Date.now() - this.silenceSince;
        const effort = config.openaiRealtimeReasoningEffort ?? 'api default';
        logger.info(
          `[Meeting:Latency] voice started ${Date.now() - at}ms after asking (via ${via},` +
            ` effort ${effort})` +
            (total === null ? '' : `, ${total}ms of silence in the room`),
        );
      }

      if (itemId && itemId !== this.currentItemId) {
        // A new utterance begins: settle any undecided pause first so stale
        // audio can't be spliced onto the front of the new one.
        this.bargeIn.commitIfPending();
        this.bargeIn.onUtteranceStarted();
        this.currentItemId = itemId;
      }
      this.playback.enqueue(this.upsampler.process(pcm24k), itemId);
    });

    this.session.on('speechStarted', () => this.bargeIn.onSpeechStarted());
    this.session.on('speechStopped', () => {
      // The room's clock starts here, not at the turn boundary: the detector takes
      // its own time to close an utterance, and the silence is already running.
      this.silenceSince = Date.now();
      this.bargeIn.onSpeechStopped();
    });

    this.session.on('responseDone', () => {
      this.responses += 1;
      // The measurement belongs to one response. Left set, a response that ends
      // without ever producing audio — cancelled by a barge-in, killed by an API
      // error — would hand its marker to whatever spoke next, including the
      // greeting, which deliberately measures nothing.
      this.pendingAnswer = null;
    });

    this.session.on('responseFailed', () => {
      this.responsesFailed += 1;
    });

    this.session.on('functionCall', (call) => {
      this.toolCalls += 1;
      void this.runTool(call.callId, call.name, call.argumentsJson);
    });

    // The model never answers on its own, so every utterance passes the policy —
    // and there is now exactly one place that happens. The turn detector closing an
    // utterance is both the earliest moment the audio can be pointed at and the
    // earliest the agent should speak, so deciding here needs no transcript, holds
    // nothing back for a later boundary, and cannot produce two verdicts for one
    // sentence.
    this.session.on('utteranceCommitted', (itemId) => {
      const decision = this.responsePolicy.onUtteranceCommitted(itemId);
      // Only a turn the policy actually accepted moves this. A duplicated commit
      // for an earlier utterance is answered `ignore`, and letting it set the marker
      // anyway would rewind the guard below — that earlier utterance's late yes
      // would then pass, and the bare response would answer whatever came after it.
      if (decision !== 'ignore') {
        this.newestItemId = itemId;
        // Counted here rather than on the finished transcript, which is where this
        // started: transcription is only requested when the log is going to carry the
        // words, so a counter on it would read zero on every default-configured call.
        // The turn boundary is also the question worth asking — could the utterance
        // the agent is about to decide on be tied to a person?
        //
        // Against `currentSpeaker`, so the agent's own voice does not score as a
        // success. An earlier version counted any reading at all, which can read 100%
        // while nothing is attributable to anybody in the room. A rate that sags while
        // the agent is being talked over is the honest reading: in those moments
        // attribution genuinely is not available.
        if (this.currentSpeaker !== null) this.attributedUtterances += 1;
        else this.unattributedUtterances += 1;
      }
      if (decision === 'respond') {
        this.answer('open-mode');
        return;
      }
      if (decision === 'gate') void this.judgeThenMaybeAnswer(itemId);
    });

    // Nothing decides anything from these words any more — the gate hears the
    // audio. What a transcript is still worth is being able to read back what a
    // call actually said next to how it was judged, which is how every wrong
    // verdict so far has been diagnosed. It lags the decision by however long
    // transcription takes, so it is written as its own line and paired with the
    // verdict by `item=` rather than folded into one.
    this.session.on('transcript', (itemId, text) => {
      const sentence = formatTranscript(text);
      if (sentence === '') return;
      logger.info(`[Meeting:Heard] item=${itemId || 'none'} ${sentence}`);
    });

    this.session.on('apiError', (message) => {
      logger.warn(`[Meeting] Realtime API reported: ${message}`);
    });

    this.session.on('closed', (reason) => {
      logger.info(`[Meeting] Realtime session closed: ${reason}`);
      // A close we didn't ask for is the end of the agent's participation: no
      // audio reaches the room and none of the room's audio reaches a model. The
      // browser is still in the call, so without this the bot lingers as a silent
      // tile until the empty-room poll or the duration cap notices.
      if (!this.stopped) this.options.onSessionLost?.(reason);
    });
  }

  /**
   * Ask the model whether an utterance was aimed at the agent, then act on it.
   *
   * Not awaited by the caller: the room keeps talking while this is in flight, and
   * a later utterance must be free to be judged before an earlier verdict lands.
   * Each probe ends its context on the utterance it is judging, so verdicts arriving
   * out of order still land on the right sentence.
   */
  private async judgeThenMaybeAnswer(itemId: string): Promise<void> {
    const asked = Date.now();
    this.gateCalls += 1;

    const verdict = await judgeAddressed(this.session, {
      itemId,
      agentName: this.options.agentName,
      roster: this.rosterNames,
    });
    this.gateLatencyMs += verdict.elapsedMs;

    // A failure is counted here and nowhere else. It must not reach the policy: a
    // verdict that never happened is not a suppression, and counting it as one
    // would put failures into `suppressed` as well as `gate_failed` — leaving no
    // way to read "the gate earned its keep" off the two numbers.
    if (verdict.failed) {
      this.gateFailed += 1;
      return;
    }

    // The call ended under the probe. Nothing to answer into.
    if (this.stopped) return;

    // A verdict this late is worse than a missed one: the room has moved on, and
    // answering a question everybody has stopped caring about breaks whatever is
    // being said now. The gate's own deadline should make this unreachable; it is
    // kept because the cost of being wrong here is paid out loud.
    if (Date.now() - asked > ADDRESSED_DEADLINE_MS) {
      logger.info(`[Meeting] Dropped a late verdict for item=${itemId} — the room has moved on`);
      return;
    }

    // Somebody else has spoken since. Answering now would answer *their* utterance,
    // because the response carries the conversation as it stands rather than the
    // turn that was judged — so a yes for a question asked of the agent could
    // interrupt an exchange between two other people. Dropped instead, on the same
    // principle as the deadline above: speaking out of turn is the failure this gate
    // exists to prevent, and someone repeating themselves recovers a lost answer.
    if (this.newestItemId !== null && this.newestItemId !== itemId) {
      this.gateSuperseded += 1;
      logger.info(
        `[Meeting] Dropped a verdict for item=${itemId || 'none'} — ` +
          `item=${this.newestItemId || 'none'} has closed since, and the answer would land on that`,
      );
      return;
    }

    if (!this.responsePolicy.resolveVerdict(itemId, verdict.addressed)) return;
    this.answer('gate');
  }


  /**
   * Ask for a response, and record how long the room waited to get one.
   *
   * `via` names what decided it — `open-mode` when a one-to-one call answers at the
   * turn boundary without asking anything, `gate` when a verdict was fetched. The
   * two cost the room very differently, and the point of measuring is to tell them
   * apart: the first is free, the second is a model round trip the room sits through
   * in silence.
   */
  private answer(via: string): void {
    const waited = this.silenceSince === null ? null : Date.now() - this.silenceSince;
    logger.info(
      `[Meeting:Latency] answering via ${via}` +
        (waited === null ? '' : ` — room waited ${waited}ms since the speaker stopped`),
    );
    this.pendingAnswer = { at: Date.now(), via };
    // Pinned for the turn before the request goes out. Asked later, the meters would answer
    // about whoever is talking now — which during a long answer is nobody, and during an
    // interruption is somebody else.
    this.answering = this.currentSpeaker;
    this.session.requestResponse();
  }

  private async runTool(callId: string, name: string, argumentsJson: string): Promise<void> {
    const output = await this.options.tools.execute(name, argumentsJson);
    if (this.stopped) return;
    this.session.sendFunctionOutput(callId, output);
  }

  /** Open the Realtime session. Throws if the connection or auth fails. */
  async start(): Promise<void> {
    await this.session.connect();
  }

  /** Feed captured meeting audio (48 kHz pcm16 mono) to the model. */
  pushMeetingAudio(pcm48k: Buffer): void {
    if (this.stopped || !this.session.isOpen) return;
    this.session.sendAudio(this.downsampler.process(pcm48k));
  }

  /**
   * Tell the model something that happened rather than was said — being admitted
   * to the call, a participant leaving, the meeting winding down.
   */
  notify(text: string): void {
    if (this.stopped) return;
    this.session.sendContext(text);
  }

  /** Ask the model to speak now (used to greet the room on admission). */
  speakNow(): void {
    if (this.stopped) return;
    this.session.requestResponse();
  }

  /**
   * Report how many people are in the room, the agent included.
   *
   * Drives `auto` mode: one human means everything said is said to the agent,
   * more than one means it waits to be addressed. `null` (the count couldn't be
   * read) leaves the current behaviour alone.
   */
  setParticipantCount(count: number | null): void {
    if (this.stopped) return;
    this.responsePolicy.setParticipantCount(count);
  }

  /**
   * Report who the meeting platform last showed as speaking.
   *
   * `null` means "could not tell", which covers the panel not being open, nobody talking,
   * two people talking at once, and the read having failed. All of them leave the last
   * known speaker in place to age out rather than clearing it: a read that failed is not
   * evidence that the person who was talking has stopped, and a moment of quiet is usually
   * a pause.
   */
  setCurrentSpeaker(reading: SpeakerReading | null): void {
    if (this.stopped || reading === null) return;
    this.speaker = { reading, at: Date.now() };
  }

  /**
   * The human who currently has the floor, or null.
   *
   * Null for all three of "nobody has been identified", "the reading is too old to
   * believe" and "that was the agent's own voice". A caller wanting the agent's own turns
   * wants `AudioPlayback`, which knows for certain rather than by scrape.
   *
   * The whole reading rather than the name, because a name cannot say whether it belongs
   * to a person or to a room full of them sharing one microphone.
   */
  get currentSpeaker(): SpeakerReading | null {
    if (!this.hasSpeakerReading) return null;
    const reading = this.speaker?.reading ?? null;
    return reading?.isSelf === true ? null : reading;
  }

  /**
   * Who said the utterance the agent is answering, or null when it could not be told.
   *
   * Captured when the response is requested and held for the whole turn, which is what
   * makes it the right answer to "who asked me this?" — the meters have moved on by the
   * time the agent finishes speaking, and the model may ask at any point in between.
   */
  get answeringSpeaker(): SpeakerReading | null {
    return this.answering;
  }

  /** The other people the platform last listed, agent excluded. Empty until the first read. */
  get roster(): readonly string[] {
    return this.rosterNames;
  }

  /**
   * Whether the last reading is recent enough to act on, whoever it named.
   *
   * Separate from `currentSpeaker` because staleness and identity are different questions,
   * and only this one is about the clock.
   */
  private get hasSpeakerReading(): boolean {
    if (this.speaker === null) return false;
    return Date.now() - this.speaker.at <= SPEAKER_FRESHNESS_MS;
  }

  /**
   * Report whether the room can hear the agent.
   *
   * Only the response policy cares: answering everything said in the room is a
   * reasonable default for a one-to-one call and an expensive way to say nothing when
   * the microphone is not live. The audio path itself is unaffected — playback still
   * runs, so the moment the mic does come up the agent is ready to be heard.
   */
  setAudible(audible: boolean): void {
    if (this.stopped) return;
    this.responsePolicy.setAudible(audible);
  }

  /**
   * Tell the transcriber how the room's names are spelled.
   *
   * Names are the words a meeting transcript gets wrong most often and the ones this
   * feature leans on hardest: one call produced "Mees" for Miska, "Mark" for Max, and
   * a third participant rendered in Japanese characters. The gate's clearest refusals
   * read "the speaker addresses Isaac" — reasoning that only holds while Isaac
   * survives transcription.
   *
   * The agent's own name always leads and is never displaced by the cap: it is the
   * one word the gate cannot do without, while a participant's name only sharpens a
   * judgement that already works without it.
   */
  setParticipantNames(names: string[]): void {
    if (this.stopped) return;

    // Sorted before anything else is derived from it. Meet reorders participant
    // tiles by who is speaking and virtualizes the grid, so the *same* people
    // arrive from the scrape in a different order poll after poll. Keyed on
    // arrival order, that read as a roster change every ten seconds — each one
    // mutating the live transcriber config and injecting another "the people in
    // the call are now…" item into the model's context.
    const others = names
      .filter((n) => n.toLowerCase() !== this.options.agentName.toLowerCase())
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    // A scrape that found nobody but the agent is a failed read, not an empty
    // room: tiles render late, and the grid drops off-screen participants. Saying
    // "you appear to be alone" on that evidence is a false statement the model may
    // act on — and leaving the call is the count's job, from a reading that has its
    // own repeated confirmation before anyone acts on it.
    if (others.length === 0) {
      logger.debug('[Meeting] Participant names came back empty — leaving the roster as it was');
      return;
    }

    const keywords = [this.options.agentName, ...others].slice(0, KEYWORD_LIMIT);

    // Only on a change. This runs on the participant poll, and re-sending the same
    // list every ten seconds would mutate a live session for no reason.
    const signature = keywords.join('\u0000');
    if (signature === this.keywordSignature) return;
    this.keywordSignature = signature;
    // The gate is given the names uncapped: the cap above exists because every
    // keyword biases the transcriber toward hearing it, and a prompt has no such
    // cost. Telling the gate about somebody the transcriber was not told about is
    // fine — it judges the audio, not the text.
    this.rosterNames = others;

    this.session.setTranscriptionKeywords(keywords);
    logger.info(`[Meeting] Transcriber now expects ${keywords.length} name(s) in the room`);

    // The model is told too, not just the transcriber. It has no other way to know who is
    // present: the room arrives as one mixed audio channel with no speaker labels, so asked
    // "who's in this call?" it could otherwise only say it didn't know. Sent as context
    // rather than folded into the system prompt, because the prompt is fixed when the
    // session is created and the roster is not.
    //
    // It no longer says the speaker is unknowable. That was true when the audio was the only
    // signal; the runtime now reads the platform's participants panel, so the model can ask
    // who it is answering with `meeting_speaker`. It is careful to promise only that: there
    // is no per-response context carrying the name, so telling the model it has already been
    // told would have it scan its context, find only this line, and pick a name off it.
    this.notify(
      `The people in the call with you are now: ${others.join(', ')}. ` +
        `The audio is still one mixed channel, so you cannot hear which of them is ` +
        `speaking — call \`meeting_speaker\` when you need to know who you are answering ` +
        `or who just spoke. Never guess at a name.`,
    );
  }

  /** What the policy is doing right now — reported by `meeting_status`. */
  get responseMode(): EffectiveMode {
    return this.responsePolicy.effectiveMode;
  }

  get statistics(): VoiceConversationStats {
    const policy = this.responsePolicy.statistics;
    return {
      responses: this.responses,
      toolCalls: this.toolCalls,
      interruptions: this.interruptions,
      utterances: policy.utterances,
      suppressed: policy.suppressed,
      addressedMatches: policy.addressedMatches,
      modeSwitches: policy.modeSwitches,
      gateCalls: this.gateCalls,
      gateFailed: this.gateFailed,
      gateLatencyMs: this.gateLatencyMs,
      gateSuperseded: this.gateSuperseded,
      responsesFailed: this.responsesFailed,
      attributedUtterances: this.attributedUtterances,
      unattributedUtterances: this.unattributedUtterances,
    };
  }

  /** Tear down the session, playback timer and pending barge-in timer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bargeIn.dispose();
    this.playback.dispose();
    this.session.close();
  }
}
