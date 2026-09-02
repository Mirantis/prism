/*
 * The audio thread of a voice chat: the microphone out as pcm16 frames, the agent's
 * speech in as a queue this plays.
 *
 * Two processors in one module, because they are one feature and a module is one fetch.
 * Served from `public/`, so the same file is delivered by the dev server and by the
 * runtime's static build.
 *
 * Everything crosses the boundary as a message on the node's port, so audio and the
 * `clear` that cancels it stay in the order they were posted.
 */

/** 20 ms at 24 kHz. The rate the context runs at, so no resampling happens here. */
const FRAME_SAMPLES = 480;

/**
 * How much silence ends a stretch of speech: 300 ms at the session rate.
 *
 * The agent's audio arrives in bursts, so the queue runs dry between them. Without a
 * wait the playback would report the agent as starting and stopping several times per
 * sentence, and the cue in the UI would flicker instead of saying anything.
 */
const IDLE_SILENCE_SAMPLES = FRAME_SAMPLES * 15;

/** Turns the microphone into pcm16 frames of a fixed size. */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input yet (the microphone is still opening) is silence, not an end: return
    // true or the node is torn down and never fed again.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = sample < 0 ? sample * 0x80_00 : sample * 0x7f_ff;
      if (this.filled === FRAME_SAMPLES) {
        // A copy, transferred: the buffer is refilled on the next block.
        const frame = this.buffer.slice();
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

/**
 * Plays what the agent said, and drops it when the agent is interrupted.
 *
 * Reports `speaking` and `idle` on the port. That is the only evidence in the browser
 * that the agent's audio arrived and was played, so the UI can say so.
 */
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Int16Array[]} */
    this.queue = [];
    this.offset = 0;
    this.speaking = false;
    this.silence = IDLE_SILENCE_SAMPLES;
    this.port.onmessage = (event) => {
      if (event.data === 'clear') {
        this.queue = [];
        this.offset = 0;
        // An interruption stops the agent now, so the next block reports it rather
        // than waiting out the gap a burst between frames gets.
        this.silence = IDLE_SILENCE_SAMPLES;
        return;
      }
      this.queue.push(new Int16Array(event.data));
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    let played = 0;
    for (let i = 0; i < output.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        output[i] = 0;
        continue;
      }
      output[i] = chunk[this.offset++] / 0x80_00;
      played++;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // Reported on what was played, not on what is left queued: a whole burst can arrive
    // and drain inside one block, and that is the agent speaking.
    if (played > 0) {
      this.silence = 0;
      this.setSpeaking(true);
    } else {
      this.silence += output.length;
      if (this.silence >= IDLE_SILENCE_SAMPLES) this.setSpeaking(false);
    }
    return true;
  }

  setSpeaking(speaking) {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.port.postMessage(speaking ? 'speaking' : 'idle');
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
registerProcessor('voice-playback', VoicePlaybackProcessor);
