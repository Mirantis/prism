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
import { VoiceConversation } from './voice-conversation';
import { prepareMeetingTools } from './tool-bridge';
import { googleMeetProvider } from './providers/google-meet.provider';
import type { JoinStep, MeetingProvider } from './meeting-provider.interface';
import type { Page } from 'playwright-core';

/** How often to check whether the meeting has emptied out. */
const PARTICIPANT_POLL_MS = 30_000;

/**
 * Consecutive lone-participant readings before leaving.
 *
 * More than one because a count of 1 is also what a brief UI reshuffle looks
 * like, and leaving a live meeting by mistake is much worse than lingering.
 */
const EMPTY_READINGS_BEFORE_LEAVING = 2;

export type MeetingState =
  | 'idle'
  | 'launching'
  | 'waiting_admission'
  | 'in_call'
  | 'leaving';

export interface MeetingStatus {
  state: MeetingState;
  provider: string | null;
  /** Whether the model answers only when addressed. */
  addressedOnly: boolean;
  joinedAt: string | null;
  /** Present once the call is under way. */
  stats?: { responses: number; toolCalls: number; interruptions: number };
}

export interface JoinMeetingInput {
  url: string;
  userId: string;
  agentId: string;
  /** Where progress notes go. Falls back to the agent's latest thread. */
  threadId?: string;
  displayName?: string
  addressedOnly?: boolean;
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
  private addressedOnly = false;
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
      addressedOnly: this.addressedOnly,
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

    this.provider = provider;
    this.current = input;
    this.addressedOnly = input.addressedOnly === true;
    this.state = 'launching';
    this.startedAt = Date.now();
    const epoch = this.epoch;

    const displayName = input.displayName || config.meetingDisplayName || config.agentName;

    try {
      // Instructions and tools first: they need the database and the model
      // catalog, and failing here should cost nothing but a message.
      const instructions = await this.buildInstructions(input);
      const tools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
      });

      // Held locally as well as on `this` so the cancellation path below can
      // release them by name: a concurrent teardown nulls the fields while these
      // objects are still very much alive.
      const audio = new AudioStack();
      this.audio = audio;
      const handles = await audio.start();

      const conversation = new VoiceConversation({
        instructions,
        tools,
        sink: handles.playbackSink,
        addressedOnly: this.addressedOnly,
        agentName: config.agentName,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => this.onSessionLost(epoch, reason),
      });
      this.conversation = conversation;
      await conversation.start();
      handles.onCapture((pcm) => this.conversation?.pushMeetingAudio(pcm));

      const browser = new BrowserStack();
      this.browser = browser;
      this.page = await browser.start({ env: handles.browserEnv });

      // Setup is several awaits long, and a leave() or shutdown during any of them
      // already tore this call down — including nulling the fields, so `teardown`
      // could not have stopped the pieces created after it ran. Release them here
      // (a metered WebSocket and a browser, so this is not a cosmetic leak) rather
      // than proceeding to sit in a waiting room for a meeting nobody wants.
      if (this.epoch !== epoch) {
        conversation.stop();
        await browser.stop();
        await audio.stop();
        return { state: 'idle', message: 'The meeting was cancelled before I could join.' };
      }

      this.state = 'waiting_admission';
      // Deliberately not awaited: the waiting room can outlast any chat turn.
      void this.runJoin(provider, this.page, input, displayName, epoch, {
        signedIn: browser.isAuthenticated,
        ...(browser.signInFailureReason ? { signInFailureReason: browser.signInFailureReason } : {}),
      });

      return {
        state: this.state,
        message:
          `Requested to join the ${provider.displayName} call` +
          // Only meaningful on the guest path: a signed-in agent shows up under its
          // Google account's own name, so quoting this one would mislead.
          (browser.isAuthenticated ? '' : ` as "${displayName}"`) +
          `. A host needs to admit me — I'll report back when I'm in.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[Meeting] Failed to start the meeting stack');
      await this.teardown('error');
      return { state: 'idle', message: `Could not join the meeting: ${message}` };
    }
  }

  /** Await the join outcome, then either settle into the call or clean up. */
  private async runJoin(
    provider: MeetingProvider,
    page: Page,
    input: JoinMeetingInput,
    displayName: string,
    epoch: number,
    auth: { signedIn: boolean; signInFailureReason?: string },
  ): Promise<void> {
    try {
      const outcome = await provider.join(page, {
        url: input.url,
        displayName,
        admissionTimeoutMs: config.meetingAdmissionTimeoutMs,
        ...auth,
      });

      // The call was ended while we waited (leave, timeout, shutdown). Whatever
      // the waiting room decided is now about a meeting that no longer exists.
      if (this.epoch !== epoch) return;

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

      this.state = 'in_call';
      this.joinedAt = Date.now();
      trackEvent('meeting joined', input.userId, {
        provider: provider.name,
        addressed_only: String(this.addressedOnly),
      });

      // Tell the model where it is and let it introduce itself, so the room isn't
      // joined by a silent participant.
      this.conversation?.notify(
        `You have just been admitted to the ${provider.displayName} call as "${displayName}". ` +
          `Greet the participants in one short sentence and say what you can help with.`,
      );
      this.conversation?.speakNow();

      await this.notifyThread(`I'm in the ${provider.displayName} call now.`);
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

  /** Leave once the bot is demonstrably the only one left. */
  private async checkParticipants(): Promise<void> {
    if (this.state !== 'in_call' || !this.page || !this.provider) return;

    let count: number | null;
    try {
      count = await this.provider.participantCount(this.page);
    } catch {
      return;
    }

    // null means "couldn't read it" — never a reason to leave a live call.
    if (count === null) return;

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
    if (this.epoch !== epoch || !this.isActive) return;
    logger.warn(`[Meeting] Lost the Realtime session mid-call: ${reason}`);
    void (async () => {
      await this.notifyThread(
        `I lost my voice connection to the ${this.provider?.displayName ?? 'meeting'} call, ` +
          `so I've left it: ${reason}`,
      );
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
      trackEvent('meeting ended', this.current.userId, {
        provider: this.provider.name,
        status,
        // Which step a failed join got to. A bounded enum, never the prose reason —
        // that would put page text into telemetry.
        ...(this.failStep ? { fail_step: this.failStep } : {}),
        duration_ms: String(Date.now() - this.startedAt),
        responses: String(this.conversation?.statistics.responses ?? 0),
        tool_calls: String(this.conversation?.statistics.toolCalls ?? 0),
        interruptions: String(this.conversation?.statistics.interruptions ?? 0),
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
    this.addressedOnly = false;
    this.failStep = null;
    this.state = 'idle';
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
  private async buildInstructions(input: JoinMeetingInput): Promise<string> {
    const context = await contextService.getAgentContext(input.userId, {
      agentId: input.agentId,
      includeConversation: false,
    });
    const parts = await buildSystemPromptParts(context, 'meeting');
    return [
      parts.map((p) => p.text).join('\n\n---\n\n'),
      getMeetingInstructions({
        agentName: context.agentName,
        platform: this.provider?.displayName ?? 'video call',
        addressedOnly: this.addressedOnly,
      }),
    ].join('\n\n---\n\n');
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
