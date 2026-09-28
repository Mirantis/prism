/**
 * The conversation core, against a local GPT-Live server.
 *
 * Run against a real socket rather than a mocked session, because the distinctions
 * tested here — a close the server started versus one we asked for, what reaches the
 * wire and in which order — only exist at the socket level.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { VoiceConversation } from '../voice-conversation';
import { MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE } from '../resampler';
import type { SpeakerReading } from '../meeting-provider.interface';
import { inferenceGate } from '../../../lib/inference-gate';
import {
  functionCallEvent,
  responseCompletedEvent,
  startLiveServer,
  type LiveServer,
} from '../../../test-utils/live-server';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Harness {
  conversation: VoiceConversation;
  server: LiveServer;
  lost: string[];
  written: Buffer[];
  execute: ReturnType<typeof vi.fn>;
  finished: ReturnType<typeof vi.fn>;
}

let active: Harness | null = null;

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(config).meetingTranscriptLogging = 'off';
});

afterEach(async () => {
  await active?.conversation.stop();
  await active?.server.dispose();
  active = null;
});

async function harness(sampleRate = MEETING_SAMPLE_RATE): Promise<Harness> {
  const server = await startLiveServer();
  const lost: string[] = [];
  const written: Buffer[] = [];
  const execute = vi.fn(async () => '{"ok":true}');
  const finished = vi.fn();
  const conversation = new VoiceConversation({
    instructions: 'You are Prism, the voice.',
    backendInstructions: 'You are Prism, the backend.',
    tools: { declarations: [], count: 0, execute },
    sink: { write: (chunk: Buffer) => void written.push(chunk) },
    agentName: 'Prism',
    sampleRate,
    endpointOverride: { url: server.url, headers: {} },
    onSessionLost: (reason) => lost.push(reason),
    onResponseFinished: finished,
  });
  await conversation.start();
  active = { conversation, server, lost, written, execute, finished };
  return active;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function reading(name: string, id = `devices/${name}`): SpeakerReading {
  return { id, isSelf: false, who: { kind: 'person', name } };
}

/** Every context append on the wire, as `type: content`. */
function appends(server: LiveServer, type: string): string[] {
  return server.sent.filter((f) => f.type === type).map((f) => String(f.content));
}

describe('losing the voice session', () => {
  it('reports a close the server started', async () => {
    const h = await harness();

    h.server.closeWith('expired');
    await settle();

    expect(h.lost).toEqual(['expired']);
  });

  it('says nothing about a close it asked for itself', async () => {
    const h = await harness();

    await h.conversation.stop();

    expect(h.lost).toEqual([]);
  });

  it('keeps the API close reason and the billed voice time for telemetry', async () => {
    const h = await harness();

    await h.conversation.stop();

    expect(h.conversation.statistics).toMatchObject({ closeReason: 'close_requested', voiceSeconds: 42 });
  });
});

describe('running the tools the backend calls', () => {
  it('runs a call and hands its result back', async () => {
    const h = await harness();

    h.server.emit(functionCallEvent('call_1', 'memory_search', '{"query":"deploys"}'));
    h.server.emit(responseCompletedEvent());
    await h.server.waitFor((f) => f.type === 'response.create');

    expect(h.execute).toHaveBeenCalledWith('memory_search', '{"query":"deploys"}');
    expect(h.server.sent.find((f) => f.type === 'response.item.create')?.item).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"ok":true}',
    });
    expect(h.conversation.statistics).toMatchObject({ toolCalls: 1, backendInputTokens: 800, backendOutputTokens: 14 });
  });

  it('holds a call while the computer is held for a secure sign-in, and runs it after', async () => {
    const h = await harness();
    inferenceGate.hold();
    try {
      h.server.emit(functionCallEvent('call_1', 'shell_exec', '{"command":"ls"}'));
      h.server.emit(responseCompletedEvent());
      await settle();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      inferenceGate.free();
    }
    await h.server.waitFor((f) => f.type === 'response.create');
    expect(h.execute).toHaveBeenCalledWith('shell_exec', '{"command":"ls"}');
  });

  it('says the backend finished only once it answers without calling a tool', async () => {
    const h = await harness();

    h.server.emit(functionCallEvent('call_1', 'memory_search'));
    h.server.emit(responseCompletedEvent());
    await h.server.waitFor((f) => f.type === 'response.create');
    expect(h.finished).not.toHaveBeenCalled();

    // The follow-up that uses the tool's result.
    h.server.emit(responseCompletedEvent());
    await settle();
    expect(h.finished).toHaveBeenCalledTimes(1);
  });
});

