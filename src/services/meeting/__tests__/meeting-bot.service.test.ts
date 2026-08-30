/**
 * Lifecycle tests for the meeting service.
 *
 * The thing worth testing here is not the happy path but the exits: every ending
 * has to release an X server, an audio daemon, a browser and a WebSocket, and a
 * join that finishes *after* the call was torn down must not resurrect it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Annotated below rather than inferred so the shape is stated where it is built.
// Note it does not *enforce* the shape: `tsconfig.json` excludes `*.test.ts`, so
// `tsc` never sees this file — a field added to the real stats has to be added here
// by hand or the telemetry assertions quietly read a default.
import type { VoiceConversationStats } from '../voice-conversation';

const audioStop = vi.fn();
const audioStart = vi.fn();
/**
 * The handler the service registered for a dead capture or playback process.
 *
 * Same seam as `onSessionLost` below, for the other half of the audio path: a test
 * fires it the way `parec` exiting would.
 */
let audioLostHandler: ((reason: string) => void) | null = null;
/**
 * Whether the browser opened the virtual microphone, as PulseAudio would report it.
 *
 * A mock rather than the real reading, which needs a daemon — see
 * `audio-stack.test.ts` for the parsing this stands in for. What is worth testing
 * here is the decision the answer drives: a call the agent cannot be heard in is
 * left, not settled into.
 */
const audioWaitForMicCapture = vi.fn();
/**
 * The same question as `waitForMicCapture`, asked once and quietly.
 *
 * Separate because the mid-call retry has to re-check *this* half too: the join reads
 * the meeting's toggle and the capture device independently, and re-reading only the
 * one that never broke is how a retry declares a recovery that did not happen.
 */
const audioIsMicCaptured = vi.fn();
class FakeAudioStack {
  start = audioStart;
  stop = audioStop;
  waitForMicCapture = audioWaitForMicCapture;
  isMicCaptured = audioIsMicCaptured;
}
vi.mock('../audio-stack', () => ({
  AudioStack: FakeAudioStack,
  AUDIO_STACK_BINARIES: ['Xvfb'],
}));

const browserStop = vi.fn();
const browserStart = vi.fn();
class FakeBrowserStack {
  start = browserStart;
  stop = browserStop;
}
vi.mock('../browser-stack', () => ({ BrowserStack: FakeBrowserStack }));

const conversationStop = vi.fn();
const conversationStart = vi.fn();
const conversationNotify = vi.fn();
const conversationSpeak = vi.fn();
const conversationSetParticipantCount = vi.fn();
const conversationSetCurrentSpeaker = vi.fn();
/**
 * Told whether the room can hear the agent.
 *
 * Only the response policy acts on it (an inaudible agent must not answer every
 * sentence in `open` mode), so what matters here is that the service reports the
 * state honestly and updates it when a retry succeeds.
 */
const conversationSetAudible = vi.fn();
/**
 * The options the service last built a conversation with.
 *
 * Captured for two reasons: a test can fire `onSessionLost` the way the real
 * Realtime socket's close handler would — that callback is the whole seam between
 * a dead session and the service's decision to leave — and the name and mode the
 * service resolved are only observable here.
 */
let conversationOptions: Record<string, unknown> & {
  onSessionLost?: (reason: string) => void;
} = {};
class FakeVoiceConversation {
  constructor(options: Record<string, unknown>) {
    conversationOptions = options;
  }
  start = conversationStart;
  stop = conversationStop;
  notify = conversationNotify;
  speakNow = conversationSpeak;
  setParticipantCount = conversationSetParticipantCount;
  setCurrentSpeaker = conversationSetCurrentSpeaker;
  setAudible = conversationSetAudible;
  pushMeetingAudio = vi.fn();
  get responseMode() {
    return 'addressed';
  }
  get statistics(): VoiceConversationStats {
    return {
      responses: 2,
      toolCalls: 1,
      interruptions: 3,
      utterances: 9,
      suppressed: 6,
      addressedMatches: 2,
      modeSwitches: 1,
      gateCalls: 4,
      gateFailed: 1,
      gateLatencyMs: 3200,
      gateSuperseded: 1,
      responsesFailed: 2,
      attributedUtterances: 3,
      unattributedUtterances: 1,
    };
  }
}
vi.mock('../voice-conversation', () => ({ VoiceConversation: FakeVoiceConversation }));

// Implementations are assigned in beforeEach, not here: the suite runs with
// `mockReset: true`, which wipes anything a vi.mock factory set up.
const prepareMeetingTools = vi.fn();
vi.mock('../tool-bridge', () => ({
  prepareMeetingTools: (...a: unknown[]) => prepareMeetingTools(...a),
}));

const getAgentContext = vi.fn();
vi.mock('../../context.service', () => ({
  contextService: { getAgentContext: (...a: unknown[]) => getAgentContext(...a) },
}));

const buildSystemPromptParts = vi.fn();
vi.mock('../../../prompts/context-builder', () => ({
  buildSystemPromptParts: (...a: unknown[]) => buildSystemPromptParts(...a),
}));

/**
 * Kept mocked although the service no longer imports it.
 *
 * Nothing about a call is published to a conversation thread. These spies are how
 * that is asserted: without them, a status note coming back would go unnoticed.
 */
const publish = vi.fn();
const publishToLatestThread = vi.fn();
vi.mock('../../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: (...a: unknown[]) => publish(...a),
    publishToLatestThread: (...a: unknown[]) => publishToLatestThread(...a),
  },
}));

/**
 * The log is where a meeting outcome lands, so for several branches it is the whole
 * observable behaviour and has to be asserted on directly.
 */
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const loggerDebug = vi.fn();
vi.mock('../../../logger', () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: (...a: unknown[]) => loggerError(...a),
    debug: (...a: unknown[]) => loggerDebug(...a),
  },
}));

/** The same four spies keyed by level, for the assertions that read one level at a time. */
const logged = { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: loggerDebug };

