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
 * One rate throughout, `REALTIME_SAMPLE_RATE`, which is the model's own. So
 * nothing here resamples, and `VoiceConversation` skips both of its resamplers
 * too: the bytes the client captured reach the model unchanged, and the model's
 * speech reaches the client the same way.
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
 * No `accept`, no candidates and no connection state: a socket that is open is
 * the media path, so the session is live from the moment it is built. Its owner
 * reports that rather than waiting for a peer to say so.
 */
export class SocketAudio {
  private closed = false;

  constructor(
    private readonly channel: SocketAudioChannel,
    private readonly events: SocketAudioEvents,
  ) {}

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

  /**
   * A frame the client sent.
   *
   * An odd byte count is dropped rather than passed on: pcm16 is two bytes a
   * sample, and half a sample would shift every sample after it by a byte and
   * turn the rest of the frame into noise.
   */
  push(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    if (pcm.length % 2 !== 0) {
      logger.warn({ bytes: pcm.length }, '[VoiceChat] Dropped an audio frame with a half sample');
      return;
    }
    this.events.onAudio(pcm);
  }

  /** Stop passing audio in either direction. Idempotent. */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
