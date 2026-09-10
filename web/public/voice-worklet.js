/*
 * The audio thread of a voice chat: the microphone out as pcm16 frames, and what the
 * agent sends in, played.
 *
 * One processor does both directions, so a page wires one node between its microphone
 * and its speakers. Served from `public/`, so the same file is delivered by the dev
 * server and by the runtime's static build.
 *
 * Two streams come in and are mixed. The agent's voice is one. The other is the sound of
 * the computer the agent is working on, which a session with one sends alongside, and
 * which is live rather than paced — a video playing on the agent's screen arrives chunk
 * by chunk as it is recorded. Each is played as one continuous stream, so a late chunk
 * plays late and a gap is silence, never a click at a chunk boundary.
 *
 * Everything crosses the boundary as a message on the node's port, so audio and the
 * `clear` that cancels it stay in the order they were posted.
 *
 * Messages in:  { stream: 'voice' | 'computer', pcm: ArrayBuffer }  pcm16 at the context rate
 *               { clear: true }                                     drop the unplayed voice
 * Messages out: { type: 'capture', pcm: ArrayBuffer }
 *               { type: 'speaking', value: boolean }
 */

/** Capture frame size when the page names none: 20 ms at 24 kHz. */
const DEFAULT_CAPTURE_FRAMES = 480;

/**
 * Audio to hold before a stream that ran dry starts playing, in seconds.
 *
 * The agent's voice is paced by the runtime and arrives ahead of real time, so it needs
 * little. The computer's sound is recorded live, so it needs a real jitter buffer: with a
 * small one the queue runs dry between chunks, and every time it does the wait for a
 * pre-roll puts a gap in the sound.
 */
const VOICE_PREROLL_S = 0.04;
const COMPUTER_PREROLL_S = 0.12;
/** How long to wait for that pre-roll before playing what there is, in seconds. */
const PREROLL_DEADLINE_S = 0.2;

/**
 * How much silence ends a stretch of speech.
 *
 * The agent's audio arrives in bursts, so the queue runs dry between them. Without a
 * wait the playback would report the agent as starting and stopping several times per
 * sentence, and the cue in the UI would flicker instead of saying anything.
 */
const SPEAKING_HANGOVER_S = 0.3;

/**
 * The computer's sound is live and never stops, so a clock drift only ever grows its
 * queue. Past this much backlog it is cut back to the target.
 */
const BACKLOG_LIMIT_S = 0.4;
const BACKLOG_TARGET_S = 0.15;

/** Chunks of pcm16 played as one continuous stream, mixed into the output. */
class StreamQueue {
  constructor(prerollSeconds) {
    this.prerollFrames = prerollSeconds * sampleRate;
    /** @type {Int16Array[]} */
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
      for (let i = 0; i < n; i++) output[filled + i] += head[this.headOffset + i] / 0x80_00;
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

class VoiceIoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frames = options?.processorOptions?.captureFrames;
    this.captureFrames = typeof frames === 'number' && frames > 0 ? frames : DEFAULT_CAPTURE_FRAMES;
    this.capture = new Int16Array(this.captureFrames);
    this.filled = 0;
    this.voice = new StreamQueue(VOICE_PREROLL_S);
    this.computer = new StreamQueue(COMPUTER_PREROLL_S);
    this.speaking = false;
    this.silence = SPEAKING_HANGOVER_S * sampleRate;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.clear) {
        this.voice.clear();
        // An interruption stops the agent now, so the next block reports it rather than
        // waiting out the gap a burst between frames gets.
        this.silence = SPEAKING_HANGOVER_S * sampleRate;
        return;
      }
      const samples = new Int16Array(message.pcm);
      if (message.stream === 'computer') {
        this.computer.push(samples);
        if (this.computer.frames > BACKLOG_LIMIT_S * sampleRate) {
          this.computer.trimTo(BACKLOG_TARGET_S * sampleRate);
        }
        return;
      }
      this.voice.push(samples);
    };
  }

  process(inputs, outputs) {
    this.captureInput(inputs[0]?.[0]);

    const output = outputs[0]?.[0];
    // No output yet is not an end: return true or the node is torn down and never fed
    // again, which would end the call the moment the graph was slow to settle.
    if (!output) return true;

    output.fill(0);
    const voiceFrames = this.voice.mixInto(output);
    this.computer.mixInto(output);
    for (let i = 0; i < output.length; i++) {
      if (output[i] > 1) output[i] = 1;
      else if (output[i] < -1) output[i] = -1;
    }

    // Reported on what was played, not on what is left queued: a whole burst can arrive
    // and drain inside one block, and that is the agent speaking. Only its own voice
    // counts, never the sound of its computer.
    if (voiceFrames > 0) {
      this.silence = 0;
      this.setSpeaking(true);
    } else {
      this.silence += output.length;
      if (this.silence >= SPEAKING_HANGOVER_S * sampleRate) this.setSpeaking(false);
    }
    return true;
  }

  /** Pack the microphone into fixed-size pcm16 frames. A part-filled frame is held. */
  captureInput(input) {
    // No input yet (the microphone is still opening) is silence, not an end.
    if (!input) return;
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      this.capture[this.filled++] = sample < 0 ? sample * 0x80_00 : sample * 0x7f_ff;
      if (this.filled < this.captureFrames) continue;
      // A copy, transferred: the buffer is refilled on the next block.
      const frame = this.capture.slice();
      this.port.postMessage({ type: 'capture', pcm: frame.buffer }, [frame.buffer]);
      this.filled = 0;
    }
  }

  setSpeaking(speaking) {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.port.postMessage({ type: 'speaking', value: speaking });
  }
}

registerProcessor('voice-io', VoiceIoProcessor);
