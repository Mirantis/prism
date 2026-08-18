/**
 * The conversation itself: meeting audio in, agent speech out.
 *
 * Wires the five collaborators into one loop and owns nothing else — the browser,
 * the audio devices and the meeting's lifecycle all belong to the service above:
 *
 *     capture (48k) → Downsampler → RealtimeSession → Upsampler → AudioPlayback
 *                                        │
 *                                   ResponsePolicy (decides whether to answer)
 *                                        │
 *                                   BargeInPolicy (yields the floor to humans)
 *                                        │
 *                                   ToolBridge (runs the agent's real tools)
 *
 * Every response on this session is one asked for here: the server is configured
 * never to answer on its own, so an utterance becomes speech only if
 * `ResponsePolicy` says it was aimed at the agent.
 *
 * The one subtlety is the ordering between a new utterance and a pending pause.
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
import { classifyAddressed, CLASSIFY_DEADLINE_MS } from './addressed-classifier';
import { isVocativeAddress } from './vocative';
import { formatKeywords, formatTranscript } from './transcript-log';

/**
 * How much of a partial transcript is worth judging.
 *
 * Long enough that a name isn't cut in half — a verdict on "Pri" is worthless — and
 * short enough to still beat the finished transcript by a useful margin. Twenty
 * characters covers a leading vocative and the start of what follows it ("Emma, can
 * you check the"), which is where a name sits when someone means to be answered.
 */
const EARLY_VERDICT_MIN_CHARS = 20;

/** How much new text would justify another look. Moot at one look; see below. */
const EARLY_VERDICT_GROWTH_CHARS = 40;

/**
 * Most early looks at one utterance.
 *
 * **One**, because the early verdict is now an optimisation and nothing more. Since
 * the agent speaks at the turn boundary rather than the moment a verdict lands, the
 * finished transcript is always judged and is always authoritative — so a name the
 * early look misses still gets answered, just without the head start.
 *
 * That changes the arithmetic completely. Re-judging as the sentence grew was worth
 * six model calls when catching a late name *early* was the only way to answer
 * early. Now it buys nothing on the common case and costs plenty: a single long
 * monologue in a live call spent seven gate calls confirming, six times over, that
 * it contained no name — and the room's speech is overwhelmingly not addressed to
 * the agent (152 no to 18 yes across one meeting).
 *
 * One look at the opening of a sentence catches the leading vocative people actually
 * use, and leaves the rest to the transcript.
 */
const MAX_EARLY_VERDICTS = 1;

