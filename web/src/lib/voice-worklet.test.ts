import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The worklet runs on the audio thread and is served as a plain file, so it is loaded
 * here the way the browser loads it: as source, with the globals it is given.
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

type ProcessorClass = new (options?: { processorOptions?: Record<string, unknown> }) => WorkletProcessor;

/** The context rate the worklet reads off the global, and the sample counts below assume. */
const SAMPLE_RATE = 24_000;

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
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeBase,
    registerProcessor,
    SAMPLE_RATE,
  );
  return registered;
}

/** A block of microphone input, as the audio thread hands one over. */
const block = (samples: number[]): Float32Array[][] => [[Float32Array.from(samples)]];

/** One render block. 128 samples is the quantum the browser uses: 5.3 ms at 24 kHz. */
const output = (length = 4): Float32Array[][] => [[new Float32Array(length)]];

/** A chunk of the agent's speech, as the page posts one. */
const voice = (samples: number[]) => ({ stream: 'voice', pcm: Int16Array.from(samples).buffer });
/** A chunk of the sound of the agent's computer. */
const computer = (samples: number[]) => ({
  stream: 'computer',
  pcm: Int16Array.from(samples).buffer,
});

/**
 * A chunk long enough to clear a stream's pre-roll, so the next block plays it.
 *
 * The pre-roll is 40 ms of voice and 120 ms of the computer's sound, and 200 ms clears
 * either while staying under both backlog limits, which would otherwise drop the head of
 * what a test just queued. A test about the pre-roll or the backlog sets its own size.
 */
const enough = (value: number) => Array.from({ length: SAMPLE_RATE * 0.2 }, () => value);

