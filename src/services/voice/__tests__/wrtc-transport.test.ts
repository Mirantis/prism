/**
 * Transport tests against a stub peer: no ICE, no DTLS, no network.
 *
 * What is worth testing here is the two frame contracts the library imposes — 480
 * samples out or it throws, and a rate that is not always 48 kHz coming in — and that
 * the configured ICE servers are what the peer is built with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config', () => ({
  config: { voiceIceServers: [] },
}));

interface AudioData {
  samples: Int16Array;
  sampleRate: number;
  numberOfFrames: number;
}

/** Every peer, source and sink the transport built, in construction order. */
const peers: FakePeer[] = [];
const sources: FakeSource[] = [];
const sinks: FakeSink[] = [];

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeSource {
  readonly frames: AudioData[] = [];
  readonly track = new FakeTrack();
  createTrack(): FakeTrack {
    return this.track;
  }
  onData(data: AudioData): void {
    // The real addon throws on any other count, so the stub does too — a test that
    // passed here while production threw would be worse than no test.
    if (data.samples.length !== 480) throw new Error(`expected 480 samples, got ${data.samples.length}`);
    this.frames.push(data);
  }
}

class FakeSink {
  ondata: ((data: AudioData) => void) | null = null;
  stopped = false;
  constructor(readonly track: unknown) {
    sinks.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakePeer {
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: unknown }) => void) | null = null;
  connectionState = 'new';
  closed = false;
  readonly added: unknown[] = [];
  readonly candidates: unknown[] = [];
  constructor(readonly configuration: { iceServers: unknown[] }) {
    peers.push(this);
  }
  addTrack(track: unknown): void {
    this.added.push(track);
  }
  async setRemoteDescription(): Promise<void> {}
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\r\nanswer' };
  }
  async setLocalDescription(): Promise<void> {}
  async addIceCandidate(candidate: unknown): Promise<void> {
    this.candidates.push(candidate);
  }
  close(): void {
    this.closed = true;
  }
  /** Drive the state machine the way the library would. */
  becomes(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

vi.mock('@roamhq/wrtc', () => ({
  RTCPeerConnection: FakePeer,
  nonstandard: {
    RTCAudioSink: FakeSink,
    RTCAudioSource: class extends FakeSource {
      constructor() {
        super();
        sources.push(this);
      }
    },
  },
}));

const { createWrtcTransport } = await import('../wrtc-transport');

/** A transport wired to spies for everything it reports. */
async function transport() {
  const events = {
    onAudio: vi.fn(),
    onIceCandidate: vi.fn(),
    onConnected: vi.fn(),
    onClosed: vi.fn(),
  };
  const t = await createWrtcTransport(events);
  return { t, events, peer: peers[peers.length - 1]!, source: sources[sources.length - 1]! };
}

beforeEach(() => {
  peers.length = 0;
  sources.length = 0;
  sinks.length = 0;
  vi.mocked(config).voiceIceServers = [];
});

describe('the outbound frame size', () => {
  it('re-frames what the core writes into 10 ms frames', async () => {
    const { t, source } = await transport();

    // 15 ms of audio: one whole frame, and half of the next one held back.
    t.sink.write(Buffer.alloc(1440, 1));
    expect(source.frames).toHaveLength(1);

    // The other half arrives, and the second frame goes out complete.
    t.sink.write(Buffer.alloc(480, 2));
    expect(source.frames).toHaveLength(2);

    // Every frame is 480 samples at 48 kHz, whatever the write sizes were.
    for (const frame of source.frames) {
      expect(frame.samples).toHaveLength(480);
      expect(frame.sampleRate).toBe(48_000);
      expect(frame.numberOfFrames).toBe(480);
    }
    // The carried half leads the second frame, in the order it was written.
    expect(source.frames[1]!.samples[0]).toBe(0x0101);
    expect(source.frames[1]!.samples[479]).toBe(0x0202);
  });

  it('holds a write shorter than a frame until it can fill one', async () => {
    const { t, source } = await transport();

    t.sink.write(Buffer.alloc(240));
    expect(source.frames).toHaveLength(0);

    t.sink.write(Buffer.alloc(720));
    expect(source.frames).toHaveLength(1);
  });
});

describe('the audio the client sends', () => {
  it('passes 48 kHz frames on and drops every other rate', async () => {
    const { t, events, peer } = await transport();
    peer.ontrack?.({ track: {} });
    const sink = sinks[sinks.length - 1]!;

    // Every session opens with a couple of these, and the core takes 48 kHz alone.
    sink.ondata?.({ samples: new Int16Array(160), sampleRate: 16_000, numberOfFrames: 160 });
    expect(events.onAudio).not.toHaveBeenCalled();

    const samples = new Int16Array([1, -1, 32_767]);
    sink.ondata?.({ samples, sampleRate: 48_000, numberOfFrames: 480 });

    // pcm16 mono, byte for byte what the peer decoded.
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    const forwarded = events.onAudio.mock.calls[0]![0] as Buffer;
    expect(forwarded).toEqual(Buffer.copyBytesFrom(samples));
    expect(t).toBeDefined();
  });
});

describe('the ICE servers the peer offers', () => {
  it('builds the peer with the configured list', async () => {
    const servers = [{ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' }];
    vi.mocked(config).voiceIceServers = servers;

    const { peer } = await transport();

    expect(peer.configuration.iceServers).toEqual(servers);
  });

  it('offers none when nothing is configured', async () => {
    const { peer } = await transport();

    // Host candidates only, which is what the docs promise an unconfigured runtime.
    expect(peer.configuration.iceServers).toEqual([]);
  });
});

describe('the session lifecycle', () => {
  it('answers the offer with the peer answer', async () => {
    const { t } = await transport();

    await expect(t.accept('v=0\r\noffer')).resolves.toBe('v=0\r\nanswer');
  });

  it('reports the media path coming up and going away', async () => {
    const { events, peer } = await transport();

    peer.becomes('connected');
    expect(events.onConnected).toHaveBeenCalled();

    peer.becomes('failed');
    expect(events.onClosed).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('reports a candidate to the client and swallows the end of gathering', async () => {
    const { events, peer } = await transport();

    peer.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0' } });
    peer.onicecandidate?.({ candidate: null });

    expect(events.onIceCandidate).toHaveBeenCalledTimes(1);
  });

  it('releases the sink, the track and the peer, once', async () => {
    const { t, source, peer } = await transport();
    peer.ontrack?.({ track: {} });
    const sink = sinks[sinks.length - 1]!;

    await t.close();
    await t.close();

    expect(sink.stopped).toBe(true);
    expect(source.track.stopped).toBe(true);
    expect(peer.closed).toBe(true);

    // Nothing leaves a closed transport, in either direction.
    t.sink.write(Buffer.alloc(960));
    expect(source.frames).toHaveLength(0);
    await t.addIceCandidate({ candidate: 'candidate:2 1 udp' });
    expect(peer.candidates).toHaveLength(0);
  });
});
