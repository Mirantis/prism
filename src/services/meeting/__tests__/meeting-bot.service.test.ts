/**
 * Lifecycle tests for the meeting service.
 *
 * The thing worth testing here is not the happy path but the exits: every ending
 * has to release an X server, an audio daemon, a browser and a WebSocket, and a
 * join that finishes *after* the call was torn down must not resurrect it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  setAudible = conversationSetAudible;
  pushMeetingAudio = vi.fn();
  get responseMode() {
    return 'addressed';
  }
  get statistics() {
    return {
      responses: 2,
      toolCalls: 1,
      interruptions: 3,
      utterances: 9,
      suppressed: 6,
      addressedMatches: 2,
      modeSwitches: 1,
      gateLocalYes: 3,
      gateModelCalls: 1,
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
 * Mocked to observe what the service asked for, not to replace the prompt: the
 * instructions have to describe the tools the model was actually given, and this is
 * the only place that decision is visible.
 */
const getMeetingInstructions = vi.fn(() => '# Live Voice Meeting');
vi.mock('../../../prompts/meeting-prompt', () => ({
  getMeetingInstructions: (...a: unknown[]) => getMeetingInstructions(...a),
}));

const publish = vi.fn();
const publishToLatestThread = vi.fn();
vi.mock('../../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: (...a: unknown[]) => publish(...a),
    publishToLatestThread: (...a: unknown[]) => publishToLatestThread(...a),
  },
}));

const trackEvent = vi.fn();
vi.mock('../../../lib/telemetry', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

const providerJoin = vi.fn();
const providerConfigurationError = vi.fn(() => null as string | null);
const providerSignIn = vi.fn(async () => {});
const providerLeave = vi.fn();
const providerParticipantCount = vi.fn();
const providerEnsureUnmuted = vi.fn();
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
    ensureUnmuted: (...a: unknown[]) => providerEnsureUnmuted(...a),
  },
}));

vi.mock('../../../config', () => ({
  config: {
    agentName: 'Prism',
    googleBotEmail: 'bot@example.com',
    googleBotPassword: 'hunter2',
    meetingTimeoutMinutes: 60,
    meetingAdmissionTimeoutMs: 5_000,
    // The shipped default: the experiment is opt-in, so an unset MEETING_TOOL_MODE
    // has to leave a call exactly where it is today.
    meetingToolMode: 'full',
    openaiRealtimeVoice: undefined,
  },
}));

