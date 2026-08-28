/**
 * Owns the agent's participation in a live voice meeting, start to finish.
 *
 * One meeting at a time per container, matching the one-agent-per-container shape.
 * That is a real constraint rather than an accident: a second call would need its
 * own display, audio daemon and browser (roughly 4 vCPU worth of media work each),
 * and the agent has one voice to lend.
 *
 * The lifecycle is deliberately asymmetric. Joining is asynchronous — `join()`
 * returns as soon as the request is in, because a guest waits for a host to click
 * "Admit" and that can take minutes; the caller gets a state, the model is told in
 * band once the call starts, and every outcome goes to the log. Leaving is
 * immediate and always safe to call.
 *
 * Everything that can leak — an X server, an audio daemon, a browser, a WebSocket —
 * is released through one `teardown()` path, used by the happy ending, every
 * failure, the inactivity timeout and process shutdown alike.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { contextService } from '../context.service';
import { buildSystemPromptParts } from '../../prompts/context-builder';
import { getMeetingInstructions } from '../../prompts/meeting-prompt';
import { AudioStack } from './audio-stack';
import { BrowserStack } from './browser-stack';
import { VoiceConversation, type VoiceConversationStats } from './voice-conversation';
import type { EffectiveMode, ResponseMode } from './response-policy';
import { prepareMeetingTools } from './tool-bridge';
import { googleMeetProvider } from './providers/google-meet';
import { formatChatBody } from './transcript-log';
import type {
  ChatSendStep,
  JoinStep,
  MeetingProvider,
  SpeakerDetails,
} from './meeting-provider.interface';
import type { Page } from 'playwright-core';

/**
 * How often to read the participant count.
 *
 * Two jobs ride on this reading: leaving once the room has emptied, and choosing
 * whether the agent answers everything or waits to be addressed. The second is
 * what sets the interval — until a third person's arrival has been noticed, the
 * agent is still answering everything said in what is now a group call, so the
 * poll wants to be quick relative to how long that stays tolerable.
 */
const PARTICIPANT_POLL_MS = 10_000;

/**
 * How often to ask the platform who is speaking.
 *
 * Its own timer, an order of magnitude faster than the participant poll, because it is
 * answering a different kind of question. Ten seconds is right for "has the room
 * emptied"; for "who has the floor" it is useless — a caption label already lags speech
 * by one to two seconds, and a whole exchange can start and finish inside one tick, so a
 * slow poll would attribute most utterances to whoever spoke before them.
 *
 * The cost is one small `page.evaluate` per second for the length of the call, which is
 * what a live call ran for hours while this was being developed.
 */
const SPEAKER_POLL_MS = 1_000;

/**
 * Unreadable counts in a row before saying so.
 *
 * The count comes from scraping Meet's UI, which changes without notice. A failure
 * is quiet by design — the last known mode simply stands — so without a log line
 * a broken selector would look exactly like a stable meeting.
 */
const UNREADABLE_COUNTS_BEFORE_WARNING = 3;

/**
 * How hard to try for a participant count at the moment of admission.
 *
 * Meet admits the agent before it renders the other tiles, so the first read is
 * a reliable 1 — see `seedParticipantCount`. Together these span a few seconds,
 * which is well inside the poll interval the reading would otherwise wait for.
 */
const SEED_READ_ATTEMPTS = 5;
const SEED_READ_INTERVAL_MS = 700;

/**
 * How long to wait for the browser to open the virtual microphone after the unmute.
 *
 * Chromium opens the capture device a moment after the toggle flips, not with it, and
 * on a cold container the first open is the slowest thing in the join.
 *
 * Generous, and it stayed generous when this stopped being a veto, because being
 * impatient is still expensive: a false "never opened" puts the agent in listen-only
 * mode for the whole meeting over a microphone that was seconds from working. The cost
 * of waiting is a few more seconds on a join that has already spent minutes in a lobby.
 */
const MIC_CAPTURE_TIMEOUT_MS = 15_000;

/**
 * How long the agent must read as the only one left before it leaves.
 *
 * More than a single reading because a count of 1 is also what a brief UI
 * reshuffle looks like, and leaving a live meeting by mistake is much worse than
 * lingering. Expressed as a duration rather than a number of polls so that
 * shortening the poll interval doesn't quietly make the agent quicker to hang up.
 */
const EMPTY_DURATION_BEFORE_LEAVING_MS = 60_000;

const EMPTY_READINGS_BEFORE_LEAVING = Math.ceil(
  EMPTY_DURATION_BEFORE_LEAVING_MS / PARTICIPANT_POLL_MS,
);

/**
 * Longest message the agent may post into a call's chat.
 *
 * Ours, not the platform's. A chat message here exists to hand over the one thing
 * speech is bad at — a link, an id, a command — so a cap this size takes those and
 * refuses an essay, which the agent should be saying out loud instead. Refusing before
 * the page sees it also means one clear answer the model can act on, rather than a
 * silent truncation nobody in the room can tell from a message that arrived whole.
 */
export const MEETING_CHAT_MAX_CHARS = 500;

export type MeetingState =
  | 'idle'
  | 'launching'
  | 'waiting_admission'
  | 'in_call'
  | 'leaving';

export interface MeetingStatus {
  state: MeetingState;
  provider: string | null;
  /** What was asked for. */
  responseMode: ResponseMode;
  /**
   * What that resolved to right now — `auto` follows the room, so this is the
   * answer to "is it going to speak up?" and the requested mode is not.
   */
  effectiveResponseMode: EffectiveMode | null;
  joinedAt: string | null;
  /** Present once the call is under way. */
  stats?: VoiceConversationStats;
}

/**
 * What the runtime can tell the agent about who is in the room and who spoke.
 *
 * The audio a meeting bot receives is one mixed channel, so the model itself hears no
 * speaker at all. This is the answer to the question it cannot answer for itself, and
 * every field is allowed to be null: attribution is read off the platform's UI and saying
 * "I cannot tell" is the whole point of having it, because a name spoken aloud to the
 * wrong person is worse than an admission.
 *
 * `SpeakerDetails` is the provider's own shape, passed through rather than copied into a
 * second one. What the platform can say about a voice is one fact, and two structures
 * describing it would only ever drift apart.
 */
export interface SpeakerReport {
  inMeeting: boolean;
  /**
   * Who last made a sound, or null when nobody has or it cannot be told.
   *
   * The platform's last reading rather than an instant: readings are polled once a second
   * and held for a few seconds afterwards, because still meters are how a pause looks as
   * well as how a stop looks. So this names whoever last had the floor, and goes null when
   * that reading is too old to believe.
   */
  speakingNow: SpeakerDetails | null;
  /**
   * Who said the utterance the agent is answering.
   *
   * The field worth having. It is pinned when the response is requested and held for the
   * turn, so it still answers "who asked me this?" once the agent has been talking for
   * ten seconds and the meters have long since gone still.
   */
  spokeToYou: SpeakerDetails | null;
  /** Everyone else the platform lists, the agent excluded. */
  roster: string[];
  /** Whether attribution is working at all on this call. */
  attribution: 'available' | 'unavailable';
  /** One line the agent can act on, since a bare null does not say why. */
  note: string;
}

