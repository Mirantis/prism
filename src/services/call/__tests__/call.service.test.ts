/**
 * The call owner, with no desktop and no voice socket.
 *
 * The computer's audio is a double a test drives by hand: it plays capture chunks, reports
 * whether a program records the microphone, and names that program. `VoiceConversation`
 * is a double too, so a test sees what the service feeds it and tells it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaybackSink } from '../../meeting/audio-playback';
import { MEETING_SAMPLE_RATE } from '../../meeting/resampler';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config', () => ({
  config: {
    openaiRealtimeVoice: 'marin',
    realtimeProvider: 'openai',
    realtimeSource: 'direct',
    meetingTimeoutMinutes: 60,
  },
}));

vi.mock('../../voice/voice-instructions', () => ({
  buildVoiceInstructions: vi.fn(async () => ({
    instructions: 'be yourself',
    sessionInstructions: 'do the work',
  })),
}));

const trackEvent = vi.fn();
vi.mock('../../../lib/telemetry', () => ({ trackEvent: (...args: unknown[]) => trackEvent(...args) }));

const conversations: FakeConversation[] = [];

class FakeConversation {
  static failStart: Error | null = null;

  readonly pushAudio = vi.fn();
  readonly stop = vi.fn(async () => {});
  readonly start = vi.fn(async () => {
    if (FakeConversation.failStart) throw FakeConversation.failStart;
  });
  readonly notify = vi.fn();
  readonly prompt = vi.fn();
  readonly ask = vi.fn();
  readonly sink: PlaybackSink;
  readonly sampleRate: number;
  readonly backend: { userId: string; agentId: string; sessionInstructions: string };
  readonly onSessionLost: (reason: string) => void;
  readonly statistics = {
    delegations: 2,
    toolCalls: 1,
    backendInputTokens: 1200,
    backendOutputTokens: 80,
    voiceSeconds: 42,
    closeReason: 'close_requested',
  };

  constructor(options: {
    sink: PlaybackSink;
    sampleRate: number;
    backend: { userId: string; agentId: string; sessionInstructions: string };
    onSessionLost: (reason: string) => void;
  }) {
    this.sink = options.sink;
    this.sampleRate = options.sampleRate;
    this.backend = options.backend;
    this.onSessionLost = options.onSessionLost;
    conversations.push(this);
  }
}

vi.mock('../../meeting/voice-conversation', () => ({ VoiceConversation: FakeConversation }));

/** The computer's audio devices, driven by the test. */
const audio = {
  captureHandlers: new Set<(pcm: Buffer) => void>(),
  lostHandlers: new Set<(reason: string) => void>(),
  lostReason: null as string | null,
  captured: true,
  client: 'Chromium' as string | null,
  playbackSink: { write: vi.fn(() => true) },
  play(pcm: Buffer) {
    for (const handler of this.captureHandlers) handler(pcm);
  },
  lose(reason: string) {
    this.lostReason = reason;
    for (const handler of this.lostHandlers) handler(reason);
  },
};

const callAudio = {
  onCapture: (handler: (pcm: Buffer) => void) => {
    audio.captureHandlers.add(handler);
    return () => audio.captureHandlers.delete(handler);
  },
  onLost: (handler: (reason: string) => void) => {
    audio.lostHandlers.add(handler);
    if (audio.lostReason) handler(audio.lostReason);
    return () => audio.lostHandlers.delete(handler);
  },
  get playbackSink() {
    return audio.playbackSink;
  },
  isMicCaptured: async () => audio.captured,
  waitForMicCapture: async () => audio.captured,
  micClient: async () => audio.client,
};

const endVoiceSession = vi.fn();

vi.mock('../../computer/computer.service', () => ({
  computerService: {
    open: vi.fn(async () => ({ callAudio, width: 1280, height: 720 })),
  },
}));
vi.mock('../../computer/computer-help.service', () => ({ computerHelpService: { endVoiceSession } }));

const { callService } = await import('../call.service');
const { voiceSessionLock } = await import('../../voice/voice-session-lock');
const { buildVoiceInstructions } = await import('../../voice/voice-instructions');

const SOUND = Buffer.from([1, 0, 2, 0]);
const SILENCE = Buffer.alloc(4);

async function join() {
  return callService.join({ userId: 'user-1', agentId: 'agent-1' });
}

