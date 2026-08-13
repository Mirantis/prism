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
 * "Admit" and that can take minutes; the caller gets a state and the rest arrives
 * as notes in the conversation thread. Leaving is immediate and always safe to
 * call.
 *
 * Everything that can leak — an X server, an audio daemon, a browser, a WebSocket —
 * is released through one `teardown()` path, used by the happy ending, every
 * failure, the inactivity timeout and process shutdown alike.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { contextService } from '../context.service';
import { messageDeliveryService } from '../message-delivery.service';
import { buildSystemPromptParts } from '../../prompts/context-builder';
import { getMeetingInstructions } from '../../prompts/meeting-prompt';
import { AudioStack } from './audio-stack';
import { BrowserStack } from './browser-stack';
import { VoiceConversation, type VoiceConversationStats } from './voice-conversation';
import type { EffectiveMode, ResponseMode } from './response-policy';
import type { MeetingToolMode } from '../../config';
import { prepareMeetingTools } from './tool-bridge';
import { createTranscriptLog } from './call-transcript';
import { googleMeetProvider } from './providers/google-meet';
import type { JoinStep, MeetingProvider } from './meeting-provider.interface';
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
  /** How many tools the Realtime model was given: everything, or one delegating one. */
  toolMode: MeetingToolMode;
  /** Present once the call is under way. */
  stats?: VoiceConversationStats;
}

export interface JoinMeetingInput {
  url: string;
  userId: string;
  agentId: string;
  /** Where progress notes go. Falls back to the agent's latest thread. */
  threadId?: string;
  /** How much the agent speaks up; `auto` follows the participant count. */
  responseMode?: ResponseMode;
  /**
   * Whether the Realtime model picks tools itself (`full`) or hands the request to
   * an ordinary agent turn that picks (`delegate`). Defaults to `MEETING_TOOL_MODE`.
   * Per-join because comparing the two is the point of the experiment, and the only
   * way to compare them is two calls minutes apart on one container.
   */
  toolMode?: MeetingToolMode;
}

/**
 * Share of "was I addressed" decisions the local vocative read answered by itself,
 * as a whole percentage.
 *
 * Zero when nothing was judged, rather than absent: a call where nobody spoke to the
 * agent is a common outcome, and a missing property looks the same as a build that
 * never emitted it.
 */
