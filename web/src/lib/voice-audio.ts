/**
 * The browser half of a voice chat's audio: the microphone as pcm16 frames, and what the
 * agent sends back, played.
 *
 * One `AudioContext` at the rate the session speaks, so nothing here resamples and the
 * bytes the microphone produced are the bytes the runtime forwards. Both directions run
 * in `public/voice-worklet.js` on the audio thread — a worklet rather than a script
 * processor, because a dropped block is a gap in a live conversation.
 *
 * Nothing is recorded. The capture frames go to `onFrame` and the played frames are
 * dropped after playing, so a call leaves nothing behind in the tab either.
 */

/** The rate a call from the chat composer runs at, in both directions. `voice_hello` states it. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Served from `public/`, so this path is the same in dev and in the built bundle. */
const WORKLET_URL = '/voice-worklet.js';

/** How much audio a capture frame carries, in seconds. */
const CAPTURE_SECONDS = 0.02;

export interface VoiceAudioOptions {
  /** False for desktop playback without microphone access. */
  capture?: boolean;
  /** The rate the session speaks. The microphone and the playback both run at it. */
  sampleRate: number;
  /** One frame of the microphone, pcm16 mono. Called on every 20 ms of audio. */
  onFrame: (frame: ArrayBuffer) => void;
  /** The agent's audio started or stopped playing — the browser's own evidence of it. */
  onSpeaking?: (speaking: boolean) => void;
}

export interface VoiceAudio {
  /**
   * Let the browser start the speakers, if it was holding them until a gesture.
   *
   * Called from a click the page already handles. Playback is the half that needs
   * permission; the microphone was granted when the call opened.
   */
  resume: () => void;
  /** Play a frame of the agent's speech, pcm16 at the session's rate. */
  enqueue: (frame: ArrayBuffer) => void;
  /**
   * Play a frame of what the agent's computer is playing, mixed under its voice.
   *
   * A session without a computer never calls this. What arrives here is live rather than
   * paced, so the worklet holds a jitter buffer for it and trims it when a clock drift
   * grows the backlog.
   */
  enqueueComputer: (frame: ArrayBuffer) => void;
  /** Drop what has not played yet, because the agent was interrupted. */
  clear: () => void;
  /** End the call's audio and release the microphone. */
  stop: () => Promise<void>;
}

/**
 * Open the microphone and the playback path.
 *
 * Rejects when the user denies the microphone or the worklet cannot load, and leaves
 * nothing open when it does: a caller that failed to start has nothing to stop.
 */
export async function startVoiceAudio(options: VoiceAudioOptions): Promise<VoiceAudio> {
  // The microphone first. It is the one step that asks the user, so failing here should
  // cost nothing else.
  const stream = options.capture === false ? null : await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ sampleRate: options.sampleRate });
    await context.audioWorklet.addModule(WORKLET_URL);
    // A tab that has not played audio yet starts suspended. Asked to resume, and never
    // awaited: a page that opens a call on mount has no user activation behind it, and
    // there the promise is held until the browser allows audio rather than rejected. The
    // call itself does not need the speakers, so it goes on without them and `resume()`
    // is asked again on the next click the page sees.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);

    const source = stream ? context.createMediaStreamSource(stream) : null;
    // One node for both directions: its input is the microphone and its output is what
    // the agent sends, so it sits between the two and is pulled by the destination.
    const io = new AudioWorkletNode(context, 'voice-io', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { captureFrames: Math.round(options.sampleRate * CAPTURE_SECONDS) },
    });
    io.port.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: 'capture'; pcm: ArrayBuffer }
        | { type: 'speaking'; value: boolean };
      if (message.type === 'speaking') {
        options.onSpeaking?.(message.value);
        return;
      }
      options.onFrame(message.pcm);
    };
    source?.connect(io);
    io.connect(context.destination);

    const ctx = context;
    const play = (stream_: 'voice' | 'computer') => (frame: ArrayBuffer) =>
      io.port.postMessage({ stream: stream_, pcm: frame }, [frame]);
    let stopped = false;
    return {
      resume: () => {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      },
      enqueue: play('voice'),
      enqueueComputer: play('computer'),
      // The same port as the audio, so a barge-in cannot be applied before the frames
      // it is meant to drop.
      clear: () => io.port.postMessage({ clear: true }),
      // Single-shot: closing a context twice rejects, and every caller ends a call once.
      stop: async () => {
        if (stopped) return;
        stopped = true;
        io.port.onmessage = null;
        source?.disconnect();
        io.disconnect();
        // The tracks are what the browser's recording indicator follows, so they are
        // stopped as well as the context closed.
        for (const track of (stream?.getTracks() ?? [])) track.stop();
        await ctx.close();
      },
    };
  } catch (err) {
    for (const track of (stream?.getTracks() ?? [])) track.stop();
    await context?.close();
    throw err;
  }
}
