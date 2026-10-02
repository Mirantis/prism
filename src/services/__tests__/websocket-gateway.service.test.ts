/**
 * WebSocket Gateway Service Tests: voice and dictation on the chat socket.
 *
 * Calls and dictations keep their frames under protocol v2; only the envelope
 * gained an id. The protocol itself — hello, resume, requests and their answers —
 * is covered against real sockets in `websocket-gateway.protocol.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockConfig,
  mockVoice,
  mockComputerAccess,
  mockDictations,
  mockRealtime,
} = vi.hoisted(() => {
  const computerListeners: Array<() => void> = [];
  return {
    mockComputerAccess: {
      on: (_event: string, cb: () => void) => {
        computerListeners.push(cb);
      },
    },
    // Every dictation the gateway built, with the options it was built with, so a test
    // can drive its signal and see what reached it.
    mockDictations: [] as Array<{
      options: { userId: string; signal: Record<string, (text?: string) => void>; onEnd?: () => void };
      start: ReturnType<typeof vi.fn>;
      pushAudio: ReturnType<typeof vi.fn>;
      commit: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    }>,
    mockRealtime: { configured: true },
    // The voice session owner. The gateway carries its control frames and its
    // audio, so what a test asserts here is what goes to which socket.
    mockVoice: {
      start: vi.fn(),
      pushAudio: vi.fn(),
      stop: vi.fn(),
      // The rate the session speaks, which the gateway states in `voice_hello`. A
      // computer raises it; the default is the model's own.
      sampleRate: 24_000,
    },
    mockConfig: {
      agentId: undefined as string | undefined,
      codingAgent: 'claude-code',
      availableCodingAgents: ['claude-code'],
      ownerUserId: '00000000-0000-0000-0000-000000000001',
    },
  };
});

vi.mock('../inbound-message.service', () => ({
  inboundMessageService: { accept: vi.fn(), cancel: vi.fn(), turns: () => [] },
  InboundMessageError: class extends Error {},
}));

vi.mock('../conversation.service', () => ({
  conversationService: { events: { on: vi.fn() } },
}));

vi.mock('../thread-title.service', () => ({
  threadTitleService: { events: { on: vi.fn() }, onFirstUserMessage: vi.fn() },
}));

vi.mock('../../config', () => ({
  CODING_AGENTS: ['claude-code', 'codex'],
  config: mockConfig,
}));

vi.mock('../voice/voice-chat.service', () => ({
  voiceChatService: mockVoice,
}));

vi.mock('../voice/dictation-session', () => ({
  DictationSession: class {
    start = vi.fn(() => Promise.resolve(true));
    pushAudio = vi.fn();
    commit = vi.fn();
    cancel = vi.fn();
    constructor(readonly options: never) {
      mockDictations.push(this as never);
    }
  },
}));

vi.mock('../meeting/openai-endpoint', () => ({
  isRealtimeConfigured: () => mockRealtime.configured,
}));

// Stubbed rather than driven for real: `computer.service` imports the browser
// automation the desktop runs on, which a unit test must not load.
vi.mock('../computer/computer.service', () => ({
  computerService: { access: mockComputerAccess, status: vi.fn() },
}));

vi.mock('../computer/computer-help.service', () => ({
  computerHelpService: { list: vi.fn() },
  HELP_ANSWER_WAIT_MS: 30 * 60_000,
}));

// Import after mocking
import { webSocketGatewayService } from '../websocket-gateway.service';
import { threadTitleService } from '../thread-title.service';
import { conversationService } from '../conversation.service';
import { contextUsageService } from '../context-usage.service';
import { compactionService } from '../compaction.service';
import { eventStreamService } from '../event-stream.service';

// The gateway subscribes at import; keep the listeners before `clearAllMocks` drops the calls.
const titleListener = vi.mocked(threadTitleService.events.on).mock.calls[0]![1] as (change: unknown) => void;
const threadListener = vi.mocked(conversationService.events.on).mock.calls[0]![1] as (created: unknown) => void;

// Access internal state for testing
const service = webSocketGatewayService as any;

function createMockWebSocket() {
  const listeners: Record<string, Function[]> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, callback: Function) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    readyState: 1, // OPEN
    // What `ws` reports as still unsent. The voice path reads it before every frame of
    // the agent's speech, so a test that stalls a client sets it.
    bufferedAmount: 0,
    isAlive: true,
  };
}

describe('Requirement: WebSocket Gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.agentId = 'agent-123';

    service.connections = [];
    service.voiceSocket = null;
    service.voiceStarting = null;
    service.dictations = new Map();
    mockDictations.length = 0;
    mockRealtime.configured = true;

    // The session opens, which is the case every voice test but the refusal wants.
    mockVoice.start.mockResolvedValue(true);
    mockVoice.stop.mockResolvedValue(undefined);
    mockVoice.pushAudio.mockReturnValue(undefined);
  });

  describe('Scenario: Voice over the socket', () => {
    type MockSocket = ReturnType<typeof createMockWebSocket>;

    /** Deliver a control frame the way a client's message does. */
    async function frame(ws: MockSocket, message: unknown): Promise<void> {
      await service.dispatch(ws, { id: 'req-1', payload: {}, ...(message as object) });
    }

    /** Deliver one binary audio frame, as `ws` reports it. */
    function audio(ws: MockSocket, pcm: Buffer): void {
      service.handleBinary(ws, pcm);
    }

    /** The signal the gateway handed the voice service for its nth request. */
    function signalOf(call = 0) {
      return mockVoice.start.mock.calls[call]![0].signal;
    }

    /** What the socket was sent last, as the object it was sent as. */
    function lastSent(ws: MockSocket): unknown {
      const calls = ws.send.mock.calls;
      return JSON.parse(calls[calls.length - 1]![0] as string);
    }

    it('opens a session and tells the client the audio format', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { threadId: 'thread-1' } });

      expect(mockVoice.start).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockConfig.ownerUserId, agentId: 'agent-123', threadId: 'thread-1' })
      );
      expect(lastSent(ws)).toEqual({
        type: 'voice_hello',
        payload: { format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
      });
    });

    it('passes the listening mode the client asked for', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: 'addressed' } });

      expect(mockVoice.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'addressed' })
      );
    });

    it('leaves the mode unstated when the client omits it', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledWith(expect.objectContaining({ mode: undefined }));
    });

    /**
     * Refused rather than defaulted, unlike every other field in this payload. `open`
     * answers every utterance in the room and an answer can be a tool call, so a client
     * that means `addressed` and misspells it would otherwise get an agent talking over
     * a meeting with nothing in the frames to say why.
     */
    it('refuses a mode it does not serve, and starts nothing', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: 'adressed' } });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'mode must be "open" or "addressed"' },
      });
    });

    /**
     * `null` is a field the client sent, not a field it left out, and the two mean
     * different things here: a client that serialized its state and got `null` asked for
     * something, and `open` answers a whole room.
     */
    it('refuses a null mode rather than taking the default', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: null } });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'mode must be "open" or "addressed"' },
      });
    });

    it('carries the session state, its errors and the clear back', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();

      signal.state('live');
      expect(lastSent(ws)).toEqual({ type: 'voice_state', payload: { state: 'live' } });

      signal.sendClear();
      expect(lastSent(ws)).toEqual({ type: 'voice_clear' });

      signal.error('the model closed the socket');
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'the model closed the socket' },
      });

      signal.state('ended');
      expect(lastSent(ws)).toEqual({ type: 'voice_state', payload: { state: 'ended' } });
      // The session is over, so this socket's close no longer ends anything.
      expect(service.voiceSocket).toBeNull();
    });

    /** The agent's speech is binary, and must not be JSON-encoded on the way out. */
    it('sends the agent audio as a binary frame', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const speech = Buffer.alloc(960, 5);

      signalOf().sendAudio(speech);

      const [payload, options] = ws.send.mock.calls[ws.send.mock.calls.length - 1]!;
      expect(payload).toEqual(speech);
      expect(options).toEqual({ binary: true });
    });

    it('says nothing on a socket the client has closed', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();
      ws.send.mockClear();
      ws.readyState = 3; // CLOSED

      signal.state('live');
      signal.sendAudio(Buffer.alloc(320));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('refuses a session while the runtime is still starting up', async () => {
      mockConfig.agentId = undefined;
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'Agent runtime is still initializing; retry shortly' },
      });
    });

    it("hands the holder's audio to the session", async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });
      const pcm = Buffer.alloc(480, 1);

      audio(owner, pcm);

      expect(mockVoice.pushAudio).toHaveBeenCalledWith(pcm);
    });

    /**
     * A second client refused the session keeps its microphone open, and its frames
     * are not this call's audio.
     */
    it('drops audio from a socket that does not hold the session', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });
      audio(other, Buffer.alloc(480));

      expect(mockVoice.pushAudio).not.toHaveBeenCalled();
    });

    /**
     * Refused by the gateway rather than by the voice service, and told apart from a
     * client's own second attempt: one person has a call to end, the other has somebody
     * to go and find.
     */
    it('refuses a second client and leaves the running call alone', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });
      expect(mockVoice.start).toHaveBeenCalledTimes(1);

      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(lastSent(other)).toEqual({
        type: 'voice_error',
        payload: { error: 'There is already a voice chat running. End that one first.' },
      });
      // The refused socket did not take the field the audio path reads.
      expect(service.voiceSocket).toBe(owner);
    });

    /**
     * The client's first frames can arrive before `start()` returns: the service reports
     * `live` from inside it. Audio dropped in that window is audio the model never hears.
     */
    it('takes the holder\'s audio from the moment the session reports live', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      const pcm = Buffer.alloc(480, 7);
      audio(ws, pcm);

      expect(mockVoice.pushAudio).toHaveBeenCalledWith(pcm);

      answer(true);
      await opening;
    });

    /**
     * A client that is not draining gets a gap rather than a growing queue: what is
     * already buffered plays late, and adding to it makes the lag permanent.
     */
    it('drops the agent speech a stalled client has not taken', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();
      ws.send.mockClear();

      ws.bufferedAmount = 200_000;
      signal.sendAudio(Buffer.alloc(960));
      expect(ws.send).not.toHaveBeenCalled();

      ws.bufferedAmount = 0;
      signal.sendAudio(Buffer.alloc(960));
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('drops audio when no session is running', () => {
      const ws = createMockWebSocket();
      expect(() => audio(ws, Buffer.alloc(480))).not.toThrow();
      expect(mockVoice.pushAudio).not.toHaveBeenCalled();
    });

    it('ends a session whose client asked to stop before it opened', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_stop' });
      answer(true);
      await opening;

      // The client asked, so the call is completed rather than dropped.
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'completed',
      );
      // Nothing to end later, and nothing holding the next caller out: the session never
      // became this socket's.
      expect(service.voiceSocket).toBeNull();
    });

    /**
     * Two starts and a stop, all inside the startup window. The second start is refused
     * before it reaches the service, so the one record the stop cancels is the session
     * this socket is really opening. Held per socket rather than per request, since a
     * record per request would let the stop land on the later one, which has nothing to
     * end, while the earlier one went live behind it.
     */
    it('honours a stop after a second start landed inside the startup window', async () => {
      const ws = createMockWebSocket();
      const answers: Array<(started: boolean) => void> = [];
      mockVoice.start.mockImplementation(
        () => new Promise<boolean>((resolve) => answers.push(resolve)),
      );

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      const second = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_stop' });
      answers.forEach((resolve) => resolve(true));
      await Promise.all([opening, second]);

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'completed',
      );
      expect(service.voiceSocket).toBeNull();
    });

    it('refuses a second start on the socket whose session is still opening', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'A voice chat is already running on this connection. Stop it first.' },
      });

      answer(true);
      await opening;
    });

    /**
     * The claim is taken before the service is asked, so a refusal — a meeting holding the
     * agent's voice, say — has to give it back. A claim left standing would refuse every
     * later call for the life of the process, with the gateway's own message rather than
     * the reason the service gave.
     */
    it('gives the claim back when the service refuses the session', async () => {
      const ws = createMockWebSocket();
      mockVoice.start.mockResolvedValue(false);

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(service.voiceSocket).toBeNull();

      mockVoice.start.mockResolvedValue(true);
      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(2);
      expect(service.voiceSocket).toBe(ws);
    });

    it('ends a session whose client went away before it opened', async () => {
      const ws = createMockWebSocket();
      service.handleConnection(ws, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      ws.emit('close', 1001);
      answer(true);
      await opening;

      // Nobody asked for this ending, so it is reported as the connection dropping.
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'disconnected',
      );
      // Ended once, by whoever knew there was a session to end.
      expect(mockVoice.stop).toHaveBeenCalledTimes(1);
      expect(service.voiceSocket).toBeNull();
    });

    it('ends the session for the socket that opened it, and for no other', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      // A second client is refused the session, so its stop is not the owner's.
      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });
      // And the refusal left the session where it was.
      expect(service.voiceSocket).toBe(owner);

      await frame(other, { type: 'voice_stop' });
      expect(mockVoice.stop).not.toHaveBeenCalled();

      await frame(owner, { type: 'voice_stop' });
      expect(mockVoice.stop).toHaveBeenCalledTimes(1);
    });

    it('ends the session when the socket that opened it goes away', async () => {
      const ws = createMockWebSocket();
      service.handleConnection(ws, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      await frame(ws, { type: 'voice_start', payload: {} });

      ws.emit('close', 1000);

      expect(mockVoice.stop).toHaveBeenCalledWith('the client disconnected', 'disconnected');
      expect(service.voiceSocket).toBeNull();
    });

    it('leaves the session alone when another socket goes away', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      const other = createMockWebSocket();
      service.handleConnection(other, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      other.emit('close', 1000);

      expect(mockVoice.stop).not.toHaveBeenCalled();
      expect(service.voiceSocket).toBe(owner);
    });
  });

  describe('Scenario: Dictation over the socket', () => {
    type MockSocket = ReturnType<typeof createMockWebSocket>;

    async function frame(ws: MockSocket, message: unknown): Promise<void> {
      await service.dispatch(ws, { id: 'req-1', payload: {}, ...(message as object) });
    }

    function sent(ws: MockSocket): unknown[] {
      return ws.send.mock.calls
        .filter((call) => typeof call[0] === 'string')
        .map((call) => JSON.parse(call[0] as string));
    }

    it('starts a dictation and answers the format once the transcriber is ready', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'dictation_start', payload: {} });

      expect(mockDictations).toHaveLength(1);
      expect(mockDictations[0]!.start).toHaveBeenCalledTimes(1);
      mockDictations[0]!.options.signal.ready!();

      expect(sent(ws).at(-1)).toEqual({
        type: 'dictation_hello',
        payload: { format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
      });
    });

    it('routes the socket audio to its dictation, never to a voice chat', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'dictation_start', payload: {} });

      service.handleBinary(ws, Buffer.alloc(960));

      expect(mockDictations[0]!.pushAudio).toHaveBeenCalledTimes(1);
      expect(mockVoice.pushAudio).not.toHaveBeenCalled();
    });

    it('commits on stop, and cancels on a stop that says not to', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'dictation_start', payload: {} });
      await frame(ws, { type: 'dictation_stop', payload: { commit: true } });
      expect(mockDictations[0]!.commit).toHaveBeenCalledTimes(1);

      const other = createMockWebSocket();
      await frame(other, { type: 'dictation_start', payload: {} });
      await frame(other, { type: 'dictation_stop', payload: { commit: false } });
      expect(mockDictations[1]!.cancel).toHaveBeenCalledTimes(1);
      expect(mockDictations[1]!.commit).not.toHaveBeenCalled();
    });

    it('carries the transcript and errors to the socket that asked', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'dictation_start', payload: {} });
      const signal = mockDictations[0]!.options.signal;

      signal.delta!('Hel');
      signal.result!('Hello.');
      signal.error!('Transcription failed.');

      expect(sent(ws).slice(-3)).toEqual([
        { type: 'dictation_delta', payload: { text: 'Hel' } },
        { type: 'dictation_result', payload: { text: 'Hello.' } },
        { type: 'dictation_error', payload: { error: 'Transcription failed.' } },
      ]);
    });

    it('frees the socket for another dictation once one ends', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'dictation_start', payload: {} });
      await frame(ws, { type: 'dictation_start', payload: {} });
      expect(sent(ws).at(-1)).toEqual({
        type: 'dictation_error',
        payload: { error: 'A dictation is already running on this connection.' },
      });

      mockDictations[0]!.options.onEnd!();
      await frame(ws, { type: 'dictation_start', payload: {} });
      expect(mockDictations).toHaveLength(2);
    });

    it('cancels the dictation of a socket that goes away', async () => {
      const ws = createMockWebSocket();
      service.handleConnection(ws, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      await frame(ws, { type: 'dictation_start', payload: {} });

      ws.emit('close', 1001);

      expect(mockDictations[0]!.cancel).toHaveBeenCalledWith('disconnected');
    });

    it('refuses a dictation on a socket with a voice chat, and the reverse', async () => {
      const calling = createMockWebSocket();
      await frame(calling, { type: 'voice_start', payload: {} });
      await frame(calling, { type: 'dictation_start', payload: {} });
      expect(mockDictations).toHaveLength(0);
      expect(sent(calling).at(-1)).toEqual({
        type: 'dictation_error',
        payload: { error: 'A voice chat is running on this connection. End it first.' },
      });

      const dictating = createMockWebSocket();
      await frame(dictating, { type: 'dictation_start', payload: {} });
      await frame(dictating, { type: 'voice_start', payload: {} });
      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(sent(dictating).at(-1)).toEqual({
        type: 'voice_error',
        payload: { error: 'A dictation is running on this connection. Finish it first.' },
      });
    });

    it('starts a dictation while another socket holds the voice chat', async () => {
      const calling = createMockWebSocket();
      await frame(calling, { type: 'voice_start', payload: {} });

      const dictating = createMockWebSocket();
      await frame(dictating, { type: 'dictation_start', payload: {} });

      expect(mockDictations).toHaveLength(1);
    });

    it('refuses a dictation when the agent has no voice provider', async () => {
      mockRealtime.configured = false;
      const ws = createMockWebSocket();

      await frame(ws, { type: 'dictation_start', payload: {} });

      expect(mockDictations).toHaveLength(0);
      expect(sent(ws).at(-1)).toEqual({
        type: 'dictation_error',
        payload: { error: 'Dictation needs a managed voice provider for this agent.' },
      });
    });
  });

  describe('Scenario: a conversation stored under a user id other than the owner', () => {
    it('puts its title, creation, context and compaction on the stream', () => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const stop = eventStreamService.subscribe((entry) => {
        const { type, payload } = entry.event;
        events.push({ type, payload });
      });
      const userId = 'agent-record-user';
      const createdAt = new Date('2026-10-02T09:00:00.000Z');

      titleListener({ userId, threadId: 'thread-1', title: 'Hello' });
      threadListener({ userId, threadId: 'thread-1', title: null, createdAt });
      contextUsageService.events.emit('usage', { userId, threadId: 'thread-1', usedTokens: 10 });
      compactionService.events.emit('compaction', { userId, threadId: 'thread-1', status: 'completed' });
      stop();

      expect(events).toEqual([
        { type: 'thread', payload: { threadId: 'thread-1', title: 'Hello' } },
        { type: 'thread', payload: { threadId: 'thread-1', title: null, createdAt: createdAt.toISOString() } },
        { type: 'context', payload: { threadId: 'thread-1', usedTokens: 10 } },
        { type: 'compaction', payload: { threadId: 'thread-1', status: 'completed' } },
      ]);
    });
  });
});
