/**
 * The session owner, with no network and no Realtime socket.
 *
 * The real transport runs here — it is as much the thing under test as the service is —
 * while `VoiceConversation` is a double, so a test can see the audio the service feeds it
 * and can write to the sink the service handed it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaybackSink } from '../../meeting/audio-playback';
import { REALTIME_SAMPLE_RATE } from '../../meeting/resampler';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config', () => ({
  config: { openaiRealtimeVoice: 'marin' },
}));

vi.mock('../voice-instructions', () => ({
  buildVoiceInstructions: vi.fn(async () => ({
    instructions: 'be yourself',
    agentName: 'Prism',
    lockedIn: false,
  })),
}));

vi.mock('../../meeting/tool-bridge', () => ({
  prepareMeetingTools: vi.fn(async () => ({ declarations: [], execute: vi.fn(), count: 3 })),
}));

const trackEvent = vi.fn();
vi.mock('../../../lib/telemetry', () => ({ trackEvent: (...args: unknown[]) => trackEvent(...args) }));

/** Every `VoiceConversation` the service built, newest last. */
const conversations: FakeConversation[] = [];

class FakeConversation {
  readonly pushAudio = vi.fn();
  readonly stop = vi.fn();
  readonly start = vi.fn(async () => {});
  readonly sink: PlaybackSink;
  readonly sampleRate?: number;
  readonly responseMode?: string;
  readonly onSessionLost?: (reason: string) => void;
  readonly statistics = {
    responses: 2,
    toolCalls: 1,
    interruptions: 0,
    utterances: 4,
    responsesFailed: 0,
    suppressed: 3,
    gateCalls: 4,
    gateFailed: 1,
    gateLatencyMs: 900,
  };

  constructor(options: {
    sink: PlaybackSink;
    sampleRate?: number;
    responseMode?: string;
    onSessionLost?: (reason: string) => void;
  }) {
    this.sink = options.sink;
    this.sampleRate = options.sampleRate;
    this.responseMode = options.responseMode;
    this.onSessionLost = options.onSessionLost;
    conversations.push(this);
  }
}

vi.mock('../../meeting/voice-conversation', () => ({ VoiceConversation: FakeConversation }));

const { voiceChatService } = await import('../voice-chat.service');
const { voiceSessionLock } = await import('../voice-session-lock');
const { buildVoiceInstructions } = await import('../voice-instructions');

/** A signal that records everything the service says and sends to the client. */
function fakeSignal() {
  return { sendAudio: vi.fn(), sendClear: vi.fn(), state: vi.fn(), error: vi.fn() };
}

type Signal = ReturnType<typeof fakeSignal>;

/** Start a session and hand back everything the assertions need. */
async function startSession(
  mode?: 'open' | 'addressed',
): Promise<{ signal: Signal; conversation: FakeConversation }> {
  const signal = fakeSignal();
  await voiceChatService.start({
    userId: 'user-1',
    agentId: 'agent-1',
    threadId: 'thread-1',
    mode,
    signal,
  });
  return { signal, conversation: conversations[conversations.length - 1]! };
}

beforeEach(() => {
  conversations.length = 0;
  trackEvent.mockClear();
  vi.mocked(buildVoiceInstructions).mockClear();
});

afterEach(async () => {
  // The lock is one per runtime while these sessions are one per test.
  await voiceChatService.stop();
  voiceSessionLock.release('voice-chat');
  voiceSessionLock.release('meeting');
});

describe('starting a session', () => {
  /**
   * Live at once, and that is the point of the change: the socket that asked is the
   * socket the audio travels on, so there is no media path still to come up. The WebRTC
   * path could not say this — it answered an offer and then waited for ICE, which on a
   * hosted runtime never completed.
   */
  it('reports the session live straight away', async () => {
    const { signal } = await startSession();

    expect(signal.state).toHaveBeenCalledWith('live');
    expect(voiceChatService.isLive).toBe(true);
  });

  it('tells the core the transport already speaks the model rate', async () => {
    const { conversation } = await startSession();
    expect(conversation.sampleRate).toBe(REALTIME_SAMPLE_RATE);
  });

  it('refuses a session while a meeting holds the agent voice', async () => {
    voiceSessionLock.tryAcquire('meeting');

    const { signal } = await startSession();

    expect(signal.error).toHaveBeenCalledWith(expect.stringContaining('meeting call'));
    expect(signal.state).not.toHaveBeenCalled();
    expect(conversations).toHaveLength(0);
  });

  it('refuses a second session while one is live', async () => {
    await startSession();

    const signal = fakeSignal();
    await voiceChatService.start({ userId: 'user-1', agentId: 'agent-1', signal });

    expect(signal.error).toHaveBeenCalledWith(expect.stringContaining('already a voice chat'));
    expect(signal.state).not.toHaveBeenCalled();
  });
});

/**
 * Which utterances the agent answers, which the client picks because it is the only one
 * that knows what its microphone is pointed at: held to an ear, or lying on a table with
 * a meeting going on around it.
 */
