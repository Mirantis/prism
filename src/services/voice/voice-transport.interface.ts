/**
 * The audio path between a voice client and the voice core.
 *
 * Four members, because that is the whole of what a session owner needs: answer the
 * client's offer, take its ICE candidates, hand the core somewhere to write speech, and
 * shut down. Narrow on purpose — the Node WebRTC library the implementation uses ships
 * about twice a year, so a replacement has to stay a one-file job.
 */

import type { PlaybackSink } from '../meeting/audio-playback';

/** One ICE candidate, in the shape the client sends and receives it. */
export interface VoiceIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** What the transport tells its owner while a session runs. */
export interface VoiceTransportEvents {
  /** Audio the client captured: pcm16 mono at 48 kHz. */
  onAudio(pcm48k: Buffer): void;
  /** A local candidate the client needs in order to complete the path. */
  onIceCandidate(candidate: VoiceIceCandidate): void;
  /** The media path is up: the client can hear the agent from here on. */
  onConnected(): void;
  /** The media path is gone, and why. */
  onClosed(reason: string): void;
}

export interface VoiceTransport {
  /** Answer the client's offer. The returned SDP is the answer, verbatim. */
  accept(offerSdp: string): Promise<string>;
  /** Add a candidate the client sent. */
  addIceCandidate(candidate: VoiceIceCandidate): Promise<void>;
  /** Where the voice core writes the agent's speech, at any chunk size. */
  readonly sink: PlaybackSink;
  /** Release the peer, the track and the capture sink. Idempotent. */
  close(): Promise<void>;
}