/** Utterances tracked for early judging. Insertion-ordered, oldest evicted. */
const EARLY_JUDGED_LIMIT = 32;

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
   * How the "was I addressed" question got answered.
   *
   * `gateLocalYes` is the number of times the local tagger recognised a vocative and
   * no model call was made; `gateModelCalls` the number of times one was. Their
   * ratio is the point: it says how much of the gate's per-utterance latency the
   * fast path is actually taking off the room, on real speech rather than on a
   * corpus.
   */
  gateLocalYes: number;
  gateModelCalls: number;
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
  private gateLocalYes = 0;
  private gateModelCalls = 0;
  private currentItemId: string | null = null;
  /**
   * Utterances already judged from a partial transcript, so it happens once.
   *
   * Holds how long the text was when last judged and how many looks it has had.
   * Bounded rather than cleared purely on the `transcript` event: a transcription
   * that fails, or one that trims to empty, never emits that event, so its entry
   * would otherwise sit here for the rest of the call. A stale entry can only ever
   * suppress further early looks at that same utterance, so evicting the oldest is
   * safe.
   */
  private readonly earlyJudged = new Map<string, { chars: number; looks: number }>();
  /**
   * Utterances whose speaker has stopped — the turn detector has closed them.
   *
   * An early verdict can land on either side of that boundary, and which side
   * decides whether the agent may speak yet. See `answerAtTurnBoundary`.
   */
  private readonly committedItems = new Set<string>();
  /**
   * Utterances whose finished transcript has already arrived.
   *
   * Held answers wait for the turn boundary, and the boundary event is what
   * releases them. If that event never came — an id-less commit, a dropped frame —
   * a verdict landing afterwards would wait for something that already happened,
   * and the policy has by then marked the item answered, so nothing else would
   * speak for it. Seeing the finished transcript is proof there is no boundary
   * left to wait for.
   */
  private readonly finalizedItems = new Set<string>();
  /**
   * Early *yes* verdicts held until their speaker stops talking.
   *
   * A partial verdict is made while the sentence is still being said, and acting
   * on it at once made the agent answer a request it had only half heard — a live
   * call produced "it didn't hear the full sentence before it started to answer",
   * with the reply aimed at the opening clause rather than the question.
   *
   * Judging early is still worth keeping: the ~1.3s classification then runs
   * concurrently with the rest of the sentence rather than after it, which is the
   * latency that actually cost anything. Only the speaking waits. What is given up
   * is answering *before* the speaker finishes, which was never something a person
   * in a meeting does.
   */
  private readonly answerAtTurnBoundary = new Set<string>();
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
   * The keyword list currently in force, for the diagnostic line below.
   *
   * Starts as the session's connect-time list — the agent's name alone — so a
   * verdict logged before the first roster poll names what was actually seeded
   * rather than nothing.
   */
  private keywords: string[] = [];
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

    // Mirrors what `RealtimeSession` seeds at connect time.
    this.keywords = [options.agentName];

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

    this.session.on('functionCall', (call) => {
      this.toolCalls += 1;
      void this.runTool(call.callId, call.name, call.argumentsJson);
    });

    // The model never answers on its own, so every utterance passes the policy.
    // Two chances to say yes, and the policy makes sure only one of them fires
    // per utterance: at the turn boundary, which needs no words and so costs
    // nothing in a one-to-one call, and again once the transcript lands, which is
    // the only way to tell whether a crowded room meant the agent.
    this.session.on('utteranceCommitted', (itemId) => {
      this.remember(this.committedItems, itemId);
      // An early verdict that already said yes has been waiting for exactly this:
      // the speaker has stopped, so the request is whole and the agent may answer.
      if (this.answerAtTurnBoundary.delete(itemId)) {
        // Counted here rather than by the policy: this path answers without asking
        // it, and an uncounted utterance skews the ratio the stats exist to report.
        this.responsePolicy.noteUtterance();
        this.answer('early-verdict');
        return;
      }
      if (this.responsePolicy.onUtteranceCommitted(itemId)) this.answer('open-mode');
    });

    // Judged while the speaker is still talking, and again when they stop.
    // Transcription streams well ahead of the utterance closing — seconds of lead,
    // sometimes tens of them — so a name can be recognised and answered before the
    // sentence even ends: a live call answered "Actually, prism, can you help with
    // that?" off the first fifteen characters, while the rest was still being said.
    // An early *yes* therefore answers immediately; an early *no* is never trusted,
    // because the rest of the sentence is still coming. The policy's per-item dedupe
    // makes the overlapping verdicts safe.
    this.session.on('transcriptPartial', (itemId, textSoFar) => {
      const chars = textSoFar.trim().length;
      if (chars < EARLY_VERDICT_MIN_CHARS) return;

      const seen = this.earlyJudged.get(itemId);
      if (seen && (seen.looks >= MAX_EARLY_VERDICTS || chars - seen.chars < EARLY_VERDICT_GROWTH_CHARS)) {
        return;
      }
      if (this.responsePolicy.onTranscript(itemId, 'partial') !== 'classify') return;
      this.earlyJudged.set(itemId, { chars, looks: (seen?.looks ?? 0) + 1 });
      if (this.earlyJudged.size > EARLY_JUDGED_LIMIT) {
        this.earlyJudged.delete(this.earlyJudged.keys().next().value as string);
      }
      void this.classifyThenMaybeRespond(itemId, textSoFar, 'partial');
    });

    this.session.on('transcript', (itemId, text) => {
      this.earlyJudged.delete(itemId);
      this.remember(this.finalizedItems, itemId);
      // The finished transcript is proof the utterance is over, so an answer still
      // waiting on a boundary event has nothing left to wait for. `committed`
      // normally lands first and this never fires; it exists so a missed event
      // costs a late answer rather than a silent one — the policy has already
      // marked the item answered, so nothing else would ever speak for it.
      if (this.answerAtTurnBoundary.delete(itemId)) {
        this.answer('early-verdict-late-commit');
        return;
      }
      const decision = this.responsePolicy.onTranscript(itemId);
      if (decision === 'respond') {
        this.answer('transcript');
        return;
      }
      if (decision === 'classify') void this.classifyThenMaybeRespond(itemId, text, 'final');
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
   * Ask the model whether an unnamed utterance was aimed at the agent.
   *
   * Deferred rather than awaited inline because the whole point of the lexical
   * test is that the common cases never get this far. A verdict that arrives too
   * late is dropped: the room has moved on, and answering a question everyone has
   * stopped caring about is worse in a meeting than having missed it.
   */
  private async classifyThenMaybeRespond(
    itemId: string,
    transcript: string,
    stage: 'partial' | 'final',
  ): Promise<void> {
    const asked = Date.now();
    // Read before the await: the roster poll runs on its own timer, and a refresh
    // landing during the ~1s gate call would otherwise make the line report the
    // list that replaced the one the utterance was actually transcribed under.
    const keywords = this.keywords;

    // The local read first. It can only ever say *yes* — see `vocative.ts` — so a
    // sentence it recognises as a vocative skips the model entirely and the room
    // waits 0ms instead of the gate's measured 0.9–1.5s, while everything else
    // reaches the model exactly as it did before. That asymmetry is the whole design:
    // a bug here costs latency, never a wrong answer.
    const local = await isVocativeAddress(transcript, this.options.agentName);
    if (local.addressed) this.gateLocalYes += 1;
    else this.gateModelCalls += 1;
    const addressed =
      local.addressed ||
      (await classifyAddressed({
        transcript,
        agentName: this.options.agentName,
        stage,
      }));

    // Every verdict is recorded; whether the sentence goes with it is a setting, and
    // `transcript-log.ts` is where that decision and its reasoning live.
    //
    // `info`, deliberately: production runs at `info`, and this line exists to be
    // read back from a deployed container. Which is exactly why the words are not on
    // it by default — the room is unauthenticated and did not agree to be written
    // down.
    //
    // What is always written is most of the diagnostic: the verdict, the item it
    // belongs to (which is what pairs a partial verdict with the final one), the mode
    // in force, and the *number* of names seeded to the transcriber. The agent's own
    // name always leads that list, so `keywords=1` means no participants have been
    // read yet.
    //
    // Tokens rather than one template, because a formatter that has nothing to say
    // returns `''` and an empty token reads as a field with no value in it.
    logger.info(
      [
        `[Meeting:Gate] ${stage} verdict addressed=${addressed}`,
        `item=${itemId || 'none'}`,
        `mode=${this.responsePolicy.effectiveMode}`,
        // Which path decided, and — when it was the model — what the local read made
        // of the sentence. `VocativeReason` is a bounded enum precisely so this token
        // is safe to write with the transcript switched off.
        local.addressed ? 'path=local' : `path=model local="${local.why}"`,
        formatKeywords(keywords),
        formatTranscript(transcript),
      ]
        .filter(Boolean)
        .join(' '),
    );

    if (this.stopped) return;

    if (Date.now() - asked > CLASSIFY_DEADLINE_MS) {
      logger.info('[Meeting] Dropped a late verdict — the room has moved on');
      return;
    }

    if (!this.responsePolicy.resolveClassification(itemId, addressed, stage)) return;

    // Decided early, spoken at the boundary. A partial verdict that beats the
    // speaker to the end of their sentence waits for `utteranceCommitted`; one that
    // arrives after it (the classification outlived the rest of the sentence, which
    // is the common case for a short question) has nothing left to wait for.
    if (
      stage === 'partial' &&
      itemId !== '' &&
      !this.committedItems.has(itemId) &&
      !this.finalizedItems.has(itemId)
    ) {
      this.remember(this.answerAtTurnBoundary, itemId);
      return;
    }

    this.answer(stage === 'partial' ? 'early-verdict' : 'final-transcript');
  }

  /**
   * Add to a bounded set of item ids.
   *
   * Turns are short-lived and a call can run for an hour, so these sets are caches
   * rather than records: the oldest entry goes when the cap is reached.
   *
   * Be careful raising or reusing the cap. Evicting a *held answer* is not
   * recoverable: the policy has already marked that utterance answered, so the
   * finished transcript sees it as handled and nothing speaks for it — a question
   * asked directly of the agent gets silence. Reaching that needs the cap's worth
   * of yes-verdicts held simultaneously, which a real conversation does not
   * produce, but the failure is silent rather than loud.
   */
  private remember(set: Set<string>, itemId: string): void {
    if (!itemId) return;
    set.add(itemId);
    if (set.size > EARLY_JUDGED_LIMIT) {
      set.delete(set.values().next().value as string);
    }
  }

  /**
   * Ask for a response, and record how long the room waited to get one.
   *
   * `via` names the path that decided it, because the paths have very different
   * costs and the point of measuring is to tell them apart: a verdict reached from a
   * partial transcript is free (it ran while the speaker was still talking), while
   * one reached from the finished transcript is a model round trip the room sits
   * through in silence.
   */
  private answer(via: string): void {
    const waited = this.silenceSince === null ? null : Date.now() - this.silenceSince;
    logger.info(
      `[Meeting:Latency] answering via ${via}` +
        (waited === null ? '' : ` — room waited ${waited}ms since the speaker stopped`),
    );
    this.pendingAnswer = { at: Date.now(), via };
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
    this.keywords = keywords;

    this.session.setTranscriptionKeywords(keywords);
    logger.info(`[Meeting] Transcriber now expects ${keywords.length} name(s) in the room`);

    // The model is told too, not just the transcriber. It has no other way to know
    // who is present: the room arrives as one mixed audio channel with no speaker
    // labels, and its own guidance tells it not to guess at names — so asked "who's
    // in this call?" it could previously only say it didn't know. Sent as context
    // rather than folded into the system prompt, because the prompt is fixed when
    // the session is created and the roster is not.
    this.notify(
      `The people in the call with you are now: ${others.join(', ')}. ` +
        `You still cannot tell which of them is speaking — the audio is one mixed ` +
        `channel — so use these names only when someone identifies themselves or ` +
        `is named by another speaker.`,
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
      gateLocalYes: this.gateLocalYes,
      gateModelCalls: this.gateModelCalls,
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