/**
 * How a chat send ended, in one word.
 *
 * This is the telemetry property, so it is an enum: `rejected` is the agent asking for
 * something this runtime will not send (empty, or over the cap), `busy` is a second send
 * arriving while the first is still typing, and `failed` is a page that would not take a
 * message it should have taken. The step a `failed` send got to rides alongside it.
 */
type ChatSendStatus = 'sent' | 'not_in_call' | 'unsupported' | 'rejected' | 'busy' | 'failed';

/** What the caller is told: whether the room has it, and one sentence saying so. */
export interface ChatSendOutcome {
  sent: boolean;
  message: string;
}

/** The outcome plus what telemetry and the log line need. Never the body. */
interface ChatSendReport extends ChatSendOutcome {
  status: ChatSendStatus;
  step?: ChatSendStep;
  /** Characters offered to the page, after the whitespace was collapsed. */
  length: number;
}

export interface JoinMeetingInput {
  url: string;
  userId: string;
  agentId: string;
  /** The thread the call was asked for from, passed on to the meeting tool set. */
  threadId?: string;
  /** How much the agent speaks up; `auto` follows the participant count. */
  responseMode?: ResponseMode;
}

/**
 * Mean time a verdict took, in whole milliseconds.
 *
 * This is the number that says whether the gate is keeping the room waiting: it
 * sits between somebody finishing a sentence and the agent starting to answer.
 * Zero when nothing was judged, rather than absent — a call where nobody spoke to
 * the agent is a common outcome, and a missing property looks the same as a build
 * that never emitted it.
 */
function meanGateLatencyMs(stats: VoiceConversationStats | undefined): number {
  const calls = stats?.gateCalls ?? 0;
  if (calls === 0) return 0;
  return Math.round((stats?.gateLatencyMs ?? 0) / calls);
}

/**
 * Share of the room's utterances that came with a speaker, as a whole percentage.
 *
 * Zero rather than absent when nothing was judged, for the reason `meanGateLatencyMs`
 * gives: a missing property cannot be told apart from a build that never emitted one.
 */
function attributionRate(stats: VoiceConversationStats | undefined): number {
  const total = (stats?.attributedUtterances ?? 0) + (stats?.unattributedUtterances ?? 0);
  if (total === 0) return 0;
  return Math.round(((stats?.attributedUtterances ?? 0) / total) * 100);
}

export class MeetingBotService {
  private readonly providers: MeetingProvider[] = [googleMeetProvider];

  private state: MeetingState = 'idle';
  private provider: MeetingProvider | null = null;
  private audio: AudioStack | null = null;
  private browser: BrowserStack | null = null;
  private conversation: VoiceConversation | null = null;
  private page: Page | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private speakerTimer: NodeJS.Timeout | null = null;
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private emptyReadings = 0;
  private joinedAt: number | null = null;
  private startedAt: number | null = null;
  private current: JoinMeetingInput | null = null;
  private responseMode: ResponseMode = 'auto';
  private unreadableCounts = 0;
  /**
   * Whether the room can hear the agent, as far as anything can tell.
   *
   * `false` is a degraded call, not a failed one — the agent still hears the meeting
   * and still acts on it. Kept here because it is retried on the participant poll and
   * because it decides whether the agent bothers speaking at all.
   */
  private micConfirmed = false;
  /** Whether a participant poll is still running; see `checkParticipants`. */
  private pollInFlight = false;
  private speakerPollInFlight = false;
  /**
   * Whether any speaker has ever been read on this call.
   *
   * Reported to the agent as whether attribution works at all, and it is the honest
   * answer to that: a quiet room reads no speaker either, so it can stay false for a while
   * on a perfectly healthy call — and "nothing has been attributed yet" is exactly what
   * the agent should hear then, rather than a confident silence.
   *
   * It does *not* gate the retry, unlike `micConfirmed`. The provider is asked to prepare
   * itself on every poll, because the panel is UI state a re-render or a reconnect can
   * take away, and a first successful read is no evidence it is still there.
   */
  private speakerSeen = false;
  /**
   * Whether a chat send is typing into the composer right now.
   *
   * Two jobs. It refuses a second send, which would otherwise fill the same draft box
   * from two places and post one message made of both. And it holds off the unmute
   * retry, which drives the same page: that one sweeps dialogs and clicks a toggle, so
   * it is the half that can move the control bar out from under a send in progress.
   */
  private chatSendInFlight = false;
  /** Step a failed join reached, carried to the `meeting ended` event. */
  private failStep: JoinStep | null = null;
  /**
   * Which call the asynchronous join flow belongs to.
   *
   * Joining is fire-and-forget — `join()` returns while the waiting room is still
   * being waited on — so a `leave()` (or a timeout, or shutdown) can tear
   * everything down while `runJoin()` is still parked inside the provider. When
   * that admission then resolves, it must not write state belonging to a call that
   * no longer exists; without this guard a late "admitted" resurrects the service
   * into `in_call` with no browser or session behind it. Bumped on every teardown,
   * and checked after every await in the join flow.
   */
  private epoch = 0;

  /**
   * The epoch of a startup that is still building, or null when none is.
   *
   * The one thing a cancelled call cannot do is stop instantly: it may be parked
   * inside a sign-in for the better part of a minute, and there is no way to
   * interrupt that from outside. So `teardown()` returns the service to `leaving`
   * rather than `idle` while this is set, and `join()` refuses until the abandoned
   * startup has let go.
   *
   * That wait is not caution about resource accounting. Both startups drive the
   * *same* persistent browser profile, and `BrowserStack.start()` clears the
   * profile's `SingletonLock`/`SingletonCookie`/`SingletonSocket` before launching —
   * which is correct for the stale locks a killed container leaves behind, and
   * catastrophic against a live one: the second Chromium would delete the first's
   * lock and open the same profile directory alongside it. Two writers to one
   * profile is how a working Google session gets invalidated, and the session is
   * the thing every join depends on.
   */
  private startupEpoch: number | null = null;

