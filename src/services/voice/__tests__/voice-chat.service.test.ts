/**
 * The session owner, with no network and no voice socket.
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
  config: { openaiRealtimeVoice: 'marin', realtimeProvider: 'azure', realtimeSource: 'managed' },
}));

vi.mock('../voice-instructions', () => ({
  buildVoiceInstructions: vi.fn(async () => ({
    instructions: 'be yourself',
    backendInstructions: 'do the work',
    agentName: 'Prism',
    lockedIn: false,
  })),
}));

vi.mock('../../meeting/tool-bridge', () => ({
  prepareMeetingTools: vi.fn(async () => ({ declarations: [], execute: vi.fn(), count: 3 })),
}));
vi.mock('../realtime-tools', () => ({
  prepareRealtimeTools: vi.fn(() => ({ declarations: [], execute: vi.fn(), count: 0 })),
}));
vi.mock('../voice-chat-tools', () => ({
  prepareVoiceChatTools: vi.fn((base: unknown) => base),
  VOICE_CHAT_TRUNCATION_GUIDANCE: 'guidance',
}));

const trackEvent = vi.fn();
vi.mock('../../../lib/telemetry', () => ({ trackEvent: (...args: unknown[]) => trackEvent(...args) }));

/** Every `VoiceConversation` the service built, newest last. */
const conversations: FakeConversation[] = [];

class FakeConversation {
  readonly pushAudio = vi.fn();
  readonly stop = vi.fn(async () => {});
  readonly start = vi.fn(async () => {});
  readonly notify = vi.fn();
  readonly prompt = vi.fn();
  readonly showRecording = vi.fn(() => true);
  readonly stopSpeaking = vi.fn();
  readonly sink: PlaybackSink;
  readonly sampleRate?: number;
  readonly instructions?: string;
  readonly backendInstructions?: string;
  readonly onSessionLost?: (reason: string) => void;
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
    sampleRate?: number;
    instructions?: string;
    backendInstructions?: string;
    onSessionLost?: (reason: string) => void;
  }) {
    this.sink = options.sink;
    this.sampleRate = options.sampleRate;
    this.instructions = options.instructions;
    this.backendInstructions = options.backendInstructions;
    this.onSessionLost = options.onSessionLost;
    conversations.push(this);
  }
}

vi.mock('../../meeting/voice-conversation', () => ({ VoiceConversation: FakeConversation }));

/** Every `AgentComputer` the service built, newest last. */
const computers: FakeComputer[] = [];

/**
 * The agent's computer, without the browser, the desktop or the display it opens.
 *
 * `openBrowser` is what fails on a host that cannot carry one, so a test can make it
 * reject and watch what the service does with the rest of the session.
 */
class FakeComputer {
  static failToOpen: Error | null = null;
  static hasDesktop = true;

  readonly attach = vi.fn();
  readonly stop = vi.fn(async () => {});
  readonly startScreenStream = vi.fn();
  readonly stopScreenStream = vi.fn();
  readonly startBrowserAudio = vi.fn(() => true);
  readonly handleInput = vi.fn();
  readonly width = 1280;
  readonly height = 720;

  constructor() {
    computers.push(this);
  }

  get hasDesktop(): boolean {
    return FakeComputer.hasDesktop;
  }

  async openBrowser(): Promise<void> {
    if (FakeComputer.failToOpen) throw FakeComputer.failToOpen;
  }
}

vi.mock('../../computer/agent-computer', () => ({ AgentComputer: FakeComputer }));
vi.mock('../../../tools/computer', () => ({ getComputerTools: vi.fn(() => ({})) }));
vi.mock('../../computer/supported', () => ({ hasComputer: () => true }));

const { voiceChatService } = await import('../voice-chat.service');
const { computerService } = await import('../../computer/computer.service');
const { voiceSessionLock } = await import('../voice-session-lock');
const { buildVoiceInstructions } = await import('../voice-instructions');

/** A signal that records everything the service says and sends to the client. */
function fakeSignal() {
  return {
    sendAudio: vi.fn(),
    sendClear: vi.fn(),
    state: vi.fn(),
    error: vi.fn(),
  };
}