function localGateShare(stats: VoiceConversationStats | undefined): number {
  const total = (stats?.gateLocalYes ?? 0) + (stats?.gateModelCalls ?? 0);
  if (total === 0) return 0;
  return Math.round(((stats?.gateLocalYes ?? 0) / total) * 100);
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
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private emptyReadings = 0;
  private joinedAt: number | null = null;
  private startedAt: number | null = null;
  private current: JoinMeetingInput | null = null;
  private responseMode: ResponseMode = 'auto';
  private toolMode: MeetingToolMode = config.meetingToolMode;
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
      toolMode: this.toolMode,
      effectiveResponseMode: this.conversation?.responseMode ?? null,
      joinedAt: this.joinedAt ? new Date(this.joinedAt).toISOString() : null,
      ...(this.conversation ? { stats: this.conversation.statistics } : {}),
    };
  }

  /**
   * Bring up the stack and request to join.
   *
   * Returns once the request is submitted (or has failed outright). Admission,
   * denial and the end of the call are reported to the thread as they happen,
   * because a guest can wait indefinitely for a host and the calling chat turn
   * must not block on that.
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
    this.toolMode = input.toolMode ?? config.meetingToolMode;
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
      // One log, shared by the conversation that writes the room's speech into it and
      // the delegation tool that sends it with every handoff. Created for every call,
      // not only delegating ones: it is a bounded in-memory buffer
      // (`call-transcript.ts`), and in `full` mode nothing reads it — the Realtime
      // session holds the call's own history.
      const transcript = createTranscriptLog();
      const tools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
        lockedIn,
        toolMode: this.toolMode,
        transcript,
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
        transcript,
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
          `A host needs to admit me — I'll report back when I'm in.`,
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
          await this.notifyThread(
            `I couldn't join the ${provider.displayName} call: signing in again didn't help — ` +
              `the meeting is still treating me as a guest, and it refuses those automatically.`,
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
        await this.notifyThread(
          outcome.status === 'denied'
            ? `I couldn't join the ${provider.displayName} call: ${outcome.reason}`
            : `Joining the ${provider.displayName} call failed: ${outcome.reason}`,
        );
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
        tool_mode: this.toolMode,
      });

      if (audible) {
        this.greetTheRoom(provider.displayName);
      } else {
        // No greeting, and the model is told why. Speaking here is worse than useless:
        // it spends Realtime tokens on audio nobody receives and leaves the model
        // believing it introduced itself. Said as a standing condition rather than a
        // one-off so it doesn't answer the next question into the void either.
        logger.warn(
          `[Meeting] In the call but not audibly (mic control confirmed: ${outcome.micConfirmed}, ` +
            `capture device open: ${capturing}) — listening, and retrying the unmute`,
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
            `carry on normally. The person who sent you has been told.`,
        );
      }

      await this.notifyThread(
        audible
          ? `I'm in the ${provider.displayName} call now.`
          : `I'm in the ${provider.displayName} call, but I couldn't confirm my microphone is ` +
              `on, so the room may not be hearing me. I can hear the meeting, so I'll stay, ` +
              `follow it, and keep trying to unmute — tell me if you'd rather I left. ` +
              // Named through the provider, not hard-coded: this service does not know
              // which platform it is on, and a Teams call explaining itself in terms of
              // Meet's controls would be a small lie in the one message somebody reads
              // when something is wrong.
              (outcome.micConfirmed
                ? `(${provider.displayName} says I'm unmuted, but my browser never opened its capture device.)`
                : `(${provider.displayName}'s own microphone control never read as live.)`),
      );
      // Failing to read the room is not a reason to abandon a call already
      // joined, so this cannot be allowed to reach the catch below.
      await this.seedParticipantCount(epoch).catch((err) => {
        logger.warn({ err }, '[Meeting] Could not read the room on admission');
      });

      // Both awaits above can outlive the call: a `leave()` or a shutdown in that
      // gap runs the whole teardown, timers included. Arming new ones now would
      // leave an interval nobody clears and — worse — a duration cap that fires an
      // hour later and hangs up on whatever call is running by then.
      if (this.epoch !== epoch) return;
      this.startWatchdogs();
    } catch (err) {
      // A teardown mid-wait closes the page underneath the provider, so the throw
      // is expected there and belongs to a call that is already gone.
      if (this.epoch !== epoch) return;
      logger.error({ err }, '[Meeting] Join flow threw');
      await this.notifyThread(
        `Something went wrong while joining the ${provider.displayName} call: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      await this.teardown('error');
    }
  }

  /** Poll for an empty room, and cap the total call duration. */
  private startWatchdogs(): void {
    this.pollTimer = setInterval(() => void this.checkParticipants(), PARTICIPANT_POLL_MS);
    this.maxDurationTimer = setTimeout(
      () => {
        void this.finish('timeout', `I've left the call — it hit the ${config.meetingTimeoutMinutes}-minute limit.`);
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

    // Re-checked after the note as well as before it: posting is a database write and a
    // channel fan-out, and a call that ends inside it leaves the greeting below aimed at
    // whatever call owns the conversation by then.
    if (this.epoch !== epoch || this.state !== 'in_call') return;

    logger.info('[Meeting] Microphone is live after a mid-call retry — the room can hear me now');
    this.micConfirmed = true;
    this.conversation?.setAudible(true);
    await this.notifyThread(`My microphone is working now — the ${provider.displayName} call can hear me.`);
    if (this.epoch !== epoch || this.state !== 'in_call') return;
    this.greetTheRoom(provider.displayName);
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
    // can hear is not really taking part.
    if (!this.micConfirmed) await this.retryUnmute(this.epoch);
    if (this.state !== 'in_call' || !this.page || !this.provider) return;

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
        await this.finish('completed', `Everyone else left the call, so I've left too.`);
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

  /** End the call, optionally telling the thread why. */
  private async finish(
    status: 'completed' | 'timeout',
    note: string | null,
  ): Promise<void> {
    if (!this.isActive) return;
    // Claim the ending before the note goes out. Posting one is a database write and
    // a fan-out to the channel adapters, and the session can close during it —
    // teardown always closes it — so without this the room would be told both
    // "everyone else left" and "I lost my voice connection". Teardown bumps the
    // epoch again; doing it twice costs nothing.
    this.epoch += 1;
    if (note) await this.notifyThread(note);
    await this.teardown(status);
  }

  /**
   * The Realtime session died under us — end the call.
   *
   * Nothing about the bot is a participant any more: no audio reaches the room and
   * nothing the room says reaches a model. Staying would leave a mute, deaf tile in
   * someone's meeting until the empty-room poll or the duration cap fired, so this
   * leaves and says why. Deliberately no reconnect: a fresh session would come back
   * with none of the call's context, so rejoining the conversation mid-sentence is
   * worse than an honest exit the room can see.
   *
   * Epoch-guarded like the join flow — a close belonging to a call that has already
   * ended must not tear down whatever is running now.
   */
  private onSessionLost(epoch: number, reason: string): void {
    this.endOnLoss(
      epoch,
      `Lost the Realtime session mid-call: ${reason}`,
      `I lost my voice connection to the ${this.provider?.displayName ?? 'meeting'} call, ` +
        `so I've left it: ${reason}`,
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
    // A process can die while the call is still in the lobby, where "I've left"
    // would describe a room the agent was never in.
    const note =
      this.state === 'in_call'
        ? `I lost my audio in the ${platform} call (${reason}), so I've left rather ` +
          `than sit there unable to hear or speak.`
        : `I gave up on joining the ${platform} call: my audio died on the way in ` +
          `(${reason}), so I'd have arrived unable to hear or speak.`;
    this.endOnLoss(epoch, `Lost the meeting's audio pipeline: ${reason}`, note);
  }

  /** End a call whose voice or audio path has gone, and say so where it was asked for. */
  private endOnLoss(epoch: number, logLine: string, note: string): void {
    if (this.epoch !== epoch || !this.isActive) return;
    logger.warn(`[Meeting] ${logLine}`);
    void (async () => {
      await this.notifyThread(note);
      // Re-checked after the note, not just before it: posting one is a database
      // write and a fan-out to every channel adapter, and a `leave()` landing in
      // that window can finish its own teardown and let the user rejoin. Without
      // this, the stale teardown below would cancel or end *that* call. Teardown's
      // own guard doesn't cover it — it only rejects a re-entry mid-teardown, and
      // by then the service is back to `idle`.
      if (this.epoch !== epoch) return;
      await this.teardown('error');
    })();
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
   * landing in the middle of it. Introduce a real await up there (posting a note,
   * say) and a new call could start in the gap, publish its fields, and have this
   * teardown null them underneath it and pin the service in `leaving`.
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
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.pollTimer = this.maxDurationTimer = null;

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
      // Read after `stop()`, so a delegation still in flight usually loses the race to
      // report itself and is missing from the tally. Left as is: the alternative is
      // waiting on work whose answer nobody is in the room to hear, and the undercount
      // is at most one handoff per call.
      const stats = this.conversation?.statistics;
      trackEvent('meeting ended', this.current.userId, {
        provider: this.provider.name,
        status,
        response_mode: this.responseMode,
        tool_mode: this.toolMode,
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
        // What the local vocative read saved. `gate_local_share` is a whole
        // percentage of the utterances that skipped the classification model
        // entirely. It is emitted rather than derived so a dashboard needs no
        // arithmetic to show it.
        gate_local_yes: String(stats?.gateLocalYes ?? 0),
        gate_model_calls: String(stats?.gateModelCalls ?? 0),
        gate_local_share: String(localGateShare(stats)),
        // `delegate` mode only, and omitted entirely in `full` mode rather than sent
        // as zeroes — this is what the experiment is judged on, so "the mode was off"
        // must not read as "it delegated nothing". Counts and a mean duration; the
        // requests themselves are participants' speech and never leave the process.
        ...(stats?.delegation
          ? {
              delegations: String(stats.delegation.total),
              delegation_failures: String(stats.delegation.failures),
              delegation_timeouts: String(stats.delegation.timeouts),
              delegation_truncated: String(stats.delegation.truncated),
              delegation_ms_avg: String(
                stats.delegation.total
                  ? Math.round(stats.delegation.msTotal / stats.delegation.total)
                  : 0,
              ),
              // How much call each handoff carried, and how much of it the provider
              // could read from cache. The share is what says whether sending the whole
              // transcript is as cheap as it was designed to be — a call whose handoffs
              // are mostly uncached is paying full price for the room's history every
              // time. Sizes only; the speech itself never leaves the process.
              delegation_transcript_chars_avg: String(
                stats.delegation.total
                  ? Math.round(stats.delegation.transcriptCharsTotal / stats.delegation.total)
                  : 0,
              ),
              delegation_transcript_cached_pct: String(
                stats.delegation.transcriptCharsTotal
                  ? Math.round(
                      (stats.delegation.transcriptCachedCharsTotal * 100) /
                        stats.delegation.transcriptCharsTotal,
                    )
                  : 0,
              ),
            }
          : {}),
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
    this.toolMode = config.meetingToolMode;
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
        toolMode: this.toolMode,
      }),
    ].join('\n\n---\n\n');
    // Handed back so the caller can give the same name to the gate that decides
    // whether the agent was called — the room hears this one, so it is the one
    // people will actually say. `lockedIn` rides along from this same context so
    // the tool set matches the prompt built beside it.
    return { instructions, agentName: context.agentName, lockedIn: context.lockedIn };
  }

  /** Post a progress note where the user asked from, or the latest thread. */
  private async notifyThread(content: string): Promise<void> {
    const input = this.current;
    if (!input) return;
    try {
      if (input.threadId) {
        await messageDeliveryService.publish(input.userId, input.threadId, content, 'SYSTEM');
      } else {
        await messageDeliveryService.publishToLatestThread(input.agentId, input.userId, content, 'SYSTEM');
      }
    } catch (err) {
      // A note nobody could deliver must not end the call.
      logger.warn(`[Meeting] Could not post a status note: ${String(err)}`);
    }
  }

  /** Called from the process shutdown path so a container exit leaves the call. */
  async shutdown(): Promise<void> {
    if (!this.isActive) return;
    logger.info('[Meeting] Shutting down — leaving the active call');
    await this.teardown('completed');
  }
}

export const meetingBotService = new MeetingBotService();
