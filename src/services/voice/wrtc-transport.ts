/**
 * A WebRTC audio path for a voice client, built on `@roamhq/wrtc`.
 *
 * The one implementation of `VoiceTransport`. Two frame contracts meet here, and both
 * are the library's, not ours:
 *
 * - **In**, `RTCAudioSink` delivers decoded 10 ms frames of pcm16 mono at 48 kHz, which
 *   is exactly what `VoiceConversation.pushAudio` takes. The first frames of every
 *   session arrive at 16 kHz and silent, so the rate is read per frame and anything but
 *   48 kHz is dropped.
 * - **Out**, `RTCAudioSource.onData` accepts 480 samples and throws on any other count,
 *   while `AudioPlayback` writes whatever size its pacing produces. So the sink here
 *   re-frames: a carry buffer emits 960-byte frames and holds the remainder. It changes
 *   no sample.
 *
 * The addon is imported lazily. `scripts/collect-natives.mjs` skips a package it cannot
 * resolve, so a build on a host without this platform's binding would otherwise ship a
 * runtime that dies on its first import rather than one whose voice chat is unavailable.
 */

import { config, type IceServerConfig } from '../../config';
import { logger } from '../../logger';
import type { PlaybackSink } from '../meeting/audio-playback';
import type { VoiceIceCandidate, VoiceTransport, VoiceTransportEvents } from './voice-transport.interface';

/** The rate both contracts are written in. */
const SAMPLE_RATE = 48_000;
/** 10 ms at that rate — the only frame size the outbound source accepts. */
const FRAME_SAMPLES = 480;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * What this file uses of `@roamhq/wrtc`, declared here rather than imported.
 *
 * The package's own types re-export the DOM's, which this runtime does not compile with,
 * and a narrow local shape is also what a swap to another library is measured against.
 */
interface AudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample: number;
  channelCount: number;
  numberOfFrames: number;
}

interface TrackLike {
  stop(): void;
}

interface AudioSinkLike {
  ondata: ((data: AudioData) => void) | null;
  stop(): void;
}

interface PeerLike {
  onicecandidate: ((event: { candidate: VoiceIceCandidate | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: { track: TrackLike }) => void) | null;
  readonly connectionState: string;
  addTrack(track: TrackLike): unknown;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: VoiceIceCandidate): Promise<void>;
  close(): void;
}

interface WrtcModule {
  RTCPeerConnection: new (configuration: { iceServers: IceServerConfig[] }) => PeerLike;
  nonstandard: {
    RTCAudioSink: new (track: TrackLike) => AudioSinkLike;
    RTCAudioSource: new () => { createTrack(): TrackLike; onData(data: AudioData): void };
  };
}

let loaded: WrtcModule | null = null;

/** Load the addon once, on first use. */
async function loadWrtc(): Promise<WrtcModule> {
  loaded ??= (await import('@roamhq/wrtc')) as unknown as WrtcModule;
  return loaded;
}

/**
 * Whether this build can carry a voice session at all.
 *
 * Asked before a session is offered, so a runtime without the native binding refuses in
 * words instead of throwing on the first offer.
 */
export async function isVoiceTransportAvailable(): Promise<boolean> {
  try {
    await loadWrtc();
    return true;
  } catch (err) {
    logger.warn({ err }, '[Voice] WebRTC is unavailable in this build; voice chat is off');
    return false;
  }
}

class WrtcTransport implements VoiceTransport {
  private readonly peer: PeerLike;
  private readonly source: { createTrack(): TrackLike; onData(data: AudioData): void };
  private readonly track: TrackLike;
  private readonly captureSinks: AudioSinkLike[] = [];
  private closed = false;
  /** Bytes short of a whole outbound frame, waiting for the next write. */
  private carry = Buffer.alloc(0);

  constructor(
    wrtc: WrtcModule,
    private readonly events: VoiceTransportEvents,
  ) {
    // Nothing here is a default: an unconfigured runtime offers host candidates only, so
    // the client has to be able to reach the runtime's host directly.
    this.peer = new wrtc.RTCPeerConnection({ iceServers: config.voiceIceServers });
    this.source = new wrtc.nonstandard.RTCAudioSource();
    this.track = this.source.createTrack();
    this.peer.addTrack(this.track);

    this.peer.ontrack = (event) => {
      this.attachCapture(new wrtc.nonstandard.RTCAudioSink(event.track));
    };

    this.peer.onicecandidate = (event) => {
      // The null candidate marks the end of gathering, which the client does not need.
      if (event.candidate) this.events.onIceCandidate(event.candidate);
    };

    this.peer.onconnectionstatechange = () => {
      const state = this.peer.connectionState;
      if (state === 'connected') this.events.onConnected();
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.events.onClosed(`the media connection is ${state}`);
      }
    };
  }

  readonly sink: PlaybackSink = {
    write: (chunk: Buffer): void => {
      if (this.closed || chunk.length === 0) return;
      const pending = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
      let offset = 0;
      while (pending.length - offset >= FRAME_BYTES) {
        this.emitFrame(pending.subarray(offset, offset + FRAME_BYTES));
        offset += FRAME_BYTES;
      }
      // Copied, so the remainder does not pin the caller's buffer until the next write.
      this.carry = Buffer.from(pending.subarray(offset));
    },
  };

  async accept(offerSdp: string): Promise<string> {
    await this.peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    if (!answer.sdp) throw new Error('The peer answered with no SDP');
    return answer.sdp;
  }

  async addIceCandidate(candidate: VoiceIceCandidate): Promise<void> {
    if (this.closed) return;
    await this.peer.addIceCandidate(candidate);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sink of this.captureSinks) {
      try {
        sink.stop();
      } catch (err) {
        logger.warn({ err }, '[Voice] Capture sink would not stop');
      }
    }
    this.track.stop();
    this.peer.close();
  }

  /** Take the client's audio off a track it has just added. */
  private attachCapture(sink: AudioSinkLike): void {
    this.captureSinks.push(sink);
    sink.ondata = (data) => {
      if (this.closed) return;
      // A session opens with a couple of 16 kHz silent frames, and the core's
      // downsampler is built for 48 kHz alone.
      if (data.sampleRate !== SAMPLE_RATE) return;
      this.events.onAudio(Buffer.copyBytesFrom(data.samples));
    };
  }

  /** Hand one 10 ms frame to the outbound track. */
  private emitFrame(frame: Buffer): void {
    const samples = new Int16Array(FRAME_SAMPLES);
    Buffer.from(samples.buffer).set(frame);
    this.source.onData({
      samples,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: FRAME_SAMPLES,
    });
  }
}

/** Build a transport, wired to the peer and gathering candidates. */
export async function createWrtcTransport(events: VoiceTransportEvents): Promise<VoiceTransport> {
  return new WrtcTransport(await loadWrtc(), events);
}