type Signal = ReturnType<typeof fakeSignal>;

/** Start a session and hand back everything the assertions need. */
async function startSession(): Promise<{ signal: Signal; conversation: FakeConversation }> {
  const signal = fakeSignal();
  await voiceChatService.start({
    userId: 'user-1',
    agentId: 'agent-1',
    threadId: 'thread-1',
    signal,
  });
  return { signal, conversation: conversations[conversations.length - 1]! };
}

/** Start a session with a computer on it, the way the Computer page asks for one. */
async function startWithComputer(): Promise<{ signal: Signal; computer: FakeComputer | undefined }> {
  const signal = fakeSignal();
  await voiceChatService.start({
    userId: 'user-1',
    agentId: 'agent-1',
    signal,
    surface: 'computer',
    computer: true,
    sampleRate: 48_000,
    greeting: 'say hello',
  });
  return { signal, computer: computers[computers.length - 1] };
}

beforeEach(() => {
  conversations.length = 0;
  computers.length = 0;
  FakeComputer.failToOpen = null;
  FakeComputer.hasDesktop = true;
  trackEvent.mockClear();
  vi.mocked(buildVoiceInstructions).mockClear();
});

afterEach(async () => {
  // The lock is one per runtime while these sessions are one per test.
  await voiceChatService.stop();
  voiceSessionLock.release('voice-chat');
  voiceSessionLock.release('meeting');
  await computerService.close();
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

    // A session with no computer says so, since the client uses it to decide whether
    // clicking the screen takes the pointer.
    expect(signal.state).toHaveBeenCalledWith('live', { desktop: false });
    expect(voiceChatService.isLive).toBe(true);
  });

  it('gives the voice and the backend their own instructions', async () => {
    const { conversation } = await startSession();
    expect(conversation.instructions).toBe('be yourself');
    expect(conversation.backendInstructions).toBe('do the work');
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
   * Everything already written is in the client's buffer, so without this the agent keeps
   * talking after it was told to stop.
   */
  it('asks the client to drop unplayed audio when the core flushes', async () => {
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
      inference_provider: 'azure',
      inference_source: 'managed',
      tools: '3',
      locked_in: 'false',
      surface: 'chat',
      computer: 'false',
    });
    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat ended',
      'user-1',
      expect.objectContaining({
        status: 'completed',
        // Which client had the call, and whether it had a computer: the two numbers below
        // read differently for a call spent working on one.
        surface: 'chat',
        computer: 'false',
        delegations: '2',
        tool_calls: '1',
        backend_input_tokens: '1200',
        backend_output_tokens: '80',
        voice_seconds: '42',
        close_reason: 'close_requested',
      }),
    );
  });

  /**
   * A call the user ended and a call whose connection dropped are read differently
   * afterwards, and only the caller knows which of the two it has.
   */
  it('reports the status its caller gave', async () => {
    await startSession();
    await voiceChatService.stop('the client disconnected', 'disconnected');

    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat ended',
      'user-1',
      expect.objectContaining({ status: 'disconnected' }),
    );
  });

  it('ends nothing when no session is running', async () => {
    await voiceChatService.stop();

    expect(trackEvent).not.toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
  });
});

/**
 * The session the Computer page's endpoint asks for. Everything here is a second branch
 * through `start()`, and the computer is a set of processes, so what it costs to get one
 * of these wrong is a desktop left running for the life of the container.
 */
