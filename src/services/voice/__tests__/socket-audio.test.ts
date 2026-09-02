/**
 * The transport is deliberately thin, so these tests are about the two things it
 * could get wrong and nothing else: passing audio through untouched in both
 * directions, and going quiet once the session is over.
 */

import { describe, it, expect, vi } from 'vitest';
import { SocketAudio, VOICE_AUDIO_FORMAT } from '../socket-audio';
import { REALTIME_SAMPLE_RATE } from '../../meeting/resampler';

vi.mock('../../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function build() {
  const sent: Buffer[] = [];
  const cleared = vi.fn();
  const received: Buffer[] = [];
  const audio = new SocketAudio(
    { sendAudio: (pcm) => void sent.push(pcm), sendClear: cleared },
    { onAudio: (pcm) => void received.push(pcm) },
  );
  return { audio, sent, cleared, received };
}

describe('the format it declares', () => {
  /**
   * The model's own rate, which is the whole reason the voice core can skip both
   * of its resamplers on this path.
   */
  it('is the rate the model speaks', () => {
    expect(VOICE_AUDIO_FORMAT.sampleRate).toBe(REALTIME_SAMPLE_RATE);
    expect(VOICE_AUDIO_FORMAT.encoding).toBe('pcm16');
    expect(VOICE_AUDIO_FORMAT.channels).toBe(1);
  });
});

describe('audio from the client', () => {
  it('reaches the core byte for byte', () => {
    const { audio, received } = build();
    const frame = Buffer.from([1, 2, 3, 4, 5, 6]);

    audio.push(frame);

    expect(received).toHaveLength(1);
    expect(received[0].equals(frame)).toBe(true);
  });

  /**
   * pcm16 is two bytes a sample. Half a sample would shift every sample after it
   * by one byte and turn the rest of the stream into noise, so the frame is
   * dropped rather than passed on.
   */
  it('drops a frame carrying half a sample', () => {
    const { audio, received } = build();
    audio.push(Buffer.from([1, 2, 3]));
    expect(received).toHaveLength(0);
  });

  it('ignores an empty frame', () => {
    const { audio, received } = build();
    audio.push(Buffer.alloc(0));
    expect(received).toHaveLength(0);
  });
});

describe('the agent speaking', () => {
  it('sends one frame per write, unchanged', () => {
    const { audio, sent } = build();
    const first = Buffer.alloc(960, 1);
    const second = Buffer.alloc(320, 2);

    audio.sink.write(first);
    audio.sink.write(second);

    expect(sent).toHaveLength(2);
    expect(sent[0].equals(first)).toBe(true);
    expect(sent[1].equals(second)).toBe(true);
  });

  /**
   * No re-framing. The WebRTC path had to cut writes into 480-sample frames
   * because `RTCAudioSource` threw on anything else; a socket has no such rule,
   * and `AudioPlayback`'s own pacing is what keeps the rate honest.
   */
  it('re-frames nothing', () => {
    const { audio, sent } = build();
    audio.sink.write(Buffer.alloc(7_000, 9));
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBe(7_000);
  });

  it('says nothing for an empty write', () => {
    const { audio, sent } = build();
    audio.sink.write(Buffer.alloc(0));
    expect(sent).toHaveLength(0);
  });

  it('asks the client to drop what it has not played', () => {
    const { audio, cleared } = build();
    audio.sink.clear?.();
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});

describe('once it is closed', () => {
  it('passes no audio in either direction', async () => {
    const { audio, sent, received, cleared } = build();
    await audio.close();

    audio.push(Buffer.alloc(320));
    audio.sink.write(Buffer.alloc(320));
    audio.sink.clear?.();

    expect(received).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(cleared).not.toHaveBeenCalled();
  });

  it('closes more than once without complaint', async () => {
    const { audio } = build();
    await audio.close();
    await expect(audio.close()).resolves.toBeUndefined();
  });
});
