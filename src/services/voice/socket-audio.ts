/**
 * The audio path for a voice client, over the WebSocket it is already on.
 *
 * There is no negotiation here and nothing to reach: the socket carrying the
 * client's chat carries its voice, so a call works wherever chat works. That is
 * the whole reason this exists in place of a peer connection — a hosted runtime
 * has no inbound path for media, so WebRTC needed a TURN relay per deployment
 * and a voice call that could not be reached was a voice call nobody had.
 *
 * What that costs is real: a socket has no jitter buffer, no packet-loss
 * concealment and no congestion control. Those were WebRTC's, and on a poor
 * cellular link they are missed.
 *
 * The rate is the client's, and every session states it: a client on the model's own
 * `REALTIME_SAMPLE_RATE` resamples nowhere at all, since `VoiceConversation` skips both
 * of its resamplers too. A client that carries the agent's screen as well speaks 48 kHz,
 * where dropping the program audio to the model's rate would dull it.
 */

import { logger } from '../../logger';
import type { PlaybackSink } from '../meeting/audio-playback';
import { REALTIME_SAMPLE_RATE } from '../meeting/resampler';

/** The one format the protocol carries. Declared to the client in `hello`. */
export const VOICE_AUDIO_FORMAT = {
  encoding: 'pcm16',
  sampleRate: REALTIME_SAMPLE_RATE,
  channels: 1,
} as const;

/**
 * The largest frame of client audio this accepts: one second at the session's rate.
 *
 * A client sends 20 to 100 ms a frame, so a second is a wide margin and anything past it
 * is not microphone audio. Bounded here rather than on the WebSocket server, which is
 * shared with chat: `ws` answers an oversize frame by closing the connection with 1009,
 * so a server-wide limit would drop a text client mid-conversation over a large paste.
 * This drops the frame and leaves the call running.
 */
export function maxFrameBytes(sampleRate: number): number {
  return sampleRate * 2;
}

/**
 * Whether a frame the client sent is microphone audio worth carrying.
 *
 * An odd byte count is not: pcm16 is two bytes a sample, and half a sample would shift
 * every sample after it by a byte and turn the rest of the frame into noise. Nor is one
 * past `maxBytes`, since everything downstream is metered by the second of audio.
 *
 * Read wherever a frame is first acted on rather than only by the transport. A recording
 * of the user's screen takes the frame before the transport sees it, and resampling one
 * nobody asked for is the work this bounds.
 */
export function isAudioFrameUsable(pcm: Buffer, maxBytes: number): boolean {
  if (pcm.length === 0) return false;
  if (pcm.length % 2 !== 0) {
    logger.warn({ bytes: pcm.length }, '[VoiceChat] Dropped an audio frame with a half sample');
    return false;
  }
  if (pcm.length > maxBytes) {
    logger.warn({ bytes: pcm.length }, '[VoiceChat] Dropped an audio frame over the size limit');
    return false;
  }
  return true;
}

/** What the transport needs from whoever owns the socket. */
export interface SocketAudioChannel {
  /** Send one frame of the agent's speech. */
  sendAudio(pcm: Buffer): void;
  /** Tell the client to drop what it has not played yet. */
  sendClear(): void;
}

/** What the transport tells its owner. */
export interface SocketAudioEvents {
  /** Audio the client captured, pcm16 mono at the format's rate. */
  onAudio(pcm: Buffer): void;
}

/**
 * The client's audio in, the agent's speech out.
 *
 * There is no connection state of its own: a socket that is open is the media path, so
 * the session is live from the moment it is built, and its owner reports that rather than
 * waiting to be told.
 */
export class SocketAudio {
  private closed = false;
  private readonly maxFrameBytes: number;

  constructor(
    private readonly channel: SocketAudioChannel,
    private readonly events: SocketAudioEvents,
    /** What the client speaks; defaults to the model's own rate. */
    sampleRate: number = REALTIME_SAMPLE_RATE,
  ) {
    this.maxFrameBytes = maxFrameBytes(sampleRate);
  }

  /**
   * Where the voice core writes the agent's speech.
   *
   * One frame per write, whatever size the write is. `AudioPlayback` paces to a
   * 150 ms lead on a 20 ms tick, so this is fed at roughly real time and needs
   * no pacing or backpressure of its own — the thing that would flood a socket
   * is a producer that runs faster than the audio, and that producer is a clock.
   */
  readonly sink: PlaybackSink = {
    write: (chunk: Buffer): void => {
      if (this.closed || chunk.length === 0) return;
      this.channel.sendAudio(chunk);
    },
    clear: (): void => {
      if (this.closed) return;
      // Everything already written is in the client's buffer. Without this the
      // agent talks over the person who interrupted it, for as long as that
      // buffer plus the network holds.
      this.channel.sendClear();
    },
  };

  /** A frame the client sent, carried on if `isAudioFrameUsable` says it is audio. */
  push(pcm: Buffer): void {
    if (this.closed) return;
    if (!isAudioFrameUsable(pcm, this.maxFrameBytes)) return;
    this.events.onAudio(pcm);
  }

  /** Stop passing audio in either direction. Idempotent. */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
