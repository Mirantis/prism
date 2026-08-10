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
class FakeAudioStack {
  start = audioStart;
  stop = audioStop;
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
class FakeVoiceConversation {
  start = conversationStart;
  stop = conversationStop;
  notify = conversationNotify;
  speakNow = conversationSpeak;
  pushMeetingAudio = vi.fn();
  get statistics() {
    return { responses: 2, toolCalls: 1, interruptions: 3 };
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
const providerLeave = vi.fn();
const providerParticipantCount = vi.fn();
vi.mock('../providers/google-meet.provider', () => ({
  googleMeetProvider: {
    name: 'google-meet',
    displayName: 'Google Meet',
    matchesUrl: (url: string) => url.startsWith('https://meet.google.com/'),
    join: (...a: unknown[]) => providerJoin(...a),
    leave: (...a: unknown[]) => providerLeave(...a),
    participantCount: (...a: unknown[]) => providerParticipantCount(...a),
  },
}));

vi.mock('../../../config', () => ({
  config: {
    agentName: 'Prism',
    meetingDisplayName: '',
    meetingTimeoutMinutes: 60,
    meetingAdmissionTimeoutMs: 5_000,
    openaiRealtimeVoice: undefined,
  },
}));

const { MeetingBotService } = await import('../meeting-bot.service');

const URL = 'https://meet.google.com/abc-defg-hij';
const input = { url: URL, userId: 'u1', agentId: 'a1', threadId: 't1' };

let service: InstanceType<typeof MeetingBotService>;

beforeEach(() => {
  vi.clearAllMocks();
  audioStart.mockResolvedValue({
    browserEnv: { DISPLAY: ':99' },
    onCapture: vi.fn(),
    playbackSink: { write: vi.fn() },
  });
  audioStop.mockResolvedValue(undefined);
  browserStart.mockResolvedValue({ mockPage: true });
  browserStop.mockResolvedValue(undefined);
  conversationStart.mockResolvedValue(undefined);
  prepareMeetingTools.mockResolvedValue({ declarations: [], count: 0, execute: vi.fn() });
  getAgentContext.mockResolvedValue({ agentName: 'Prism', soulMd: '', userMd: '' });
  buildSystemPromptParts.mockResolvedValue([{ text: '# Identity', cacheable: true }]);
  publish.mockResolvedValue(undefined);
  publishToLatestThread.mockResolvedValue(undefined);
  providerJoin.mockResolvedValue({ status: 'admitted' });
  providerLeave.mockResolvedValue(undefined);
  providerParticipantCount.mockResolvedValue(3);
  service = new MeetingBotService();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the fire-and-forget join flow settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('joining', () => {
  it('returns before admission, then reports being in the call', async () => {
    // A guest can wait minutes for a host; the chat turn must not block on it.
    let admit: (v: unknown) => void = () => {};
    providerJoin.mockReturnValue(new Promise((r) => { admit = r; }));

    const result = await service.join(input);
    expect(result.state).toBe('waiting_admission');
    expect(result.message).toMatch(/host needs to admit me/i);
    expect(service.status().state).toBe('waiting_admission');

    admit({ status: 'admitted' });
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

  it('reports the agent name as the display name by default', async () => {
    await service.join(input);
    expect(providerJoin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: 'Prism' }),
    );
  });

  it('passes an explicit display name through', async () => {
    await service.join({ ...input, displayName: 'Prism (bot)' });
    expect(providerJoin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: 'Prism (bot)' }),
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

describe('a late admission cannot resurrect a torn-down call', () => {
  it('ignores an admission that arrives after leave()', async () => {
    let admit: (v: unknown) => void = () => {};
    providerJoin.mockReturnValue(new Promise((r) => { admit = r; }));

    await service.join(input);
    await service.leave();
    expect(service.status().state).toBe('idle');

    // The waiting room finally answers — for a meeting that no longer exists.
    admit({ status: 'admitted' });
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
      addressed_only: 'false',
    });

    await service.leave();

    expect(trackEvent).toHaveBeenCalledWith(
      'meeting ended',
      'u1',
      expect.objectContaining({
        provider: 'google-meet',
        status: 'completed',
        responses: '2',
        tool_calls: '1',
        interruptions: '3',
      }),
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
    await service.join({ ...input, addressedOnly: true });
    await settle();

    expect(service.status()).toMatchObject({
      state: 'in_call',
      provider: 'google-meet',
      addressedOnly: true,
      stats: { responses: 2, toolCalls: 1, interruptions: 3 },
    });
    expect(service.status().joinedAt).toBeTruthy();
  });
});
