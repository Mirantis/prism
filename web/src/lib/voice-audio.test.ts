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
  /** Set when the browser will not start audio yet, so `resume()` is never settled. */
  static holdResume = false;

  sampleRate: number;
  state = 'suspended';
  isClosed = false;
  didResume = false;
  destination = { name: 'destination' };
  modules: string[] = [];
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
    // A context the browser is holding until a gesture never settles this promise: it is
    // appended to a pending list and left there, rather than rejected.
    if (FakeAudioContext.holdResume) return new Promise<void>(() => {});
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
    FakeAudioContext.holdResume = false;
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

  const open = (options: Partial<Parameters<typeof startVoiceAudio>[0]> = {}) =>
    startVoiceAudio({ sampleRate: VOICE_SAMPLE_RATE, onFrame: vi.fn(), ...options });

  it('asks for the microphone once and runs at the session rate', async () => {
    const audio = await open();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const context = FakeAudioContext.instances[0]!;
    // The rate the session speaks, so nothing between the microphone and the runtime
    // resamples the audio.
    expect(context.sampleRate).toBe(VOICE_SAMPLE_RATE);
    expect(context.modules).toEqual(['/voice-worklet.js']);
    expect(context.didResume).toBe(true);

    await audio.stop();
  });

  it('opens the call even where the browser will not start the speakers yet', async () => {
    // A page that opens a call on mount has no user activation behind it. Waiting on
    // `resume()` there never returns, and the call is never connected at all: no audio,
    // no socket, and a page that says "connecting" forever.
    FakeAudioContext.holdResume = true;

    const audio = await open();

    expect(FakeAudioContext.instances[0]!.didResume).toBe(true);
    // And the click the page does see is what starts the speakers.
    audio.resume();
    expect(FakeWorkletNode.byName('voice-io')).toBeDefined();
  });

  it('sits between the microphone and the speakers', async () => {
    await open();

    const context = FakeAudioContext.instances[0]!;
    const io = FakeWorkletNode.byName('voice-io');

    // One node does both directions: the microphone reaches its input and its output is
    // what the agent sent, so it is pulled by the destination without being heard.
    expect(context.sources[0]!.connectedTo).toEqual([io]);
    expect(io.connectedTo).toEqual([context.destination]);
  });

  it('asks for capture frames of 20 ms at the session rate', async () => {
    await open({ sampleRate: 48_000 });

    // The frame size is the one thing about the worklet that follows the rate: a fixed
    // sample count would be 10 ms of audio at one rate and 40 at another.
    expect(FakeWorkletNode.byName('voice-io').options).toMatchObject({
      processorOptions: { captureFrames: 960 },
    });
  });

  it('forwards each captured frame', async () => {
    const onFrame = vi.fn();
    await open({ onFrame });

    const frame = new Int16Array([1, -1, 0, 300]).buffer;
    FakeWorkletNode.byName('voice-io').port.deliver({ type: 'capture', pcm: frame });

    expect(onFrame).toHaveBeenCalledWith(frame);
  });

  it('sends both streams and the clear that cancels the voice over one port, in order', async () => {
    const audio = await open();
    const io = FakeWorkletNode.byName('voice-io');

    const voice = new Int16Array([1, 2]).buffer;
    const computer = new Int16Array([3, 4]).buffer;
    audio.enqueue(voice);
    audio.enqueueComputer(computer);
    audio.clear();

    // One port means one order: the worklet cannot drop frames it has not been given.
    expect(io.port.posted).toEqual([
      { stream: 'voice', pcm: voice },
      { stream: 'computer', pcm: computer },
      { clear: true },
    ]);
  });

  it('reports when the agent is heard and when it stops', async () => {
    const onSpeaking = vi.fn();
    await open({ onSpeaking });
    const io = FakeWorkletNode.byName('voice-io');

    io.port.deliver({ type: 'speaking', value: true });
    io.port.deliver({ type: 'speaking', value: false });

    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
  });

  it('releases the microphone when the call ends', async () => {
    const audio = await open();

    await audio.stop();

    // The track is what the browser's recording indicator follows: stopping the
    // context alone leaves the tab marked as listening.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.isClosed).toBe(true);
    expect(FakeWorkletNode.byName('voice-io').isDisconnected).toBe(true);
  });

  it('opens nothing when the microphone is denied', async () => {
    const denied = new Error('Permission denied');
    getUserMedia.mockRejectedValueOnce(denied);

    await expect(open()).rejects.toBe(denied);
    expect(FakeAudioContext.instances).toEqual([]);
  });

  it('releases the microphone when the worklet will not load', async () => {
    FakeAudioContext.moduleError = new Error('404');

    await expect(open()).rejects.toThrow('404');

    // A start that failed has no caller to stop it, so it cleans up after itself.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.isClosed).toBe(true);
  });
});
