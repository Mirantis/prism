/**
 * The audio thread half of the voice chat.
 *
 * One worklet does both directions. Input frames from the microphone are packed
 * into fixed-size pcm16 chunks and posted to the main thread, which sends them on
 * the socket. Output mixes two streams the main thread posts in, each played as one
 * continuous stream: the agent's voice, and the sound of the agent's browser. A late
 * chunk plays late, and a gap is silence, never a click at a chunk boundary.
 *
 * Messages in:  { type: 'play', samples }         the agent's voice
 *               { type: 'play-screen', samples }  the browser's sound
 *               { type: 'clear' }                 drop the agent's unplayed voice
 * Messages out: { type: 'capture', pcm: ArrayBuffer } | { type: 'playing', value: boolean }
 */

/** Frames per capture message: ~43 ms at 48 kHz. */
const CAPTURE_FRAMES = 2048;
/**
 * Audio to hold before a stream that ran dry starts playing again, in seconds.
 *
 * The agent's voice arrives 150 ms ahead of real time from the runtime, so it needs
 * little here. The browser's sound arrives live, chunk by chunk, so it needs a real
 * jitter buffer: with a small one the queue runs dry between chunks, and every time
 * it does the wait for a pre-roll puts a gap in the sound.
 */
const VOICE_PREROLL_S = 0.04;
const SCREEN_PREROLL_S = 0.12;
/** How long to wait for the pre-roll before playing what there is, in seconds. */
const PREROLL_DEADLINE_S = 0.2;
/** Silence after the last voice frame before the agent counts as no longer speaking. */
const SPEAKING_HANGOVER_S = 0.25;
/**
 * The browser's sound is live and never stops, so a clock drift only ever grows its
 * queue. Past this much backlog it is cut back to `BACKLOG_TARGET_S`.
 */
const BACKLOG_LIMIT_S = 0.4;
const BACKLOG_TARGET_S = 0.15;

/** Decoded chunks played as one continuous stream, mixed into the output. */
class StreamQueue {
  constructor(prerollSeconds) {
    this.prerollFrames = prerollSeconds * sampleRate;
    this.chunks = [];
    this.headOffset = 0;
    this.frames = 0;
    this.prerolling = false;
    this.waitingFrames = 0;
  }

  push(samples) {
    if (this.frames === 0) {
      this.prerolling = true;
      this.waitingFrames = 0;
    }
    this.chunks.push(samples);
    this.frames += samples.length;
  }

  clear() {
    this.chunks = [];
    this.headOffset = 0;
    this.frames = 0;
    this.prerolling = false;
  }

  /** Drop the oldest audio until at most `frames` remain. */
  trimTo(frames) {
    while (this.frames > frames && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.frames - frames;
      const available = head.length - this.headOffset;
      if (available <= excess) {
        this.chunks.shift();
        this.headOffset = 0;
        this.frames -= available;
      } else {
        this.headOffset += excess;
        this.frames -= excess;
      }
    }
  }

  /** Add up to `output.length` frames into `output`. Returns how many were added. */
  mixInto(output) {
    if (this.frames === 0) return 0;
    if (this.prerolling) {
      this.waitingFrames += output.length;
      const enough = this.frames >= this.prerollFrames;
      const waited = this.waitingFrames >= PREROLL_DEADLINE_S * sampleRate;
      if (!enough && !waited) return 0;
      this.prerolling = false;
    }
    let filled = 0;
    while (filled < output.length && this.chunks.length > 0) {
      const head = this.chunks[0];
      const n = Math.min(output.length - filled, head.length - this.headOffset);
      for (let i = 0; i < n; i++) output[filled + i] += head[this.headOffset + i];
      filled += n;
      this.headOffset += n;
      this.frames -= n;
      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return filled;
  }
}

class VoiceChatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voice = new StreamQueue(VOICE_PREROLL_S);
    this.screen = new StreamQueue(SCREEN_PREROLL_S);
    this.capture = new Float32Array(CAPTURE_FRAMES);
    this.captureLength = 0;
    this.playing = false;
    this.silentFrames = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'play') {
        this.voice.push(msg.samples);
      } else if (msg.type === 'play-screen') {
        this.screen.push(msg.samples);
        if (this.screen.frames > BACKLOG_LIMIT_S * sampleRate) {
          this.screen.trimTo(BACKLOG_TARGET_S * sampleRate);
        }
      } else if (msg.type === 'clear') {
        this.voice.clear();
      }
    };
  }

  process(inputs, outputs) {
    this.captureInput(inputs[0] && inputs[0][0]);
    const output = outputs[0][0];
    const voiceFrames = this.voice.mixInto(output);
    this.screen.mixInto(output);
    for (let i = 0; i < output.length; i++) {
      if (output[i] > 1) output[i] = 1;
      else if (output[i] < -1) output[i] = -1;
    }
    this.reportSpeaking(voiceFrames, output.length);
    return true;
  }

  captureInput(input) {
    if (!input) return;
    let offset = 0;
    while (offset < input.length) {
      const n = Math.min(input.length - offset, CAPTURE_FRAMES - this.captureLength);
      this.capture.set(input.subarray(offset, offset + n), this.captureLength);
      this.captureLength += n;
      offset += n;
      if (this.captureLength < CAPTURE_FRAMES) continue;
      const pcm = new Int16Array(CAPTURE_FRAMES);
      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        const s = Math.max(-1, Math.min(1, this.capture[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'capture', pcm: pcm.buffer }, [pcm.buffer]);
      this.captureLength = 0;
    }
  }

  /** Only the agent's own voice counts as speaking, not the browser's sound. */
  reportSpeaking(voiceFrames, quantum) {
    if (voiceFrames > 0) {
      this.silentFrames = 0;
      if (!this.playing) {
        this.playing = true;
        this.port.postMessage({ type: 'playing', value: true });
      }
      return;
    }
    if (!this.playing) return;
    this.silentFrames += quantum;
    if (this.silentFrames < SPEAKING_HANGOVER_S * sampleRate) return;
    this.playing = false;
    this.port.postMessage({ type: 'playing', value: false });
  }
}

registerProcessor('voice-chat-processor', VoiceChatProcessor);
