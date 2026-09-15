/**
 * Owns the agent's participation in a live voice meeting, start to finish.
 *
 * One meeting at a time per container, matching the one-agent-per-container shape.
 * That is a real constraint rather than an accident: a second call would need its
 * own display, audio daemon and browser (roughly 4 vCPU worth of media work each),
 * and the agent has one voice to lend.
 *
 * The lifecycle is deliberately asymmetric. Joining is asynchronous from the request
 * onwards — `join()` returns as soon as the request is in, because a guest waits for a
 * host to click "Admit" and that can take minutes; the caller gets a state, the model is
 * told in band once the call starts, and every outcome goes to the log. A join that
 * fails before the request goes in is answered to the caller instead, step and all,
 * since nothing else would tell it. Leaving is immediate and always safe to call.
 *
 * Everything that can leak — an X server, an audio daemon, a browser, a WebSocket —
 * is released through one `teardown()` path, used by the happy ending, every
 * failure, the inactivity timeout and process shutdown alike.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { buildVoiceInstructions, type VoiceInstructions } from '../voice/voice-instructions';
import { AudioStack } from './audio-stack';
import { BrowserStack } from './browser-stack';
import {
  capture,
  normalizeUrl,
  read,
  runBrowserCommand,
  summarizeTabs,
  type BrowserCommand,
  type BrowserReading,
  type BrowserResult,
} from './browser-control';
import { VoiceConversation, type VoiceConversationStats } from './voice-conversation';
import { MEETING_SAMPLE_RATE } from './resampler';
import { meanGateLatencyMs } from './gate-stats';
import type { EffectiveMode, ResponseMode } from './response-policy';
import { prepareMeetingTools } from './tool-bridge';
import { googleMeetProvider } from './providers/google-meet';
import { withTimeout } from '../../utils/with-timeout';
import { voiceSessionLock } from '../voice/voice-session-lock';
import { MAX_TOOL_RESULT_CHARS } from '../voice/realtime-tools';
import type {
  ChatMessageRead,
  ChatReadStep,
  ChatSendStep,
  JoinStep,
  MeetingProvider,
  ScreenShareOutcome,
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
 * The label the screenshot carries into the session.
 *
 * A user message is the only item shape that takes an image. So the note says that
 * nobody in the room said it, and the model does not answer it as a remark.
 */
const SCREEN_LOOK_NOTE =
  'This is a picture of your own screen as it looks right now, in answer to your ' +
  'see_screen call. Nobody in the room said this.';

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
 * the page sees it also means one clear answer the model can act on: Meet's own composer
 * carries `maxlength="4000"` and cuts a longer message there silently — no counter, no
 * error, and the send button stays enabled — so a truncated message posts and is
 * acknowledged, and nobody in the room can tell it from one that arrived whole.
 */
export const MEETING_CHAT_MAX_CHARS = 500;

/**
 * Wall clock for one whole send, panel and confirmation included.
 *
 * The provider bounds every read it takes, but a dozen of them timing out in series adds
 * up, and this is a tool call inside a live call: what the room hears while it runs is
 * silence. Whatever a page this slow is doing, the agent is better off saying the line out
 * loud, which is what a failed send tells it to do.
 *
 * Ten seconds is measured from both ends. A live two-participant call sent in 1277ms and
 * 1288ms, and the slowest send in that session took 5745ms with a dialog stuck over the
 * call controls behind it — so this clears the observed worst case with room to spare. The
 * ceiling is `EMPTY_DURATION_BEFORE_LEAVING_MS`: the panel is open while a send runs, an
 * open panel can read the participant count down, and a send that outlasted that would take
 * the agent out of the call it was posting into.
 */
const CHAT_SEND_TIMEOUT_MS = 10_000;

/**
 * How many of the newest chat messages one read brings back.
 *
 * Enough to cover what a room typed while the agent was talking, and short enough to be
 * read out or acted on. The agent is told when there was more than this.
 */
export const MEETING_CHAT_READ_LIMIT = 20;

/**
 * How much of one message a read keeps.
 *
 * Long enough for the pasted stack trace or log line a person puts in the chat instead of
 * reading out. A message longer than this is marked as cut, so the model can say that the
 * end is missing and ask for it.
 *
 * The whole reading is bounded by `MAX_TOOL_RESULT_CHARS`, the cap on one tool result handed
 * to a Realtime model: enough to be read out or acted on, and past it the adapter cuts the
 * result anyway.
 */
const CHAT_READ_MAX_CHARS_PER_MESSAGE = 4_000;

/**
 * Wall clock for one whole read, panel and restore included.
 *
 * The same figure as a send, for the same reason: what the room hears while it runs is
 * silence, and the agent is better off saying it cannot see the chat.
 */
const CHAT_READ_TIMEOUT_MS = 10_000;

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
  /**
   * Whether the room can hear the agent right now.
   *
   * `true` audible. `false` not audible — the platform's toggle is muted, or the browser
   * never opened the capture device, which are two failures with one consequence. `null`
   * when nothing could be read, and it stays `null`: an agent told its microphone is live
   * on the strength of a reading nobody took spends the call talking to a room that hears
   * nothing, which is the failure this field exists to report.
   *
   * Read on the participant poll and kept, so this answers from memory.
   */
  isMicLive: boolean | null;
  /** Whether a screen share was started on this call. */
  sharingScreen: boolean;
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

/**
 * What a join attempt has to say to whoever asked for it.
 *
 * Every ending names itself: requested, cancelled, or failed with a reason.
 */
type JoinAnswer =
  /** The request is in — or the whole join finished, which the caller is told the same way. */
  | { kind: 'requested' }
  /** A `leave()` or a shutdown ended the call before the request went in. */
  | { kind: 'cancelled' }
  /** It stopped short of the request, at `step` when the provider named one. */
  | { kind: 'failed'; step?: JoinStep; reason: string };

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

/**
 * How a chat read ended, in one word.
 *
 * The telemetry property, so it is an enum. `empty` is a panel that opened and holds
 * nothing, which is a real answer and not a failure. `busy` is a read arriving while
 * something else has the panel, and `failed` covers both a provider that could not read
 * and a page that threw.
 */
type ChatReadStatus = 'read' | 'empty' | 'not_in_call' | 'unsupported' | 'busy' | 'failed';

/**
 * What the caller is told: the messages as one fenced block, and whether it is all of them.
 *
 * `success` is false for every outcome that read nothing, so the model never reads a
 * refusal as an empty chat.
 */
export interface ChatReadOutcome {
  success: boolean;
  message: string;
  /** True when the panel held more than the reading carries. */
  incomplete: boolean;
}