describe('the listening mode', () => {
  it('answers everything when the client asks for nothing', async () => {
    const { conversation } = await startSession();

    expect(conversation.responseMode).toBe('open');
    // The default is where the two halves come apart most easily: passing
    // `input.mode` to one and `input.mode ?? 'open'` to the other leaves the prompt
    // reading the `auto` text while the policy runs `open`.
    expect(vi.mocked(buildVoiceInstructions)).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: 'open' }),
    );
  });

  it('gates on being addressed when the client asks for it', async () => {
    const { conversation } = await startSession('addressed');
    expect(conversation.responseMode).toBe('addressed');
  });

  /**
   * The invariant worth a test of its own. The prompt tells the model whether it is being
   * filtered and the policy does the filtering, so a call where the two disagree is one
   * that either explains gaps in a conversation that has none, or waits to be named in a
   * room where nothing will name it.
   */
  it('tells the prompt and the policy the same thing', async () => {
    const { conversation } = await startSession('addressed');

    expect(vi.mocked(buildVoiceInstructions)).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: 'addressed' }),
    );
    expect(conversation.responseMode).toBe('addressed');
  });

  it('reports the mode and the gate numbers to telemetry', async () => {
    await startSession('addressed');
    await voiceChatService.stop();

    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat started',
      'user-1',
      expect.objectContaining({ response_mode: 'addressed' }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat ended',
      'user-1',
      // `gate_failed` is the number that separates an agent nobody addressed from one
      // that could not tell, and the two sound identical from the room.
      expect.objectContaining({
        response_mode: 'addressed',
        suppressed: '3',
        gate_calls: '4',
        gate_failed: '1',
        // The mean of 900ms over 4 verdicts, which is what `meeting ended` reports
        // under this key. A sum here would make the two events incomparable.
        gate_latency_ms: '225',
      }),
    );
  });
});

describe('the audio path', () => {
  it("hands the client's audio to the core untouched", async () => {
    const { conversation } = await startSession();
    const frame = Buffer.from([7, 0, 249, 255, 255, 127]);

    voiceChatService.pushAudio(frame);

    expect(conversation.pushAudio).toHaveBeenCalledTimes(1);
    expect(conversation.pushAudio.mock.calls[0]![0]).toEqual(frame);
  });

  /**
   * pcm16 is two bytes a sample, so a frame with an odd length would shift every sample
   * after it. The WebRTC transport dropped an off-rate frame for the same reason: better
   * a gap than noise.
   */
  it('drops a frame that is not whole samples', async () => {
    const { conversation } = await startSession();
    voiceChatService.pushAudio(Buffer.from([1, 2, 3]));
    expect(conversation.pushAudio).not.toHaveBeenCalled();
  });

  it('sends what the core writes to the client, one frame per write', async () => {
    const { signal, conversation } = await startSession();

    // 20 ms at the model's rate, written the way the playback pacer writes it.
    const speech = Buffer.alloc(960, 3);
    conversation.sink.write(speech);

    expect(signal.sendAudio).toHaveBeenCalledTimes(1);
    expect(signal.sendAudio.mock.calls[0]![0]).toEqual(speech);
  });

  /**
   * The barge-in signal. Everything already written is in the client's buffer, so
   * without this the agent talks over the person who interrupted it.
   */
  it('asks the client to drop unplayed audio when the floor is yielded', async () => {
    const { signal, conversation } = await startSession();

    conversation.sink.clear?.();

    expect(signal.sendClear).toHaveBeenCalledTimes(1);
  });

  it('passes no audio once the session has ended', async () => {
    const { signal, conversation } = await startSession();
    await voiceChatService.stop();

    voiceChatService.pushAudio(Buffer.alloc(320));
    conversation.sink.write(Buffer.alloc(320));

    expect(conversation.pushAudio).not.toHaveBeenCalled();
    expect(signal.sendAudio).not.toHaveBeenCalled();
  });

  it('drops audio arriving when nothing is running', () => {
    expect(() => voiceChatService.pushAudio(Buffer.alloc(320))).not.toThrow();
  });
});

describe('ending a session', () => {
  it('ends on the client asking, and frees the voice', async () => {
    const { signal, conversation } = await startSession();

    await voiceChatService.stop();

    expect(conversation.stop).toHaveBeenCalled();
    expect(signal.state).toHaveBeenCalledWith('ended');
    // Asked for, so nothing failed.
    expect(signal.error).not.toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
  });

  it('ends when the model session dies under it', async () => {
    const { signal, conversation } = await startSession();

    conversation.onSessionLost?.('the model closed the socket');
    await vi.waitFor(() => expect(signal.state).toHaveBeenCalledWith('ended'));

    expect(signal.error).toHaveBeenCalledWith('the model closed the socket');
    expect(voiceSessionLock.holder).toBeNull();
  });

  it('reports the session to telemetry at both ends', async () => {
    await startSession();
    await voiceChatService.stop();

    expect(trackEvent).toHaveBeenCalledWith('voice chat started', 'user-1', {
      tools: '3',
      locked_in: 'false',
      response_mode: 'open',
    });
    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat ended',
      'user-1',
      expect.objectContaining({ status: 'completed', responses: '2', tool_calls: '1', utterances: '4' }),
    );
  });

  it('ends nothing when no session is running', async () => {
    await voiceChatService.stop();

    expect(trackEvent).not.toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
  });
});
