// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startVoiceAudio, VOICE_SAMPLE_RATE } from './voice-audio';

/** A worklet port, recording what crossed it and in which order. */
class FakePort {
  posted: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;

  postMessage(data: unknown) {
    this.posted.push(data);
  }
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  static byName(name: string) {
    return FakeWorkletNode.instances.find((n) => n.name === name)!;
  }

  port = new FakePort();
  connectedTo: unknown[] = [];
  isDisconnected = false;
  name: string;
  options: unknown;

  constructor(_context: unknown, name: string, options?: unknown) {
    this.name = name;
    this.options = options;
    FakeWorkletNode.instances.push(this);
  }
  connect(target: unknown) {
    this.connectedTo.push(target);
  }
  disconnect() {
    this.isDisconnected = true;
  }
}

class FakeNode {
  connectedTo: unknown[] = [];
  isDisconnected = false;
  gain = { value: 1 };
  connect(target: unknown) {
    this.connectedTo.push(target);
  }
  disconnect() {
    this.isDisconnected = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** Set to make the worklet module fail to load. */
  static moduleError: Error | null = null;

  sampleRate: number;
  state = 'suspended';
  isClosed = false;
  didResume = false;
  destination = { name: 'destination' };
  modules: string[] = [];
  gains: FakeNode[] = [];
  sources: FakeNode[] = [];

  audioWorklet = {
    addModule: async (url: string) => {
      this.modules.push(url);
      if (FakeAudioContext.moduleError) throw FakeAudioContext.moduleError;
    },
  };

  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    FakeAudioContext.instances.push(this);
  }
  async resume() {
    this.didResume = true;
    this.state = 'running';
  }
  async close() {
    this.isClosed = true;
  }
  createMediaStreamSource() {
    const node = new FakeNode();
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = new FakeNode();
    this.gains.push(node);
    return node;
  }
}

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks };
}

describe('startVoiceAudio', () => {
  let stream: ReturnType<typeof fakeStream>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioContext.moduleError = null;
    FakeWorkletNode.instances = [];
    stream = fakeStream();
    getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the microphone once and runs at the session rate', async () => {
    const audio = await startVoiceAudio({ onFrame: vi.fn() });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });

    const context = FakeAudioContext.instances[0]!;
    // The model's own rate, so nothing between the microphone and the runtime
    // resamples the audio.
    expect(context.sampleRate).toBe(VOICE_SAMPLE_RATE);
    expect(context.modules).toEqual(['/voice-worklet.js']);
    expect(context.didResume).toBe(true);

    await audio.stop();
  });

  it('keeps the microphone out of the speakers', async () => {
    await startVoiceAudio({ onFrame: vi.fn() });

    const context = FakeAudioContext.instances[0]!;
    const capture = FakeWorkletNode.byName('voice-capture');
    const silence = context.gains[0]!;

    // The capture node has to reach the destination to be pulled at all, so it goes
    // through a gain of zero rather than straight there.
    expect(silence.gain.value).toBe(0);
    expect(capture.connectedTo).toEqual([silence]);
    expect(silence.connectedTo).toEqual([context.destination]);
  });

  it('forwards each captured frame', async () => {
    const onFrame = vi.fn();
    await startVoiceAudio({ onFrame });

    const frame = new Int16Array([1, -1, 0, 300]).buffer;
    FakeWorkletNode.byName('voice-capture').port.deliver(frame);

    expect(onFrame).toHaveBeenCalledWith(frame);
  });

  it('sends the agent audio and the clear that cancels it over one port, in order', async () => {
    const audio = await startVoiceAudio({ onFrame: vi.fn() });
    const playback = FakeWorkletNode.byName('voice-playback');

    const first = new Int16Array([1, 2]).buffer;
    const second = new Int16Array([3, 4]).buffer;
    audio.enqueue(first);
    audio.enqueue(second);
    audio.clear();

    // One port means one order: playback cannot drop frames it has not been given.
    expect(playback.port.posted).toEqual([first, second, 'clear']);
  });

  it('reports when the agent is heard and when it stops', async () => {
    const onSpeaking = vi.fn();
    await startVoiceAudio({ onFrame: vi.fn(), onSpeaking });
    const playback = FakeWorkletNode.byName('voice-playback');

    playback.port.deliver('speaking');
    playback.port.deliver('idle');

    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
  });

  it('releases the microphone when the call ends', async () => {
    const audio = await startVoiceAudio({ onFrame: vi.fn() });

    await audio.stop();

    // The track is what the browser's recording indicator follows: stopping the
    // context alone leaves the tab marked as listening.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.isClosed).toBe(true);
    expect(FakeWorkletNode.byName('voice-capture').isDisconnected).toBe(true);
    expect(FakeWorkletNode.byName('voice-playback').isDisconnected).toBe(true);
  });

  it('opens nothing when the microphone is denied', async () => {
    const denied = new Error('Permission denied');
    getUserMedia.mockRejectedValueOnce(denied);

    await expect(startVoiceAudio({ onFrame: vi.fn() })).rejects.toBe(denied);
    expect(FakeAudioContext.instances).toEqual([]);
  });

  it('releases the microphone when the worklet will not load', async () => {
    FakeAudioContext.moduleError = new Error('404');

    await expect(startVoiceAudio({ onFrame: vi.fn() })).rejects.toThrow('404');

    // A start that failed has no caller to stop it, so it cleans up after itself.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.isClosed).toBe(true);
  });
});
