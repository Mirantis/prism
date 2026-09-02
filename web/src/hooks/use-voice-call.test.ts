// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useVoiceCall } from './use-voice-call';

class FakeTrack {
  kind = 'audio';
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

/** Enough RTCPeerConnection for the hook: jsdom has none at all. */
class FakePC {
  static instances: FakePC[] = [];

  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = 'new';
  closed = false;
  addedTracks: FakeTrack[] = [];
  remoteCandidates: RTCIceCandidateInit[] = [];
  onicecandidate: ((e: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: ((e: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePC.instances.push(this);
  }
  addTrack(track: FakeTrack) {
    this.addedTracks.push(track);
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\noffer' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.remoteCandidates.push(c);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  // Test helpers
  gather(candidate: string) {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
  enter(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

describe('useVoiceCall', () => {
  let track: FakeTrack;
  let getUserMedia: Mock<(constraints: unknown) => Promise<FakeStream>>;
  let sendOffer: Mock<(sdp: string, threadId?: string) => void>;
  let sendIce: Mock<(candidate: RTCIceCandidateInit) => void>;
  let sendStop: Mock<() => void>;
  let onError: Mock<(message: string) => void>;

  beforeEach(() => {
    FakePC.instances = [];
    track = new FakeTrack();
    getUserMedia = vi.fn(async () => new FakeStream([track]));
    sendOffer = vi.fn();
    sendIce = vi.fn();
    sendStop = vi.fn();
    onError = vi.fn();
    vi.stubGlobal('RTCPeerConnection', FakePC as unknown as typeof RTCPeerConnection);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(threadId: string | undefined = 't1') {
    return renderHook(() => useVoiceCall({ sendOffer, sendIce, sendStop, threadId, onError }));
  }

  /** Take a call to `live`, which is where most of the tests start. */
  async function goLive(threadId?: string) {
    const utils = render(threadId);
    await act(async () => {
      await utils.result.current.start();
    });
    const pc = FakePC.instances[0]!;
    await act(async () => {
      utils.result.current.onFrame({ kind: 'answer', sdp: 'v=0\r\nanswer' });
    });
    act(() => utils.result.current.onFrame({ kind: 'state', state: 'live' }));
    return { ...utils, pc };
  }

  it('sends the offer it just gathered, with the thread the call belongs to', async () => {
    const { result } = render('t1');

    await act(async () => {
      await result.current.start();
    });

    const pc = FakePC.instances[0]!;
    expect(pc.addedTracks).toEqual([track]);
    expect(pc.localDescription?.sdp).toBe('v=0\r\noffer');
    expect(sendOffer).toHaveBeenCalledWith('v=0\r\noffer', 't1');
    // Starting, not live: the runtime has not answered yet.
    expect(result.current.state).toBe('starting');
  });

  it('walks starting → connecting → live as the runtime answers', async () => {
    const { result, pc } = await goLive();

    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\nanswer' });
    expect(result.current.state).toBe('live');
  });

  it('holds its candidates until the answer, then sends them in order', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    const pc = FakePC.instances[0]!;

    // The runtime drops a candidate that arrives before the answer, so these wait.
    act(() => pc.gather('candidate:1'));
    act(() => pc.gather('candidate:2'));
    expect(sendIce).not.toHaveBeenCalled();

    await act(async () => {
      result.current.onFrame({ kind: 'answer', sdp: 'v=0\r\nanswer' });
    });

    expect(sendIce.mock.calls.map(([c]) => c.candidate)).toEqual(['candidate:1', 'candidate:2']);

    // Gathered after the answer: sent straight out.
    act(() => pc.gather('candidate:3'));
    expect(sendIce).toHaveBeenCalledTimes(3);
    expect(sendIce.mock.calls.at(-1)![0].candidate).toBe('candidate:3');
  });

  it("holds the runtime's candidates until its answer is applied", async () => {
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    const pc = FakePC.instances[0]!;

    act(() => result.current.onFrame({ kind: 'ice', candidate: { candidate: 'remote:1' } }));
    expect(pc.remoteCandidates).toEqual([]);

    await act(async () => {
      result.current.onFrame({ kind: 'answer', sdp: 'v=0\r\nanswer' });
    });
    act(() => result.current.onFrame({ kind: 'ice', candidate: { candidate: 'remote:2' } }));

    expect(pc.remoteCandidates.map((c) => c.candidate)).toEqual(['remote:1', 'remote:2']);
  });

  it('releases the microphone when the ending arrives, not when it is asked for', async () => {
    const { result, pc } = await goLive();

    act(() => result.current.stop());

    expect(sendStop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('ending');
    // Still holding the microphone: the call is not over until the runtime says so.
    expect(track.stopped).toBe(false);

    act(() => result.current.onFrame({ kind: 'state', state: 'ended' }));

    expect(result.current.state).toBe('idle');
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
    expect(result.current.remoteStream).toBeNull();
  });

  it('reports a denied microphone itself and sends nothing', async () => {
    getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
    const { result } = render();

    await act(async () => {
      await result.current.start();
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('microphone'));
    expect(result.current.state).toBe('idle');
    expect(sendOffer).not.toHaveBeenCalled();
    expect(FakePC.instances).toEqual([]);
  });

  it('shows a refusal and frees the control, since no ending follows one', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });

    act(() =>
      result.current.onFrame({ kind: 'error', error: 'There is already a voice chat running. End that one first.' }),
    );

    expect(onError).toHaveBeenCalledWith('There is already a voice chat running. End that one first.');
    expect(result.current.state).toBe('idle');
    expect(track.stopped).toBe(true);
  });

  it('waits for the ending after a failure mid-call', async () => {
    const { result } = await goLive();

    act(() => result.current.onFrame({ kind: 'error', error: 'the media connection is failed' }));

    expect(onError).toHaveBeenCalledWith('the media connection is failed');
    // A failure sends `ended` after the error, so the call is ending rather than over.
    expect(result.current.state).toBe('ending');

    act(() => result.current.onFrame({ kind: 'state', state: 'ended' }));
    expect(result.current.state).toBe('idle');
  });

  it('ends a call whose media path never comes up, which no frame reports', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    const pc = FakePC.instances[0]!;

    act(() => pc.enter('failed'));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('audio connection failed'));
    expect(result.current.state).toBe('idle');
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
  });

  it('plays the track the runtime adds, without touching the audio', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    const pc = FakePC.instances[0]!;
    const inbound = new FakeStream([new FakeTrack()]);

    act(() => pc.ontrack?.({ streams: [inbound], track: new FakeTrack() }));

    expect(result.current.remoteStream).toBe(inbound);
  });

  it('ignores a second start while a call is already up', async () => {
    const { result } = await goLive();

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('live');
  });

  it('ends the call when the page goes away', async () => {
    const { result, unmount, pc } = await goLive();
    expect(result.current.state).toBe('live');

    unmount();

    // Otherwise the runtime holds the agent's one voice until the socket closes.
    expect(sendStop).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
  });
});
