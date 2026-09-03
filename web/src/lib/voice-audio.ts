/**
 * The browser half of a voice chat's audio: the microphone as pcm16 frames, and the
 * agent's speech played back.
 *
 * One `AudioContext` at the model's own rate, so nothing here resamples and the bytes
 * the microphone produced are the bytes the runtime forwards. Both directions run in
 * `public/voice-worklet.js` on the audio thread — a worklet rather than a script
 * processor, because a dropped block is a gap in a live conversation.
 *
 * Nothing is recorded. The capture frames go to `onFrame` and the played frames are
 * dropped after playing, so a call leaves nothing behind in the tab either.
 */

/** The rate a voice session runs at, in both directions. `voice_hello` states it. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Served from `public/`, so this path is the same in dev and in the built bundle. */
const WORKLET_URL = '/voice-worklet.js';

export interface VoiceAudioOptions {
  /** One frame of the microphone, pcm16 mono. Called on every 20 ms of audio. */
  onFrame: (frame: ArrayBuffer) => void;
  /** The agent's audio started or stopped playing — the browser's own evidence of it. */
  onSpeaking?: (speaking: boolean) => void;
}

export interface VoiceAudio {
  /** Play a frame of the agent's speech. */
  enqueue: (frame: ArrayBuffer) => void;
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
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    await context.audioWorklet.addModule(WORKLET_URL);
    // A tab that has not played audio yet starts suspended. The call begins in a click,
    // so this is allowed to resume.
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'voice-capture');
    capture.port.onmessage = (event: MessageEvent) => {
      options.onFrame(event.data as ArrayBuffer);
    };

    // A worklet is pulled only while it reaches the destination, and the capture node
    // must not be heard, so it arrives there through a silent gain.
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(capture);
    capture.connect(silence);
    silence.connect(context.destination);

    const playback = new AudioWorkletNode(context, 'voice-playback', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    playback.port.onmessage = (event: MessageEvent) => {
      options.onSpeaking?.(event.data === 'speaking');
    };
    playback.connect(context.destination);

    const ctx = context;
    return {
      enqueue: (frame) => playback.port.postMessage(frame, [frame]),
      // The same port as the audio, so a barge-in cannot be applied before the frames
      // it is meant to drop.
      clear: () => playback.port.postMessage('clear'),
      stop: async () => {
        capture.port.onmessage = null;
        playback.port.onmessage = null;
        source.disconnect();
        capture.disconnect();
        silence.disconnect();
        playback.disconnect();
        // The tracks are what the browser's recording indicator follows, so they are
        // stopped as well as the context closed.
        for (const track of stream.getTracks()) track.stop();
        await ctx.close();
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    await context?.close();
    throw err;
  }
}
