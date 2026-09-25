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
import { startLiveServer, type LiveServer } from '../../../test-utils/live-server';
import type { InvokeRequest, InvokeStep } from '../../../types';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../computer/computer-help.service', () => ({
  computerHelpService: { list: vi.fn(async () => []) },
}));

interface Harness {
  conversation: VoiceConversation;
  server: LiveServer;
  lost: string[];
  written: Buffer[];
  /** Each backend run the conversation started, in order. */
  runs: InvokeRequest[];
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
  const runs: InvokeRequest[] = [];
  const run = (request: InvokeRequest): AsyncIterable<InvokeStep> => {
    runs.push(request);
    return (async function* () {
      yield { text: 'You have two tasks scheduled.', toolCalls: [] };
    })();
  };
  const conversation = new VoiceConversation({
    instructions: 'You are Prism, the voice.',
    backend: { userId: 'u1', agentId: 'a1', sessionInstructions: 'call rules', computer: true, run },
    sink: { write: (chunk: Buffer) => void written.push(chunk) },
    sampleRate,
    endpointOverride: { url: server.url, headers: {} },
    onSessionLost: (reason) => lost.push(reason),
  });
  await conversation.start();
  active = { conversation, server, lost, written, runs };
  return active;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

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

describe('handing work to the backend', () => {
  it('runs a delegation with what was said, and gives the voice the answer to say', async () => {
    const h = await harness();

    h.server.emit({ type: 'session.input_transcript.delta', delta: 'Prism, what is scheduled?', start_ms: 600, end_ms: 1200 });
    h.server.emit({
      type: 'session.delegation.created',
      offset_ms: 1300,
      delegation: { id: 'item_delegation_1', type: 'delegation', target: 'client' },
    });
    const answer = await h.server.waitFor((f) => f.type === 'session.commentary.append');

    expect(h.runs[0]).toMatchObject({ mode: 'voice', sessionInstructions: 'call rules' });
    expect(h.runs[0]!.prompt).toContain('Them: Prism, what is scheduled?');
    expect(answer).toMatchObject({ delegation_id: 'item_delegation_1', content: 'You have two tasks scheduled.' });
    expect(h.conversation.statistics.delegations).toBe(1);
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

  it('has the backend look at a recording, and the voice say what it found', async () => {
    const h = await harness();

    h.conversation.showRecording(
      [
        { label: '0:00', images: ['data:image/jpeg;base64,AA'] },
        { label: '0:30', images: ['data:image/jpeg;base64,BB'] },
      ],
      'Your user recorded their screen.',
    );
    const answer = await h.server.waitFor((f) => f.type === 'session.commentary.append');

    expect(h.runs[0]!.promptImages).toEqual([
      { mediaType: 'image/jpeg', data: 'AA' },
      { mediaType: 'image/jpeg', data: 'BB' },
    ]);
    expect(h.runs[0]!.prompt).toContain('Your user recorded their screen. The pictures start at, in order: 0:00 (1), 0:30 (1).');
    expect(answer.delegation_id).toBeNull();
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

  it('holds back a chunk too short to yield a sample, rather than sending it empty', async () => {
    const h = await harness();

    // Four samples: shorter than the filter window, so the downsampler has nothing yet.
    h.conversation.pushAudio(Buffer.alloc(8));
    h.conversation.pushAudio(Buffer.alloc(960));
    await h.server.waitFor((f) => f.type === 'session.input_audio.append');

    expect(inputs(h.server).every((pcm) => pcm.length > 0)).toBe(true);
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
          backend: { userId: 'u1', agentId: 'a1', sessionInstructions: 'y', computer: false },
          sink: { write: vi.fn() },
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