function latest(): FakeConversation {
  return conversations[conversations.length - 1]!;
}

function endedEvents() {
  return trackEvent.mock.calls.filter(([name]) => name === 'call ended');
}

/** Run the microphone poll `times` times, letting each read settle. */
async function poll(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(10_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeConversation.failStart = null;
  conversations.length = 0;
  audio.captureHandlers.clear();
  audio.lostHandlers.clear();
  audio.lostReason = null;
  audio.captured = true;
  audio.client = 'Chromium';
  trackEvent.mockClear();
  endVoiceSession.mockClear();
  vi.mocked(buildVoiceInstructions).mockClear();
});

afterEach(async () => {
  await callService.leave();
  voiceSessionLock.release('call');
  voiceSessionLock.release('voice-chat');
  vi.useRealTimers();
});

describe('joining', () => {
  it('connects the voice to the computer audio and names the call app', async () => {
    const result = await join();

    expect(result).toMatchObject({ success: true, micCaptured: true, app: 'Chromium' });
    expect(voiceSessionLock.holder).toBe('call');
    const conversation = latest();
    expect(conversation.sink).toBe(audio.playbackSink);
    expect(conversation.sampleRate).toBe(MEETING_SAMPLE_RATE);
    expect(vi.mocked(buildVoiceInstructions).mock.calls[0]![0]).toMatchObject({
      call: { kind: 'call', app: 'Chromium', desktop: { width: 1280, height: 720 } },
    });
    // Told to greet once it hears the call, since the app may still be in a lobby.
    expect(conversation.prompt).not.toHaveBeenCalled();
    expect(conversation.notify).toHaveBeenCalledWith(expect.stringContaining('waiting in its lobby'));
    expect(trackEvent).toHaveBeenCalledWith(
      'call started',
      'user-1',
      expect.objectContaining({ app: 'Chromium', mic_captured: 'true' }),
    );
  });

  it("hands the backend runs the call's rules, for the one who asked", async () => {
    await join();

    expect(latest().backend).toEqual({ userId: 'user-1', agentId: 'agent-1', sessionInstructions: 'do the work', computer: true });
  });

  it('feeds every capture chunk to the voice, silence included', async () => {
    await join();

    audio.play(SOUND);
    audio.play(SILENCE);

    expect(latest().pushAudio.mock.calls.map(([pcm]) => pcm)).toEqual([SOUND, SILENCE]);
  });

  it('holds the greeting and says why when no app records the microphone', async () => {
    audio.captured = false;

    const result = await join();

    expect(result).toMatchObject({ success: true, micCaptured: false, app: null });
    expect(result.message).toContain('PrismMicrophone');
    expect(latest().prompt).not.toHaveBeenCalled();
    expect(latest().notify).toHaveBeenCalledWith(expect.stringContaining('nobody in the call hears you'));
  });

  it('refuses while a voice chat holds the voice', async () => {
    voiceSessionLock.tryAcquire('voice-chat');

    const result = await join();

    expect(result.success).toBe(false);
    expect(result.message).toContain('voice chat');
    expect(conversations).toHaveLength(0);
  });

  it('refuses a second call', async () => {
    await join();

    const second = await join();

    expect(second).toMatchObject({ success: false });
    expect(second.message).toContain('already in a call');
    expect(conversations).toHaveLength(1);
  });

  it('refuses when the computer audio is already gone, and frees the voice', async () => {
    audio.lostReason = 'the capture process exited (code 1)';

    const result = await join();

    expect(result.success).toBe(false);
    expect(result.message).toContain('audio has stopped');
    expect(conversations).toHaveLength(0);
    expect(voiceSessionLock.holder).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('call start failed', 'user-1', expect.objectContaining({ stage: 'computer' }));
  });

  it('releases everything when the voice session will not open', async () => {
    FakeConversation.failStart = new Error('401 from the voice endpoint');

    const result = await join();

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
    expect(latest().stop).toHaveBeenCalledOnce();
    expect(endVoiceSession).toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
    expect(audio.captureHandlers.size).toBe(0);
    expect(trackEvent).toHaveBeenCalledWith('call start failed', 'user-1', expect.objectContaining({ stage: 'session' }));
  });
});