describe('voice-worklet', () => {
  let processors: Map<string, ProcessorClass>;
  let io: WorkletProcessor;

  beforeEach(() => {
    processors = loadProcessors();
    io = new (processors.get('voice-io')!)();
  });

  describe('the microphone', () => {
    it('posts one 20 ms frame per 480 samples and holds the remainder', () => {
      expect(io.process(block(Array.from({ length: 479 }, () => 0)), output())).toBe(true);
      // A part-filled frame is held rather than padded: padding would insert silence
      // in the middle of a word.
      expect(io.port.posted).toHaveLength(0);

      io.process(block([0, 0]), output());
      const captured = io.port.posted.filter(
        (m) => (m as { type?: string }).type === 'capture',
      ) as { pcm: ArrayBuffer }[];
      expect(captured).toHaveLength(1);
      expect(new Int16Array(captured[0]!.pcm)).toHaveLength(480);
    });

    it('takes the frame size the page asked for', () => {
      const wide = new (processors.get('voice-io')!)({ processorOptions: { captureFrames: 960 } });
      wide.process(block(Array.from({ length: 959 }, () => 0)), output());
      expect(wide.port.posted).toHaveLength(0);
      wide.process(block([0]), output());
      expect(wide.port.posted).toHaveLength(1);
    });

    it('scales the samples to pcm16 and clamps what is out of range', () => {
      const samples = [1, -1, 0, 0.5, 2, -2];
      io.process(block([...samples, ...Array.from({ length: 474 }, () => 0)]), output());

      const frame = new Int16Array((io.port.posted[0] as { pcm: ArrayBuffer }).pcm);
      expect(Array.from(frame.slice(0, 6))).toEqual([32_767, -32_768, 0, 16_383, 32_767, -32_768]);
    });

    it('stays alive while the microphone has nothing yet', () => {
      // A node that returns false is torn down and never fed again, which would end
      // the call the moment the microphone was slow to open.
      expect(io.process([[]], output())).toBe(true);
      expect(io.port.posted).toHaveLength(0);
    });
  });

  describe('playback', () => {
    it('plays what it was given and reports the agent as heard', () => {
      io.port.onmessage!({ data: voice([32_767, -32_768, 0, ...enough(0)]) });

      const out = output(3);
      io.process([], out);

      expect(Array.from(out[0]![0]!)).toEqual([32_767 / 32_768, -1, 0]);
      // A whole burst can arrive and drain inside one block, and that is still the
      // agent speaking — the cue in the UI is the browser's only evidence its audio
      // arrived at all.
      expect(io.port.posted).toEqual([{ type: 'speaking', value: true }]);
    });

    it('holds a moment of audio back before starting, then plays it anyway', () => {
      io.port.onmessage!({ data: voice([32_767, -32_768, 0, 0]) });

      // Less than the pre-roll is queued, so the first block is silence rather than the
      // start of a stream that will immediately run dry.
      const first = output();
      io.process([], first);
      expect(Array.from(first[0]![0]!)).toEqual([0, 0, 0, 0]);
      expect(io.port.posted).toEqual([]);

      // 200 ms later it plays what there is, since more may never come.
      for (let i = 0; i < SAMPLE_RATE * 0.2 / 128; i++) io.process([], output(128));
      expect(io.port.posted).toContainEqual({ type: 'speaking', value: true });
    });

    it('pads with silence when nothing is queued', () => {
      const out = output();
      io.process([], out);

      expect(Array.from(out[0]![0]!)).toEqual([0, 0, 0, 0]);
      expect(io.port.posted).toEqual([]);
    });

    it('rides out the gap between bursts before calling the agent silent', () => {
      // Exactly the pre-roll, drained by one block of the same length, so the queue is
      // empty from here and what follows is the gap.
      const preroll = SAMPLE_RATE * 0.04;
      io.port.onmessage!({ data: voice(Array.from({ length: preroll }, () => 1000)) });
      io.process([], output(preroll));
      expect(io.port.posted).toEqual([{ type: 'speaking', value: true }]);

      // 56 blocks of 128 samples is 298 ms of nothing queued. The agent's audio
      // arrives in bursts, so a gap that short sits inside a sentence and the cue
      // must not flicker.
      for (let i = 0; i < 56; i++) io.process([], output(128));
      expect(io.port.posted).toEqual([{ type: 'speaking', value: true }]);

      // Past 300 ms it is a stop.
      io.process([], output(128));
      expect(io.port.posted).toEqual([
        { type: 'speaking', value: true },
        { type: 'speaking', value: false },
      ]);
    });

    it('drops the queued audio on clear', () => {
      io.port.onmessage!({ data: voice(Array.from({ length: 4000 }, () => 32_767)) });
      io.port.onmessage!({ data: { clear: true } });

      const out = output();
      io.process([], out);

      // A barge-in is only honoured if the audio already in the queue goes too.
      expect(Array.from(out[0]![0]!)).toEqual([0, 0, 0, 0]);
      // And the agent is reported silent at once: it was interrupted, so this is not
      // the gap between two bursts.
      expect(io.port.posted).toEqual([]);
    });

    it('carries one chunk across blocks rather than truncating it', () => {
      io.port.onmessage!({ data: voice([1, 2, 3, 4, 5, 6, ...enough(0)]) });

      io.process([], output(2));
      const next = output(2);
      io.process([], next);

      expect(Array.from(next[0]![0]!)).toEqual([3 / 32_768, 4 / 32_768]);
    });
  });

  describe("the computer's sound", () => {
    it('mixes under the voice without counting as the agent speaking', () => {
      io.port.onmessage!({ data: computer(enough(16_384)) });

      const out = output(2);
      io.process([], out);

      expect(out[0]![0]![0]).toBeCloseTo(0.5, 5);
      // The cue in the UI is about the agent, and a video playing on its screen is not
      // the agent talking.
      expect(io.port.posted).toEqual([]);
    });

    it('clamps a mix that would overflow', () => {
      io.port.onmessage!({ data: voice(enough(32_767)) });
      io.port.onmessage!({ data: computer(enough(32_767)) });

      const out = output(2);
      io.process([], out);

      expect(Array.from(out[0]![0]!)).toEqual([1, 1]);
    });

    it('trims a backlog the voice would never build', () => {
      // The computer's sound is live and never stops, so a clock drift only ever grows
      // its queue: past 400 ms of backlog it is cut to 150.
      const tenth = Array.from({ length: SAMPLE_RATE / 10 }, () => 1000);
      for (let i = 0; i < 5; i++) io.port.onmessage!({ data: computer(tenth) });

      // 150 ms at the context rate, and nothing more.
      const out = output(SAMPLE_RATE);
      io.process([], out);
      const played = Array.from(out[0]![0]!).filter((s) => s !== 0).length;
      expect(played).toBeLessThanOrEqual(SAMPLE_RATE * 0.15);
      expect(played).toBeGreaterThan(SAMPLE_RATE * 0.1);
    });

    it('is left alone by a barge-in, which is about the voice', () => {
      io.port.onmessage!({ data: computer(enough(16_384)) });
      io.port.onmessage!({ data: { clear: true } });

      const out = output(2);
      io.process([], out);
      expect(out[0]![0]![0]).toBeCloseTo(0.5, 5);
    });
  });
});
