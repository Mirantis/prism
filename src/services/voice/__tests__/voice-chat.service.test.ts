/**
 * The session owner, driven against a stub peer: no ICE, no DTLS, no network, and no
 * Realtime socket.
 *
 * The real transport runs here — it is the thing under test as much as the service is —
 * while `VoiceConversation` is a double, so a test can see the audio the service feeds it
 * and can write to the sink the service handed it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fakeWrtcModule,
  lastFakePeer,
  lastFakeSource,
  resetFakeWrtc,
  type FakeAudioSink,
} from '../../../test-utils/fake-wrtc';
import type { PlaybackSink } from '../../meeting/audio-playback';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config', () => ({
  config: { voiceIceServers: [], openaiRealtimeVoice: 'marin' },
}));

vi.mock('@roamhq/wrtc', () => fakeWrtcModule);

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
  readonly onSessionLost?: (reason: string) => void;
  readonly statistics = {
    responses: 2,
    toolCalls: 1,
    interruptions: 0,
    utterances: 4,
    responsesFailed: 0,
  };

  constructor(options: { sink: PlaybackSink; onSessionLost?: (reason: string) => void }) {
    this.sink = options.sink;
    this.onSessionLost = options.onSessionLost;
    conversations.push(this);
  }
}

vi.mock('../../meeting/voice-conversation', () => ({ VoiceConversation: FakeConversation }));

const { voiceChatService } = await import('../voice-chat.service');
const { voiceSessionLock } = await import('../voice-session-lock');

/** A signal that records everything the service says to the client. */
function fakeSignal() {
  return { answer: vi.fn(), iceCandidate: vi.fn(), state: vi.fn(), error: vi.fn() };
}

type Signal = ReturnType<typeof fakeSignal>;

/** Start a session and hand back everything the assertions need. */
async function startSession(): Promise<{ signal: Signal; conversation: FakeConversation }> {
  const signal = fakeSignal();
  await voiceChatService.start({
    userId: 'user-1',
    agentId: 'agent-1',
    threadId: 'thread-1',
    offerSdp: 'v=0\r\noffer',
    signal,
  });
  return { signal, conversation: conversations[conversations.length - 1]! };
}

/** The client's microphone track arrives, and the transport attaches a sink to it. */
function clientSendsAudio(): FakeAudioSink {
  return lastFakePeer().addRemoteTrack();
}

beforeEach(() => {
  resetFakeWrtc();
  conversations.length = 0;
  trackEvent.mockClear();
});

afterEach(async () => {
  // The lock is one per runtime while these sessions are one per test.
  await voiceChatService.stop();
  voiceSessionLock.release('voice-chat');
  voiceSessionLock.release('meeting');
});

describe('starting a session', () => {
  it('answers the offer and reports the session live once the peer connects', async () => {
    const { signal } = await startSession();

    expect(signal.answer).toHaveBeenCalledWith('v=0\r\nanswer');
    expect(signal.state).not.toHaveBeenCalled();

    lastFakePeer().becomes('connected');
    expect(signal.state).toHaveBeenCalledWith('live');
    expect(voiceChatService.isLive).toBe(true);
  });

  it('holds its candidates until the client has the answer', async () => {
    const signal = fakeSignal();
    // The peer gathers while the answer is still being built, and a client cannot add a
    // candidate before it has the answer.
    signal.answer.mockImplementation(() => {
      expect(signal.iceCandidate).not.toHaveBeenCalled();
    });

    await voiceChatService.start({
      userId: 'user-1',
      agentId: 'agent-1',
      offerSdp: 'v=0\r\noffer',
      signal,
    });

    expect(signal.answer).toHaveBeenCalled();
    expect(signal.iceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: expect.stringContaining('typ host') }),
    );
  });

  it('refuses a session while a meeting holds the agent voice', async () => {
    voiceSessionLock.tryAcquire('meeting');

    const { signal } = await startSession();

    expect(signal.error).toHaveBeenCalledWith(expect.stringContaining('meeting call'));
    expect(signal.answer).not.toHaveBeenCalled();
    expect(conversations).toHaveLength(0);
  });

  it('refuses a second session while one is live', async () => {
    await startSession();

    const { signal } = await startSession();

    expect(signal.error).toHaveBeenCalledWith(expect.stringContaining('already a voice chat'));
    expect(signal.answer).not.toHaveBeenCalled();
  });
});

describe('the audio path', () => {
  it("hands the client's audio to the core as pcm16 mono at 48 kHz", async () => {
    const { conversation } = await startSession();
    const sink = clientSendsAudio();

    // Every session opens with a couple of 16 kHz silent frames, which the core cannot take.
    sink.deliver(new Int16Array(160), 16_000);
    expect(conversation.pushAudio).not.toHaveBeenCalled();

    const samples = new Int16Array([7, -7, 32_767]);
    sink.deliver(samples);

    expect(conversation.pushAudio).toHaveBeenCalledTimes(1);
    expect(conversation.pushAudio.mock.calls[0]![0]).toEqual(Buffer.copyBytesFrom(samples));
  });

  it('sends what the core writes out on the outbound track', async () => {
    const { conversation } = await startSession();

    // 20 ms of speech, written the way the playback pacer writes it.
    conversation.sink.write(Buffer.alloc(1920, 3));

    const frames = lastFakeSource().frames;
    expect(frames).toHaveLength(2);
    expect(frames[0]!.samples).toHaveLength(480);
    expect(frames[0]!.sampleRate).toBe(48_000);
    expect(frames[0]!.samples[0]).toBe(0x0303);
  });
});

describe('ending a session', () => {
  // A client that walks away leaves the peer `disconnected`; a path that breaks under a
  // live call leaves it `failed`. Both end the session and give the voice back.
  it.each(['disconnected', 'failed'])('tears the session down when the peer is %s', async (state) => {
    const { signal, conversation } = await startSession();
    clientSendsAudio();
    const peer = lastFakePeer();

    peer.becomes(state);
    // The ending awaits the peer's close, so let it run.
    await vi.waitFor(() => expect(signal.state).toHaveBeenCalledWith('ended'));

    expect(conversation.stop).toHaveBeenCalled();
    expect(peer.closed).toBe(true);
    expect(signal.error).toHaveBeenCalledWith(`the media connection is ${state}`);
    expect(voiceSessionLock.holder).toBeNull();
    expect(voiceChatService.isLive).toBe(false);
  });

  it('ends on the client asking, and frees the voice', async () => {
    const { signal, conversation } = await startSession();

    await voiceChatService.stop();

    expect(conversation.stop).toHaveBeenCalled();
    expect(lastFakePeer().closed).toBe(true);
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
