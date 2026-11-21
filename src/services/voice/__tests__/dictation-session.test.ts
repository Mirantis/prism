/**
 * Protocol-level tests against a real local WebSocket server standing in for the Realtime
 * endpoint, so the frames a dictation sends are checked as they go over the wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { DictationSession, type DictationSignal } from '../dictation-session';
import { recordRealtimeUsage } from '../../meeting/realtime-usage';

vi.mock('../../meeting/realtime-usage', () => ({ recordRealtimeUsage: vi.fn() }));

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));

vi.mock('../../../config', () => ({
  config: { openaiTranscriptionModel: 'gpt-live-transcribe', realtimeProvider: 'azure' },
}));

/** `ms` of pcm16 silence at 24 kHz, the size a client frame has. */
function pcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((ms / 1000) * 24_000) * 2);
}

/** Let the frames in flight on the loopback socket land. */
function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Upstream {
  /** Frames the session sent, parsed, in order. */
  sent: Array<Record<string, any>>;
  /** Push a server event to the session. */
  emit(event: Record<string, unknown>): void;
  /** Accept the configuration the way the Realtime API does. */
  accept(): void;
  drop(): void;
  close(): Promise<void>;
}

interface Harness {
  upstream: Upstream;
  session: DictationSession;
  signal: DictationSignal & { calls: Array<[string, string?]> };
  ended: ReturnType<typeof vi.fn>;
  started: Promise<boolean>;
}

async function harness(options: { maxAudioMs?: number; resultTimeoutMs?: number; connectTimeoutMs?: number } = {}): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const sent: Array<Record<string, any>> = [];
  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      ws.on('message', (data) => sent.push(JSON.parse(data.toString())));
      resolve();
    });
  });

  const calls: Array<[string, string?]> = [];
  const signal = {
    calls,
    ready: () => calls.push(['ready']),
    delta: (text: string) => calls.push(['delta', text]),
    result: (text: string) => calls.push(['result', text]),
    error: (message: string) => calls.push(['error', message]),
  };
  const ended = vi.fn();
  const session = new DictationSession({
    userId: 'user-1',
    signal,
    onEnd: ended,
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
    ...options,
  });
  const started = session.start();
  await connected;
  await settle();

  const upstream: Upstream = {
    sent,
    emit: (event) => socket?.send(JSON.stringify(event)),
    accept: () => socket?.send(JSON.stringify({ type: 'session.updated', session: {} })),
    drop: () => socket?.close(1011, 'gone'),
    close: () => new Promise<void>((resolve) => {
      server.clients.forEach((client) => client.terminate());
      server.close(() => resolve());
    }),
  };
  return { upstream, session, signal, ended, started };
}

let active: Harness | null = null;
beforeEach(() => {
  active = null;
  mockTrackEvent.mockClear();
});
afterEach(async () => {
  active?.session.cancel();
  await active?.upstream.close();
});