  /** The provider that handles this link, if any. */
  findProvider(url: string): MeetingProvider | null {
    return this.providers.find((p) => p.matchesUrl(url)) ?? null;
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  status(): MeetingStatus {
    return {
      state: this.state,
      provider: this.provider?.name ?? null,
      responseMode: this.responseMode,
      effectiveResponseMode: this.conversation?.responseMode ?? null,
      joinedAt: this.joinedAt ? new Date(this.joinedAt).toISOString() : null,
      ...(this.conversation ? { stats: this.conversation.statistics } : {}),
    };
  }

  /**
   * Who is speaking, and who the agent is answering.
   *
   * Reads state the polls have already gathered and touches the browser not at all. That
   * is a requirement rather than an optimisation: the agent calls this mid-turn in a live
   * room, and a fresh page read would put a CDP round trip between a question and its
   * answer — silence the room hears. So it answers from the last reading, up to a few
   * seconds old, not from the instant it was asked.
   */
  speakerReport(): SpeakerReport {
    const inMeeting = this.state !== 'idle';
    const conversation = this.conversation;
    if (!inMeeting || !conversation) {
      return {
        inMeeting,
        speakingNow: null,
        spokeToYou: null,
        roster: [],
        attribution: 'unavailable',
        note:
          this.state === 'idle'
            ? 'You are not in a call.'
            : `You are ${this.state === 'leaving' ? 'leaving' : 'still joining'} the call, so ` +
              'there is nobody to attribute yet.',
      };
    }

    const speakingNow = conversation.currentSpeaker?.who ?? null;
    const spokeToYou = conversation.answeringSpeaker?.who ?? null;

    return {
      inMeeting,
      speakingNow,
      spokeToYou,
      roster: [...conversation.roster],
      attribution: this.speakerSeen ? 'available' : 'unavailable',
      note: this.speakerNote(spokeToYou ?? speakingNow),
    };
  }

  private speakerNote(who: SpeakerDetails | null): string {
    if (!this.speakerSeen) {
      return (
        'I cannot tell who is speaking in this call — the platform is not showing it. ' +
        'Do not guess at a name; ask if it matters.'
      );
    }
    if (who === null) {
      return (
        'Nobody has been identified recently. That usually means a pause, or two people ' +
        'talking at once, which cannot be told apart on one mixed channel.'
      );
    }
    if (who.kind === 'group') {
      // Named where the platform could say who, because "one of Jari or Mario" is more use to
      // the room than the label Meet gives its own shared row.
      const people = who.members.length ? who.members.join(' or ') : 'more than one person';
      return (
        `That came from a microphone shared by ${people} in the same room, so I cannot tell ` +
        'which of them spoke.'
      );
    }
    return `That was ${who.name}.`;
  }

  /**
   * Bring up the stack and request to join.
   *
   * Returns once the request is submitted (or has failed outright), because a guest
   * can wait indefinitely for a host and the calling chat turn must not block on
   * that. Admission, denial and the end of the call are logged as they happen, and
   * `status()` answers for them on request.
   */
  async join(input: JoinMeetingInput): Promise<{ state: MeetingState; message: string }> {
    if (this.state === 'leaving') {
      // Not "already in a call" — the last one has ended and its browser is still
      // being let go of. Saying so is the honest answer, and starting anyway is the
      // thing this state exists to prevent.
      //
      // Two different waits share this state, and only one of them is the long one:
      // an abandoned startup parked in a sign-in, or an ordinary teardown a moment
      // from finishing. Naming the wrong one tells the room to expect the wrong thing.
      return {
        state: this.state,
        message:
          this.startupEpoch === null
            ? `I'm still releasing the previous call's browser. Give me a moment and ask again.`
            : `I'm still releasing the previous call — a sign-in already in progress has to ` +
              `finish first. Give me a moment and ask again.`,
      };
    }
    if (this.isActive) {
      return {
        state: this.state,
        message: `Already in a ${this.provider?.displayName ?? 'meeting'} call (${this.state}). Leave that one first.`,
      };
    }

    const provider = this.findProvider(input.url);
    if (!provider) {
      return { state: 'idle', message: `That doesn't look like a supported meeting link.` };
    }

    // Asked before a call's worth of infrastructure is built: a platform that will
    // not take an unauthenticated bot says so here rather than in the lobby, where
    // finding out costs a virtual display, an audio daemon, a browser and a metered
    // Realtime socket first. The provider answers because only it knows what it
    // needs — this file should not be reading one platform's credentials.
    const misconfigured = provider.configurationError();
    if (misconfigured) return { state: 'idle', message: misconfigured };

    this.provider = provider;
    this.current = input;
    this.responseMode = input.responseMode ?? 'auto';
    this.state = 'launching';
    this.startedAt = Date.now();
    const epoch = this.epoch;
    this.startupEpoch = epoch;

    // Built into locals and published onto `this` only once the epoch check below
    // says the call is still wanted.
    //
    // Startup is many awaits long — a sign-in alone can take 45s — and a `leave()`
    // in that window returns the service to `idle`, so a *second* `join()` can be
    // well under way by the time this one resumes. Assigning to the fields as we
    // went would have the dead call overwrite the live call's browser, page and
    // session, and its own late rejection tear the live call down. Locals also give
    // the cancellation path something to release by name, since a teardown that ran
    // in between has already nulled the fields.
    let audio: AudioStack | null = null;
    let browser: BrowserStack | null = null;
    let conversation: VoiceConversation | null = null;

    /** Release a stack that was built for a call nobody is waiting for any more. */
    const releaseLocals = async (): Promise<void> => {
      conversation?.stop();
      await browser?.stop();
      await audio?.stop();
    };

    try {
      // Instructions and tools first: they need the database and the model
      // catalog, and failing here should cost nothing but a message.
      const { instructions, agentName, lockedIn } = await this.buildInstructions(input);
      const tools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
        lockedIn,
      });

      audio = new AudioStack();
      const handles = await audio.start();
      // Deaf or mute is not a state to sit in: a dead capture or playback process
      // leaves the bot in the room unable to hear or speak, which nobody can see
      // from the inside. Same ending as a lost Realtime session.
      handles.onLost((reason) => this.onAudioLost(epoch, reason));

      conversation = new VoiceConversation({
        instructions,
        tools,
        sink: handles.playbackSink,
        responseMode: this.responseMode,
        // The name the prompt introduces it by, not `config.agentName`. These
        // differ the moment someone renames the agent in its workspace — and an
        // agent that says one name and answers to another would be addressed by
        // the name it just gave the room, and stay silent.
        agentName,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => this.onSessionLost(epoch, reason),
      });
      await conversation.start();
      // Bound to this call's session rather than to `this.conversation`, which at
      // this point still belongs to whatever ran before — and, if this call is
      // abandoned, will belong to whatever runs next.
      const live = conversation;
      handles.onCapture((pcm) => live.pushMeetingAudio(pcm));

      browser = new BrowserStack();
      const page = await browser.start({ env: handles.browserEnv });

      // Before the epoch check below, deliberately: a login can take 20-45s, and a
      // leave() during it must still find the browser and audio released. The
      // contract says this cannot reject — guarded anyway, because a sign-in failure
      // is not a reason to refuse a join that the profile's cookies might carry.
      try {
        await provider.signIn?.(page);
      } catch (err) {
        logger.warn({ err }, '[Meeting] Sign-in threw, which it should not — joining anyway');
      }

      // Setup is several awaits long, and a leave() or shutdown during any of them
      // already tore this call down. Release the stack here (a metered WebSocket and
      // a browser, so this is not a cosmetic leak) rather than proceeding to sit in a
      // waiting room for a meeting nobody wants — and, above all, without publishing
      // any of it onto the fields, which may already describe a newer call.
      if (this.epoch !== epoch) {
        await releaseLocals();
        return { state: 'idle', message: 'The meeting was cancelled before I could join.' };
      }

      this.audio = audio;
      this.conversation = conversation;
      this.browser = browser;
      this.page = page;

      this.state = 'waiting_admission';
      // Deliberately not awaited: the waiting room can outlast any chat turn.
      void this.runJoin(provider, page, input, epoch);

      return {
        state: this.state,
        message:
          `Requested to join the ${provider.displayName} call. ` +
          `A host needs to admit me — ask me for my meeting status to find out whether I'm in.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[Meeting] Failed to start the meeting stack');
      // Locals first, and unconditionally: the stack reaches the fields only once
      // the join is under way, so a failure before that leaves `teardown` with
      // nothing to release — it cannot stop what it cannot see.
      await releaseLocals();
      // Then the service's own state, unless this failure belongs to a call that has
      // already ended, in which case the state describes the one running now.
      if (this.epoch === epoch) await this.teardown('error');
      return { state: 'idle', message: `Could not join the meeting: ${message}` };
    } finally {
      this.releaseStartupSlot(epoch);
    }
  }

  /**
   * Mark this startup as finished building, and free the service if it was waiting.
   *
   * Its own method rather than a few lines in the `finally` because the state it
   * reads is written from elsewhere — a `teardown()` between the last `await` and
   * here — and the compiler is happy to narrow `this.state` on the assumption that
   * nothing did.
   *
   * Only the startup that is still the current one clears the marker: a newer
   * `join()` owns it from the moment it sets its own.
   */
  private releaseStartupSlot(epoch: number): void {
    if (this.startupEpoch !== epoch) return;
    this.startupEpoch = null;
    // Held in `leaving` by `teardown()` precisely until this moment: the shared
    // browser profile was not free until this startup let go of it.
    if (this.state === 'leaving') this.state = 'idle';
  }

  /** Await the join outcome, then either settle into the call or clean up. */
  private async runJoin(
    provider: MeetingProvider,
    page: Page,
    input: JoinMeetingInput,
    epoch: number,
  ): Promise<void> {
    const joinOptions = {
      url: input.url,
      admissionTimeoutMs: config.meetingAdmissionTimeoutMs,
    };

    try {
      let outcome = await provider.join(page, joinOptions);

      // The call was ended while we waited (leave, timeout, shutdown). Whatever
      // the waiting room decided is now about a meeting that no longer exists.
      if (this.epoch !== epoch) return;

      // The platform says the profile's session is stale. Sign in again and try the
      // link once more — this is the one join failure that fixes itself, and until
      // now it recovered only if the agent happened to call the tool a second time.
      // Once, deliberately: a second failure is a real problem (a challenged
      // account, a changed password) and retrying it in a loop would hammer Google's
      // login with the credentials that just didn't work.
      if (outcome.status === 'reauth_required') {
        // `force`, and it matters: the provider's own "am I signed in?" probe is
        // exactly what got this wrong — a profile whose account page loads happily
        // is still handed a guest field by the platform. Without it the retry would
        // re-use the same dead session and fail identically.
        await provider.signIn?.(page, { force: true });
        if (this.epoch !== epoch) return;

        outcome = await provider.join(page, joinOptions);
        if (this.epoch !== epoch) return;

        // Twice in a row is not a stale cookie any more. Report it as a refusal
        // rather than looping, and name the session as the cause.
        if (outcome.status === 'reauth_required') {
          this.failStep = 'lobby';
          logger.warn(
            `[Meeting] Could not join the ${provider.displayName} call: signing in again did not ` +
              `help, and the meeting still treats this browser as a guest, which it refuses ` +
              `automatically`,
          );
          await this.teardown('denied');
          return;
        }
      }

      if (outcome.status !== 'admitted') {
        // Handed to the one owning emitter in `teardown` rather than emitted here, so
        // the failing step rides the existing `meeting ended` event instead of adding
        // a second one that would have to be kept in step with it.
        this.failStep = outcome.step;
        if (outcome.status === 'denied') {
          logger.warn(
            `[Meeting] Denied entry to the ${provider.displayName} call at the ` +
              `"${outcome.step}" step: ${outcome.reason}`,
          );
        } else {
          logger.error(
            `[Meeting] Joining the ${provider.displayName} call failed at the ` +
              `"${outcome.step}" step: ${outcome.reason}`,
          );
        }
        await this.teardown(outcome.status === 'denied' ? 'denied' : 'error');
        return;
      }

      // The provider has the platform's word for the microphone. This is the layer under
      // it, which only the runtime can see: whether the browser ever opened a capture
      // device at all. The two can disagree in both directions — WebRTC mute disables the
      // track rather than closing the device, so an open device proves nothing about
      // transmission, and a platform that believes it is transmitting proves nothing
      // about the device. Hence both, every time.
      //
      // Not a silent skip: reaching admission without an audio stack is a bug in this
      // service, not a condition to tolerate, so let the catch below report it.
      const audio = this.audio;
      if (!audio) throw new Error('admitted to a call with no audio stack');

      const capturing = await audio.waitForMicCapture(MIC_CAPTURE_TIMEOUT_MS);
      // The wait can outlive the call, and the stack it asked about may already be
      // torn down — reporting this against the next meeting would be worse than
      // missing it.
      if (this.epoch !== epoch) return;

      // Audible only if both halves agree. Either one failing is a call the agent can
      // hear but not speak in — degraded, not over. It keeps listening (the room's audio
      // arrives on a different device entirely) and keeps every tool it has; what it
      // must not do is carry on as though it had been heard.
      const audible = outcome.micConfirmed && capturing;
      this.micConfirmed = audible;
      this.conversation?.setAudible(audible);

      this.state = 'in_call';
      this.joinedAt = Date.now();

      // Speaker attribution, before the agent has said a word. Owned here rather than inside
      // the provider's join so there is one caller and the interface's contract is true for
      // the next platform: a provider that only prepared itself in its own join flow would be
      // relying on a promise the runtime never made.
      //
      // Ahead of the greeting, so the very first thing said in the call can already be
      // attributed. Meet starts every call with its participants panel shut, and with it shut
      // the roster is not in the page at all, so this is per join rather than per profile. It
      // never throws — the participant poll keeps retrying while nothing has been attributed,
      // so a control bar still painting costs a tick rather than the whole meeting.
      if (this.page && provider.enableSpeakerAttribution) {
        await provider.enableSpeakerAttribution(this.page).catch((err: unknown) => {
          logger.debug(`[Meeting] Could not prepare speaker attribution: ${String(err)}`);
        });
        if (this.epoch !== epoch) return;
      }

      trackEvent('meeting joined', input.userId, {
        provider: provider.name,
        response_mode: this.responseMode,
        // How often the platform auto-mutes a new joiner. Worth a property because it
        // is the number whose absence let a permanently silent agent go unnoticed: if
        // it reads near-zero in production, this step is doing nothing and can go, and
        // if it reads high, it is load-bearing.
        muted_on_entry: String(outcome.mutedOnEntry),
        // And whether the unmute worked. The pair is the whole diagnosis: muted on
        // entry and confirmed is the fix earning its keep, unconfirmed is a room that
        // heard nothing — which used to be indistinguishable from a good call.
        mic_confirmed: String(audible),
      });

      if (audible) {
        logger.info(`[Meeting] Admitted to the ${provider.displayName} call, and audible to the room`);
        this.greetTheRoom(provider.displayName);
      } else {
        // No greeting, and the model is told why. Speaking here is worse than useless:
        // it spends Realtime tokens on audio nobody receives and leaves the model
        // believing it introduced itself. Said as a standing condition rather than a
        // one-off so it doesn't answer the next question into the void either.
        //
        // The warning names both readings, because they send an engineer to different
        // places: the platform's own control, or the container's audio devices.
        logger.warn(
          `[Meeting] Admitted to the ${provider.displayName} call but not audibly (mic ` +
            `control confirmed: ${outcome.micConfirmed}, capture device open: ${capturing}) — ` +
            `listening, and retrying the unmute`,
        );
        // Hedged deliberately, in both directions. It is stated as *unconfirmed* rather
        // than muted because the readings behind it are a scraped attribute and a
        // `pactl` line, either of which can be wrong — and the model is told not to fix
        // it because it holds the shell tools, and PulseAudio is one plausible train of
        // thought away: killing the daemon it would be "repairing" is the one action
        // here that could actually end the call.
        this.conversation?.notify(
          `You are in the ${provider.displayName} call, but I could not confirm your ` +
            `microphone is on, so the participants may not hear you. Don't greet anyone ` +
            `and don't try to repair this — it is not something your tools can reach, and ` +
            `it is being retried for you. Keep listening, and act on what you hear. If ` +
            `somebody responds to something you said, you are audible after all and can ` +
            `carry on normally.`,
        );
      }