const trackEvent = vi.fn();
vi.mock('../../../lib/telemetry', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

const providerJoin = vi.fn();
const providerConfigurationError = vi.fn(() => null as string | null);
const providerSignIn = vi.fn(async () => {});
const providerLeave = vi.fn();
const providerParticipantCount = vi.fn();
const providerSetMicrophone = vi.fn();
const providerMicrophoneLive = vi.fn();
const providerEnableAttribution = vi.fn();
const providerParticipantNames = vi.fn();
const providerCurrentSpeaker = vi.fn();
const providerSendChatMessage = vi.fn();
/**
 * Whether this platform offers a chat the runtime can post into.
 *
 * A getter rather than a field, so one test can take the method away: the seam is
 * optional, and "no chat panel" has to be answerable without a second mocked module.
 */
let chatSupported = true;
vi.mock('../providers/google-meet', () => ({
  googleMeetProvider: {
    name: 'google-meet',
    displayName: 'Google Meet',
    matchesUrl: (url: string) => url.startsWith('https://meet.google.com/'),
    configurationError: (...a: unknown[]) => providerConfigurationError(...a),
    signIn: (...a: unknown[]) => providerSignIn(...a),
    join: (...a: unknown[]) => providerJoin(...a),
    leave: (...a: unknown[]) => providerLeave(...a),
    participantCount: (...a: unknown[]) => providerParticipantCount(...a),
    setMicrophone: (...a: unknown[]) => providerSetMicrophone(...a),
    microphoneLive: (...a: unknown[]) => providerMicrophoneLive(...a),
    participantNames: (...a: unknown[]) => providerParticipantNames(...a),
    enableSpeakerAttribution: (...a: unknown[]) => providerEnableAttribution(...a),
    currentSpeaker: (...a: unknown[]) => providerCurrentSpeaker(...a),
    get sendChatMessage() {
      return chatSupported ? (...a: unknown[]) => providerSendChatMessage(...a) : undefined;
    },
  },
}));

vi.mock('../../../config', () => ({
  config: {
    agentName: 'Prism',
    googleBotEmail: 'bot@example.com',
    googleBotPassword: 'hunter2',
    meetingTimeoutMinutes: 60,
    meetingAdmissionTimeoutMs: 5_000,
    openaiRealtimeVoice: undefined,
  },
}));

const { MeetingBotService, MEETING_CHAT_MAX_CHARS } = await import('../meeting-bot.service');

const URL = 'https://meet.google.com/abc-defg-hij';
const input = { url: URL, userId: 'u1', agentId: 'a1', threadId: 't1' };

let service: InstanceType<typeof MeetingBotService>;

beforeEach(() => {
  vi.clearAllMocks();
  audioLostHandler = null;
  audioStart.mockResolvedValue({
    browserEnv: { DISPLAY: ':99' },
    onCapture: vi.fn(),
    onLost: (handler: (reason: string) => void) => {
      audioLostHandler = handler;
    },
    playbackSink: { write: vi.fn() },
  });
  audioStop.mockResolvedValue(undefined);
  audioWaitForMicCapture.mockResolvedValue(true);
  audioIsMicCaptured.mockResolvedValue(true);
  browserStart.mockResolvedValue({ mockPage: true });
  browserStop.mockResolvedValue(undefined);
  conversationStart.mockResolvedValue(undefined);
  prepareMeetingTools.mockResolvedValue({ declarations: [], count: 0, execute: vi.fn() });
  getAgentContext.mockResolvedValue({ agentName: 'Prism', soulMd: '', userMd: '' });
  buildSystemPromptParts.mockResolvedValue([{ text: '# Identity', cacheable: true }]);
  publish.mockResolvedValue(undefined);
  publishToLatestThread.mockResolvedValue(undefined);
  providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
  providerLeave.mockResolvedValue(undefined);
  providerEnableAttribution.mockResolvedValue(undefined);
  providerParticipantNames.mockResolvedValue([]);
  providerCurrentSpeaker.mockResolvedValue(null);
  providerParticipantCount.mockResolvedValue(3);
  providerSetMicrophone.mockResolvedValue(false);
  providerSendChatMessage.mockResolvedValue({ sent: true });
  chatSupported = true;
  // Live by default. Any other default would have every existing test that advances the
  // clock read a mute the call never had, and report it.
  providerMicrophoneLive.mockResolvedValue(true);
  conversationOptions = {};
  service = new MeetingBotService();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the fire-and-forget join flow settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Every line a logger mock was handed, as one searchable list. */
const loggedLines = (...mocks: Array<ReturnType<typeof vi.fn>>): string[] =>
  mocks.flatMap((mock) => mock.mock.calls.map((call) => call.map(String).join(' ')));

/** Assert one of the logger mocks was handed a line matching `pattern`. */
const expectLogged = (mock: ReturnType<typeof vi.fn>, pattern: RegExp): void => {
  expect(loggedLines(mock).some((line) => pattern.test(line))).toBe(true);
};

/** Assert no thread anywhere was given a message about the call. */
const expectNothingPublished = (): void => {
  expect(publish).not.toHaveBeenCalled();
  expect(publishToLatestThread).not.toHaveBeenCalled();
};

describe('a platform that will not take an unauthenticated bot', () => {
  it('says so instead of building a call to be refused', async () => {
    // Meet denies an automated anonymous guest before a host is prompted, so this
    // join cannot succeed — and finding that out in the lobby costs a virtual
    // display, an audio daemon, a browser and a metered Realtime socket first. The
    // provider answers, so this file no longer knows what a Google account is.
    providerConfigurationError.mockReturnValueOnce('Set GOOGLE_BOT_EMAIL and GOOGLE_BOT_PASSWORD.');

    const result = await service.join(input);

    expect(result.state).toBe('idle');
    expect(result.message).toMatch(/GOOGLE_BOT_EMAIL/);
    // Nothing was started, and nothing to tear down.
    expect(providerJoin).not.toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });
});

describe('joining', () => {
  it('returns before admission, then reports being in the call', async () => {
    // A guest can wait minutes for a host; the chat turn must not block on it.
    let admit: (v: unknown) => void = () => {};
    providerJoin.mockReturnValue(new Promise((r) => { admit = r; }));

    const result = await service.join(input);
    expect(result.state).toBe('waiting_admission');
    expect(result.message).toMatch(/host needs to admit me/i);
    expect(service.status().state).toBe('waiting_admission');

    admit({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    await settle();

    expect(service.status().state).toBe('in_call');
    // Logged for an engineer, and told to nobody: the room hears the greeting, and the
    // person who asked reads `status()` if they want to know.
    expectLogged(loggerInfo, /Admitted to the Google Meet call, and audible to the room/);
    expectNothingPublished();
  });

  it('introduces itself once admitted so the room is not joined in silence', async () => {
    await service.join(input);
    await settle();

    expect(conversationNotify).toHaveBeenCalledWith(expect.stringMatching(/just been admitted/i));
    expect(conversationSpeak).toHaveBeenCalled();
  });

  it('refuses a second call rather than dropping the first', async () => {
    await service.join(input);
    await settle();

    const second = await service.join({ ...input, url: 'https://meet.google.com/xyz' });
    expect(second.message).toMatch(/already in a/i);
    // The first call is untouched.
    expect(service.status().state).toBe('in_call');
    expect(browserStop).not.toHaveBeenCalled();
  });

  it('rejects an unsupported link without starting anything', async () => {
    const result = await service.join({ ...input, url: 'https://zoom.us/j/1' });

    expect(result.state).toBe('idle');
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('signs in before it asks to join, and before the cancellation check', async () => {
    // A login takes 20-45s. Run after the epoch check, a leave() during it would
    // skip the browser and audio release; run after the join, it would be useless.
    await service.join(input);

    expect(providerSignIn).toHaveBeenCalledTimes(1);
    expect(providerSignIn.mock.invocationCallOrder[0]).toBeLessThan(
      providerJoin.mock.invocationCallOrder[0],
    );
  });

  it('joins without a display name — the room sees the account it signed in as', async () => {
    await service.join(input);

    const [, options] = providerJoin.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty('displayName');
    expect(options).toMatchObject({ url: input.url });
  });
});

describe('a session the platform will not accept', () => {
  it('signs in again with force, then retries the link once', async () => {
    // `force` is the whole point. The provider's own "am I signed in?" probe is what
    // got this wrong — a profile whose account page loads happily is still handed a
    // guest field — so a retry that re-probes would reuse the same dead session and
    // fail identically.
    providerJoin
      .mockResolvedValueOnce({ status: 'reauth_required' })
      .mockResolvedValueOnce({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });

    await service.join(input);
    await settle();

    expect(providerSignIn).toHaveBeenCalledTimes(2);
    expect(providerSignIn).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    expect(providerJoin).toHaveBeenCalledTimes(2);
    expect(service.status().state).toBe('in_call');
  });

  it('gives up after one retry rather than hammering the login', async () => {
    // A second failure is a real problem — a challenged account, a changed password
    // — and retrying it in a loop would drive repeated logins with credentials that
    // have just been refused.
    providerJoin.mockResolvedValue({ status: 'reauth_required' });

    await service.join(input);
    await settle();

    expect(providerJoin).toHaveBeenCalledTimes(2);
    expect(service.status().state).toBe('idle');
    // The log names the session as the cause, which is what tells an engineer to look
    // at the account rather than at the meeting link.
    expectLogged(loggerWarn, /signing in again did not help.*treats this browser as a guest/s);
    expectNothingPublished();
  });
});

describe('a call the room cannot hear the agent in', () => {
  /**
   * Two independent readings, and either one failing means the same thing.
   *
   * The provider's unmute is the meeting's word for it; `waitForMicCapture` is the
   * browser's. They come from different systems and can disagree — Meet's toggle can
   * read live over a capture device Chromium never opened — so neither answers alone.
   *
   * What the agent does about it is the interesting part, and it is *not* to leave. The
   * room's audio arrives on `meet_out.monitor`, which has nothing to do with the
   * microphone, so an inaudible agent is still listening and still holds its whole tool
   * surface. Leaving would discard that to avoid one of its failure modes — and both of
   * these readings are unvalidated enough to produce false alarms, which would then cost
   * a meeting each. So: stay, and make sure somebody knows.
   */
  it('stays in the call when the browser never opened the microphone', async () => {
    audioWaitForMicCapture.mockResolvedValue(false);

    await service.join(input);
    await settle();

    expect(service.status().state).toBe('in_call');
    expect(audioStop).not.toHaveBeenCalled();
    expect(browserStop).not.toHaveBeenCalled();
  });

  it('stays in the call when the meeting never confirmed the unmute', async () => {
    // The other half, reported by the provider rather than read from PulseAudio. Same
    // conclusion, so it must not matter which one noticed.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });

    await service.join(input);
    await settle();

    expect(service.status().state).toBe('in_call');
  });

  it('warns, and says which half failed', async () => {
    // The whole point of not leaving is that the failure is still on the record. A line
    // that just said "in the call" would put this back where it started.
    audioWaitForMicCapture.mockResolvedValue(false);

    await service.join(input);
    await settle();

    // Both readings, because the two send an engineer to different places: the
    // platform's own control, or the container's audio devices. Here the platform
    // reported the unmute and the capture device never opened.
    expectLogged(
      loggerWarn,
      /not audibly \(mic control confirmed: true, capture device open: false\)/,
    );
    expectNothingPublished();
  });

  it('names the platform through the provider rather than hard-coding it', async () => {
    // This service has no idea which platform it is on — that is the whole point of
    // `MeetingProvider`. A Teams call logged in terms of Meet would be a small lie in
    // the one line somebody reads when something is wrong.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });

    await service.join(input);
    await settle();

    // "Google Meet" is what the mocked provider declares as its `displayName`, and the
    // service has no other source for it — so finding the full name here is what shows
    // the line was built from the provider rather than typed in.
    expectLogged(loggerWarn, /Admitted to the Google Meet call but not audibly/);
  });

  it('does not greet a room that cannot hear it, and tells the model why', async () => {
    // Greeting here spends Realtime tokens on audio nobody receives and leaves the model
    // believing it introduced itself — so the model is told the standing condition
    // instead, which also stops it answering the next question into the void.
    audioWaitForMicCapture.mockResolvedValue(false);

    await service.join(input);
    await settle();

    expect(conversationSpeak).not.toHaveBeenCalled();
    expect(conversationNotify).not.toHaveBeenCalledWith(expect.stringMatching(/just been admitted/i));
    expect(conversationNotify).toHaveBeenCalledWith(expect.stringMatching(/may not hear you/i));
    // Pointed at the one control it should touch, and stopped at the audio stack below it:
    // the meeting toolset includes the shell, PulseAudio is running in this container, and a
    // model that decides to fix its own microphone can kill the daemon carrying the call.
    expect(conversationNotify).toHaveBeenCalledWith(
      expect.stringMatching(/set_microphone with on: true is yours/i),
    );
    expect(conversationNotify).toHaveBeenCalledWith(
      expect.stringMatching(/not something to repair from in here/i),
    );
  });

  it('keeps trying the unmute, and greets the room once it lands', async () => {
    // The whole reason staying is defensible: this is what a human does when they
    // notice the mute icon. One unlucky moment during admission — a dialog that
    // outlived the sweep, a control bar mid-paint — should cost a poll interval, not
    // the meeting. The greeting waits for this rather than being skipped outright, so
    // a recovered call is introduced properly instead of joining mid-conversation.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      expect(conversationSpeak).not.toHaveBeenCalled();

      providerSetMicrophone.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(conversationNotify).toHaveBeenCalledWith(expect.stringMatching(/just been admitted/i));
      expect(conversationSpeak).toHaveBeenCalled();
      expect(conversationSetAudible).toHaveBeenCalledWith(true);
      // The recovery is on the record too, and named through the provider like the
      // failure that preceded it.
      expectLogged(
        loggerInfo,
        /Microphone is live after a mid-call retry — audible in the Google Meet call now/,
      );
      expectNothingPublished();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call itself recovered on the strength of the half that never broke', async () => {
    // The join reads two independent things: Meet's toggle, and whether Chromium opened
    // the capture device. Here the toggle was live all along and the device never opened
    // — the `parec`/`/dev/shm` failure. A retry that only re-reads the toggle finds it
    // live, and would declare victory on evidence it already had: silencing the warning,
    // disarming the retry, restoring `open` mode and greeting a room that still hears
    // nothing. The one recovery that must be verified is the one that was broken.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    audioWaitForMicCapture.mockResolvedValue(false);
    audioIsMicCaptured.mockResolvedValue(false);
    providerSetMicrophone.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(conversationSpeak).not.toHaveBeenCalled();
      expect(conversationSetAudible).not.toHaveBeenCalledWith(true);
      // Nothing claimed a recovery, in the log or anywhere else.
      expect(loggedLines(loggerInfo).some((l) => /Microphone is live/.test(l))).toBe(false);
      // And it kept asking, rather than settling into a call it cannot be heard in.
      expect(providerSetMicrophone.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when the capture device is what comes up late', async () => {
    // The same shape, resolved: the device opens a few seconds after the toggle did.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    audioWaitForMicCapture.mockResolvedValue(false);
    audioIsMicCaptured.mockResolvedValue(false);
    providerSetMicrophone.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      audioIsMicCaptured.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(conversationSetAudible).toHaveBeenCalledWith(true);
      expect(conversationSpeak).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run two unmute retries at once', async () => {
    // `setInterval` re-fires on the wall clock, not on the last callback finishing, so a
    // retry slower than the interval can overlap the next one. On a *toggle* that is not
    // a wasted call, it is one tick switching on what the next switches off.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
    let inFlight = 0;
    let overlapped = false;
    providerSetMicrophone.mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      // Longer than the 10s poll interval, which is the condition that produces the race
      // — a dialog sweep on a stuck control is exactly this slow.
      await new Promise((r) => setTimeout(r, 25_000));
      inFlight -= 1;
      return false;
    });
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(overlapped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops clicking once the room can hear it, and reads from then on', async () => {
    // A toggle toggles, so a retry that keeps firing after it has succeeded is not
    // harmless persistence — the next click would mute what the last one fixed. The poll
    // does not go quiet, though: it changes job, from fixing the microphone to watching it.
    audioWaitForMicCapture.mockResolvedValue(false);
    providerSetMicrophone.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(providerSetMicrophone).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(providerSetMicrophone).toHaveBeenCalledTimes(1);
      expect(providerMicrophoneLive.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads rather than clicks in a call it is already audible in', async () => {
    // The common case: the join confirmed the microphone, so the poll has no business
    // clicking at the control bar every ten seconds. It reads it instead.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(providerSetMicrophone).not.toHaveBeenCalled();
      expect(providerMicrophoneLive.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(service.status().micLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports the join, tagged as inaudible', async () => {
    // `meeting joined` fires — the agent is in the call — but carrying the fact that
    // nothing it says will arrive. That pair is the measurement the original bug hid.
    audioWaitForMicCapture.mockResolvedValue(false);

    await service.join(input);
    await settle();

    expect(trackEvent).toHaveBeenCalledWith(
      'meeting joined',
      'u1',
      expect.objectContaining({ mic_confirmed: 'false' }),
    );
  });
});

/**
 * What the agent is told about its own microphone, mid-call.
 *
 * The agent cannot hear itself: the room's audio arrives on a different device from the one
 * it speaks into, so a mute is invisible from the inside. Every test here is about closing
 * that gap without lying in either direction.
 */
describe('the microphone the agent can see', () => {
  it('reports the join reading straight away rather than waiting for a poll', async () => {
    // Three readings, all from the outcome the provider already returned: confirmed is
    // live, an auto-mute it could not undo is muted, and an unconfirmed join with no
    // auto-mute is the control it could not read. A page read here would answer the same
    // question ten seconds early and leave a healthy call reading `null` in the meantime.
    const cases = [
      { outcome: { mutedOnEntry: false, micConfirmed: true }, capturing: true, expected: true },
      { outcome: { mutedOnEntry: true, micConfirmed: false }, capturing: true, expected: false },
      { outcome: { mutedOnEntry: false, micConfirmed: false }, capturing: true, expected: null },
      // The fourth reading, and the one worth the field: a live toggle over a capture device
      // Chromium never opened. Reported as live, this is the silent call that used to look
      // perfectly healthy from every angle the agent could see.
      { outcome: { mutedOnEntry: false, micConfirmed: true }, capturing: false, expected: false },
    ] as const;

    for (const { outcome, capturing, expected } of cases) {
      providerJoin.mockResolvedValue({ status: 'admitted', ...outcome });
      audioWaitForMicCapture.mockResolvedValue(capturing);
      await service.join(input);
      await settle();

      expect(service.status().micLive).toBe(expected);

      await service.leave();
      await settle();
    }
  });

  it('tells the agent when the call mutes it mid-way', async () => {
    // The notice the whole feature exists for. The model is told in band because it is the
    // one party that cannot tell, and the log carries the same transition for an engineer.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      expect(service.status().micLive).toBe(true);

      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(service.status().micLive).toBe(false);
      // Reported, not fought. Undoing a mute the agent did not ask for is the agent's
      // decision to make, so the poll clicks nothing here.
      expect(providerSetMicrophone).not.toHaveBeenCalled();
      expect(conversationNotify).toHaveBeenCalledWith(
        expect.stringMatching(/microphone has just been muted/i),
      );
      expectLogged(loggerWarn, /muted mid-call and nobody here asked for it/);
      expectNothingPublished();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it once per transition, not once per poll', async () => {
    // A mute that lasts a minute is one piece of news. Repeating it every ten seconds would
    // interrupt the agent six times over one fact, in a live call.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(40_000);

      const muteNotices = conversationNotify.mock.calls.filter(([text]) =>
        /has just been muted/i.test(String(text)),
      );
      expect(muteNotices).toHaveLength(1);

      providerMicrophoneLive.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(service.status().micLive).toBe(true);
      const backNotices = conversationNotify.mock.calls.filter(([text]) =>
        /microphone is on again/i.test(String(text)),
      );
      expect(backNotices).toHaveLength(1);
      expectLogged(loggerInfo, /The microphone is live again/);
      expectNothingPublished();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unreadable control as unreadable, and says nothing about it', async () => {
    // A reading nobody took is not a mute. Reported as one it would interrupt a healthy
    // call every time a scraped attribute flickered; reported as live it would hide the
    // failure this whole field exists to surface. So `null` reaches the agent through
    // `meeting_status` and nowhere else.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      providerMicrophoneLive.mockResolvedValue(null);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(service.status().micLive).toBeNull();
      expect(conversationNotify).not.toHaveBeenCalledWith(
        expect.stringMatching(/muted|microphone is on again/i),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count an unreadable moment as the mute ending', async () => {
    // Muted, unreadable, muted again is one mute. Tracking the transition off `micLive`
    // alone would call the middle reading a recovery and the third a fresh mute.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_000);
      providerMicrophoneLive.mockResolvedValue(null);
      await vi.advanceTimersByTimeAsync(10_000);
      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_000);

      const muteNotices = conversationNotify.mock.calls.filter(([text]) =>
        /has just been muted/i.test(String(text)),
      );
      expect(muteNotices).toHaveLength(1);
      expect(conversationNotify).not.toHaveBeenCalledWith(
        expect.stringMatching(/microphone is on again/i),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last reading when the read itself fails', async () => {
    // A page closing under the read is not a reading. Turning the rejection into `false`
    // would announce a mute on a teardown, and into `true` would announce a recovery on
    // one, so the field keeps what it last knew and the next poll asks again.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      expect(service.status().micLive).toBe(true);

      providerMicrophoneLive.mockRejectedValue(new Error('Target closed'));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(service.status().micLive).toBe(true);
      expect(conversationNotify).not.toHaveBeenCalledWith(expect.stringMatching(/muted/i));
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the mute when the call ends', async () => {
    // A muted reading is a fact about one call. Carried over, the next call would start out
    // believing it had already reported a mute, and would stay silent about a real one.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await service.leave();
      await vi.advanceTimersByTimeAsync(10);

      expect(service.status().micLive).toBeNull();

      conversationNotify.mockClear();
      providerMicrophoneLive.mockResolvedValue(true);
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      providerMicrophoneLive.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(conversationNotify).toHaveBeenCalledWith(
        expect.stringMatching(/microphone has just been muted/i),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The microphone as something the agent operates, not only watches.
 *
 * A room that asks the agent to mute is asking the agent, and speech is its only reply
 * unless it can reach the control itself.
 */
describe('the microphone the agent can set', () => {
  it('turns it off and on again at the agent\'s request', async () => {
    providerSetMicrophone.mockResolvedValue(false);
    await service.join(input);
    await settle();

    const off = await service.setMicrophone(false);

    expect(providerSetMicrophone).toHaveBeenCalledWith(expect.anything(), false);
    expect(off.success).toBe(true);
    expect(service.status().micLive).toBe(false);

    providerSetMicrophone.mockResolvedValue(true);
    const on = await service.setMicrophone(true);

    expect(providerSetMicrophone).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(on.success).toBe(true);
    expect(service.status().micLive).toBe(true);
  });

  it('says nothing about a mute the agent chose', async () => {
    // The poll reads the mute four times over forty seconds. An imposed mute is news; the
    // agent's own is not, so the reading has to be told apart from the request behind it.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      providerSetMicrophone.mockResolvedValue(false);
      providerMicrophoneLive.mockResolvedValue(false);
      await service.setMicrophone(false);
      providerSetMicrophone.mockClear();
      await vi.advanceTimersByTimeAsync(40_000);

      expect(providerSetMicrophone).not.toHaveBeenCalled();
      expect(service.status().micLive).toBe(false);
      expect(conversationNotify).not.toHaveBeenCalledWith(
        expect.stringMatching(/has just been muted/i),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call a call audible on the strength of the toggle alone', async () => {
    // Two independent halves, as at the join: the platform's toggle and the audio device
    // under it. Uncovering the first says nothing about the second, and a call whose device
    // never opened is one the room cannot hear however the toggle reads.
    audioWaitForMicCapture.mockResolvedValue(false);
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
    providerSetMicrophone.mockResolvedValue(true);
    await service.join(input);
    await settle();

    const result = await service.setMicrophone(true);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/nothing has yet carried your voice/i);
    expect(service.status().micLive).toBe(false);
  });

  it('does not let the poll call a call audible on the toggle alone either', async () => {
    // The poll reads the toggle rather than clicking it once the agent has asked to be muted,
    // and a mute click that did not take leaves that toggle reading live. Recording the
    // reading as it comes would report a room that hears nothing as one that can hear.
    vi.useFakeTimers();
    try {
      audioWaitForMicCapture.mockResolvedValue(false);
      providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      providerSetMicrophone.mockResolvedValue(true);
      await service.setMicrophone(false);
      providerMicrophoneLive.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerMicrophoneLive).toHaveBeenCalled();
      expect(service.status().micLive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the unmute retry once the agent has asked to be muted', async () => {
    // The retry exists for a mute nobody asked for. A call the agent muted on purpose is
    // not that, and clicking it open again would be the runtime overruling the agent every
    // ten seconds for the rest of the meeting.
    vi.useFakeTimers();
    try {
      audioWaitForMicCapture.mockResolvedValue(false);
      providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
      providerSetMicrophone.mockResolvedValue(false);
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerSetMicrophone).toHaveBeenCalledWith(expect.anything(), true);

      await service.setMicrophone(false);
      providerSetMicrophone.mockClear();
      await vi.advanceTimersByTimeAsync(40_000);

      expect(providerSetMicrophone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the unmute retry for the next call', async () => {
    // A mute belongs to the call it was asked for. Carried over, the next call would join
    // muted and stay muted, because the retry that fixes that reads the previous agreement.
    vi.useFakeTimers();
    try {
      providerSetMicrophone.mockResolvedValue(false);
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await service.setMicrophone(false);
      await service.leave();
      await vi.advanceTimersByTimeAsync(10);

      audioWaitForMicCapture.mockResolvedValue(false);
      providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
      providerSetMicrophone.mockClear();
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerSetMicrophone).toHaveBeenCalledWith(expect.anything(), true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a poll read land on top of a click', async () => {
    // The read and the click both write `micLive`, so the poll takes the same lock. Reading
    // first and writing afterwards would put the state the click replaced back for a whole
    // poll interval, and the agent would speak into a microphone it had just closed.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      let releaseRead = () => {};
      providerMicrophoneLive.mockImplementation(
        async () =>
          new Promise<boolean>((resolve) => {
            releaseRead = () => resolve(true);
          }),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      providerSetMicrophone.mockResolvedValue(false);
      const tool = service.setMicrophone(false);
      await vi.advanceTimersByTimeAsync(10);
      releaseRead();
      await vi.advanceTimersByTimeAsync(10);
      await tool;

      expect(service.status().micLive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a recovery the agent has already overruled', async () => {
    // The retry's click can finish after the agent has asked to be muted. Its tail declares
    // the call audible, restores `open` mode and greets the room out loud, so it has to read
    // the newer request rather than the one that started it.
    vi.useFakeTimers();
    try {
      audioWaitForMicCapture.mockResolvedValue(false);
      providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
      let releaseRetry = () => {};
      providerSetMicrophone.mockImplementationOnce(
        async () =>
          new Promise<boolean>((resolve) => {
            releaseRetry = () => resolve(true);
          }),
      );
      providerSetMicrophone.mockResolvedValue(false);
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10_000);

      const tool = service.setMicrophone(false);
      await vi.advanceTimersByTimeAsync(10);
      releaseRetry();
      await vi.advanceTimersByTimeAsync(10);
      await tool;

      expect(service.status().micLive).toBe(false);
      expect(conversationSetAudible).not.toHaveBeenCalledWith(true);
      expect(conversationNotify).not.toHaveBeenCalledWith(
        expect.stringMatching(/greet the participants/i),
      );
      expectNothingPublished();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the call ending under the click, and writes nothing after it', async () => {
    // The click outlives the call it was made in. Reported as done, it would tell the agent
    // it is muted in a call that no longer exists.
    let releaseClick = () => {};
    providerSetMicrophone.mockImplementation(
      async () =>
        new Promise<boolean>((resolve) => {
          releaseClick = () => resolve(false);
        }),
    );
    await service.join(input);
    await settle();

    const pending = service.setMicrophone(false);
    await service.leave();
    releaseClick();

    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/call ended/i);
    expect(service.status().micLive).toBeNull();
  });

  it('reports a control it could not reach at all', async () => {
    providerSetMicrophone.mockRejectedValue(new Error('page closed'));
    await service.join(input);
    await settle();

    const result = await service.setMicrophone(false);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not reach/i);
  });

  it('reports a control it could not read rather than clicking it blind', async () => {
    // The provider answers `null` and the runtime passes that on as a failure. Reporting it
    // as done is how the agent carries on talking to a room that cannot hear it.
    providerSetMicrophone.mockResolvedValue(null);
    await service.join(input);
    await settle();

    const result = await service.setMicrophone(false);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not read/i);
    expect(service.status().micLive).toBeNull();
  });

  it('reports a click that did not take', async () => {
    providerSetMicrophone.mockResolvedValue(true);
    await service.join(input);
    await settle();

    const result = await service.setMicrophone(false);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still reads live/i);
  });

  it('refuses outside a call, without touching the page', async () => {
    const result = await service.setMicrophone(true);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not in a call/i);
    expect(providerSetMicrophone).not.toHaveBeenCalled();
  });

  it('waits for the poll\'s retry instead of racing it', async () => {
    // Two clicks on one toggle undo each other, so the second caller waits for the first
    // and then reads for itself.
    vi.useFakeTimers();
    try {
      audioWaitForMicCapture.mockResolvedValue(false);
      providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);

      const order: string[] = [];
      let releaseRetry = () => {};
      providerSetMicrophone.mockImplementationOnce(async () => {
        order.push('retry started');
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
        order.push('retry finished');
        return false;
      });
      providerSetMicrophone.mockImplementationOnce(async () => {
        order.push('tool clicked');
        return false;
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const tool = service.setMicrophone(false);
      await vi.advanceTimersByTimeAsync(10);

      expect(order).toEqual(['retry started']);

      releaseRetry();
      await vi.advanceTimersByTimeAsync(10);
      await tool;

      expect(order).toEqual(['retry started', 'retry finished', 'tool clicked']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('release of resources', () => {
  it('releases everything when the audio stack fails to come up', async () => {
    audioStart.mockRejectedValue(new Error('no pulseaudio'));

    const result = await service.join(input);

    expect(result.state).toBe('idle');
    expect(result.message).toMatch(/no pulseaudio/);
    expect(audioStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('releases everything when the Realtime session cannot connect', async () => {
    conversationStart.mockRejectedValue(new Error('401 unauthorized'));

    const result = await service.join(input);

    expect(result.state).toBe('idle');
    // The audio daemon and X server came up first and must not be left behind.
    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
  });

  it('releases everything when the browser fails to launch', async () => {
    browserStart.mockRejectedValue(new Error('no chromium'));

    await service.join(input);

    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
  });

  it('releases everything when a host denies the request', async () => {
    providerJoin.mockResolvedValue({ status: 'denied', reason: 'A host denied the request to join.' });

    await service.join(input);
    await settle();

    // The platform's own reason, and the step it got to, so the log says which half of
    // the join to look at.
    expectLogged(loggerWarn, /Denied entry to the Google Meet call.*A host denied/s);
    expectNothingPublished();
    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('logs a join that broke as an error, not as a refusal', async () => {
    // A denial is the platform working as designed; a failure is something for an
    // engineer to fix. They land at different log levels so the second one is findable.
    providerJoin.mockResolvedValue({
      status: 'failed',
      step: 'lobby',
      reason: 'the join button never appeared',
    });

    await service.join(input);
    await settle();

    expectLogged(loggerError, /Joining the Google Meet call failed.*lobby.*join button/s);
    expect(loggedLines(loggerWarn).some((l) => /Denied entry/.test(l))).toBe(false);
    expectNothingPublished();
    expect(browserStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('releases everything on an explicit leave', async () => {
    await service.join(input);
    await settle();

    const { message } = await service.leave();

    expect(message).toMatch(/left the google meet call/i);
    expect(providerLeave).toHaveBeenCalled();
    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('releases everything on process shutdown', async () => {
    await service.join(input);
    await settle();

    await service.shutdown();

    // Otherwise the browser dies with the process and the bot lingers in the
    // room as a frozen participant.
    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
  });

  it('tolerates a leave when not in a meeting', async () => {
    const { message } = await service.leave();
    expect(message).toMatch(/not in a meeting/i);
    expect(browserStop).not.toHaveBeenCalled();
  });

  it('shuts down cleanly when idle', async () => {
    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it('still releases resources when the provider leave call fails', async () => {
    providerLeave.mockRejectedValue(new Error('page already closed'));
    await service.join(input);
    await settle();

    await service.leave();

    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });
});

describe('a lost Realtime session', () => {
  /** Fire the callback the real socket's close handler calls. */
  const dropSession = async (reason = 'code 1011') => {
    conversationOptions.onSessionLost?.(reason);
    await settle();
  };

  it('leaves the call and logs why', async () => {
    await service.join(input);
    await settle();
    expect(service.status().state).toBe('in_call');

    await dropSession('connection reset');

    // Everything a participant needs is gone, so staying would leave a mute tile
    // in someone's meeting until the empty-room poll or the duration cap noticed.
    expectLogged(loggerWarn, /Lost the Realtime session mid-call.*connection reset/s);
    expectNothingPublished();
    expect(providerLeave).toHaveBeenCalled();
    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('reports the ending as an error, once', async () => {
    await service.join(input);
    await settle();
    trackEvent.mockClear();

    await dropSession();

    const ended = trackEvent.mock.calls.filter((c) => c[0] === 'meeting ended');
    expect(ended).toHaveLength(1);
    expect(ended[0][2]).toMatchObject({ status: 'error' });
  });

  it('stays quiet about a close it asked for itself', async () => {
    await service.join(input);
    await settle();
    await service.leave();
    loggerWarn.mockClear();
    trackEvent.mockClear();

    // The real conversation sets `stopped` before closing the socket, so this
    // callback never fires for our own teardown. Belt and braces: even if it did,
    // the epoch has moved on and the ended call must not be reported twice.
    await dropSession();

    expect(loggedLines(loggerWarn).some((l) => /Lost the Realtime session/.test(l))).toBe(false);
    expect(trackEvent.mock.calls.filter((c) => c[0] === 'meeting ended')).toHaveLength(0);
  });

  it('does not tear down a later call', async () => {
    await service.join(input);
    await settle();
    const firstCallSessionLost = conversationOptions.onSessionLost;
    await service.leave();

    await service.join(input);
    await settle();
    loggerWarn.mockClear();

    firstCallSessionLost?.('code 1011');
    await settle();

    expect(service.status().state).toBe('in_call');
    expect(loggedLines(loggerWarn).some((l) => /Lost the Realtime session/.test(l))).toBe(false);
  });

});

describe('a lost audio pipeline', () => {
  it('leaves the call rather than sit there deaf', async () => {
    await service.join(input);
    await settle();
    expect(service.status().state).toBe('in_call');

    // What `parec` exiting looks like from the outside: the browser is still in the
    // call and the Realtime socket is still open, so nothing else notices that the
    // room's audio has stopped reaching a model.
    audioLostHandler?.('the capture process exited (code 1)');
    await settle();

    expectLogged(loggerWarn, /Lost the audio pipeline in the Google Meet call.*capture process exited/s);
    expectNothingPublished();
    expect(providerLeave).toHaveBeenCalled();
    expect(browserStop).toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
  });

  it('does not tear down a later call', async () => {
    await service.join(input);
    await settle();
    const stale = audioLostHandler;
    // Asserted, not optional-called: a refactor that stopped registering the
    // handler would otherwise leave this test passing on a no-op.
    expect(stale).toBeTypeOf('function');

    await service.leave();
    await service.join(input);
    await settle();
    expect(service.status().state).toBe('in_call');

    // A process from the first call exiting, late — the stack it belonged to is
    // already gone, and the call running now has its own.
    stale!('the playback process exited (code null)');
    await settle();

    expect(service.status().state).toBe('in_call');
  });
});

describe('a startup that outlives its own call', () => {
  it('refuses a replacement call until the abandoned startup has let go', async () => {
    // Startup is many awaits long — a sign-in alone can take 45s — and there is no
    // way to interrupt one from outside. Both startups drive the *same* persistent
    // browser profile, and launching clears that profile's singleton locks, so a
    // second Chromium would delete the first's live lock and open the profile
    // alongside it. Two writers is how a working Google session gets invalidated.
    let finishSignIn: () => void = () => {};
    providerSignIn.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishSignIn = () => resolve(); }),
    );

    const abandoned = service.join(input);
    await settle();

    await service.leave();
    // Not idle: the previous startup still holds the profile.
    expect(service.status().state).toBe('leaving');

    const refused = await service.join(input);
    expect(refused.message).toMatch(/still releasing/i);
    // The decisive assertion — no second browser was ever launched.
    expect(browserStart).toHaveBeenCalledTimes(1);
    expect(audioStart).toHaveBeenCalledTimes(1);

    finishSignIn();
    const result = await abandoned;
    await settle();

    // It never asked to join, it let go of its own stack, and the service is free.
    expect(result.message).toMatch(/cancelled/i);
    expect(providerJoin).not.toHaveBeenCalled();
    expect(browserStop).toHaveBeenCalledTimes(1);
    expect(conversationStop).toHaveBeenCalledTimes(1);
    expect(service.status().state).toBe('idle');
  });

  it('accepts a replacement call once the abandoned startup is done', async () => {
    // The refusal above is a wait, not a dead end: the service has to come back on
    // its own, or a cancelled sign-in would strand it until a restart.
    let finishSignIn: () => void = () => {};
    providerSignIn.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishSignIn = () => resolve(); }),
    );

    const abandoned = service.join(input);
    await settle();
    await service.leave();

    finishSignIn();
    await abandoned;
    await settle();
    expect(service.status().state).toBe('idle');

    const second = await service.join(input);
    await settle();
    expect(second.state).toBe('waiting_admission');
    expect(service.status().state).toBe('in_call');
    expect(browserStart).toHaveBeenCalledTimes(2);
  });

  it('releases its stack when it fails after the call it belonged to ended', async () => {
    // Same window, other ending: nothing on the service points at a stack that was
    // never published, so the failure path has to let go of it by name.
    let failBrowser: (err: Error) => void = () => {};
    browserStart.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failBrowser = reject; }),
    );

    const abandoned = service.join(input);
    await settle();
    await service.leave();
    trackEvent.mockClear();

    failBrowser(new Error('no chromium'));
    await abandoned;
    await settle();

    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
    // The call already ended once; it must not be ended a second time.
    expect(trackEvent.mock.calls.filter((c) => c[0] === 'meeting ended')).toHaveLength(0);
  });
});

describe('a late admission cannot resurrect a torn-down call', () => {
  it('ignores an admission that arrives after leave()', async () => {
    let admit: (v: unknown) => void = () => {};
    providerJoin.mockReturnValue(new Promise((r) => { admit = r; }));

    await service.join(input);
    await service.leave();
    expect(service.status().state).toBe('idle');

    // The waiting room finally answers — for a meeting that no longer exists.
    admit({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    await settle();

    expect(service.status().state).toBe('idle');
    expect(conversationSpeak).not.toHaveBeenCalled();
  });

  it('ignores a join that throws after teardown', async () => {
    let fail: (e: Error) => void = () => {};
    providerJoin.mockReturnValue(new Promise((_r, reject) => { fail = reject; }));

    await service.join(input);
    await service.leave();
    loggerError.mockClear();

    // Tearing down closes the page underneath the provider; the throw is expected.
    fail(new Error('Target page closed'));
    await settle();

    expect(loggedLines(loggerError).some((l) => /Join flow threw/.test(l))).toBe(false);
    expect(service.status().state).toBe('idle');
  });
});

describe('reading who has the floor', () => {
  it('prepares attribution as soon as the join lands, before the greeting', async () => {
    await service.join(input);
    await settle();

    // Meet opens every call with its participants panel shut, and preparing after the join
    // was reported meant the first named address arrived with no speaker attached —
    // observed twice, back when this read captions. Asserted as an ordering, because "it
    // was called at some point" would have passed then too. Owned here rather than inside
    // the provider's join so the interface's contract is true for the next platform.
    expect(providerEnableAttribution).toHaveBeenCalledWith({ mockPage: true });
    expect(providerEnableAttribution.mock.invocationCallOrder[0]).toBeLessThan(
      conversationSpeak.mock.invocationCallOrder[0],
    );
  });

  it('keeps the call when attribution cannot be prepared at all', async () => {
    // Attribution is a hint. A provider that throws here must not cost the meeting.
    providerEnableAttribution.mockRejectedValue(new Error('Target closed'));

    await service.join(input);
    await settle();

    expect(service.status().state).toBe('in_call');
  });

  it('asks for the speaker with nothing but the page', async () => {
    // It used to be handed the roster, so a scraped caption label could be checked against
    // who was in the call. Reading the panel removes that ambiguity rather than
    // compensating for it, so passing the roster would be passing something unused — and an
    // unused parameter is a claim about how the read works that is no longer true.
    providerParticipantNames.mockResolvedValue(['Prism', 'Emma Lee']);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerCurrentSpeaker).toHaveBeenCalledWith({ mockPage: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands each reading to the conversation, on its own faster timer', async () => {
    // A second, not the participant poll's ten: a speaker reading already lags speech by
    // one to two seconds, and a whole exchange can start and finish inside one slow tick.
    providerCurrentSpeaker.mockResolvedValue({ name: 'Emma Lee', isSelf: false });
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      conversationSetCurrentSpeaker.mockClear();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(conversationSetCurrentSpeaker).toHaveBeenCalledWith({ name: 'Emma Lee', isSelf: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps asking the provider to prepare attribution until something is attributed', async () => {
    // Same shape as the unmute retry, and for the same reason: one unlucky moment during
    // admission would otherwise cost attribution for the whole meeting, silently. Safe to
    // repeat because the provider tests for the state it wants before touching a control,
    // off.
    providerCurrentSpeaker.mockResolvedValue(null);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      providerEnableAttribution.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerEnableAttribution).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps asking even after a speaker has been read, because the state can be lost', async () => {
    // This used to stop once anything had been attributed, which was fair when attribution
    // came from a caption pane: captions stay on once they are on, so "have I ever read a
    // speaker" stood in for "is it still working". A participants panel is UI state that a
    // re-render or a reconnect can take away, and under the old condition attribution would
    // then be gone for the rest of the call with nothing left to notice.
    providerCurrentSpeaker.mockResolvedValue({
      id: 'spaces/x/devices/1',
      name: 'Emma Lee',
      isSelf: false,
      isGroup: false,
    });
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(2_000);
      providerEnableAttribution.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(providerEnableAttribution).toHaveBeenCalledWith({ mockPage: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries on when the platform cannot be read', async () => {
    // Attribution is a hint. A provider that throws must not stop the poll that also
    // decides whether the room has emptied.
    providerCurrentSpeaker.mockRejectedValue(new Error('Target closed'));
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(service.status().state).toBe('in_call');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('auto-leaving an empty meeting', () => {
  it('leaves once the bot is demonstrably the only one left', async () => {
    vi.useFakeTimers();
    await service.join(input);
    await vi.advanceTimersByTimeAsync(10);

    providerParticipantCount.mockResolvedValue(1);
    // One reading is not enough — a UI reshuffle also looks like this.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.status().state).toBe('in_call');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.status().state).toBe('idle');
    expectLogged(loggerInfo, /Everyone else left the call/i);
    expectNothingPublished();
  });

  it('stays in a call whose participant count cannot be read', async () => {
    vi.useFakeTimers();
    await service.join(input);
    await vi.advanceTimersByTimeAsync(10);

    // A selector change must never eject the bot from a live meeting.
    providerParticipantCount.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(service.status().state).toBe('in_call');
  });

  it('resets its count when people come back', async () => {
    vi.useFakeTimers();
    await service.join(input);
    await vi.advanceTimersByTimeAsync(10);

    providerParticipantCount.mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(30_000);
    providerParticipantCount.mockResolvedValue(4);
    await vi.advanceTimersByTimeAsync(30_000);
    providerParticipantCount.mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(service.status().state).toBe('in_call');
  });

  it('leaves when the call hits its duration cap', async () => {
    vi.useFakeTimers();
    await service.join(input);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);

    expect(service.status().state).toBe('idle');
    expectLogged(loggerInfo, /60-minute limit/);
    expectNothingPublished();
  });
});

describe('telemetry', () => {
  it('emits joined on admission and ended on teardown', async () => {
    await service.join(input);
    await settle();

    expect(trackEvent).toHaveBeenCalledWith('meeting joined', 'u1', {
      provider: 'google-meet',
      response_mode: 'auto',
      muted_on_entry: 'false',
      mic_confirmed: 'true',
    });

    await service.leave();

    expect(trackEvent).toHaveBeenCalledWith(
      'meeting ended',
      'u1',
      expect.objectContaining({
        provider: 'google-meet',
        status: 'completed',
        response_mode: 'auto',
        responses: '2',
        tool_calls: '1',
        interruptions: '3',
        // How the room was handled — the counters that say whether the gate
        // suppressed anything and how much of that was a name being said.
        utterances: '9',
        suppressed: '6',
        addressed_matches: '2',
        mode_switches: '1',
      }),
    );
  });

  it('records that the platform had muted the agent on arrival', async () => {
    // The measurement whose absence let this bug live in production: if Meet rarely
    // auto-mutes, the unmute step is dead weight; if it usually does, it is the only
    // reason the agent is audible at all. Either way it should be visible.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: true });

    await service.join(input);
    await settle();

    expect(trackEvent).toHaveBeenCalledWith(
      'meeting joined',
      'u1',
      expect.objectContaining({ muted_on_entry: 'true' }),
    );
  });

  it('never puts the meeting URL in event properties', async () => {
    await service.join(input);
    await settle();
    await service.leave();

    // No PII in props, and a meeting link is a credential of sorts.
    for (const call of trackEvent.mock.calls) {
      expect(JSON.stringify(call[2])).not.toContain('meet.google.com');
      expect(JSON.stringify(call[2])).not.toContain('abc-defg-hij');
    }
  });

  it('reports a denial as the ended status', async () => {
    providerJoin.mockResolvedValue({ status: 'denied', reason: 'nope' });
    await service.join(input);
    await settle();

    // Never admitted, so no "joined" — but the attempt still ends.
    expect(trackEvent).not.toHaveBeenCalledWith('meeting joined', expect.anything(), expect.anything());
    expect(trackEvent).toHaveBeenCalledWith(
      'meeting ended',
      'u1',
      expect.objectContaining({ status: 'denied' }),
    );
  });

  it('records which step a failed join reached', async () => {
    // The point of the enum: "joins are failing" is not actionable, "joins are
    // failing at admission" is. Emitted on the existing event rather than a new one.
    providerJoin.mockResolvedValue({
      status: 'denied',
      step: 'admission',
      reason: 'Nobody admitted the request to join before the wait timed out.',
    });
    await service.join(input);
    await settle();

    expect(trackEvent).toHaveBeenCalledWith(
      'meeting ended',
      'u1',
      expect.objectContaining({ status: 'denied', fail_step: 'admission' }),
    );
  });

  it('omits the step entirely for a call that ended normally', async () => {
    await service.join(input);
    await settle();
    await service.leave();

    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).not.toHaveProperty('fail_step');
  });

  it('reports how the addressed gate fared, including how often it failed', async () => {
    await service.join(input);
    await settle();
    await service.leave();

    // `gate_failed` is the one that matters: the gate fails closed, so a failing
    // gate and a room nobody addressed both produce silence, and nothing else
    // tells them apart. The mean is emitted rather than derived so a dashboard
    // needs no arithmetic — 3200ms over four calls here.
    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).toMatchObject({
      gate_calls: '4',
      gate_failed: '1',
      gate_latency_ms: '800',
      gate_superseded: '1',
      // Distinct from `gate_failed`: there the verdict never arrived, here it did
      // and the response the agent asked for produced no audio.
      responses_failed: '2',
    });
  });

  it('reports how often the platform said who was speaking', async () => {
    await service.join(input);
    await settle();
    await service.leave();

    // Scraped from a UI nobody promised to keep stable, and it fails silently — the call
    // carries on, just anonymously. This rate dropping between releases is the signal.
    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).toMatchObject({ attribution_rate: '75' });
  });

  it('reports a zero share for a call nobody spoke to the agent in', async () => {
    // A common outcome. Absent properties would look the same as a build that never
    // emitted them, and a mean over no calls must not be NaN.
    vi.spyOn(FakeVoiceConversation.prototype, 'statistics', 'get').mockReturnValue({
      responses: 0,
      toolCalls: 0,
      interruptions: 0,
      utterances: 0,
      suppressed: 0,
      addressedMatches: 0,
      modeSwitches: 0,
      gateCalls: 0,
      gateFailed: 0,
      gateLatencyMs: 0,
      gateSuperseded: 0,
      responsesFailed: 0,
      attributedUtterances: 0,
      unattributedUtterances: 0,
    });

    await service.join(input);
    await settle();
    await service.leave();

    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).toMatchObject({
      gate_calls: '0',
      gate_failed: '0',
      gate_latency_ms: '0',
      gate_superseded: '0',
      responses_failed: '0',
      attribution_rate: '0',
    });
  });
});

describe('a caller with no thread', () => {
  it('joins the call and logs the outcome like any other', async () => {
    // `threadId` is optional — an autonomous run has none. It only reaches the
    // meeting tool set, so the call itself must not depend on it.
    await service.join({ ...input, threadId: undefined });
    await settle();

    expect(service.status().state).toBe('in_call');
    expectLogged(loggerInfo, /Admitted to the Google Meet call/);
    expectNothingPublished();
  });
});

describe('status()', () => {
  it('reports idle with no provider before any call', () => {
    expect(service.status()).toMatchObject({ state: 'idle', provider: null, joinedAt: null });
  });

  it('reports the provider, mode and stats during a call', async () => {
    await service.join({ ...input, responseMode: 'addressed' });
    await settle();

    expect(service.status()).toMatchObject({
      state: 'in_call',
      provider: 'google-meet',
      responseMode: 'addressed',
      // What `auto` actually resolved to is the answer to "will it speak up?",
      // so status reports it alongside what was asked for.
      effectiveResponseMode: 'addressed',
      stats: { responses: 2, toolCalls: 1, interruptions: 3 },
    });
    expect(service.status().joinedAt).toBeTruthy();
  });
});

describe('reading the room', () => {
  it('reads the participant count on admission rather than a poll later', async () => {
    providerParticipantCount.mockResolvedValue(2);

    await service.join(input);
    await settle();

    // Until a count lands the policy assumes a crowd, so a one-to-one caller
    // would have to say the agent's name to be answered at all.
    expect(conversationSetParticipantCount).toHaveBeenCalledWith(2);
  });

  it('waits for the room to render instead of believing the first "1"', async () => {
    // Observed live: Meet admits the agent a moment before it renders anyone
    // else's tile, so an immediate read is a reliable 1.
    providerParticipantCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(3);

    await service.join(input);
    // The seed retries over a few seconds while the room renders.
    await vi.waitFor(() => expect(conversationSetParticipantCount).toHaveBeenCalledWith(3), {
      timeout: 6_000,
    });

    // And never the transient 1 — which is also what an empty room looks like,
    // so seeding it would put a false "I'm alone" into a call just joined.
    expect(conversationSetParticipantCount).not.toHaveBeenCalledWith(1);
  });

  it('does not count the admission read towards leaving an empty room', async () => {
    // A room a host has just admitted the agent to is not empty by definition.
    providerParticipantCount.mockResolvedValue(1);

    await service.join(input);
    await settle();

    expect(service.status().state).toBe('in_call');
  });

  it('keeps the call when the count cannot be read, and seeds nothing', async () => {
    providerParticipantCount.mockRejectedValue(new Error('selector gone'));

    await service.join(input);
    await settle();

    // Never guessed at. The policy's own default — wait to be addressed — is
    // where an unknown room belongs, and guessing "open" instead would put the
    // agent back to answering everything said by everyone.
    expect(conversationSetParticipantCount).not.toHaveBeenCalled();
    expect(service.status().state).toBe('in_call');
  });

  it('listens for the name the room actually hears, not the env default', async () => {
    // The prompt introduces the agent by its workspace name. If detection listened
    // for `config.agentName` instead, a renamed agent would ignore the very name it
    // had just given the room.
    getAgentContext.mockResolvedValue({ agentName: 'Atlas', soulMd: '', userMd: '' });

    await service.join(input);
    await settle();

    expect(conversationOptions).toMatchObject({ agentName: 'Atlas', responseMode: 'auto' });
  });

});

describe('posting into the call chat', () => {
  /** Get to a live call, which is the only place a send is allowed from. */
  const enterCall = async () => {
    await service.join(input);
    await settle();
  };

  /** The `[Meeting:Chat]` lines one log level received, as strings. */
  const chatLines = (level: { mock: { calls: unknown[][] } }): string[] =>
    level.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('[Meeting:Chat]'));

  it('posts the message and says the room has it', async () => {
    await enterCall();

    const result = await service.sendChatMessage('https://example.test/run/42', 'u1');

    expect(result).toEqual({ sent: true, message: `Posted it in the call's chat.` });
    expect(providerSendChatMessage).toHaveBeenCalledWith(
      { mockPage: true },
      'https://example.test/run/42',
    );
  });

  it('collapses the whitespace before the composer sees it', async () => {
    // The composer submits on Enter, so a newline in the draft posts half a message —
    // and the half nobody sees is the link.
    await enterCall();

    await service.sendChatMessage('  see\n\nhttps://example.test/run/42   ', 'u1');

    expect(providerSendChatMessage).toHaveBeenCalledWith(
      { mockPage: true },
      'see https://example.test/run/42',
    );
  });

  it('refuses when there is no call to post into, and says what to do', async () => {
    // The common case now that a chat turn and a scheduled run can both call this: the
    // usual caller is not in a call at all. It answers rather than throws, and the answer
    // names what is missing and what fixes it.
    const result = await service.sendChatMessage('anyone there?', 'u1');

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/not in a call/i);
    expect(result.message).toMatch(/join a call first/i);
    expect(providerSendChatMessage).not.toHaveBeenCalled();
  });

  it('refuses once the call has ended', async () => {
    // The window that matters: a Realtime session can still be draining a tool call
    // after the room is gone, and the page it would type into has been closed.
    await enterCall();
    await service.leave();

    const result = await service.sendChatMessage('one more thing', 'u1');

    expect(result.sent).toBe(false);
    expect(providerSendChatMessage).not.toHaveBeenCalled();
  });

  it('says so when the platform has no chat it can drive', async () => {
    chatSupported = false;
    await enterCall();

    const result = await service.sendChatMessage('the link is in the doc', 'u1');

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/can't post into the chat of a Google Meet call/i);
  });

  it('refuses a message with nothing in it', async () => {
    await enterCall();

    const result = await service.sendChatMessage('   \n  ', 'u1');

    expect(result.sent).toBe(false);
    expect(providerSendChatMessage).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'meeting chat sent',
      'u1',
      expect.objectContaining({ status: 'rejected', length: '0' }),
    );
  });

  it('refuses an over-long message instead of posting part of it', async () => {
    // Refused here rather than truncated, because a truncated message reads in the room
    // exactly like one that arrived whole — and the model can shorten it if it is told.
    await enterCall();
    const tooLong = 'x'.repeat(MEETING_CHAT_MAX_CHARS + 1);

    const result = await service.sendChatMessage(tooLong, 'u1');

    expect(result.sent).toBe(false);
    expect(result.message).toContain(String(MEETING_CHAT_MAX_CHARS));
    expect(providerSendChatMessage).not.toHaveBeenCalled();
  });

  it('takes a message exactly at the cap', async () => {
    await enterCall();

    const result = await service.sendChatMessage('x'.repeat(MEETING_CHAT_MAX_CHARS), 'u1');

    expect(result.sent).toBe(true);
  });

  it('refuses a second send while the first is still typing', async () => {
    // Both would fill the same draft box, and the room would get one message made of
    // both halves.
    await enterCall();
    let finish: (v: unknown) => void = () => {};
    providerSendChatMessage.mockReturnValueOnce(new Promise((r) => { finish = r; }));

    const first = service.sendChatMessage('first', 'u1');
    const second = await service.sendChatMessage('second', 'u1');

    expect(second.sent).toBe(false);
    expect(second.message).toMatch(/still posting/i);
    expect(providerSendChatMessage).toHaveBeenCalledTimes(1);

    finish({ sent: true });
    expect((await first).sent).toBe(true);

    // And the next one is accepted again.
    expect((await service.sendChatMessage('third', 'u1')).sent).toBe(true);
  });

  it('reports a page that would not take the message, and tells the model to speak', async () => {
    providerSendChatMessage.mockResolvedValue({
      sent: false,
      step: 'composer',
      reason: 'the chat panel opened but painted no input',
    });
    await enterCall();

    const result = await service.sendChatMessage('https://example.test/run/42', 'u1');

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/painted no input/);
    expect(result.message).toMatch(/out loud/);
    expect(trackEvent).toHaveBeenCalledWith(
      'meeting chat sent',
      'u1',
      expect.objectContaining({ status: 'failed', fail_step: 'composer' }),
    );
  });

  it('survives a page that closed under the send', async () => {
    providerSendChatMessage.mockRejectedValue(new Error('Target page closed'));
    await enterCall();

    const result = await service.sendChatMessage('https://example.test/run/42', 'u1');

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/Target page closed/);
    // No step: a throw can land at any of them, and naming one would be a guess.
    const props = trackEvent.mock.calls.find((c) => c[0] === 'meeting chat sent')?.[2] as Record<
      string,
      string
    >;
    expect(props.status).toBe('failed');
    expect(props).not.toHaveProperty('fail_step');

    // And the next send is accepted, so a throw does not wedge the call.
    providerSendChatMessage.mockResolvedValue({ sent: true });
    expect((await service.sendChatMessage('again', 'u1')).sent).toBe(true);
  });

  it('emits one event, and never the message itself', async () => {
    await enterCall();
    const secret = 'https://example.test/deploy?token=abcd1234';

    await service.sendChatMessage(secret, 'u1');

    const sends = trackEvent.mock.calls.filter((c) => c[0] === 'meeting chat sent');
    expect(sends).toHaveLength(1);
    const props = sends[0][2] as Record<string, string>;
    expect(props).toMatchObject({
      provider: 'google-meet',
      status: 'sent',
      length: String(secret.length),
    });
    expect(props.duration_ms).toMatch(/^\d+$/);
    // The whole point of the length property: no property may carry the body, and no
    // property may carry a piece of it either.
    expect(JSON.stringify(props)).not.toContain('abcd1234');
    expect(JSON.stringify(props)).not.toContain('example.test');
  });

  it('logs one line per send, at debug when it worked and warn when it did not', async () => {
    await enterCall();
    logged.debug.mockClear();
    logged.warn.mockClear();

    await service.sendChatMessage('https://example.test/run/42', 'u1');

    const debugged = chatLines(logged.debug);
    expect(debugged).toHaveLength(1);
    expect(debugged[0]).toContain('sent chars=27');
    expect(chatLines(logged.warn)).toHaveLength(0);

    // A send that quietly did nothing is silence in a room with no other symptom, so it
    // is the one an operator has to be able to see without turning anything on.
    providerSendChatMessage.mockResolvedValue({ sent: false, step: 'composer', reason: 'gone' });
    await service.sendChatMessage('https://example.test/run/42', 'u1');

    const warned = chatLines(logged.warn);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('step=composer');
  });

  it('never writes the message itself, at any log level', async () => {
    // The promise holds by construction: no code path puts the body on a line, so there
    // is no setting to get wrong. This asserts the construction, over every level, for a
    // send that worked and one that failed.
    await enterCall();
    const secret = 'https://example.test/deploy?token=abcd1234';

    await service.sendChatMessage(secret, 'u1');
    providerSendChatMessage.mockResolvedValue({ sent: false, step: 'confirm', reason: 'no echo' });
    await service.sendChatMessage(secret, 'u1');

    for (const level of [logged.debug, logged.info, logged.warn, logged.error]) {
      const written = level.mock.calls.flat().map(String).join(' ');
      expect(written).not.toContain('abcd1234');
      expect(written).not.toContain('example.test');
    }
  });

  it('stores nothing and tells no thread', async () => {
    // A chat message lives in the room and in this process, and nowhere else: it is not
    // conversation history, and it is not a status note.
    await enterCall();
    publish.mockClear();
    publishToLatestThread.mockClear();

    await service.sendChatMessage('https://example.test/run/42', 'u1');

    expect(publish).not.toHaveBeenCalled();
    expect(publishToLatestThread).not.toHaveBeenCalled();
  });

  it('holds off the unmute retry while a send is typing', async () => {
    // Both drive the same page, and the retry is the destructive half: it sweeps dialogs
    // and clicks the control bar, which is how a composer goes away mid-message.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
    let finish: (v: unknown) => void = () => {};
    providerSendChatMessage.mockReturnValueOnce(new Promise((r) => { finish = r; }));

    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      providerSetMicrophone.mockClear();

      const sending = service.sendChatMessage('https://example.test/run/42', 'u1');
      // The gate lasts as long as the send does, and a send lasts at most its deadline
      // (10s), so the window holding one poll is the last 10ms of it: the poll timer
      // started at join and fires at 10_000, the deadline started 10ms later.
      await vi.advanceTimersByTimeAsync(9_990);

      expect(providerSetMicrophone).not.toHaveBeenCalled();

      finish({ sent: true });
      await sending;
      await vi.advanceTimersByTimeAsync(30_000);

      // And it resumes: a skipped retry costs a poll interval, not the microphone.
      expect(providerSetMicrophone).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds off the attribution refresh while a send is typing', async () => {
    // Meet's side rail shows one panel at a time, so an open chat panel is exactly the
    // state that makes the refresh click People — and that click takes the composer away
    // mid-message. A skipped refresh costs one poll of attribution.
    providerCurrentSpeaker.mockResolvedValue(null);
    let finish: (v: unknown) => void = () => {};
    providerSendChatMessage.mockReturnValueOnce(new Promise((r) => { finish = r; }));

    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      providerEnableAttribution.mockClear();

      const sending = service.sendChatMessage('https://example.test/run/42', 'u1');
      // One poll inside the send deadline — see the unmute test above for the arithmetic.
      await vi.advanceTimersByTimeAsync(9_990);

      expect(providerEnableAttribution).not.toHaveBeenCalled();

      finish({ sent: true });
      await sending;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(providerEnableAttribution).toHaveBeenCalledWith({ mockPage: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