describe('DictationSession', () => {
  it('configures a transcription-only session with no turn detection', async () => {
    active = await harness();

    const update = active.upstream.sent[0];
    expect(update.type).toBe('session.update');
    expect(update.session.output_modalities).toEqual(['text']);
    expect(update.session.audio.input).toEqual({
      format: { type: 'audio/pcm', rate: 24_000 },
      turn_detection: null,
      transcription: { model: 'gpt-live-transcribe' },
    });
  });

  it('reports ready once the upstream accepts the configuration', async () => {
    active = await harness();
    expect(active.signal.calls).toEqual([]);

    active.upstream.accept();

    await expect(active.started).resolves.toBe(true);
    expect(active.signal.calls).toEqual([['ready']]);
  });

  it('keeps audio sent while connecting, and forwards it in order once ready', async () => {
    active = await harness();
    const first = pcm(20).fill(1);
    const second = pcm(20).fill(2);
    active.session.pushAudio(first);
    active.session.pushAudio(second);
    await settle();
    // Nothing but the configuration has gone out before the upstream is ready.
    expect(active.upstream.sent.map((f) => f.type)).toEqual(['session.update']);

    active.upstream.accept();
    await active.started;
    await settle();

    const appended = active.upstream.sent.filter((f) => f.type === 'input_audio_buffer.append');
    expect(appended.map((f) => f.audio)).toEqual([first.toString('base64'), second.toString('base64')]);
  });

  it('commits on stop and answers the transcript, deltas first', async () => {
    active = await harness();
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(500));
    active.session.commit();
    await settle();
    expect(active.upstream.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });

    active.upstream.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Hello, ' });
    active.upstream.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'world.' });
    active.upstream.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: ' Hello, world. ',
      usage: { type: 'tokens', input_tokens: 25, output_tokens: 4 },
    });
    await settle();

    expect(recordRealtimeUsage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'dictation' }),
      'gpt-live-transcribe',
      { type: 'tokens', input_tokens: 25, output_tokens: 4 },
    );
    expect(active.signal.calls).toEqual([
      ['ready'],
      ['delta', 'Hello, '],
      ['delta', 'world.'],
      ['result', 'Hello, world.'],
    ]);
    expect(active.ended).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith('dictation finished', 'user-1', expect.objectContaining({ status: 'transcribed', audio_ms: '500' }));
  });

  it('honours a stop that arrives before the upstream is ready', async () => {
    active = await harness();
    active.session.pushAudio(pcm(300));
    active.session.commit();

    active.upstream.accept();
    await active.started;
    await settle();

    // The client has already let go, so it is not told to start recording.
    expect(active.signal.calls.some(([kind]) => kind === 'ready')).toBe(false);

    expect(active.upstream.sent.map((f) => f.type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
  });

  it('answers an empty transcript without committing a buffer too short to transcribe', async () => {
    active = await harness();
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(40));
    active.session.commit();
    await settle();

    expect(active.upstream.sent.some((f) => f.type === 'input_audio_buffer.commit')).toBe(false);
    expect(active.signal.calls.at(-1)).toEqual(['result', '']);
    expect(mockTrackEvent).toHaveBeenCalledWith('dictation finished', 'user-1', expect.objectContaining({ status: 'empty' }));
  });

  it('drops the recording on cancel and sends nothing back', async () => {
    active = await harness();
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(500));
    active.session.cancel();
    await settle();

    expect(active.upstream.sent.some((f) => f.type === 'input_audio_buffer.commit')).toBe(false);
    expect(active.signal.calls).toEqual([['ready']]);
    expect(active.ended).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith('dictation finished', 'user-1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('commits by itself when a recording outlasts the cap without audio', async () => {
    active = await harness({ maxAudioMs: 150 });
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(120));
    await settle(250);

    expect(active.upstream.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
  });

  it('commits by itself at the recording cap', async () => {
    active = await harness({ maxAudioMs: 200 });
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(100));
    active.session.pushAudio(pcm(100));
    active.session.pushAudio(pcm(100));
    await settle();

    const types = active.upstream.sent.map((f) => f.type);
    expect(types.filter((t) => t === 'input_audio_buffer.append')).toHaveLength(2);
    expect(types.at(-1)).toBe('input_audio_buffer.commit');
  });

  it('reports a transcription failure as an error', async () => {
    active = await harness();
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(500));
    active.session.commit();
    active.upstream.emit({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'i1',
      error: { message: 'audio unreadable' },
    });
    await settle();

    expect(active.signal.calls.at(-1)).toEqual(['error', 'Transcription failed: audio unreadable']);
    expect(mockTrackEvent).toHaveBeenCalledWith('dictation finished', 'user-1', expect.objectContaining({ status: 'failed' }));
  });

  it('fails the start when the upstream rejects the configuration', async () => {
    active = await harness();
    active.upstream.emit({ type: 'error', error: { message: 'Invalid transcription model' } });

    await expect(active.started).resolves.toBe(false);
    expect(active.signal.calls).toEqual([['error', 'Invalid transcription model']]);
  });

  it('reports an upstream that goes away mid-recording', async () => {
    active = await harness();
    active.upstream.accept();
    await active.started;
    active.upstream.drop();
    await settle();

    expect(active.signal.calls.at(-1)).toEqual(['error', 'The transcriber closed the connection (code 1011).']);
    expect(active.ended).toHaveBeenCalledTimes(1);
  });

  it('gives up on a transcript that never arrives', async () => {
    active = await harness({ resultTimeoutMs: 50 });
    active.upstream.accept();
    await active.started;
    active.session.pushAudio(pcm(500));
    active.session.commit();
    await settle(250);

    expect(active.signal.calls.at(-1)).toEqual(['error', 'The transcript did not arrive in time.']);
  });

  it('gives up on an upstream that never accepts the configuration', async () => {
    active = await harness({ connectTimeoutMs: 50 });

    await expect(active.started).resolves.toBe(false);
    expect(active.signal.calls).toEqual([['error', 'The transcriber did not answer in time.']]);
  });
});