/** The outcome plus what telemetry and the log line need. Never a message body. */
interface ChatReadReport extends ChatReadOutcome {
  status: ChatReadStatus;
  step?: ChatReadStep;
  /** How many messages the reading carries. */
  count: number;
  /** How many characters of message text it carries. */
  chars: number;
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

/** The fence the chat text sits inside, so the model can see where other people's words end. */
const CHAT_FENCE_OPEN = '<chat>';
const CHAT_FENCE_CLOSE = '</chat>';

/** A control character, and each half of a surrogate pair whose other half is missing. */
const EXPENSIVE_TO_ESCAPE =
  /[\u0000-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * What marks a message the read cut, so no line ends short without saying so.
 *
 * Exported because the tool's own description names it, so the model is told what the
 * marker means before it reads one.
 */
export const MEETING_CHAT_CUT_MARK = ' [message cut]';

/** Text that cannot end the fence early and holds nothing expensive to JSON-escape. */
function fenceSafe(text: string): string {
  return text.replace(EXPENSIVE_TO_ESCAPE, ' ').split(CHAT_FENCE_CLOSE).join(' ');
}

/**
 * One message on one line: who sent it, what they typed, and whether the read cut it.
 *
 * A name loses the characters the Slack sender tag drops as well, since a name holding a
 * colon or a bracket would read as a second sender. A name the panel did not show leaves
 * the line with the text alone.
 */
function chatLine(message: ChatMessageRead): string {
  const name = message.sender ? fenceSafe(message.sender).replace(/[<>:]/gu, '').trim() : '';
  return `${name ? `${name}: ` : ''}${fenceSafe(message.text)}${
    message.truncated ? MEETING_CHAT_CUT_MARK : ''
  }`;
}

/**
 * Turn the messages into the one block the model reads.
 *
 * It strips the closing marker out of every message, so a person cannot end the fence early
 * and have the rest of their line read as the runtime talking.
 *
 * It drops the oldest messages until the block fits the budget, which is the most a meeting
 * tool result hands to the model. Dropping oldest first keeps what the room just typed, which
 * is what was asked for. The newest message is cut to fit rather than dropped, since a
 * reading with nothing in it is spoken as an empty chat, and it is marked as cut like any
 * other message the read shortened.
 *
 * Both cuts count characters while the adapter measures the JSON-escaped result, so a
 * character that escapes to six is replaced with a space: a control character does, and so
 * does half a surrogate pair, which either cut can leave behind — so a message cut to fit is
 * cleaned again. Everything that survives escapes to at most two.
 */
function fenceChatMessages(
  messages: readonly ChatMessageRead[],
  truncated: boolean,
): ChatReadReport {
  const safe = messages.map(chatLine);

  const kept: string[] = [];
  let chars = 0;
  for (let i = safe.length - 1; i >= 0; i -= 1) {
    if (chars + safe[i].length > MAX_TOOL_RESULT_CHARS) break;
    kept.unshift(safe[i]);
    chars += safe[i].length;
  }

  let cutToFit = false;
  if (kept.length === 0 && safe.length > 0) {
    const room = MAX_TOOL_RESULT_CHARS - MEETING_CHAT_CUT_MARK.length;
    // A message the reader already cut ends with the mark, so that copy comes off before
    // this cut. Slicing over it would leave half a mark and then append a whole one.
    const newest = safe[safe.length - 1];
    const body = newest.endsWith(MEETING_CHAT_CUT_MARK)
      ? newest.slice(0, -MEETING_CHAT_CUT_MARK.length)
      : newest;
    const fitted = body.slice(0, room).replace(EXPENSIVE_TO_ESCAPE, ' ');
    kept.push(`${fitted}${MEETING_CHAT_CUT_MARK}`);
    chars = kept[0].length;
    cutToFit = true;
  }

  const incomplete =
    truncated || cutToFit || kept.length < safe.length || messages.some((one) => one.truncated);

  const numbered = kept.map((text, index) => `${index + 1}. ${text}`).join('\n');
  const message = [
    `The last ${kept.length} message${kept.length === 1 ? '' : 's'} in the call's chat, oldest ` +
      `first, each with the name the call shows for whoever sent it.`,
    CHAT_FENCE_OPEN,
    numbered,
    CHAT_FENCE_CLOSE,
    ...(incomplete
      ? [
          `This is not the whole chat — older messages, or the rest of a message marked ` +
            `${MEETING_CHAT_CUT_MARK.trim()}, are not here.`,
        ]
      : []),
  ].join('\n');

  return { success: true, status: 'read', message, incomplete, count: kept.length, chars };
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
   * Whether the room has ever been proved able to hear the agent on this call.
   *
   * `false` is a degraded call, not a failed one — the agent still hears the meeting
   * and still acts on it. It decides whether the poll keeps working at getting the call
   * audible, and whether the agent bothers speaking at all. A mute the agent chooses
   * leaves it `true`: the audio device below the toggle is proved once and stays proved.
   * `isMicLive` is the current answer to "can the room hear you".
   */
  private micConfirmed = false;
  /**
   * Whether the room can hear the agent, reported as `MeetingStatus.isMicLive`.
   *
   * `true` means it can, `false` that it cannot, and `null` that nobody could read the
   * control. `false` and `null` differ in their evidence: a mute somebody made, against a
   * reading that is missing.
   */
  private isMicLive: boolean | null = null;
  /**
   * Whether the agent wants to be heard.
   *
   * The poll needs to tell a mute the agent chose from one the call imposed, and only this
   * says which: the reading is the same either way. A request that does not take is rolled
   * back, so this holds what the agent last actually got.
   */
  private micDesired = true;
  /**
   * Whether the platform's microphone toggle has ever read on during this call.
   *
   * A muted toggle means two different things, and this tells them apart. Before the first
   * reading of `on`, the join never got the microphone open, so the poll clicks it. After
   * one, somebody in the call did the mute, so the poll reports it and leaves it alone.
   */
  private hasMicBeenOn = false;
  /**
   * Whether the current mute has already been reported.
   *
   * One notice per transition, not one per poll. A mute the agent asked for counts as
   * reported, since the party that asked for it needs no telling. Held separately from
   * `isMicLive` because an unreadable reading between two muted ones must not count as the
   * mute ending.
   */
  private micMuteReported = false;
  /**
   * The microphone click currently in flight, if any; see `withMicClick`.
   *
   * Two callers can want the control at once — the poll's retry and the agent's own tool —
   * and on a toggle two overlapping clicks undo each other.
   */
  private micClick: Promise<void> = Promise.resolve();
  /**
   * Whether a share was started on this call.
   *
   * Held here so the agent can be told without a CDP round trip, and cleared with the
   * rest of the call state. It records what this runtime started, not what Meet shows
   * now: a share that somebody stopped from the room still reads true until the call
   * ends.
   */
  private sharingScreen = false;
  /**
   * Whether the agent presented at any point in this call.
   *
   * Separate from `sharingScreen`, which a stop clears: the telemetry question is
   * whether the room was ever shown anything, and a call that shared and then stopped
   * would answer that with `false`.
   */
  private sharedScreen = false;
  /** Browser commands run on this call, reported once at the end. */
  private browserCommands = 0;
  /**
   * Tail of the queue for everything that moves the front tab.
   *
   * The Realtime model issues tool calls in parallel, and a `browse` that lands inside a
   * share start leaves the front tab decided by whichever `bringToFront` resolves last —
   * which the room watches happen. Each acquisition chains onto the previous tail, so
   * these run in arrival order. The tail only ever resolves: a command that throws must
   * not stop the next one.
   */
  private frontTail: Promise<void> = Promise.resolve();
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
   * Whether a send or a read has the chat panel right now.
   *
   * Two jobs. It refuses a second one, which would otherwise fill the same draft box
   * from two places and post one message made of both, or have one flow close the panel
   * the other is reading. And it holds off the unmute retry, which drives the same page:
   * that one sweeps dialogs and clicks a toggle, so it is the half that can move the
   * control bar out from under a send in progress.
   *
   * One flag for both directions, since both drive the one panel.
   */
  private chatPanelBusy = false;
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
      isMicLive: this.isMicLive,
      sharingScreen: this.sharingScreen,
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
   * Returns once the request is submitted, or once the join has failed short of that,
   * and names the step it failed at. A guest can wait indefinitely for a host, so the
   * calling chat turn must not block on admission — but it can and must wait for the
   * request itself, which is seconds on a healthy call and minutes on a pathological one,
   * since a lobby that refuses the session is loaded and hunted twice over a second
   * sign-in. Admission, denial and the end of the call are logged as they happen, and
   * `status()` answers for them on request.
   */
  async join(
    input: JoinMeetingInput,
  ): Promise<{ state: MeetingState; step?: JoinStep; message: string }> {
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

    // The agent has one voice, and a browser voice chat may be using it. The lock is
    // held for exactly as long as this service is not `idle`, so the two release sites
    // below are the two places that word is written.
    if (!voiceSessionLock.tryAcquire('meeting')) {
      return {
        state: 'idle',
        message: `I'm in a voice chat right now. End that first and I'll join the call.`,
      };
    }

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
        // The virtual audio devices run at the meeting rate, so both resamplers are in
        // the path. Stated rather than defaulted — see the option's own comment.
        sampleRate: MEETING_SAMPLE_RATE,
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
      handles.onCapture((pcm) => live.pushAudio(pcm));

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
      // The stack is on the fields, so `teardown()` can release it — which is the whole
      // job of the startup marker. Let go of it here rather than in the `finally`: from
      // this line on a teardown does real, awaited work, and this call now waits for the
      // request to go in. A marker released in the middle of that teardown would return
      // the service to `idle` while a live browser still held the shared profile.
      this.releaseStartupSlot(epoch);

      this.state = 'waiting_admission';
      // Two answers race, and the join decides which one this call gets. The request
      // going in is the ordinary one. The other is a failure before it went in — a page
      // that would not load, a lobby that refused, no microphone — which used to be
      // logged and nothing more, so the room was told a host had been asked to admit a
      // request nobody had made.
      let requestSubmitted = (): void => {};
      const submitted = new Promise<JoinAnswer>((resolve) => {
        requestSubmitted = () => resolve({ kind: 'requested' });
      });
      // Not awaited beyond the race: the waiting room can outlast any chat turn, and
      // `runJoin` reports everything after the request itself.
      const attempt = this.runJoin(provider, page, input, epoch, requestSubmitted);

      const answer = await Promise.race([submitted, attempt]);
      if (answer.kind === 'requested') {
        // Answered on the request alone, and the epoch is deliberately not re-read: an
        // ordinary ending bumps it too, and a host who denies the request straight away
        // gets the teardown far enough to do so before this line runs. Reporting that as
        // a cancelled join would name the wrong cause. `runJoin` answers `cancelled` for
        // a call that really was ended before it asked.
        return {
          // The state the request left behind, rather than a fresh reading: a call a host
          // admits at once is already `in_call` by the time this line runs, and one that
          // waits is not, so reading the field here answers different things for the same
          // event. The message sends the caller to `status()` for what happened next.
          state: 'waiting_admission',
          message:
            `Requested to join the ${provider.displayName} call. ` +
            `A host needs to admit me — ask me for my meeting status to find out whether I'm in.`,
        };
      }
      // The attempt finished before the request went in. `idle` literally, never
      // `this.state`: the teardown it has just run may still be releasing the browser,
      // and `leaving` describes that teardown rather than this answer.
      if (answer.kind === 'cancelled') {
        return { state: 'idle', message: 'The meeting was cancelled before I could join.' };
      }
      return {
        state: 'idle',
        step: answer.step,
        message: `Could not join the meeting: ${answer.reason}`,
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
    if (this.state === 'leaving') {
      this.state = 'idle';
      voiceSessionLock.release('meeting');
    }
  }

  /**
   * Await the join outcome, then either settle into the call or clean up.
   *
   * Answers the failures that happen before the request goes in, so `join()` can report
   * them to whoever asked. Everything after the request — admission, denial, the end of
   * the call — is logged and left to `status()`, because no chat turn can wait for a
   * host, so those endings answer `requested` here.
   */
  private async runJoin(
    provider: MeetingProvider,
    page: Page,
    input: JoinMeetingInput,
    epoch: number,
    onRequestSubmitted: () => void,
  ): Promise<JoinAnswer> {
    const joinOptions = {
      url: input.url,
      admissionTimeoutMs: config.meetingAdmissionTimeoutMs,
      onRequestSubmitted,
    };

    try {
      let outcome = await provider.join(page, joinOptions);

      // The call was ended while we waited (leave, timeout, shutdown). Whatever
      // the waiting room decided is now about a meeting that no longer exists.
      if (this.epoch !== epoch) return { kind: 'cancelled' };

      // The platform says the profile's session is stale. Sign in again and try the
      // link once more — this is the one join failure that fixes itself, and until
      // now it recovered only if the agent happened to call the tool a second time.
      // Once, deliberately: a second failure is a real problem (a challenged
      // account, a changed password) and retrying it in a loop would hammer Google's
      // login with the credentials that just didn't work.
      if (outcome.status === 'reauth_required') {
        // `force`, and it matters: the provider asks for this only once the session it
        // was handed has failed to work — its own check said Google refuses it, or the
        // lobby kept asking for a guest name. Checking again spends the settle budget
        // for an answer we hold, and the retry would re-use the same session and fail
        // identically.
        await provider.signIn?.(page, { force: true });
        if (this.epoch !== epoch) return { kind: 'cancelled' };

        outcome = await provider.join(page, joinOptions);
        if (this.epoch !== epoch) return { kind: 'cancelled' };

        // Twice in a row is not a stale cookie any more. Report it as a refusal
        // rather than looping, and name the session as the cause.
        if (outcome.status === 'reauth_required') {
          this.failStep = 'lobby';
          const reason =
            `signing in again did not help, and the meeting still treats this browser as a ` +
            `guest, which it refuses automatically`;
          logger.warn(`[Meeting] Could not join the ${provider.displayName} call: ${reason}`);
          await this.teardown('denied');
          return { kind: 'failed', step: 'lobby', reason };
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
        return { kind: 'failed', step: outcome.step, reason: outcome.reason };
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
      if (this.epoch !== epoch) return { kind: 'cancelled' };

      // Audible only if both halves agree. Either one failing is a call the agent can
      // hear but not speak in — degraded, not over. It keeps listening (the room's audio
      // arrives on a different device entirely) and keeps every tool it has; what it
      // must not do is carry on as though it had been heard.
      const audible = outcome.micConfirmed && capturing;
      this.micConfirmed = audible;
      this.conversation?.setAudible(audible);

      // The first `isMicLive` reading, taken from the join rather than waited for. Both
      // halves, exactly as `audible` above: a live toggle over a capture device Chromium
      // never opened is a room that hears nothing, and reporting that as a live microphone
      // is the failure this field is here to catch. `null` only where nothing was read at
      // all — an unconfirmed join with no auto-mute is the provider failing to read the
      // control. Reading the page again here would answer the same question ten seconds
      // sooner than the poll and report `null` for the first tick of a healthy call.
      this.isMicLive = audible ? true : outcome.micConfirmed || outcome.mutedOnEntry ? false : null;
      // The join read the toggle open, so a muted reading later in the call came from
      // somebody in it.
      this.hasMicBeenOn = outcome.micConfirmed;

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
        if (this.epoch !== epoch) return { kind: 'cancelled' };
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
        // than muted because the readings behind it are a scraped attribute and a `pactl`
        // line, either of which can be wrong. The microphone control is named because the
        // model has it, and the audio stack below the call is ruled out because it holds
        // the shell tools too: PulseAudio is one plausible train of thought away, and
        // killing the daemon it would be "repairing" is the one action here that could
        // actually end the call.
        this.conversation?.notify(
          `You are in the ${provider.displayName} call, but I could not confirm your ` +
            `microphone is on, so the participants may not hear you. Don't greet anyone. ` +
            `I am retrying the unmute for you, and set_microphone with on: true is yours ` +
            `to try as well. Go no further than that control — the audio devices under ` +
            `the call are not something to repair from in here. Keep listening, and act ` +
            `on what you hear. If somebody responds to something you said, you are ` +
            `audible after all and can carry on normally.`,
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
      if (this.epoch !== epoch) return { kind: 'cancelled' };
      this.startWatchdogs();
      return { kind: 'requested' };
    } catch (err) {
      // A teardown mid-wait closes the page underneath the provider, so the throw
      // is expected there and belongs to a call that is already gone.
      if (this.epoch !== epoch) return { kind: 'cancelled' };
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ err }, `[Meeting] Join flow threw for the ${provider.displayName} call`);
      await this.teardown('error');
      // The throw can come from either side of the request going in. `join()` has
      // answered already in the second case, and drops this.
      return { kind: 'failed', step: this.failStep ?? undefined, reason };
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
   * Read the microphone on the poll, and work at getting the call audible while it is not.
   *
   * The reading comes first and is recorded either way, so a mute that arrives mid-call is
   * reported. Then, while the agent wants to be heard and nothing has yet carried its
   * voice, the poll works at both halves of the audio path.
   */
  private async checkMicrophone(epoch: number): Promise<void> {
    const page = this.page;
    const provider = this.provider;
    if (!page || !provider?.microphoneLive) return;

    let live: boolean | null;
    try {
      // Under the click lock as well, and for the write rather than the read: a read that
      // starts before a click and lands after it would put the replaced state back.
      live = await this.withMicClick(() => provider.microphoneLive!(page));
    } catch (err) {
      // A teardown can close the page mid-read. The next poll asks again if there is one.
      logger.debug(`[Meeting] Could not read the microphone: ${String(err)}`);
      return;
    }
    if (this.epoch !== epoch || this.state !== 'in_call') return;

    this.recordMicReading(live);
    if (this.micConfirmed || !this.micDesired) return;
    // The clicking half waits while the chat panel is busy: it sweeps dialogs and clicks the
    // control bar on the same page — see `chatPanelBusy`. A skipped attempt costs one poll
    // interval; a swept-away composer costs the message. The reading above costs nothing, so
    // a mute that arrives during a send is still reported.
    if (this.chatPanelBusy) return;
    await this.makeAudible(epoch, live);
  }

  /**
   * Record a microphone reading, and tell the agent when it stops matching what it asked
   * for.
   *
   * Both directions, once each. The model is told in band because it is the party that
   * cannot tell: it hears the room while the room hears nothing back. Each transition also
   * writes one log line, which is where an engineer reads why the agent went quiet.
   *
   * An unreadable control changes the reading and says nothing, since the evidence for a
   * mute is missing rather than present. It reaches the agent as `isMicLive: null`.
   *
   * The reading is the platform's toggle and `isMicLive` is audibility. So the recovery
   * notice goes by audibility, and the mute notice needs the toggle to have read on earlier
   * in the call — the mute the join itself never cleared is nobody's doing.
   */
  private recordMicReading(next: boolean | null): void {
    if (next === true) this.hasMicBeenOn = true;
    this.isMicLive = next === true ? this.micConfirmed : next;

    if (next === false && this.hasMicBeenOn && this.micDesired && !this.micMuteReported) {
      this.micMuteReported = true;
      logger.warn('[Meeting] The microphone was muted mid-call and nobody here asked for it');
      this.conversation?.notify(
        `Your microphone has just been muted — something in the call did that, not you, so ` +
          `the participants cannot hear you now. Say nothing until it is back. If somebody ` +
          `asked you to be quiet, stay muted. Otherwise call set_microphone with on: true, ` +
          `and carry on if that works.`,
      );
      return;
    }

    if (this.isMicLive === true && this.micMuteReported) {
      this.micMuteReported = false;
      logger.info('[Meeting] The microphone is live again');
      this.conversation?.notify('Your microphone is on again — the participants can hear you.');
    }
  }

  /**
   * Work at getting the call audible, on the poll that is already running.
   *
   * Two halves have to hold: the platform's toggle open, and the browser capturing from the
   * virtual device. The toggle gets one click per poll while the join never got it open —
   * the analogue of a person noticing the mute icon — and the capture device is re-read
   * every poll, because Meet opens it when the toggle opens. The greeting waits for both,
   * so a recovered call is introduced properly rather than sliding in mid-conversation.
   */
  private async makeAudible(epoch: number, reading: boolean | null): Promise<void> {
    const page = this.page;
    const provider = this.provider;
    const audio = this.audio;
    if (!page || !provider?.setMicrophone) return;

    let live = reading;
    if (live !== true) {
      // Somebody in the call made this mute, so the poll has already reported it and stops
      // here. Undoing it is the agent's own call, through `set_microphone`.
      if (this.hasMicBeenOn) return;
      try {
        live = await this.withMicClick(() => provider.setMicrophone!(page, true));
      } catch (err) {
        // The page can go out from under this — a teardown closes it mid-click. Never a
        // reason to disturb a call, and the next poll will ask again if there is one.
        logger.debug(`[Meeting] Unmute retry failed: ${String(err)}`);
        return;
      }
      // The agent asked to be muted while this click was queued behind the lock. Its
      // request is the newer one, so nothing below it applies: no recovery, and no greeting
      // spoken into a microphone it has just closed.
      if (this.epoch !== epoch || this.state !== 'in_call' || !this.micDesired) return;
      this.recordMicReading(live);
      if (live !== true) return;
    }

    // Both halves, every time. The toggle and the capture device fail independently, so a
    // call whose toggle read live over a device Chromium never opened would otherwise be
    // declared recovered on the strength of the half that was never broken.
    if (!(await audio?.isMicCaptured())) return;

    // Re-checked after the capture reading above: that is a real await, and a call that
    // ends inside it leaves the greeting below aimed at whatever call owns the
    // conversation by then. `micDesired` is re-read for the same reason — the request can
    // change inside any await, not only inside the click.
    if (this.epoch !== epoch || this.state !== 'in_call' || !this.micDesired) return;

    logger.info(
      `[Meeting] Microphone is live after a mid-call retry — audible in the ` +
        `${provider.displayName} call now`,
    );
    this.micConfirmed = true;
    this.isMicLive = true;
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
    // Captured and re-checked after the await, as `makeAudible` does. The read is capped at
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

  /** One poll: check the microphone, then read the room. */
  private async pollOnce(): Promise<void> {
    // The microphone first, because it is the more urgent of the two: an agent nobody
    // can hear is not really taking part.
    await this.checkMicrophone(this.epoch);
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
    // Skipped while the chat panel is busy, like the unmute retry above. Meet's side rail
    // shows one panel at a time, so an open chat panel is exactly the state that makes
    // this one click People — and that click closes the chat panel out from under the
    // composer, or out from under a read. A skipped refresh costs at most one poll of
    // attribution; the click costs the message or the reading.
    //
    // Both gates read the flag one way only: they hold a *new* poll off, and neither stops
    // a retry or a panel click already in flight when the send begins. That case fails in
    // the safe direction — the send reports `confirm` and the agent says the line out loud
    // — so a lock across both is not worth what it would cost to hold.
    if (this.provider.enableSpeakerAttribution && !this.chatPanelBusy) {
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

  /**
   * Mute or unmute on request. Doesn't throw if nothing is running.
   *
   * The agent's own control over whether it can be heard. Every outcome is reported, never
   * thrown. Not in a call, no such control on this platform, and a control nobody could read
   * are all answers the model can act on mid-turn in a live room.
   *
   * `micDesired` is set before the first await, so the poll can tell a mute the agent chose
   * from one the call imposed even while the click is still going out. A request that does
   * not take puts it back.
   */
  async setMicrophone(on: boolean): Promise<{ success: boolean; message: string }> {
    if (this.state !== 'in_call') {
      return {
        success: false,
        message:
          this.state === 'idle'
            ? 'You are not in a call, so there is no microphone to turn on or off.'
            : `You are ${this.state === 'leaving' ? 'leaving' : 'still joining'} the call, so ` +
              'the microphone is not yours to set yet.',
      };
    }

    const page = this.page;
    const provider = this.provider;
    if (!page || !provider?.setMicrophone) {
      return {
        success: false,
        message: `I cannot control the microphone on ${provider?.displayName ?? 'this platform'}.`,
      };
    }

    // Before the await, so a poll that fires during the click already knows this mute was
    // asked for and does not report it as one the call imposed. Every exit below that did
    // not get what it asked for puts this back: otherwise one failed self-mute leaves the
    // poll judging the rest of the call against a state the agent never reached, and the
    // next mute a host makes goes unreported.
    const wanted = this.micDesired;
    this.micDesired = on;

    const epoch = this.epoch;
    let live: boolean | null;
    try {
      live = await this.withMicClick(() => provider.setMicrophone!(page, on));
    } catch (err) {
      this.micDesired = wanted;
      logger.debug(`[Meeting] Could not set the microphone: ${String(err)}`);
      return { success: false, message: 'I could not reach the microphone control.' };
    }
    if (this.epoch !== epoch || this.state !== 'in_call') {
      this.micDesired = wanted;
      return { success: false, message: 'The call ended before that took effect.' };
    }

    if (live === null) {
      this.micDesired = wanted;
      this.isMicLive = null;
      return {
        success: false,
        message:
          'I could not read the microphone control back, so I cannot say what state it is ' +
          'in. Check meeting_status before you speak.',
      };
    }

    // A muted toggle settles audibility on its own — the room hears nothing through it. An
    // open toggle is half the answer, so a call whose capture device never opened stays
    // inaudible here, and the poll says so once it reads that device.
    if (live) this.hasMicBeenOn = true;
    this.isMicLive = live && this.micConfirmed;
    // Accounted for on the outcome rather than on the request. A mute the agent chose is
    // not news to tell it about, so it counts as reported; an unmute that worked clears the
    // slate for the next one. A click that did not take leaves the standing mute exactly as
    // it was, since clearing it here would have the next poll blame the call for a mute the
    // agent made — once per failed attempt.
    if (live === on) this.micMuteReported = !on;
    if (live !== on) {
      this.micDesired = wanted;
      return {
        success: false,
        message: on
          ? 'I clicked unmute and the microphone still reads muted.'
          : 'I clicked mute and the microphone still reads live.',
      };
    }

    if (on && !this.micConfirmed) {
      // The toggle is open over an audio device nothing has read on this call. Saying the
      // room can hear you is the one claim the runtime cannot make here, so it reports what
      // it did instead. The poll's retry reads the device and says so when it works.
      return {
        success: true,
        message:
          'Your microphone is uncovered at the platform, but nothing has yet carried your ' +
          'voice on this call. I keep checking, and I tell you when the room can hear you.',
      };
    }

    return {
      success: true,
      message: on
        ? 'Your microphone is on — the participants can hear you.'
        : 'Your microphone is off — the participants cannot hear you until you turn it on.',
    };
  }

  /**
   * Show the room the agent's screen.
   *
   * Only from `in_call`. During a join the page is the lobby, not the meeting. Every
   * other state answers with what the agent should say instead.
   *
   * This touches the browser and takes several seconds, because it clicks through
   * Meet's controls. The room hears a pause, which the prompt's speak-before-a-tool
   * rule covers.
   */
  async startScreenShare(): Promise<{ success: boolean; message: string }> {
    const outcome = await this.driveScreenShare('start');
    if (outcome.status === 'failed') return { success: false, message: outcome.reason };

    this.sharingScreen = true;
    this.sharedScreen = true;
    return {
      success: true,
      message:
        outcome.status === 'already_sharing'
          ? 'I am already sharing my screen.'
          : 'I am sharing my screen — the room can see it now.',
    };
  }

  /**
   * Run a microphone click with no other click in flight.
   *
   * The control is a toggle, so one overlapping click switches on what the other switches
   * off. A second caller waits, then reads for itself, so the provider sees the state the
   * first click left and "the state already matches, so click nothing" holds.
   */
  private async withMicClick<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.micClick;
    let release = () => {};
    this.micClick = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Stop presenting. The call keeps running.
   *
   * `not_sharing` is a success: the room sees nothing, which is what was asked for.
   * Somebody may have stopped the share from the meeting's own controls.
   */
  async stopScreenShare(): Promise<{ success: boolean; message: string }> {
    const outcome = await this.driveScreenShare('stop');
    if (outcome.status === 'failed') return { success: false, message: outcome.reason };

    this.sharingScreen = false;
    return {
      success: true,
      message:
        outcome.status === 'not_sharing'
          ? 'I was not sharing my screen.'
          : 'I have stopped sharing my screen.',
    };
  }

  /**
   * Run `fn` after everything else that moves the front tab.
   *
   * Serialized rather than locked per tab: what has to hold is the order the room sees,
   * and that is one thing however many tabs are open.
   */
  private async onFrontQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.frontTail.then(fn);
    this.frontTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * The part both share tools have in common: the state gate, the provider call and the
   * telemetry event. One place, so the two directions cannot drift apart.
   */
  private async driveScreenShare(direction: 'start' | 'stop'): Promise<ScreenShareOutcome> {
    if (!this.isActive) return { status: 'failed', reason: 'I am not in a meeting right now.' };
    if (this.state !== 'in_call' || !this.page || !this.provider) {
      return {
        status: 'failed',
        reason:
          this.state === 'leaving'
            ? 'I am leaving the call, so there is nothing to share into.'
            : 'I am still getting into the call — ask me again once I am in.',
      };
    }

    const provider = this.provider;
    const drive = direction === 'start' ? provider.startScreenShare : provider.stopScreenShare;
    if (!drive) {
      return {
        status: 'failed',
        reason: `I cannot share my screen in a ${provider.displayName} call.`,
      };
    }

    // Read before the awaits below: a teardown that lands during them clears `current`,
    // and an event attributed to "unknown" is an event nobody can find again.
    const userId = this.current?.userId ?? 'unknown';
    const page = this.page;
    const browser = this.browser;

    const outcome = await this.onFrontQueue(async () => {
      try {
        // The share controls belong to the meeting page, so that page goes in front for
        // the clicks. The agent is told to open what it wants to show *before* it shares,
        // which leaves the meeting tab in the background, and a capture that a background
        // tab asks for is not reliably granted.
        await page.bringToFront().catch(() => {});
        return await drive.call(provider, page);
      } catch (err) {
        logger.error({ err }, `[Meeting] Screen share ${direction} failed`);
        return {
          status: 'failed',
          reason: 'Something went wrong using the meeting controls.',
        } as ScreenShareOutcome;
      } finally {
        // Back to the tab the room is meant to watch. Nothing is opened for this: a call
        // that never browsed has no tab, and the meeting stays in front.
        await browser?.raiseActiveTab().catch(() => {});
      }
    });

    trackEvent('meeting screen share', userId, { provider: provider.name, status: outcome.status });
    return outcome;
  }

  /**
   * Show the model what is on the screen right now.
   *
   * A picture, not a description. A page reading cannot say that a chart is empty or
   * that a dialog covers the button.
   *
   * A tool result is a string, so the picture cannot travel in it. The picture goes in
   * as its own conversation item, and the tool answers with the reading.
   *
   * That item reaches the meeting's own model and nothing else, so `toSession` says who
   * is asking. A chat turn during a live call can call this tool too, and it gets the
   * page in words: sending the picture into the meeting session would show it to the
   * model that did not ask, while telling the one that did that it is looking at
   * something it cannot see.
   */
  async lookAtScreen(
    options: { toSession?: boolean } = {},
  ): Promise<{ success: boolean; message: string } & Partial<BrowserReading>> {
    if (!this.isActive) return { success: false, message: 'I am not in a meeting right now.' };
    if (this.state !== 'in_call' || !this.browser) {
      return { success: false, message: 'I am still getting into the call — ask me again once I am in.' };
    }

    const page = this.browser.front();
    if (!page) return { success: false, message: 'There is no browser window open.' };

    try {
      const { imageUrl, reading } = await capture(page);
      const shown =
        options.toSession === true &&
        (this.conversation?.showImage(imageUrl, SCREEN_LOOK_NOTE) ?? false);
      return {
        success: true,
        message: shown
          ? 'This is what my screen is showing.'
          : 'Here is what the screen says. I cannot show you the picture of it from here.',
        ...reading,
      };
    } catch (err) {
      logger.error({ err }, '[Meeting] Screen capture failed');
      return { success: false, message: 'I could not get a picture of the screen.' };
    }
  }

  /**
   * Use the browser's second tab — the one the meeting is not in.
   *
   * Same gate as `startScreenShare`. Before the call is up the only page is the lobby,
   * and browsing there would leave the meeting on the way in.
   */
  async browse(command: BrowserCommand): Promise<BrowserResult> {
    if (!this.isActive) return { success: false, message: 'I am not in a meeting right now.' };
    if (this.state !== 'in_call' || !this.browser) {
      return {
        success: false,
        message:
          this.state === 'leaving'
            ? 'I am leaving the call, so the browser is being closed.'
            : 'I am still getting into the call — ask me again once I am in.',
      };
    }

    this.browserCommands += 1;
    const browser = this.browser;
    // Queued with the share flow: both move which tab is in front, and the model can
    // call them at the same time.
    return this.onFrontQueue(async () => {
      try {
        const result = await this.runBrowseCommand(browser, command);
        // Every answer lists the tabs, so the model always knows what it can switch to
        // and which tab the room is seeing.
        return { ...result, tabs: await summarizeTabs(browser.listTabs(), browser.front()) };
      } catch (err) {
        logger.error({ err }, '[Meeting] Browser command failed');
        return { success: false, message: 'I could not reach the browser.' };
      }
    });
  }

  /**
   * Pick the tab, then run the command on it.
   *
   * The three tab commands are answered here rather than in `browser-control.ts`,
   * because the set of tabs belongs to the browser and not to any one page.
   */
  private async runBrowseCommand(
    browser: BrowserStack,
    command: BrowserCommand,
  ): Promise<BrowserResult> {
    switch (command.action) {
      case 'new_tab': {
        // The address is checked before the tab exists. Opening first would put a blank
        // tab in front of the room, and the answer would explain the address rather
        // than the empty screen everybody is now looking at.
        if (command.url && !normalizeUrl(command.url)) {
          return { success: false, message: `"${command.url}" is not a web address I can open.` };
        }

        const page = await browser.openTab();
        if (command.url) return runBrowserCommand(page, { action: 'navigate', url: command.url });
        return { success: true, message: 'Opened a new tab.', ...(await read(page)) };
      }

      case 'switch_tab': {
        // Compared against `undefined` rather than tested for truth, so that tab 0 —
        // a number the model can produce and no tab ever has — is refused as the wrong
        // number instead of acting on the tab it is already in.
        const page = command.tab === undefined ? null : await browser.selectTab(command.tab - 1);
        if (!page) {
          return { success: false, message: `There is no tab ${command.tab ?? 'of that number'}.` };
        }
        return { success: true, message: `Switched to tab ${command.tab}.`, ...(await read(page)) };
      }

      case 'close_tab': {
        const tabs = browser.listTabs();
        const index =
          command.tab === undefined ? tabs.indexOf(browser.front() as Page) : command.tab - 1;
        if (index < 0 || !(await browser.closeTab(index))) {
          return { success: false, message: 'There is no such tab to close.' };
        }

        const page = browser.front();
        if (!page || page === this.page) {
          return { success: true, message: 'Closed the last tab. Nothing is open now.' };
        }
        return { success: true, message: 'Closed the tab.', ...(await read(page)) };
      }

      default:
        return runBrowserCommand(await browser.workbench(), command);
    }
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
   * One channel out of a call beside speech: it hands over what a spoken sentence mangles
   * — a link, an id, a command to paste — and nothing else. Reading the chat back is a
   * separate act, done only when somebody asks; see `readChatMessages`.
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
    const elapsed = Date.now() - startedAt;

    // Built by hand rather than spread from the report: the report holds the length, and
    // the body must not be one field name away from a telemetry property.
    trackEvent('meeting chat sent', userId, {
      provider: this.provider?.name ?? 'none',
      status: report.status,
      length: String(report.length),
      duration_ms: String(elapsed),
      ...(report.step ? { fail_step: report.step } : {}),
    });

    // Every send writes one line, and the message itself is in none of them. The body is
    // the agent's half of an unauthenticated conversation, and the log outlives the call,
    // so there is no setting that puts it there: the status, the length, the duration and
    // the step it stopped at answer "did that message go out" on their own. A send that
    // failed is silence in a room with no other symptom, so it warns; a send that worked
    // is pure diagnostics, so it debugs.
    //
    // One `elapsed`, shared with the telemetry above: two readings of the clock would put
    // a different duration in the log than in the metric, for the same send.
    const line =
      `[Meeting:Chat] ${report.status} chars=${report.length} ${elapsed}ms` +
      (report.step ? ` step=${report.step}` : '');
    if (report.sent) logger.debug(line);
    else logger.warn(line);

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
        // Reachable from an ordinary chat turn and from a scheduled run, not only from
        // inside a call, so it says what is missing and what fixes it.
        message:
          `I'm not in a call, so there's no meeting chat to post into. ` +
          `Nothing was posted — join a call first.`,
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
    if (this.chatPanelBusy) {
      return {
        sent: false,
        status: 'busy',
        length,
        message: `I'm still posting the previous message. Ask me again in a moment.`,
      };
    }

    // Read before the flag goes up, and re-checked in the `finally`: the send can outlive
    // the call it belongs to. A `leave()` while it is typing resets the flag, a `join()`
    // takes the service back, and this send's `finally` would then clear the *new* call's
    // flag — which is the one thing the flag exists to hold.
    const epoch = this.epoch;
    this.chatPanelBusy = true;
    try {
      const result = await withTimeout(
        provider.sendChatMessage(page, message),
        CHAT_SEND_TIMEOUT_MS,
      );
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
      // A page that closed under the send, or the deadline above. Reported rather than
      // thrown, because the caller is a tool and the room is still waiting.
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
      if (this.epoch === epoch) this.chatPanelBusy = false;
    }
  }

  /**
   * Read the newest messages in the call's own chat, on request.
   *
   * A pull, and only a pull: somebody in the room asks the agent to look, and it looks
   * once. Nothing polls the panel, nothing remembers what a previous read saw, and the
   * agent never speaks about a message nobody asked about.
   *
   * **In-call only.** The text never reaches a thread, a channel adapter or the
   * conversation database — it goes to the model that asked and nowhere else. A reading over
   * the adapter's cap is saved whole to the tool-output store, as any long tool result is,
   * and the hourly sweep deletes it there; that is the one copy a call leaves behind. Apart
   * from it the only trace after the call is a count and a duration in telemetry. The tool
   * runs in meeting mode alone for the same reason: a chat turn persists its tool results as
   * history, which would file a third party's words into the database for good.
   *
   * **Each message is named and fenced.** A line says who the call shows as the sender and
   * what they typed, and the closing marker is stripped from every message, so nobody can
   * end the fence early.
   *
   * The one emitter for `meeting chat read`, at every outcome including the refusals.
   */
  async readChatMessages(userId: string): Promise<ChatReadOutcome> {
    const startedAt = Date.now();
    const report = await this.attemptChatRead();
    const elapsed = Date.now() - startedAt;

    // Built by hand, as the send's is: counts and an outcome, and no field that could
    // carry a word anybody typed.
    trackEvent('meeting chat read', userId, {
      provider: this.provider?.name ?? 'none',
      status: report.status,
      count: String(report.count),
      chars: String(report.chars),
      duration_ms: String(elapsed),
      ...(report.step ? { fail_step: report.step } : {}),
    });

    // One line per read, and no message text in it at any level. The chat is other
    // people's words and the log outlives the call, so there is no setting that puts them
    // there: the outcome, the counts, the duration and the step answer "could it see the
    // chat" on their own. A read that failed is the agent going quiet about something it
    // was asked for, so it warns.
    const line =
      `[Meeting:ChatRead] ${report.status} count=${report.count} chars=${report.chars} ${elapsed}ms` +
      (report.step ? ` step=${report.step}` : '');
    if (report.success) logger.debug(line);
    else logger.warn(line);

    return { success: report.success, message: report.message, incomplete: report.incomplete };
  }

  /**
   * Decide whether this read can run, and drive it if it can.
   *
   * Split from `readChatMessages` for the reason `attemptChatSend` is: every path,
   * refusals included, leaves by one route that reports it.
   */
  private async attemptChatRead(): Promise<ChatReadReport> {
    const provider = this.provider;
    const page = this.page;
    const blank = { count: 0, chars: 0, incomplete: false };

    if (this.state !== 'in_call' || !page || !provider) {
      return {
        success: false,
        status: 'not_in_call',
        ...blank,
        // Reachable from a voice chat with no call in it, so it says what is missing.
        message: `I'm not in a call, so there's no meeting chat to read.`,
      };
    }
    if (!provider.readChatMessages) {
      return {
        success: false,
        status: 'unsupported',
        ...blank,
        message: `I can't read the chat of a ${provider.displayName} call. Ask me out loud.`,
      };
    }
    if (this.chatPanelBusy) {
      return {
        success: false,
        status: 'busy',
        ...blank,
        message: `I'm still working in the chat panel. Ask me again in a moment.`,
      };
    }

    // Read before the flag goes up and re-checked in the `finally`, as the send does: a
    // read can outlive the call it belongs to, and clearing the next call's flag is the
    // one thing this flag exists to hold.
    const epoch = this.epoch;
    this.chatPanelBusy = true;
    try {
      const result = await withTimeout(
        provider.readChatMessages(page, {
          limit: MEETING_CHAT_READ_LIMIT,
          maxCharsPerMessage: CHAT_READ_MAX_CHARS_PER_MESSAGE,
        }),
        CHAT_READ_TIMEOUT_MS,
      );
      if (!result.read) {
        // The reason is page prose, so it goes to the model and to the log line's `step=`,
        // never to telemetry. It never says the chat was empty.
        return {
          success: false,
          status: 'failed',
          step: result.step,
          ...blank,
          message:
            `I couldn't read the call's chat (${result.reason}). ` +
            `I don't know whether anyone typed anything — ask me out loud.`,
        };
      }
      if (result.messages.length === 0) {
        return {
          success: true,
          status: 'empty',
          ...blank,
          message: `Nobody has typed anything in the call's chat.`,
        };
      }
      return fenceChatMessages(result.messages, result.truncated);
    } catch {
      // A page that closed under the read, or the deadline above. The error is not quoted:
      // an exception from a page carries page text, and none of a call's chat belongs in a
      // message the runtime assembles.
      return {
        success: false,
        status: 'failed',
        ...blank,
        message: `I couldn't read the call's chat — the page didn't answer. Ask me out loud.`,
      };
    } finally {
      if (this.epoch === epoch) this.chatPanelBusy = false;
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
        // What the agent did with the browser it was given: whether it ever presented,
        // and how many browser commands it ran. Counted here rather than emitted per
        // action, because a click is a step and not a lifecycle.
        screen_shared: String(this.sharedScreen),
        browser_commands: String(this.browserCommands),
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
    // Nothing has been read yet, nobody has been told anything, and the next call wants to
    // be heard — a mute one agent chose is not a standing instruction for the next call.
    this.isMicLive = null;
    this.micDesired = true;
    this.hasMicBeenOn = false;
    this.micMuteReported = false;
    this.micClick = Promise.resolve();
    // The browser is closed with the call, so the next one starts presenting nothing.
    this.sharingScreen = false;
    this.sharedScreen = false;
    this.browserCommands = 0;
    // A queue belonging to a browser that is gone. Anything still on it works on a
    // closed page, fails, and would otherwise hold the next call's commands behind it.
    this.frontTail = Promise.resolve();
    // A poll still in flight belongs to the call being torn down; its own epoch check
    // stops it acting, but leaving this set would deadlock the next call's polling.
    this.pollInFlight = false;
    this.speakerPollInFlight = false;
    // Meet opens every call with its participants panel shut, so the next call starts out
    // unattributed and has to open it again.
    this.speakerSeen = false;
    // Same reasoning: a send or a read left mid-flight here would refuse every one in the
    // next call, and it reaches nothing in it — the page it was driving is gone.
    this.chatPanelBusy = false;
    this.failStep = null;
    // Free only when nothing is still being built. A startup abandoned mid-sign-in
    // still holds the shared browser profile, and the next `join()` would clear its
    // live lock and open a second Chromium on it — see `startupEpoch`. It flips this
    // to `idle` itself once it has let go.
    this.state = this.startupEpoch === null ? 'idle' : 'leaving';
    if (this.state === 'idle') voiceSessionLock.release('meeting');
  }

  /** Build the model's session instructions, naming the platform the room is on. */
  private async buildInstructions(input: JoinMeetingInput): Promise<VoiceInstructions> {
    return buildVoiceInstructions({
      userId: input.userId,
      agentId: input.agentId,
      call: { kind: 'meeting', platform: this.provider?.displayName ?? 'video call' },
      responseMode: this.responseMode,
    });
  }

  /** Called from the process shutdown path so a container exit leaves the call. */
  async shutdown(): Promise<void> {
    if (!this.isActive) return;
    logger.info('[Meeting] Shutting down — leaving the active call');
    await this.teardown('completed');
  }
}

export const meetingBotService = new MeetingBotService();