describe('telling the voice what happened', () => {
  it('sends notices as instructions and prompts as speech', async () => {
    const h = await harness();

    h.conversation.notify('Your microphone is off.');
    h.conversation.prompt('Greet the room.');
    await h.server.waitFor((f) => f.type === 'session.commentary.append');

    expect(appends(h.server, 'session.instructions.append')).toEqual(['Your microphone is off.']);
    expect(appends(h.server, 'session.commentary.append')).toEqual(['Greet the room.']);
  });

  it('shows a picture to the backend without asking it to answer', async () => {
    const h = await harness();

    expect(h.conversation.showImage('data:image/png;base64,AAAA', 'Your screen.')).toBe(true);
    await h.server.waitFor((f) => f.type === 'response.item.create');
    await settle();

    expect(h.server.sent.find((f) => f.type === 'response.item.create')?.item.content).toEqual([
      { type: 'input_text', text: 'Your screen.' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
    expect(h.server.sent.some((f) => f.type === 'response.create')).toBe(false);
  });

  it('shows a recording window by window and asks for an answer', async () => {
    const h = await harness();

    h.conversation.showRecording(
      [
        { label: '0:00', images: ['data:image/jpeg;base64,AA'] },
        { label: '0:30', images: ['data:image/jpeg;base64,BB'] },
      ],
      'Your user recorded their screen.',
    );
    await h.server.waitFor((f) => f.type === 'response.create');

    expect(h.server.sent.find((f) => f.type === 'response.item.create')?.item.content).toEqual([
      { type: 'input_text', text: 'Your user recorded their screen.' },
      { type: 'input_text', text: 'At 0:00:' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AA' },
      { type: 'input_text', text: 'At 0:30:' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BB' },
    ]);
  });
});

describe('knowing who has the floor', () => {
  it('tells the voice when a new person has the floor, and only then', async () => {
    const h = await harness();

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    h.conversation.setCurrentSpeaker({ id: 'devices/self', isSelf: true, who: { kind: 'person', name: 'Prism' } });
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));
    await h.server.waitFor((f) => f.type === 'session.thinking.append' && String(f.content).startsWith('Mario'));

    expect(appends(h.server, 'session.thinking.append')).toEqual([
      'Emma Lee is speaking now.',
      'Mario Sarcher is speaking now.',
    ]);
  });

  it('names the people sharing a microphone rather than the platform label', async () => {
    const h = await harness();

    h.conversation.setCurrentSpeaker({ id: 'devices/room', isSelf: false, who: { kind: 'group', members: ['Emma', 'Lee'] } });
    await h.server.waitFor((f) => f.type === 'session.thinking.append');

    expect(appends(h.server, 'session.thinking.append')).toEqual([
      'Several people on one microphone are speaking now: Emma, Lee.',
    ]);
  });

  it('reports nobody while the agent itself is speaking', async () => {
    const h = await harness();

    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));
    h.conversation.setCurrentSpeaker({ id: 'devices/self', isSelf: true, who: { kind: 'person', name: 'Prism' } });

    expect(h.conversation.currentSpeaker).toBeNull();
  });

  it('keeps the last speaker when a read comes back empty', async () => {
    const h = await harness();

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    h.conversation.setCurrentSpeaker(null);

    expect(h.conversation.currentSpeaker?.who).toEqual({ kind: 'person', name: 'Emma Lee' });
  });

  it('forgets a speaker that has gone stale', async () => {
    const h = await harness();
    h.conversation.setCurrentSpeaker(reading('Emma Lee'));

    // Only the clock is faked: the harness runs a real socket, and faking timers would
    // stall it.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_001 });
    try {
      expect(h.conversation.currentSpeaker).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins who asked when the voice hands the request over', async () => {
    const h = await harness();

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    h.server.emit({ type: 'session.delegation.created', delegation: { id: 'item_1', type: 'delegation', target: 'responses' } });
    await settle();
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    expect(h.conversation.answeringSpeaker?.who).toEqual({ kind: 'person', name: 'Emma Lee' });
    expect(h.conversation.statistics.delegations).toBe(1);
  });
});

describe('a roster read from a moving UI', () => {
  it('tells the voice who is in the call, without the agent, once per change', async () => {
    const h = await harness();

    h.conversation.setParticipantNames(['Mario Sarcher', 'Prism', 'Emma Lee']);
    h.conversation.setParticipantNames(['Emma Lee', 'Mario Sarcher', 'Prism']);
    await h.server.waitFor((f) => f.type === 'session.thinking.append');
    await settle();

    expect(appends(h.server, 'session.thinking.append')).toEqual([
      'The people in the call with you are now: Emma Lee, Mario Sarcher.',
    ]);
    expect(h.conversation.roster).toEqual(['Emma Lee', 'Mario Sarcher']);
  });

  it('does not tell the voice it is alone when the scrape found only itself', async () => {
    const h = await harness();

    h.conversation.setParticipantNames(['Prism']);
    await settle();

    expect(appends(h.server, 'session.thinking.append')).toEqual([]);
  });
});

describe('what a call leaves in the log', () => {
  it('keeps the words out of it by default', async () => {
    const h = await harness();

    h.server.emit({ type: 'session.input_transcript.delta', delta: 'Hi Prism', start_ms: 0, end_ms: 200 });
    await settle();
    await h.conversation.stop();

    expect(vi.mocked(logger.info).mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Hi Prism');
  });

  it('writes each side as a line when asked', async () => {
    vi.mocked(config).meetingTranscriptLogging = 'full';
    const h = await harness();

    h.server.emit({ type: 'session.input_transcript.delta', delta: 'Hi', start_ms: 0, end_ms: 200 });
    h.server.emit({ type: 'session.input_transcript.delta', delta: ' Prism', start_ms: 200, end_ms: 400 });
    h.server.emit({ type: 'session.output_transcript.delta', delta: 'Hello!', start_ms: 400, end_ms: 600 });
    await settle();
    await h.conversation.stop();

    const lines = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('[Voice:Heard] transcript="Hi Prism"');
    expect(lines).toContain('[Voice:Said] transcript="Hello!"');
  });
});

describe('audio in and out', () => {
  const inputs = (server: LiveServer): Buffer[] =>
    server.sent.filter((f) => f.type === 'session.input_audio.append').map((f) => Buffer.from(String(f.audio), 'base64'));

  it('halves the rate of what the caller pushes', async () => {
    const h = await harness();

    // 10 ms of 48 kHz pcm16 mono: 480 samples, two bytes each.
    h.conversation.pushAudio(Buffer.alloc(960));
    await h.server.waitFor((f) => f.type === 'session.input_audio.append');

    expect(inputs(h.server)[0]).toHaveLength(480);
  });

  it('sends what the caller pushes untouched when the transport speaks 24 kHz', async () => {
    const h = await harness(REALTIME_SAMPLE_RATE);

    h.conversation.pushAudio(Buffer.from([1, 0, 2, 0]));
    await h.server.waitFor((f) => f.type === 'session.input_audio.append');

    expect(inputs(h.server)[0]).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it('plays the voice and drops the digital silence between its words', async () => {
    const h = await harness(REALTIME_SAMPLE_RATE);

    // 100 ms of silence, as the stream carries it, then 100 ms of speech.
    h.server.emit({ type: 'session.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') });
    const speech = Buffer.alloc(4800, 1);
    h.server.emit({ type: 'session.output_audio.delta', delta: speech.toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(Buffer.concat(h.written)).toEqual(speech);
  });

  it('refuses a rate it has no converter for', () => {
    expect(
      () =>
        new VoiceConversation({
          instructions: 'x',
          backendInstructions: 'y',
          tools: { declarations: [], count: 0, execute: vi.fn() },
          sink: { write: vi.fn() },
          agentName: 'Prism',
          sampleRate: 16_000,
          endpointOverride: { url: 'ws://127.0.0.1:1', headers: {} },
        }),
    ).toThrow(/16000/);
  });

  it('sends nothing after the conversation stops', async () => {
    const h = await harness();

    await h.conversation.stop();
    h.conversation.pushAudio(Buffer.alloc(960));
    await settle();

    expect(inputs(h.server)).toHaveLength(0);
  });
});
