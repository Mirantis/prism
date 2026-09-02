import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The worklet runs on the audio thread and is served as a plain file, so it is loaded
 * here the way the browser loads it: as source, with the two globals it is given.
 */
interface WorkletPort {
  posted: unknown[];
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (data: unknown, transfer?: unknown[]) => void;
}

interface WorkletProcessor {
  port: WorkletPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

type ProcessorClass = new () => WorkletProcessor;

function loadProcessors(): Map<string, ProcessorClass> {
  const source = readFileSync(new URL('../../public/voice-worklet.js', import.meta.url), 'utf8');
  const registered = new Map<string, ProcessorClass>();

  class FakeBase {
    port: WorkletPort = {
      posted: [],
      onmessage: null,
      postMessage(data: unknown) {
        this.posted.push(data);
      },
    };
  }
  const registerProcessor = (name: string, cls: ProcessorClass) => registered.set(name, cls);

  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', source)(FakeBase, registerProcessor);
  return registered;
}

/** A block of microphone input, as the audio thread hands one over. */
const block = (samples: number[]): Float32Array[][] => [[Float32Array.from(samples)]];

describe('voice-worklet', () => {
  let processors: Map<string, ProcessorClass>;

  beforeEach(() => {
    processors = loadProcessors();
  });

  describe('voice-capture', () => {
    it('posts one 20 ms frame per 480 samples and holds the remainder', () => {
      const capture = new (processors.get('voice-capture')!)();

      expect(capture.process(block(Array.from({ length: 479 }, () => 0)), [])).toBe(true);
      // A part-filled frame is held rather than padded: padding would insert silence
      // in the middle of a word.
      expect(capture.port.posted).toHaveLength(0);

      capture.process(block([0, 0]), []);
      expect(capture.port.posted).toHaveLength(1);

      const frame = new Int16Array(capture.port.posted[0] as ArrayBuffer);
      expect(frame).toHaveLength(480);
    });

    it('scales the samples to pcm16 and clamps what is out of range', () => {
      const capture = new (processors.get('voice-capture')!)();
      const samples = [1, -1, 0, 0.5, 2, -2];
      capture.process(block([...samples, ...Array.from({ length: 474 }, () => 0)]), []);

      const frame = new Int16Array(capture.port.posted[0] as ArrayBuffer);
      expect(Array.from(frame.slice(0, 6))).toEqual([32_767, -32_768, 0, 16_383, 32_767, -32_768]);
    });

    it('stays alive while the microphone has nothing yet', () => {
      const capture = new (processors.get('voice-capture')!)();
      // A node that returns false is torn down and never fed again, which would end
      // the call the moment the microphone was slow to open.
      expect(capture.process([[]], [])).toBe(true);
      expect(capture.port.posted).toHaveLength(0);
    });
  });

  describe('voice-playback', () => {
    /** One render block. 128 samples is the quantum the browser uses: 5.3 ms at 24 kHz. */
    const output = (length = 4) => [[new Float32Array(length)]];

    it('plays what it was given and reports the agent as heard', () => {
      const playback = new (processors.get('voice-playback')!)();
      playback.port.onmessage!({ data: new Int16Array([32_767, -32_768, 0]).buffer });

      const out = output();
      playback.process([], out);

      expect(Array.from(out[0]![0]!.slice(0, 3))).toEqual([32_767 / 32_768, -1, 0]);
      // A whole burst can arrive and drain inside one block, and that is still the
      // agent speaking — the cue in the UI is the browser's only evidence its audio
      // arrived at all.
      expect(playback.port.posted).toEqual(['speaking']);
    });

    it('rides out the gap between bursts before calling the agent silent', () => {
      const playback = new (processors.get('voice-playback')!)();
      playback.port.onmessage!({ data: new Int16Array([1, 2, 3, 4]).buffer });
      playback.process([], output());
      expect(playback.port.posted).toEqual(['speaking']);

      // 56 blocks of 128 samples is 298 ms of nothing queued. The agent's audio
      // arrives in bursts, so a gap that short sits inside a sentence and the cue
      // must not flicker.
      for (let i = 0; i < 56; i++) playback.process([], output(128));
      expect(playback.port.posted).toEqual(['speaking']);

      // Past 300 ms it is a stop.
      playback.process([], output(128));
      expect(playback.port.posted).toEqual(['speaking', 'idle']);
    });

    it('pads with silence when nothing is queued', () => {
      const playback = new (processors.get('voice-playback')!)();

      const out = output();
      playback.process([], out);

      expect(Array.from(out[0]![0]!)).toEqual([0, 0, 0, 0]);
      expect(playback.port.posted).toEqual([]);
    });

    it('drops the queued audio on clear', () => {
      const playback = new (processors.get('voice-playback')!)();
      playback.port.onmessage!({ data: new Int16Array([32_767, 32_767, 32_767, 32_767]).buffer });
      playback.port.onmessage!({ data: 'clear' });

      const out = output();
      playback.process([], out);

      // A barge-in is only honoured if the audio already in the queue goes too.
      expect(Array.from(out[0]![0]!)).toEqual([0, 0, 0, 0]);
      // And the agent is reported silent at once: it was interrupted, so this is not
      // the gap between two bursts.
      expect(playback.port.posted).toEqual([]);

      playback.port.onmessage!({ data: new Int16Array([1, 2]).buffer });
      playback.process([], output());
      playback.port.onmessage!({ data: 'clear' });
      playback.process([], output());
      expect(playback.port.posted).toEqual(['speaking', 'idle']);
    });

    it('carries one chunk across blocks rather than truncating it', () => {
      const playback = new (processors.get('voice-playback')!)();
      playback.port.onmessage!({ data: new Int16Array([1, 2, 3, 4, 5, 6]).buffer });

      const first = output();
      playback.process([], first);
      const second = output();
      playback.process([], second);

      expect(Array.from(second[0]![0]!.slice(0, 2))).toEqual([5 / 32_768, 6 / 32_768]);
    });
  });
});
