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
import type { SpeakerReading } from './meeting-provider.interface';
import { classifyAddressed, CLASSIFY_DEADLINE_MS } from './addressed-classifier';
import { isVocativeAddress, warmVocativeTagger } from './vocative';
import { judgeFollowUp, CONTEXT_LINES, type JudgeLine } from './follow-up-judge';
import { formatKeywords, formatTranscript } from './transcript-log';

/**
 * Lines of the meeting held for the follow-up judge.
 *
 * Its context, plus the agent's own marker for the turn being followed up on, plus the
 * utterance under judgement. The shape the judge was measured with — see `CONTEXT_LINES`.
 */
const TRANSCRIPT_LINES_KEPT = CONTEXT_LINES + 2;

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
   * How the "was I addressed" question got answered.
   *
   * `gateLocalYes` is the number of times the local tagger recognised a vocative and
   * no model call was made; `gateModelCalls` the number of times one was. Their ratio
   * shows how often the fast path removes the gate's per-utterance latency, measured
   * on real speech rather than on a corpus.
   */
  gateLocalYes: number;
  gateModelCalls: number;
  /**
   * How many finished utterances had a speaker attached, and how many did not.
   *
   * The reason this is measured at all: attribution is scraped from Meet's participants
   * panel, so it stops working when Google moves the UI, and it stops working *silently*
   * — the call carries on, just anonymously. A rate that falls off a cliff between
   * releases is the only signal that has happened.
   */
  attributedUtterances: number;
  unattributedUtterances: number;
  /**
   * Utterances answered as a continuation of an exchange, without the name being said again,
   * and utterances the exchange's clock allowed but the judge turned down.
   *
   * The two together say whether judging an exchange earns its keep: every decline is a
   * model call the room paid nothing for out loud, and every accept is an answer that no
   * addressed gate would have given. See `follow-up-judge.ts`.
   */
  followUpAccepted: number;
  followUpDeclined: number;
  /** Exchanges that ended because nothing followed up in time. */
  followUpLapsed: number;
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
  private attributedUtterances = 0;
  private unattributedUtterances = 0;
  /**
   * Whether the model is part-way through a turn.
   *
   * The playback queue empties during a turn as well as at the end of one — a response that
   * speaks a preamble, calls a slow tool and then answers drains in the gap — so "the device
   * ran dry" is not by itself "the agent has finished". Without this the follow-up window
   * would open against the preamble and start its clock in the middle of an answer.
   */
  private responseOpen = false;
  /**
   * The last speaker Meet showed, and when it was read.
   *
   * Kept rather than replaced on a failed or empty read, and aged out by
   * `SPEAKER_FRESHNESS_MS` instead — see `setCurrentSpeaker`.
   */
  private speaker: { reading: SpeakerReading; at: number } | null = null;
  /** Who the answer being spoken is for — see `answeringSpeaker`. */
  private answering: SpeakerReading | null = null;
  private lastRoster: readonly string[] = [];
  /**
   * The tail of the meeting, as the follow-up judge reads it.
   *
   * Held because the sentence alone does not say who it was said to: "so what happens at 14
   * days?" is a follow-up when it lands on the agent's answer and an aside between two
   * colleagues otherwise, and the words are identical. Speaker labels are what carry that,
   * which is also why the ring is worth so little when attribution is unavailable — every
   * human line reads `Someone`, honestly, and the judge is left with the words.
   *
   * Bounded at what the judge is given, so nothing accumulates across an hour-long call.
   */
  private readonly transcriptLines: JudgeLine[] = [];
  /**
   * Whether this turn has put its marker in that ring yet.
   *
   * Two of the three paths that end a turn can fire for the same turn (generation finishing
   * and playback draining), and a doubled marker would spend a line of context saying the
   * same thing twice.
   *
   * Starts true so the greeting — a turn nobody asked for — adds nothing.
   */
  private agentLineRecorded = true;
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

    this.responsePolicy = new ResponsePolicy({
      mode: options.responseMode,
      followUpWindowMs: config.meetingFollowUpWindowMs,
    });

    this.playback = new AudioPlayback(options.sink);
    // The room has stopped hearing the agent, which is when a follow-up window starts
    // running. Measured from the answer rather than from the request, because what
    // somebody follows up on is the answer.
    this.playback.onDrained = () => {
      if (this.responseOpen) return;
      this.endAgentTurn();
    };

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
        // Being cut off ends the turn too, and somebody who interrupts is plainly still in
        // the exchange. Reported here rather than by the playback, because only this path
        // knows a human took the floor instead of the speech running out.
        this.endAgentTurn();
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

      // The room is hearing the agent, so no follow-up window may be running — whatever
      // asked for this response. The `responseOpen` flag below covers a gap *within* one
      // response, but the session fires a *deferred* response itself on `response.done`,
      // without going through `answer()`: measured live, that let the clock start at the gap
      // and keep running while she talked for another five seconds, so the window expired
      // before she had finished speaking. Enforced here because this is the one place every
      // path converges — audio reaching the room.
      this.responsePolicy.onAgentTurnStarted();

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
      // The model has finished generating. The room may still be hearing the tail of it, so
      // the turn is over only once playback drains too — which is what `onDrained` reports,
      // and why it checks this flag rather than assuming an empty queue means the end.
      this.responseOpen = false;
      if (!this.playback.isSpeaking) this.endAgentTurn();
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
      // Asked on a partial as well as on the finished sentence, and not only for the early
      // verdict: this is where the follow-up window learns when the speaker *started*.
      // Reached only from a final, a follow-up's clock began at the moment its last word
      // landed, so a long question timed out on its own length. Two live calls, two failures.
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
      // Counted on the finished transcript rather than at the turn boundary: an utterance
      // that produced no words says nothing either way about whether attribution works.
      //
      // Against `currentSpeaker`, so this asks the question the follow-up window asks —
      // could this utterance be tied to a person? An earlier version counted any reading at
      // all, including the agent's own voice, on the reasoning that the scrape had plainly
      // worked. It read 100% through a whole call in which no exchange could arm, because
      // merged audio was naming a group that matched nobody: the one number watching this
      // feature was blind to its only real failure. A rate that sags while the agent is
      // being talked over is the correct reading — in those moments attribution
      // is not available.
      if (this.currentSpeaker !== null) this.attributedUtterances += 1;
      else this.unattributedUtterances += 1;
      // Kept whatever is decided below, including `ignore`: the value of the ring is that it
      // shows who has been talking to whom, and an utterance the agent stayed out of is as
      // much a part of that as one it answered.
      this.recordLine(this.currentSpeaker?.name ?? 'Someone', text);
      // The finished transcript is proof the utterance is over, so an answer still
      // waiting on a boundary event has nothing left to wait for. `committed`
      // normally lands first and this never fires; it exists so a missed event
      // costs a late answer rather than a silent one — the policy has already
      // marked the item answered, so nothing else would ever speak for it.
      if (this.answerAtTurnBoundary.delete(itemId)) {
        this.answer('early-verdict-late-commit');
        return;
      }
      const decision = this.responsePolicy.onTranscript(itemId, 'final');
      if (decision === 'follow-up') {
        void this.answerIfFollowingUp(itemId, text);
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

    // The local read first, when the operator has asked for it. It can only ever say *yes*
    // — see `vocative.ts` — so a sentence it recognises as a vocative skips the model
    // entirely and the room waits 0ms instead of the gate's latency, while everything else
    // goes to the model.
    //
    // Off by default, which is a change. The asymmetry that made it safe cuts the other way
    // once the gate is quick: its only failure is saying yes to a sentence nobody addressed
    // to the agent, and the agent then answers a room that asked it nothing. That was worth
    // 0.9-1.5s of saving and is not worth about 750ms, which is what a fast classification
    // model measured over live calls. `MEETING_LOCAL_ADDRESSED_READ=true` puts it back for a
    // deployment whose gate is slow enough to want it — the saving scales with that latency,
    // and so does the case for taking the risk.
    const local = config.meetingLocalAddressedRead
      ? await isVocativeAddress(transcript, this.options.agentName)
      : { addressed: false as const, why: 'local read off' as const };
    if (local.addressed) this.gateLocalYes += 1;
    else this.gateModelCalls += 1;
    const addressed =
      local.addressed ||
      (await classifyAddressed({
        transcript,
        agentName: this.options.agentName,
        stage,
        roster: this.lastRoster,
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
        // of the sentence. `VocativeReason` is a bounded enum, so this token is safe
        // to write with the transcript switched off.
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
   * Ask whether an utterance inside an open exchange is aimed at the agent, and answer it.
   *
   * Reached only when the exchange's clock allows it, which is the cheap half of the
   * question — see `follow-up-window.ts`. This is the other half, and it costs a model call
   * of about 600ms.
   *
   * A decline is not silence. The utterance goes straight on to the addressed gate, so the
   * worst this path can do is spend two model calls on one sentence — and a sentence that
   * ends up answered by neither produced no speech, which makes both of them inaudible. That
   * is why the judge keeps the question it was measured on rather than being folded into the
   * addressed gate to save a round trip.
   */
  private async answerIfFollowingUp(itemId: string, transcript: string): Promise<void> {
    const asked = Date.now();
    const followsUp = await judgeFollowUp({
      agentName: this.options.agentName,
      lines: this.transcriptLines.slice(-TRANSCRIPT_LINES_KEPT),
      itemId,
      roster: this.lastRoster,
    });
    if (this.stopped) return;

    // Somebody answered it while the judge was thinking — a verdict on the same utterance
    // from a partial transcript takes the same road and can land inside those 600ms. There
    // is no decline to count and no gate call to make: the room already has its reply.
    if (this.responsePolicy.wasAnswered(itemId)) return;

    // A verdict too old to act on counts as a decline rather than as a drop. Dropping it was
    // the one path on which this whole feature could make the agent *quieter* than switching
    // it off: an utterance routed here is not asked about the name first, so "Iris, and
    // staging?" inside an open exchange would have gone unanswered on a slow judge call —
    // retried twice by the SDK, and past the deadline. Falling through instead means the
    // sentence is judged on the name too, and that gate applies its own freshness rule.
    const late = Date.now() - asked > CLASSIFY_DEADLINE_MS;
    if (late) logger.info('[Meeting:FollowUp] verdict came too late to answer as a follow-up');

    if (!followsUp || late) {
      this.responsePolicy.declineFollowUp();
      // Judged again, by a different question: this one asked whether the words continue an
      // exchange, and the gate asks whether they name the agent. A sentence can fail the
      // first and pass the second.
      void this.classifyThenMaybeRespond(itemId, transcript, 'final');
      return;
    }

    if (!this.responsePolicy.acceptFollowUp(itemId)) return;
    this.answer('follow-up');
  }

  /**
   * The agent's turn is over — the room heard all of it, or somebody cut it off.
   *
   * Also where the agent's own line enters the transcript ring, because that is when it is
   * chronologically true. Written at the *start* of a turn the marker landed before the
   * question that prompted it: an answer decided from a partial transcript is spoken at the
   * turn boundary, and the finished transcript of that question arrives afterwards.
   */
  private endAgentTurn(): void {
    this.responsePolicy.onAgentTurnEnded();
    if (this.agentLineRecorded) return;
    this.agentLineRecorded = true;
    this.recordLine(this.options.agentName, '(answered)');
  }

  /** Append to the transcript ring, dropping the oldest line once it is full. */
  private recordLine(speaker: string, text: string): void {
    const said = text.trim();
    if (said === '') return;
    this.transcriptLines.push({ speaker, text: said });
    if (this.transcriptLines.length > TRANSCRIPT_LINES_KEPT) this.transcriptLines.shift();
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
    // This turn owes the transcript ring a line, which `endAgentTurn` writes once the room
    // has actually heard it.
    this.agentLineRecorded = false;
    // A turn is starting, so nothing said over it is a follow-up *to* it. Marked before the
    // request goes out rather than when audio arrives: the model takes its own time to
    // start, and the gap between asking and hearing is exactly when somebody says "yeah".
    this.responseOpen = true;
    this.responsePolicy.onAgentTurnStarted();
    // Pinned for the turn before the request goes out. Asked later, the meters would
    // answer about whoever is talking now — which during a long answer is nobody, and
    // during an interruption is somebody else.
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
    // Loaded here rather than on first use so the local read can take the shortcut on the
    // first utterance of a call, and only when there is a local read to take it: the tagger
    // is 70MB resident, and it is off by default. ~58ms, once per process.
    if (config.meetingLocalAddressedRead) await warmVocativeTagger();
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
   * evidence that the person who was talking has stopped, and a moment of quiet is
   * usually a pause. Nothing here changes how the agent behaves — the reading is
   * recorded, and what reads it decides what it is worth.
   */
  setCurrentSpeaker(reading: SpeakerReading | null): void {
    if (this.stopped) return;
    if (reading !== null) this.speaker = { reading, at: Date.now() };
    // The policy is given the platform's *identity* rather than the display name, because
    // the only question it asks of it is "the same person as before?" — and two people can
    // share a name, while a name can change mid-call.
    this.responsePolicy.setCurrentSpeaker(this.currentSpeaker?.id ?? null);
  }

  /**
   * The human who currently has the floor, or null.
   *
   * Null for all three of "nobody has been identified", "the reading is too old to
   * believe" and "that was the agent's own voice". A caller wanting the agent's own turns
   * wants `AudioPlayback`, which knows for certain rather than by scrape.
   */
  get currentSpeaker(): SpeakerReading | null {
    if (!this.hasSpeakerReading) return null;
    const reading = this.speaker?.reading ?? null;
    return reading?.isSelf === true ? null : reading;
  }

  /**
   * Whether the last reading is recent enough to act on, whoever it named.
   *
   * Separate from `currentSpeaker` because staleness and identity are different
   * questions, and only this one is about the clock.
   */
  private get hasSpeakerReading(): boolean {
    if (this.speaker === null) return false;
    return Date.now() - this.speaker.at <= SPEAKER_FRESHNESS_MS;
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

  /** The other people the platform last listed. Empty until the first read. */
  get roster(): readonly string[] {
    return this.lastRoster;
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

    this.lastRoster = names;

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
      gateLocalYes: this.gateLocalYes,
      gateModelCalls: this.gateModelCalls,
      attributedUtterances: this.attributedUtterances,
      unattributedUtterances: this.unattributedUtterances,
      followUpAccepted: policy.followUp.accepted,
      followUpDeclined: policy.followUp.declined,
      followUpLapsed: policy.followUp.lapsed,
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