describe('a session with a computer', () => {
  it('opens one and tells the client it has a desktop', async () => {
    const { signal, computer } = await startWithComputer();

    expect(computer).toBeDefined();
    expect(signal.state).toHaveBeenCalledWith('live', { desktop: true });
    // Attached before the model's session opens, so the first tool call has somewhere to
    // put its picture.
    expect(computer!.attach).not.toHaveBeenCalled();
  });

  it('captures the screen only while somebody is watching it', async () => {
    const { computer } = await startWithComputer();

    // Nothing is encoded until a client attaches: the call can be live with nobody
    // looking at the screen, and an encoder running for nobody is a core burned.
    expect(computer!.startScreenStream).not.toHaveBeenCalled();

    const client = { screen: vi.fn(), audio: vi.fn() };
    const detach = await computerService.attach('viewer', client);

    expect(detach).toBeTypeOf('function');
    expect(computer!.startScreenStream).toHaveBeenCalled();
    expect(computer!.startBrowserAudio).toHaveBeenCalled();

    detach!();
    expect(computer!.stopScreenStream).toHaveBeenCalled();
  });

  it('describes the computer to the prompt, so it only names tools the session has', async () => {
    await startWithComputer();

    expect(buildVoiceInstructions).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { kind: 'voice-chat', computer: { desktop: { width: 1280, height: 720 } }, userScreen: true },
      }),
    );
  });

  it('says there is no desktop on a host that owns its own display', async () => {
    FakeComputer.hasDesktop = false;
    const { signal } = await startWithComputer();

    // The browser opened in the operator's own session, so nothing here may take its
    // pointer, and the prompt is not given the desktop rules.
    expect(signal.state).toHaveBeenCalledWith('live', { desktop: false });
    expect(buildVoiceInstructions).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { kind: 'voice-chat', computer: { desktop: null }, userScreen: true },
      }),
    );
  });

  it("speaks the rate the client asked for rather than the model's own", async () => {
    await startWithComputer();
    expect(conversations[conversations.length - 1]!.sampleRate).toBe(48_000);
  });

  it('greets the client, since it opened a page rather than pressed a button', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;
    expect(conversation.prompt).toHaveBeenCalledWith('say hello');
  });

  it('refuses in words when the computer will not open, and holds no voice after', async () => {
    FakeComputer.failToOpen = new Error('this image lacks the desktop packages');
    const { signal, computer } = await startWithComputer();

    expect(signal.error).toHaveBeenCalledWith(
      expect.stringContaining('this image lacks the desktop packages'),
    );
    expect(signal.state).not.toHaveBeenCalled();
    expect(voiceChatService.isLive).toBe(false);
    expect(voiceSessionLock.holder).toBeNull();
    // Nothing was built beyond the computer, and the computer itself is released: it may
    // have got a display up before the browser failed.
    expect(computer!.stop).toHaveBeenCalled();
    expect(conversations).toHaveLength(0);
  });

  it('keeps the computer running when the voice session ends', async () => {
    const { computer } = await startWithComputer();
    expect(computer!.stop).not.toHaveBeenCalled();

    await voiceChatService.stop();

    expect(computer!.stop).not.toHaveBeenCalled();
    expect(voiceSessionLock.holder).toBeNull();
  });

  it('keeps the computer when the voice client leaves during startup', async () => {
    const signal = fakeSignal();
    const starting = voiceChatService.start({
      userId: 'user-1',
      agentId: 'agent-1',
      signal,
      surface: 'computer',
      computer: true,
    });
    // The page closed while the computer was still coming up. Nothing is waiting for the
    // session, and a computer left running would cost the host a whole desktop.
    await voiceChatService.stop('the client disconnected', 'disconnected');
    await starting;

    expect(computers[0]!.stop).not.toHaveBeenCalled();
    expect(voiceChatService.isLive).toBe(false);
    expect(voiceSessionLock.holder).toBeNull();
  });

  it('reports the surface and the computer in telemetry', async () => {
    await startWithComputer();
    await voiceChatService.stop();

    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat started',
      'user-1',
      expect.objectContaining({ surface: 'computer', computer: 'true' }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'voice chat ended',
      'user-1',
      expect.objectContaining({ surface: 'computer', computer: 'true' }),
    );
  });

});

/**
 * A recording of the user's screen belongs to the call the Computer page started: the
 * user talks the call's voice through it, and its pictures go to that call's backend. The desktop outlives any one
 * call, so the recorder lives with the session rather than with the computer.
 */
