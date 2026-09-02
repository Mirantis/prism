/**
 * A stub WebRTC peer, standing in for `@roamhq/wrtc` in unit tests.
 *
 * No ICE, no DTLS, no sockets: the tests drive the state machine by hand and read what
 * the transport handed the peer. The one thing this copies from the real addon is where
 * it throws — `RTCAudioSource.onData` takes 480 samples and nothing else — because a
 * stub that accepted any frame size would pass while production threw.
 *
 * Register it with `vi.mock('@roamhq/wrtc', async () => (await
 * import('../../../test-utils/fake-wrtc')).fakeWrtcModule)`, and call `resetFakeWrtc()`
 * in `beforeEach`, since the registries below are module state.
 */

/** One frame, in the shape both sides of the addon use. */
export interface FakeAudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample?: number;
  channelCount?: number;
  numberOfFrames: number;
}

export class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

export class FakeAudioSource {
  /** Every frame the transport sent out, oldest first. */
  readonly frames: FakeAudioData[] = [];
  readonly track = new FakeTrack();

  constructor() {
    fakeWrtcState.sources.push(this);
  }

  createTrack(): FakeTrack {
    return this.track;
  }

  onData(data: FakeAudioData): void {
    if (data.samples.length !== 480) {
      throw new Error(`expected 480 samples, got ${data.samples.length}`);
    }
    this.frames.push(data);
  }
}

export class FakeAudioSink {
  ondata: ((data: FakeAudioData) => void) | null = null;
  stopped = false;

  constructor(readonly track: unknown) {
    fakeWrtcState.sinks.push(this);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Deliver a frame the way the addon does once the client's track is live. */
  deliver(samples: Int16Array, sampleRate = 48_000): void {
    this.ondata?.({
      samples,
      sampleRate,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: samples.length,
    });
  }
}

export class FakePeer {
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: unknown }) => void) | null = null;
  connectionState = 'new';
  closed = false;
  /** Tracks the transport added, and candidates it forwarded. */
  readonly added: unknown[] = [];
  readonly candidates: unknown[] = [];

  constructor(readonly configuration: { iceServers: unknown[] }) {
    fakeWrtcState.peers.push(this);
  }

  addTrack(track: unknown): void {
    this.added.push(track);
  }

  async setRemoteDescription(): Promise<void> {}

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\r\nanswer' };
  }

  async setLocalDescription(): Promise<void> {
    // Gathering starts with the local description, as it does in the library, so a
    // candidate exists before the answer has been sent anywhere.
    this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 51000 typ host' } });
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.candidates.push(candidate);
  }

  close(): void {
    this.closed = true;
  }

  /** Drive the connection state the way the library would. */
  becomes(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** The client's audio track arrives; the transport attaches a sink to it. */
  addRemoteTrack(): FakeAudioSink {
    this.ontrack?.({ track: new FakeTrack() });
    return lastFakeSink();
  }
}

/** Everything the stub has built this test, newest last. */
export const fakeWrtcState = {
  peers: [] as FakePeer[],
  sources: [] as FakeAudioSource[],
  sinks: [] as FakeAudioSink[],
};

export const fakeWrtcModule = {
  RTCPeerConnection: FakePeer,
  nonstandard: { RTCAudioSink: FakeAudioSink, RTCAudioSource: FakeAudioSource },
};

export function resetFakeWrtc(): void {
  fakeWrtcState.peers.length = 0;
  fakeWrtcState.sources.length = 0;
  fakeWrtcState.sinks.length = 0;
}

export const lastFakePeer = (): FakePeer => at(fakeWrtcState.peers, 'peer');
export const lastFakeSource = (): FakeAudioSource => at(fakeWrtcState.sources, 'source');
export const lastFakeSink = (): FakeAudioSink => at(fakeWrtcState.sinks, 'sink');

function at<T>(list: T[], what: string): T {
  const item = list[list.length - 1];
  if (!item) throw new Error(`No fake ${what} was built`);
  return item;
}