describe('starting while something ends', () => {
  it('opens no voice session when the call is left during startup', async () => {
    const joining = join();
    await callService.leave();

    const result = await joining;

    expect(result.success).toBe(false);
    expect(conversations).toHaveLength(0);
    expect(endVoiceSession).toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
  });

  it('refuses when the computer audio dies during startup', async () => {
    vi.mocked(buildVoiceInstructions).mockImplementationOnce(async () => {
      audio.lose('the capture process exited (code 1)');
      return { instructions: 'i', sessionInstructions: 'b' };
    });

    const result = await join();

    expect(result.success).toBe(false);
    expect(result.message).toContain('audio has stopped');
    expect(conversations).toHaveLength(0);
    expect(voiceSessionLock.holder).toBeNull();
  });
});

describe('the microphone during a call', () => {
  it('tells the voice when the call app opens or lets go of it', async () => {
    audio.captured = false;
    await join();
    latest().notify.mockClear();

    audio.captured = true;
    await poll();
    expect(latest().notify).toHaveBeenLastCalledWith(expect.stringContaining('now using your microphone'));

    audio.captured = false;
    await poll();
    expect(latest().notify).toHaveBeenLastCalledWith(expect.stringContaining('No app is using your microphone'));
    expect(latest().notify).toHaveBeenCalledTimes(2);
  });
});

describe('ending', () => {
  it('ends once on leave_call, and reports it', async () => {
    await join();
    const conversation = latest();

    const result = await callService.leave();
    await callService.leave();

    expect(result.success).toBe(true);
    expect(conversation.stop).toHaveBeenCalledOnce();
    expect(endVoiceSession).toHaveBeenCalledOnce();
    expect(voiceSessionLock.holder).toBeNull();
    expect(audio.captureHandlers.size).toBe(0);
    expect(endedEvents()).toHaveLength(1);
    expect(endedEvents()[0]![2]).toMatchObject({
      status: 'completed',
      app: 'Chromium',
      delegations: '2',
      tool_calls: '1',
      voice_seconds: '42',
    });
  });

  it('hangs up once the app has let go of the microphone and the call is quiet', async () => {
    await join();
    audio.captured = false;
    await poll();
    expect(callService.isActive).toBe(true);

    audio.play(SILENCE);
    await poll(6);

    expect(callService.isActive).toBe(false);
    expect(endedEvents()[0]![2]).toMatchObject({ status: 'hung_up' });
  });

  it('stays while the call is still audible after the microphone is released', async () => {
    await join();
    audio.captured = false;
    await poll();

    for (let i = 0; i < 8; i++) {
      audio.play(SOUND);
      await poll();
    }

    expect(callService.isActive).toBe(true);
  });

  it('stays while muted: the microphone stays open', async () => {
    await join();

    await poll(20);

    expect(callService.isActive).toBe(true);
  });

  it('gives up on a desktop that stays silent with no call on it', async () => {
    audio.captured = false;
    await join();

    await poll(89);
    expect(callService.isActive).toBe(true);
    await poll(1);

    expect(callService.isActive).toBe(false);
    expect(endedEvents()[0]![2]).toMatchObject({ status: 'hung_up' });
  });

  it('ends at the time limit', async () => {
    await join();

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(callService.isActive).toBe(false);
    expect(endedEvents()[0]![2]).toMatchObject({ status: 'timeout' });
  });

  it('ends when the voice session dies', async () => {
    await join();

    latest().onSessionLost('connection_lost');
    await vi.advanceTimersByTimeAsync(0);

    expect(callService.isActive).toBe(false);
    expect(endedEvents()[0]![2]).toMatchObject({ status: 'error' });
  });

  it('ends when the computer audio dies', async () => {
    await join();

    audio.lose('the playback process exited (code 1)');
    await vi.advanceTimersByTimeAsync(0);

    expect(callService.isActive).toBe(false);
    expect(endedEvents()[0]![2]).toMatchObject({ status: 'error' });
  });

  it('has the voice carry on after the user finishes a computer help request', async () => {
    await join();

    callService.continueComputer('Sign in to the call app');

    expect(latest().ask).toHaveBeenLastCalledWith(expect.stringContaining('Sign in to the call app'));
  });

  it('ends on shutdown', async () => {
    await join();

    await callService.shutdown();

    expect(callService.isActive).toBe(false);
    expect(voiceSessionLock.holder).toBeNull();
  });
});