describe('a recording of the user\'s screen', () => {
  const ack = () => {};

  /** A frame of the microphone, as the client sends it at the computer page's rate. */
  const frame = () => Buffer.alloc(960, 1);

  it('lets the voice hear the narration while one runs', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);
    voiceChatService.pushAudio(frame());

    // The backend is given pictures only, so the words have to reach the voice live.
    expect(conversation.pushAudio).toHaveBeenCalledTimes(1);
    expect(conversation.notify).toHaveBeenCalledWith(expect.stringContaining('say nothing until they stop'));
  });

  /**
   * An answer already in the air plays over the demonstration, which is the opposite of
   * what a recording promises. Notifying the model is not enough on its own: that adds
   * context rather than ending the turn it is already speaking.
   */
  it('cuts an answer short when a recording begins', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;
    // The session greets on start, so the note below is the only one this asserts on.
    conversation.notify.mockClear();

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);

    expect(conversation.stopSpeaking).toHaveBeenCalledTimes(1);
    // Before the note, so the model is not told to wait by a turn it is still finishing.
    expect(conversation.stopSpeaking.mock.invocationCallOrder[0]).toBeLessThan(
      conversation.notify.mock.invocationCallOrder[0]!,
    );
  });

  /** The page opens its microphone on this, and not before. */
  it('answers the page on the socket the request came in on', async () => {
    await startWithComputer();
    const acknowledge = vi.fn();

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, acknowledge);
    expect(acknowledge).toHaveBeenCalledTimes(1);

    // A page repeating itself is not a second recording, and is not answered twice.
    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, acknowledge);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('hands the pictures to the model when it stops', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);
    voiceChatService.pushAudio(frame());
    voiceChatService.handleRecordingFrame(
      'client-1',
      { type: 'recording_frame', data: Buffer.from('a picture').toString('base64'), at: 0 },
      ack,
    );
    voiceChatService.handleRecordingFrame(
      'client-1',
      { type: 'recording_stopped', ms: 4_000, reason: 'user' },
      ack,
    );

    expect(conversation.showRecording).toHaveBeenCalledTimes(1);
    const [segments, note] = conversation.showRecording.mock.calls[0]!;
    expect(segments).toEqual([{ label: '0:00', images: [expect.stringMatching(/^data:image\/jpeg;base64,/)] }]);
    expect(note).toContain('recorded their own screen');
  });

  /** The narration reached the voice live, so a recording with no pictures lost only those. */
  it('reports only the missing pictures when a narrated recording kept none', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);
    voiceChatService.pushAudio(frame());
    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_stopped', ms: 4_000, reason: 'user' }, ack);

    expect(conversation.showRecording).not.toHaveBeenCalled();
    const note = String(conversation.notify.mock.calls.at(-1)?.[0]);
    expect(note).toContain('no picture of their screen came through');
    expect(note).not.toMatch(/nothing said/);
  });

  /**
   * The pictures and the end were going to arrive on that socket. Left running, the voice
   * would stay quiet for the rest of the call, waiting for a hand-over nobody can send.
   */
  it('drops a recording whose page has gone, and tells the voice', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;
    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);

    voiceChatService.releaseRecordingClient('client-1');

    expect(conversation.notify).toHaveBeenCalledWith(expect.stringContaining('recording is gone'));
  });

  it('leaves a recording alone when another page goes', async () => {
    await startWithComputer();
    const conversation = conversations[conversations.length - 1]!;
    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, ack);

    voiceChatService.releaseRecordingClient('client-2');

    expect(conversation.notify).not.toHaveBeenCalledWith(expect.stringContaining('recording is gone'));
  });

  it('has no recording to run when the session has no computer', async () => {
    const { conversation } = await startSession();
    const acknowledge = vi.fn();

    voiceChatService.handleRecordingFrame('client-1', { type: 'recording_started' }, acknowledge);

    expect(acknowledge).not.toHaveBeenCalled();
    voiceChatService.pushAudio(Buffer.alloc(960, 1));
    expect(conversation.pushAudio).toHaveBeenCalledTimes(1);
  });
});