      // Failing to read the room is not a reason to abandon a call already
      // joined, so this cannot be allowed to reach the catch below.
      await this.seedParticipantCount(epoch).catch((err) => {
        logger.warn({ err }, '[Meeting] Could not read the room on admission');
      });

      // The await above can outlive the call: a `leave()` or a shutdown in that
      // gap runs the whole teardown, timers included. Arming new ones now would
      // leave an interval nobody clears and — worse — a duration cap that fires an
      // hour later and hangs up on whatever call is running by then.
      if (this.epoch !== epoch) return;
      this.startWatchdogs();
    } catch (err) {
      // A teardown mid-wait closes the page underneath the provider, so the throw
      // is expected there and belongs to a call that is already gone.
      if (this.epoch !== epoch) return;
      logger.error({ err }, `[Meeting] Join flow threw for the ${provider.displayName} call`);
      await this.teardown('error');
    }
  }

  /** Poll for an empty room, and cap the total call duration. */
  private startWatchdogs(): void {
    this.pollTimer = setInterval(() => void this.checkParticipants(), PARTICIPANT_POLL_MS);
    if (this.provider?.currentSpeaker) {
      this.speakerTimer = setInterval(() => void this.checkSpeaker(), SPEAKER_POLL_MS);
    }
    this.maxDurationTimer = setTimeout(
      () => {
        void this.finish('timeout', `Left the call: it hit the ${config.meetingTimeoutMinutes}-minute limit`);
      },
      config.meetingTimeoutMinutes * 60 * 1000,
    );
  }

  /**
   * Read the room once on admission, patiently, for the response mode alone.
   *
   * Not simply an early `checkParticipants()`, for two reasons found on a live
   * call. Meet renders the other tiles a moment *after* it admits us, so an
   * immediate read comes back as 1 — and 1 is also what an empty room looks like,
   * so feeding it to the leave counter would put a false "I'm alone" reading into
   * a call a host had just that second let us into. And the mode is the only
   * thing that needs an answer this early; the leave check can wait for the timer,
   * which is what it is for.
   *
   * Gives up quietly rather than seeding a 1. The policy's cautious default —
   * wait to be addressed — is the right place to stay when the room is unknown,
   * and the poll will correct it within one interval.
   */
  private async seedParticipantCount(epoch: number): Promise<void> {
    for (let attempt = 0; attempt < SEED_READ_ATTEMPTS; attempt += 1) {
      if (this.epoch !== epoch || this.state !== 'in_call' || !this.page || !this.provider) return;

      let count: number | null = null;
      try {
        count = await this.provider.participantCount(this.page);
      } catch {
        // Keep trying: the page is still settling.
      }

      // Anything above the agent itself means the room has rendered.
      if (count !== null && count > 1) {
        this.conversation?.setParticipantCount(count);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, SEED_READ_INTERVAL_MS));
    }

    logger.info('[Meeting] Room not readable yet on admission — waiting for the poll');
  }

  /**
   * Read the room: how loudly the agent should participate, and whether to leave.
   *
   * One reading serves both. The count is the only thing the agent knows about
   * the shape of the call, and it answers both "is anyone still here?" and
   * "am I talking to one person or interrupting a group?".
   */
  /**
   * Introduce the agent to the room.
   *
   * Held in one place because it happens at either of two moments: on admission when
   * the microphone came up with the call, or later, the first time a mid-call retry
   * gets it live. A room that could not hear the greeting was never greeted, so
   * deferring it to the moment somebody can hear it is the honest reading of "so the
   * room isn't joined by a silent participant".
   */
  private greetTheRoom(displayName: string): void {
    this.conversation?.notify(
      `You have just been admitted to the ${displayName} call. ` +
        `Greet the participants in one short sentence and say what you can help with.`,
    );
    this.conversation?.speakNow();
  }

  /**
   * Try again to get the microphone live, on the poll that is already running.
   *
   * The analogue of a human noticing the mute icon and clicking it. Without this, one
   * unlucky moment during admission — a dialog that outlived the sweep, a control bar
   * mid-paint — costs the entire meeting; with it, the usual cost is one poll interval
   * of silence. The greeting waits for this, so a recovered call is introduced properly
   * rather than sliding in mid-conversation.
   */
  private async retryUnmute(epoch: number): Promise<void> {
    const page = this.page;
    const provider = this.provider;
    const audio = this.audio;
    if (!page || !provider?.ensureUnmuted) return;

    let live: boolean;
    try {
      live = await provider.ensureUnmuted(page);
    } catch (err) {
      // The page can go out from under this — a teardown closes it mid-click. Never a
      // reason to disturb a call, and the next poll will ask again if there is one.
      logger.debug(`[Meeting] Unmute retry failed: ${String(err)}`);
      return;
    }
    if (!live || this.epoch !== epoch || this.state !== 'in_call') return;

    // Both halves, every time — not just the one the provider can see. The join decides
    // audibility from the meeting's toggle *and* the capture device, and those fail
    // independently: a call that got in with a live toggle over a device Chromium never
    // opened would otherwise be declared recovered by the very first retry, on the
    // strength of re-reading the half that was never broken. That would stand the whole
    // arrangement on its head — it would silence the warning, disarm the retry, restore
    // `open` mode and greet the room, for a call that still cannot be heard.
    if (!(await audio?.isMicCaptured())) return;

    // Re-checked after the capture reading above: that is a real await, and a call that
    // ends inside it leaves the greeting below aimed at whatever call owns the
    // conversation by then.
    if (this.epoch !== epoch || this.state !== 'in_call') return;

    logger.info(
      `[Meeting] Microphone is live after a mid-call retry — audible in the ` +
        `${provider.displayName} call now`,
    );
    this.micConfirmed = true;
    this.conversation?.setAudible(true);
    this.greetTheRoom(provider.displayName);
  }

  /**
   * Read who has the floor and hand it to the conversation.
   *
   * Deliberately does nothing else. Nothing about the call depends on the answer yet;
   * this records it and counts how often it was available, which is what says whether a
   * scrape of somebody else's UI is still working. An overlap guard for the same reason
   * the participant poll has one — the interval fires on a wall clock, so a slow read
   * would otherwise stack ticks behind it — though here a skipped tick costs nothing,
   * since the next one is a second away and asks a fresher question.
   */
  private async checkSpeaker(): Promise<void> {
    if (this.state !== 'in_call' || !this.page || !this.provider?.currentSpeaker) return;
    if (this.speakerPollInFlight) return;
    // Captured and re-checked after the await, as `retryUnmute` does. The read is capped at
    // a second and a half, so a cross-call leak is not reachable today — but the invariant
    // then holds by timing rather than by the pattern, and it would quietly stop holding if
    // anyone lengthened that cap.
    const epoch = this.epoch;
    this.speakerPollInFlight = true;
    try {
      const reading = await this.provider.currentSpeaker(this.page);
      if (this.epoch !== epoch) return;
      if (reading !== null) this.speakerSeen = true;
      this.conversation?.setCurrentSpeaker(reading);
    } catch {
      // A hint, not a mechanism. `currentSpeaker` is documented to answer null rather
      // than throw, so this is a page that closed under it mid-read.
    } finally {
      this.speakerPollInFlight = false;
    }
  }

  private async checkParticipants(): Promise<void> {
    if (this.state !== 'in_call' || !this.page || !this.provider) return;

    // `setInterval` re-fires on a wall clock, not on the previous callback finishing, so
    // without this two ticks can be inside this method at once. Harmless for the count —
    // it is a read — and not harmless at all for the unmute retry: that clicks a
    // *toggle*, so an overlap is how one tick switches on what the next switches back
    // off. Reachable in the environment that causes a stuck mute in the first place, a
    // slow dialog sweep being exactly what pushes one retry past ten seconds.
    //
    // Skipping a tick outright rather than queueing it: everything here is a fresh
    // reading of a live page, so a delayed one has no value the next one lacks.
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.pollOnce();
    } finally {
      this.pollInFlight = false;
    }
  }

  /** One poll: get the microphone live if it isn't, then read the room. */
  private async pollOnce(): Promise<void> {
    // The microphone first, because it is the more urgent of the two: an agent nobody
    // can hear is not really taking part. Skipped while a chat send is typing, since the
    // retry sweeps dialogs and clicks the control bar on the same page — see
    // `chatSendInFlight`. A skipped retry costs one poll interval; a swept-away composer
    // costs the message.
    if (!this.micConfirmed && !this.chatSendInFlight) await this.retryUnmute(this.epoch);
    if (this.state !== 'in_call' || !this.page || !this.provider) return;

    // Then the participants panel. Same shape as the unmute retry and for the same reason:
    // one unlucky moment during admission — a dialog that outlived the sweep, a control bar
    // still painting — would otherwise cost attribution for the whole meeting without
    // saying so. Safe to repeat, because the provider tests for the state it wants before
    // touching a control.
    //
    // Asked on *every* poll rather than only until something has been attributed once. A
    // panel is UI state that a re-render or a reconnect can take away, so "have I ever read
    // a speaker" is no evidence it is still open — and gating on that, attribution would be
    // gone for the rest of the call with nothing left to notice. The cost of asking is one
    // DOM query while the panel is up, and the provider bounds its own fruitless clicking.
    //
    // Skipped while a chat send is typing, like the unmute retry above. Meet's side rail
    // shows one panel at a time, so an open chat panel is exactly the state that makes
    // this one click People — and that click closes the chat panel out from under the
    // composer. A skipped refresh costs at most one poll of attribution; the click costs
    // the message.
    if (this.provider.enableSpeakerAttribution && !this.chatSendInFlight) {
      try {
        await this.provider.enableSpeakerAttribution(this.page);
      } catch {
        // Documented not to throw; a closed page is the remaining way here.
      }
      if (this.state !== 'in_call' || !this.page || !this.provider) return;
    }

    let count: number | null;
    try {
      count = await this.provider.participantCount(this.page);
    } catch {
      count = null;
    }

    this.conversation?.setParticipantCount(count);

    // Same poll, because the roster changes for the same reason the count does. Read
    // separately rather than returned alongside it: a provider need not offer names
    // at all, and failing to read them must not disturb the count that decides
    // whether the agent stays in the call.
    if (this.provider.participantNames) {
      try {
        const names = await this.provider.participantNames(this.page);
        if (names.length > 0) this.conversation?.setParticipantNames(names);
      } catch {
        // A hint, not a mechanism — the call carries on without it.
      }
    }

    // null means "couldn't read it" — never a reason to leave a live call, nor to
    // change how the agent behaves. But it is worth saying out loud: the count is
    // scraped from Meet's UI, so a persistent null is a broken selector rather
    // than a quiet meeting, and it silently pins the agent to one mode.
    if (count === null) {
      this.unreadableCounts += 1;
      if (this.unreadableCounts === UNREADABLE_COUNTS_BEFORE_WARNING) {
        logger.warn(
          `[Meeting] Can't read the participant count (${this.unreadableCounts} tries) — ` +
            `staying in "${this.conversation?.responseMode ?? 'addressed'}" mode and not checking for an empty room`,
        );
      }
      return;
    }
    this.unreadableCounts = 0;

    if (count <= 1) {
      this.emptyReadings += 1;
      if (this.emptyReadings >= EMPTY_READINGS_BEFORE_LEAVING) {
        await this.finish('completed', 'Everyone else left the call, so left it too');
      }
      return;
    }
    this.emptyReadings = 0;
  }

  /** Leave on request. Safe when nothing is running. */
  async leave(): Promise<{ message: string }> {
    if (this.state === 'leaving') {
      return { message: 'I have left, but I am still releasing the previous call.' };
    }
    if (!this.isActive) return { message: 'I am not in a meeting right now.' };
    const platform = this.provider?.displayName ?? 'meeting';
    await this.finish('completed', null);
    return { message: `Left the ${platform} call.` };
  }

  /**
   * Post one short message into the call's own chat.
   *
   * The only way out of a call other than speech, and it goes one way: nothing reads
   * the chat back, so this hands over what a spoken sentence mangles — a link, an id,
   * a command to paste — and nothing else.
   *
   * **In-call only, and nothing is kept.** The message is not a conversation message:
   * it is never stored, never delivered to a thread, and never reaches a channel
   * adapter. It exists in the room and in this process, and when the call ends the only
   * trace is a count and a duration in telemetry. That is why the tool behind it runs in
   * meeting mode alone — a chat turn would persist its arguments as history.
   *
   * The one emitter for `meeting chat sent`, at every outcome including the refusals, so
   * a send that never reached the page is still visible as something the agent tried.
   */
  async sendChatMessage(text: string, userId: string): Promise<ChatSendOutcome> {
    const startedAt = Date.now();
    // Collapsed before anything measures or sends it. A model dictating a message hands
    // over newlines, and the composer submits on Enter — so a newline in the draft is
    // half a message in the room, and the half nobody sees is the half that mattered.
    const message = text.trim().replace(/\s+/g, ' ');
    const report = await this.attemptChatSend(message);

    // Built by hand rather than spread from the report: the report holds the length, and
    // the body must not be one field name away from a telemetry property.
    trackEvent('meeting chat sent', userId, {
      provider: this.provider?.name ?? 'none',
      status: report.status,
      length: String(report.length),
      duration_ms: String(Date.now() - startedAt),
      ...(report.step ? { fail_step: report.step } : {}),
    });

    // A send that failed is silence in a room with no other symptom, so it writes a line
    // at every setting, naming the step it stopped at. A send that worked writes one only
    // from `redacted` up, since nothing is wrong and the line is pure diagnostics. Only
    // `full` adds the words, which `formatChatBody` decides.
    const line =
      `[Meeting:Chat] ${report.status} chars=${report.length} ${Date.now() - startedAt}ms` +
      (report.step ? ` step=${report.step}` : '');
    const body = formatChatBody(message);
    const full = body ? `${line} ${body}` : line;
    if (!report.sent) logger.warn(full);
    else if (config.meetingChatLogging !== 'off') logger.info(full);

    return { sent: report.sent, message: report.message };
  }

  /**
   * Decide whether this send can go out, and drive it if it can.
   *
   * Split from `sendChatMessage` so that every path — the refusals included — leaves by
   * one route that reports it.
   */
  private async attemptChatSend(message: string): Promise<ChatSendReport> {
    const provider = this.provider;
    const page = this.page;
    const length = message.length;

    if (this.state !== 'in_call' || !page || !provider) {
      return {
        sent: false,
        status: 'not_in_call',
        length,
        message: `I'm not in a call, so there's no meeting chat to post into.`,
      };
    }
    if (!provider.sendChatMessage) {
      return {
        sent: false,
        status: 'unsupported',
        length,
        message: `I can't post into the chat of a ${provider.displayName} call. Say it instead.`,
      };
    }
    if (length === 0) {
      return { sent: false, status: 'rejected', length, message: `There was no message to post.` };
    }
    if (length > MEETING_CHAT_MAX_CHARS) {
      return {
        sent: false,
        status: 'rejected',
        length,
        message:
          `That's ${length} characters and I post at most ${MEETING_CHAT_MAX_CHARS}. ` +
          `Send the link or the id on its own and say the rest out loud.`,
      };
    }
    if (this.chatSendInFlight) {
      return {
        sent: false,
        status: 'busy',
        length,
        message: `I'm still posting the previous message. Ask me again in a moment.`,
      };
    }

    this.chatSendInFlight = true;
    try {
      const result = await provider.sendChatMessage(page, message);
      if (result.sent) {
        return { sent: true, status: 'sent', length, message: `Posted it in the call's chat.` };
      }
      // The reason is page prose, so it goes to the model and to the log line's `step=`,
      // never to telemetry.
      return {
        sent: false,
        status: 'failed',
        step: result.step,
        length,
        message:
          `I couldn't post that in the call's chat (${result.reason}). ` +
          `Say it out loud instead — don't try again.`,
      };
    } catch (err) {
      // A page that closed under the send: a `leave()` or a teardown mid-type. Reported
      // rather than thrown, because the caller is a tool and the room is still waiting.
      //
      // No `step`: a throw can land at any of them, and naming one would be a guess in a
      // telemetry property. `failed` with no step is exactly "it threw".
      return {
        sent: false,
        status: 'failed',
        length,
        message:
          `I couldn't post that in the call's chat: ${err instanceof Error ? err.message : String(err)}. ` +
          `Say it out loud instead.`,
      };
    } finally {
      this.chatSendInFlight = false;
    }
  }

  /**
   * End the call, logging why when the ending was not asked for.
   *
   * `reason` is null for a user's own `leave()`, which needs no explanation — they
   * know why. The polls and the duration cap pass one, since an ending nobody asked
   * for is the kind an engineer reads the log to understand.
   */
  private async finish(status: 'completed' | 'timeout', reason: string | null): Promise<void> {
    if (!this.isActive) return;
    if (reason) logger.info(`[Meeting] ${reason}`);
    // Claim the ending before teardown reaches its own await. Closing the session is
    // part of teardown, and the close fires `onSessionLost`, so without this the log
    // would carry both "everyone else left" and "lost the Realtime session" for one
    // ending. Teardown bumps the epoch again; doing it twice costs nothing.
    this.epoch += 1;
    await this.teardown(status);
  }

  /**
   * The Realtime session died under us — end the call.
   *
   * Nothing about the bot is a participant any more: no audio reaches the room and
   * nothing the room says reaches a model. Staying would leave a mute, deaf tile in
   * someone's meeting until the empty-room poll or the duration cap fired, so this
   * leaves. Deliberately no reconnect: a fresh session would come back with none of
   * the call's context, so rejoining the conversation mid-sentence is worse than an
   * honest exit the room can see.
   *
   * Epoch-guarded like the join flow — a close belonging to a call that has already
   * ended must not tear down whatever is running now.
   */
  private onSessionLost(epoch: number, reason: string): void {
    const platform = this.provider?.displayName ?? 'meeting';
    this.endOnLoss(
      epoch,
      `Lost the Realtime session mid-call, so left the ${platform} call: ${reason}`,
    );
  }

  /**
   * The virtual audio devices died under us — end the call, for the same reason.
   *
   * `parec` dying makes the bot deaf and `pacat` dying makes it mute, and neither
   * announces itself: the browser is still in the call, the Realtime socket is still
   * open, and the room simply has a participant that stopped responding. Left alone
   * it sits there until the empty-room poll or the duration cap notices, which can
   * be the better part of an hour.
   */
  private onAudioLost(epoch: number, reason: string): void {
    const platform = this.provider?.displayName ?? 'meeting';
    // A process can die while the call is still in the lobby, where "left the call"
    // would describe a room the agent was never in.
    this.endOnLoss(
      epoch,
      this.state === 'in_call'
        ? `Lost the audio pipeline in the ${platform} call, so left it rather than sit ` +
            `there unable to hear or speak: ${reason}`
        : `Lost the audio pipeline on the way into the ${platform} call, so gave up on ` +
            `joining rather than arrive unable to hear or speak: ${reason}`,
    );
  }

  /** End a call whose voice or audio path has gone, and log why. */
  private endOnLoss(epoch: number, logLine: string): void {
    if (this.epoch !== epoch || !this.isActive) return;
    logger.warn(`[Meeting] ${logLine}`);
    void this.teardown('error');
  }

  /**
   * Release everything, in the reverse order it was acquired.
   *
   * The single exit path for every ending — success, denial, crash, timeout,
   * shutdown — so there is one place to be sure nothing is left running. Never
   * throws: a teardown failure would otherwise mask the reason for the teardown.
   *
   * **Do not add an await before the fields are nulled.** A teardown that runs while
   * a startup is still building finds every field already null, so it reaches the
   * end without yielding to anything but microtasks — which is what stops a `join()`
   * landing in the middle of it. Introduce a real await up there and a new call could
   * start in the gap, publish its fields, and have this teardown null them underneath
   * it and pin the service in `leaving`.
   */
  private async teardown(status: 'completed' | 'denied' | 'timeout' | 'error'): Promise<void> {
    // Re-entrancy guard. Two endings can race — a user's `leave()` and the
    // duration cap firing in the same moment — and both would otherwise run the
    // whole teardown, emitting `meeting ended` twice and silently corrupting the
    // metric. First one in owns the ending.
    if (this.state === 'leaving') return;

    const wasActive = this.isActive;
    this.state = 'leaving';
    // Invalidate the in-flight join, if any: from here on its result is stale.
    this.epoch += 1;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.speakerTimer) clearInterval(this.speakerTimer);
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.pollTimer = this.speakerTimer = this.maxDurationTimer = null;

    if (this.page && this.provider) {
      try {
        await this.provider.leave(this.page);
      } catch (err) {
        logger.debug(`[Meeting] leave() failed: ${String(err)}`);
      }
    }

    this.conversation?.stop();
    await this.browser?.stop();
    await this.audio?.stop();

    if (wasActive && this.startedAt && this.current && this.provider) {
      const stats = this.conversation?.statistics;
      trackEvent('meeting ended', this.current.userId, {
        provider: this.provider.name,
        status,
        response_mode: this.responseMode,
        // Which step a failed join got to. A bounded enum, never the prose reason —
        // that would put page text into telemetry.
        ...(this.failStep ? { fail_step: this.failStep } : {}),
        duration_ms: String(Date.now() - this.startedAt),
        responses: String(stats?.responses ?? 0),
        tool_calls: String(stats?.toolCalls ?? 0),
        interruptions: String(stats?.interruptions ?? 0),
        // How the room was handled. `suppressed` against `utterances` is what says
        // whether the gate earned its keep, and `addressed_matches` how often
        // someone actually called the agent by name. Counts only — no transcript
        // ever leaves the process.
        utterances: String(stats?.utterances ?? 0),
        suppressed: String(stats?.suppressed ?? 0),
        addressed_matches: String(stats?.addressedMatches ?? 0),
        mode_switches: String(stats?.modeSwitches ?? 0),
        // How the gate itself fared. `gate_failed` is the one number that says the
        // agent was *deaf* rather than merely quiet: the gate fails closed, so a
        // failing gate and a room nobody addressed produce identical silence, and
        // nothing else distinguishes them. The mean is emitted rather than derived
        // so a dashboard needs no arithmetic to show it.
        gate_calls: String(stats?.gateCalls ?? 0),
        gate_failed: String(stats?.gateFailed ?? 0),
        gate_latency_ms: String(meanGateLatencyMs(stats)),
        // Verdicts thrown away because a later utterance had closed first. The
        // agent never answers a turn nothing judged; this is what that costs, and a
        // high count means a busy room is paying it often.
        gate_superseded: String(stats?.gateSuperseded ?? 0),
        // Answers the agent gave that the room never heard. Distinct from
        // `gate_failed`: there the decision never arrived, here it did and the
        // response produced nothing.
        responses_failed: String(stats?.responsesFailed ?? 0),
        // How often the platform told us who was speaking. Read off a UI nobody
        // promised to keep stable, and it fails silently — the call carries on, just
        // anonymously — so this rate falling between releases is the only signal that
        // Google has moved something.
        attribution_rate: String(attributionRate(stats)),
      });
    }

    this.conversation = null;
    this.browser = null;
    this.audio = null;
    this.page = null;
    this.provider = null;
    this.current = null;
    this.joinedAt = null;
    this.startedAt = null;
    this.emptyReadings = 0;
    this.unreadableCounts = 0;
    this.responseMode = 'auto';
    // Reset to the pessimistic value, not the optimistic one: the next call has to earn
    // "the room can hear me" the same way this one did, and inheriting a `true` would
    // skip the retry for a meeting that needed it.
    this.micConfirmed = false;
    // A poll still in flight belongs to the call being torn down; its own epoch check
    // stops it acting, but leaving this set would deadlock the next call's polling.
    this.pollInFlight = false;
    this.speakerPollInFlight = false;
    // Meet opens every call with its participants panel shut, so the next call starts out
    // unattributed and has to open it again.
    this.speakerSeen = false;
    // Same reasoning: a send left mid-flight here would refuse every send in the next
    // call, and it cannot post anything into it — the page it was typing into is gone.
    this.chatSendInFlight = false;
    this.failStep = null;
    // Free only when nothing is still being built. A startup abandoned mid-sign-in
    // still holds the shared browser profile, and the next `join()` would clear its
    // live lock and open a second Chromium on it — see `startupEpoch`. It flips this
    // to `idle` itself once it has let go.
    this.state = this.startupEpoch === null ? 'idle' : 'leaving';
  }

  /**
   * Build the model's session instructions: the agent's own system prompt, plus
   * how to behave in a live call.
   *
   * Same pipeline `invoke()` uses, so Soul, User, Agent Guide, Memory and Skills
   * all carry over — that is what makes the voice in the room the agent rather
   * than a generic assistant wearing its name. Conversation history is left out:
   * a meeting is its own context, and a whole thread would bloat a session that
   * pays per audio token.
   */
  private async buildInstructions(
    input: JoinMeetingInput,
  ): Promise<{ instructions: string; agentName: string; lockedIn: boolean }> {
    const context = await contextService.getAgentContext(input.userId, {
      agentId: input.agentId,
      includeConversation: false,
    });
    const parts = await buildSystemPromptParts(context, 'meeting');
    const instructions = [
      parts.map((p) => p.text).join('\n\n---\n\n'),
      getMeetingInstructions({
        agentName: context.agentName,
        platform: this.provider?.displayName ?? 'video call',
        responseMode: this.responseMode,
      }),
    ].join('\n\n---\n\n');
    // Handed back so the caller can give the same name to the gate that decides
    // whether the agent was called — the room hears this one, so it is the one
    // people will actually say. `lockedIn` rides along from this same context so
    // the tool set matches the prompt built beside it.
    return { instructions, agentName: context.agentName, lockedIn: context.lockedIn };
  }

  /** Called from the process shutdown path so a container exit leaves the call. */
  async shutdown(): Promise<void> {
    if (!this.isActive) return;
    logger.info('[Meeting] Shutting down — leaving the active call');
    await this.teardown('completed');
  }
}

export const meetingBotService = new MeetingBotService();