const { MeetingBotService } = await import('../meeting-bot.service');

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
  providerParticipantCount.mockResolvedValue(3);
  providerEnsureUnmuted.mockResolvedValue(false);
  conversationOptions = {};
  service = new MeetingBotService();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the fire-and-forget join flow settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

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
    expect(publish).toHaveBeenCalledWith('u1', 't1', expect.stringMatching(/I'm in the/), 'SYSTEM');
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
    expect(publish).toHaveBeenCalledWith(
      'u1',
      't1',
      expect.stringMatching(/signing in again didn't help/i),
      'SYSTEM',
    );
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

  it('tells the user, and says which half failed', async () => {
    // The whole point of not leaving is that somebody still finds out. A note that just
    // said "I'm in the call" would put this back where it started.
    audioWaitForMicCapture.mockResolvedValue(false);

    await service.join(input);
    await settle();

    // "Couldn't confirm", never "am muted". The readings behind this are a scraped DOM
    // attribute and a `pactl` line, so a confident claim is one the user would act on
    // and one that can be wrong.
    expect(publish).toHaveBeenCalledWith(
      'u1',
      't1',
      expect.stringMatching(/couldn't confirm my microphone/i),
      'SYSTEM',
    );
    // And which half, because the two send you to different places: the platform's UI, or
    // the container's audio devices.
    expect(publish).toHaveBeenCalledWith(
      'u1',
      't1',
      expect.stringMatching(/never opened its capture device/i),
      'SYSTEM',
    );
  });

  it('names the platform through the provider rather than hard-coding it', async () => {
    // This service has no idea which platform it is on — that is the whole point of
    // `MeetingProvider`. A Teams call explaining itself in terms of Meet's controls would
    // be a small lie in the one message somebody reads when something is wrong.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });

    await service.join(input);
    await settle();

    // "Google Meet" is what the mocked provider declares as its `displayName`, and the
    // service has no other source for it — so finding the full name here is what shows
    // the sentence was built from the provider rather than typed in.
    const notes = publish.mock.calls.map((c) => String(c[2]));
    expect(notes.some((n) => n.includes("Google Meet's own microphone control"))).toBe(true);
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
    // Told not to repair it, and that matters more than it looks: the meeting toolset
    // includes the shell, PulseAudio is running in this container, and a model that
    // decides to fix its own microphone can kill the daemon carrying the call.
    expect(conversationNotify).toHaveBeenCalledWith(expect.stringMatching(/don't try to repair/i));
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

      providerEnsureUnmuted.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(conversationNotify).toHaveBeenCalledWith(expect.stringMatching(/just been admitted/i));
      expect(conversationSpeak).toHaveBeenCalled();
      expect(conversationSetAudible).toHaveBeenCalledWith(true);
      expect(publish).toHaveBeenCalledWith(
        'u1',
        't1',
        expect.stringMatching(/microphone is working now/i),
        'SYSTEM',
      );
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
    providerEnsureUnmuted.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(conversationSpeak).not.toHaveBeenCalled();
      expect(conversationSetAudible).not.toHaveBeenCalledWith(true);
      expect(publish).not.toHaveBeenCalledWith(
        'u1',
        't1',
        expect.stringMatching(/microphone is working now/i),
        'SYSTEM',
      );
      // And it kept asking, rather than settling into a call it cannot be heard in.
      expect(providerEnsureUnmuted.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when the capture device is what comes up late', async () => {
    // The same shape, resolved: the device opens a few seconds after the toggle did.
    providerJoin.mockResolvedValue({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    audioWaitForMicCapture.mockResolvedValue(false);
    audioIsMicCaptured.mockResolvedValue(false);
    providerEnsureUnmuted.mockResolvedValue(true);
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
    providerEnsureUnmuted.mockImplementation(async () => {
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

  it('stops retrying once the room can hear it', async () => {
    // A toggle toggles, so a retry that keeps firing after it has succeeded is not
    // harmless persistence — the next click would mute what the last one fixed.
    audioWaitForMicCapture.mockResolvedValue(false);
    providerEnsureUnmuted.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(providerEnsureUnmuted).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(providerEnsureUnmuted).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never asks the provider to unmute a call it is already audible in', async () => {
    // The common case: the join confirmed the microphone, so the poll has no business
    // clicking at the control bar every ten seconds.
    vi.useFakeTimers();
    try {
      await service.join(input);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(providerEnsureUnmuted).not.toHaveBeenCalled();
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

    expect(publish).toHaveBeenCalledWith('u1', 't1', expect.stringMatching(/A host denied/), 'SYSTEM');
    expect(browserStop).toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalled();
    expect(conversationStop).toHaveBeenCalled();
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

  it('leaves the call and says why', async () => {
    await service.join(input);
    await settle();
    expect(service.status().state).toBe('in_call');

    await dropSession('connection reset');

    // Everything a participant needs is gone, so staying would leave a mute tile
    // in someone's meeting until the empty-room poll or the duration cap noticed.
    expect(publish).toHaveBeenCalledWith(
      'u1',
      't1',
      expect.stringMatching(/lost my voice connection.*connection reset/is),
      'SYSTEM',
    );
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
    publish.mockClear();

    // The real conversation sets `stopped` before closing the socket, so this
    // callback never fires for our own teardown. Belt and braces: even if it did,
    // the epoch has moved on and the ended call must not be announced twice.
    await dropSession();

    expect(publish).not.toHaveBeenCalled();
  });

  it('does not tear down a later call', async () => {
    await service.join(input);
    await settle();
    const firstCallSessionLost = conversationOptions.onSessionLost;
    await service.leave();

    await service.join(input);
    await settle();
    publish.mockClear();

    firstCallSessionLost?.('code 1011');
    await settle();

    expect(service.status().state).toBe('in_call');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not tear down a later call when the note it posts is slow', async () => {
    // The dangerous version of the case above: the drop happens while the old call
    // is still live, so the guard passes — and then posting the note takes long
    // enough for the user to leave and rejoin underneath it. Teardown's own guard
    // does not catch this (it only rejects a re-entry mid-teardown, and by then the
    // service is back to idle), so the epoch has to be re-checked after the await.
    await service.join(input);
    await settle();

    // Mocked only now: the admission note is published first and would otherwise
    // consume this, leaving the race untested.
    let releaseNote: () => void = () => {};
    publish.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseNote = () => resolve(); }),
    );

    conversationOptions.onSessionLost?.('code 1011');
    await settle();

    // The note is still in flight. Meanwhile the call ends and another one starts.
    await service.leave();
    await service.join(input);
    await settle();
    expect(service.status().state).toBe('in_call');

    releaseNote();
    await settle();

    expect(service.status().state).toBe('in_call');
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

    expect(publish).toHaveBeenCalledWith(
      'u1',
      't1',
      expect.stringMatching(/lost my audio.*capture process exited/is),
      'SYSTEM',
    );
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
    publish.mockClear();

    // Tearing down closes the page underneath the provider; the throw is expected.
    fail(new Error('Target page closed'));
    await settle();

    expect(publish).not.toHaveBeenCalled();
    expect(service.status().state).toBe('idle');
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
    expect(publish).toHaveBeenCalledWith('u1', 't1', expect.stringMatching(/everyone else left/i), 'SYSTEM');
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
    expect(publish).toHaveBeenCalledWith('u1', 't1', expect.stringMatching(/60-minute limit/), 'SYSTEM');
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
      tool_mode: 'full',
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

  it('reports how much of the addressed gate ran locally', async () => {
    await service.join(input);
    await settle();
    await service.leave();

    // The share is emitted rather than derived, so a dashboard needs no arithmetic to
    // show it. Three of four here.
    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).toMatchObject({
      gate_local_yes: '3',
      gate_model_calls: '1',
      gate_local_share: '75',
    });
  });

  it('reports a zero share for a call nobody spoke to the agent in', async () => {
    // A common outcome. Absent properties would look the same as a build that never
    // emitted them.
    vi.spyOn(FakeVoiceConversation.prototype, 'statistics', 'get').mockReturnValue({
      responses: 0,
      toolCalls: 0,
      interruptions: 0,
      utterances: 0,
      suppressed: 0,
      addressedMatches: 0,
      modeSwitches: 0,
      gateLocalYes: 0,
      gateModelCalls: 0,
    });

    await service.join(input);
    await settle();
    await service.leave();

    const ended = trackEvent.mock.calls.find((c) => c[0] === 'meeting ended');
    expect(ended?.[2]).toMatchObject({ gate_local_share: '0' });
  });
});

describe('status notes', () => {
  it('falls back to the latest thread when the caller has none', async () => {
    await service.join({ ...input, threadId: undefined });
    await settle();

    expect(publishToLatestThread).toHaveBeenCalledWith('a1', 'u1', expect.any(String), 'SYSTEM');
  });

  it('keeps the call alive when a status note cannot be delivered', async () => {
    publish.mockRejectedValue(new Error('thread gone'));

    await service.join(input);
    await settle();

    // A note nobody could deliver must not end a working meeting.
    expect(service.status().state).toBe('in_call');
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

/**
 * The tool-mode experiment (AGENT-135) is only comparable if one container can run
 * both, so the mode is a per-join argument over an env default.
 */
describe('how many tools the voice is given', () => {
  it('gives the model everything by default', async () => {
    await service.join(input);
    await settle();

    // `MEETING_TOOL_MODE` is unset in tests, so this is the shipped default — and it
    // has to be today's behaviour, or every existing deployment moves onto the
    // experiment by upgrading.
    expect(prepareMeetingTools).toHaveBeenCalledWith(expect.objectContaining({ toolMode: 'full' }));
    expect(service.status().toolMode).toBe('full');
  });

  it('takes the mode from the join that asked for it', async () => {
    await service.join({ ...input, toolMode: 'delegate' });
    await settle();

    expect(prepareMeetingTools).toHaveBeenCalledWith(
      expect.objectContaining({ toolMode: 'delegate' }),
    );
    // Reported, so a call can be told apart from the outside — `meeting_status`
    // spreads this straight through, which is how an A/B is checked mid-call.
    expect(service.status().toolMode).toBe('delegate');
  });

  it('builds the prompt for the mode the call is running in', async () => {
    await service.join({ ...input, toolMode: 'delegate' });
    await settle();

    // The instructions describe the tools the model actually has. A `full`-mode
    // section in a `delegate`-mode call tells it to use tools it cannot see.
    expect(getMeetingInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ toolMode: 'delegate' }),
    );
  });

  it('does not carry a per-join mode into the next call', async () => {
    await service.join({ ...input, toolMode: 'delegate' });
    await settle();
    await service.leave();

    await service.join(input);
    await settle();

    // Two calls minutes apart on one container is the whole A/B; a mode that stuck
    // would silently make the second half of the comparison a repeat of the first.
    expect(service.status().toolMode).toBe('full');
  });
});
