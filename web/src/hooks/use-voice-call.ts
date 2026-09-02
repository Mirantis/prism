import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceFrame } from './use-websocket';

/**
 * One voice call with the agent, from this browser.
 *
 * The states are the ones docs/voice-chat.md names in its lifecycle table. "Failing or
 * refused" is not among them: a refusal means no session started, so it reports its text
 * and returns to `idle`, and a failure mid-call goes to `ending` because `voice_state:
 * ended` still follows it.
 */
export type VoiceCallState = 'idle' | 'starting' | 'connecting' | 'live' | 'ending';

interface UseVoiceCallOptions {
  /** Signalling out. The hook sends nothing else. */
  sendOffer: (sdp: string, threadId?: string) => void;
  sendIce: (candidate: RTCIceCandidateInit) => void;
  sendStop: () => void;
  /** The thread the call belongs to, which the agent's tools use. */
  threadId?: string;
  /** Readable text for the user: a refusal, or a failure that ended the call. */
  onError: (message: string) => void;
}

/** The runtime never sees a denied microphone — there is no offer to send. */
const MIC_DENIED = 'Voice chat needs your microphone. Allow it in your browser and try again.';

/**
 * No frame reports this. The runtime answers a peer that connects and a peer that goes
 * away, and one that never connects at all reaches neither, so the browser's own peer
 * connection is what says so.
 */
const MEDIA_FAILED = 'The voice chat could not reach the agent: the audio connection failed.';

export function useVoiceCall(opts: UseVoiceCallOptions) {
  const [state, setState] = useState<VoiceCallState>('idle');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // The options change every render (they close over the active thread), and the
  // handlers below are bound once onto a peer connection, so they read the latest
  // through a ref — the same reason use-websocket.ts mirrors its callbacks.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Everything a handler has to read is a ref: `state` is rendered, `stateRef` is what
  // the once-bound handlers decide on.
  const stateRef = useRef<VoiceCallState>('idle');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  /** Our candidates, held until the answer: the runtime drops any that arrive earlier. */
  const pendingLocal = useRef<RTCIceCandidateInit[]>([]);
  /** The runtime's candidates, held until its answer is applied. */
  const pendingRemote = useRef<RTCIceCandidateInit[]>([]);
  const answered = useRef(false);

  const enter = useCallback((next: VoiceCallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Read as a call, so a check after an `await` re-reads the phase rather than testing
  // what it was narrowed to before the wait.
  const phase = useCallback((): VoiceCallState => stateRef.current, []);

  /** Release everything the call holds, and free the control. Safe to call twice. */
  const teardown = useCallback(() => {
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
    localStreamRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    pendingLocal.current = [];
    pendingRemote.current = [];
    answered.current = false;
    setRemoteStream(null);
    enter('idle');
  }, [enter]);

  const start = useCallback(async () => {
    if (phase() !== 'idle') return;
    // Entered before the permission prompt, so a second click cannot open a second call
    // while the first one waits on the user.
    enter('starting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      enter('idle');
      optsRef.current.onError(MIC_DENIED);
      return;
    }

    // The user can end the call inside the prompt. Release the microphone they just
    // granted rather than opening a call nobody asked for any more.
    if (phase() !== 'starting') {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    localStreamRef.current = stream;

    // The microphone track, added before the offer is created: that is what makes the
    // single `sendrecv` audio m-line the runtime answers.
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    // The agent's audio needs no code of ours beyond handing the stream to an <audio>
    // element: the browser decodes, buffers and plays it.
    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
    };

    pc.onicecandidate = (event) => {
      // The end-of-gathering marker needs no frame: the runtime sends none either.
      if (!event.candidate) return;
      const init = event.candidate.toJSON();
      if (answered.current) optsRef.current.sendIce(init);
      else pendingLocal.current.push(init);
    };

    pc.onconnectionstatechange = () => {
      if (pc !== pcRef.current) return;
      if (pc.connectionState === 'failed') {
        optsRef.current.onError(MEDIA_FAILED);
        teardown();
        return;
      }
      // A peer that closes while we are already ending is the ending arriving through
      // the media path instead of a frame. Nothing to report.
      if (
        (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') &&
        phase() === 'ending'
      ) {
        teardown();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (phase() !== 'starting') return;
    optsRef.current.sendOffer(pc.localDescription?.sdp ?? offer.sdp ?? '', optsRef.current.threadId);
  }, [enter, phase, teardown]);

  /** End the call. The microphone is released when `voice_state: ended` arrives. */
  const stop = useCallback(() => {
    const current = phase();
    if (current === 'idle') return;
    optsRef.current.sendStop();
    // With no answer there is no session yet, so nothing will send `ended`. The stop
    // still counts — the runtime ends the session as soon as it opens.
    if (!answered.current) {
      teardown();
      return;
    }
    if (current !== 'ending') enter('ending');
  }, [enter, phase, teardown]);

  const applyAnswer = useCallback(
    async (sdp: string) => {
      const pc = pcRef.current;
      if (!pc || phase() !== 'starting') return;
      await pc.setRemoteDescription({ type: 'answer', sdp });
      answered.current = true;
      enter('connecting');
      for (const candidate of pendingRemote.current) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingRemote.current = [];
      for (const candidate of pendingLocal.current) optsRef.current.sendIce(candidate);
      pendingLocal.current = [];
    },
    [enter, phase],
  );

  /** What the chat socket hands over. One entry point for all four runtime frames. */
  const onFrame = useCallback(
    (frame: VoiceFrame) => {
      switch (frame.kind) {
        case 'answer':
          void applyAnswer(frame.sdp);
          break;
        case 'ice': {
          const pc = pcRef.current;
          if (!pc) return;
          if (answered.current) void pc.addIceCandidate(frame.candidate).catch(() => {});
          else pendingRemote.current.push(frame.candidate);
          break;
        }
        case 'state':
          if (frame.state === 'ended') teardown();
          else if (phase() === 'starting' || phase() === 'connecting') enter('live');
          break;
        case 'error':
          optsRef.current.onError(frame.error);
          // A refusal arrives before any answer, and no `ended` follows it, so this is
          // the end of it. A failure after the answer is followed by `ended`.
          if (answered.current) enter('ending');
          else teardown();
          break;
      }
    },
    [applyAnswer, enter, phase, teardown],
  );

  // Leaving the page ends the call: the runtime holds the agent's one voice until the
  // session ends or the socket goes.
  useEffect(
    () => () => {
      if (stateRef.current === 'idle') return;
      optsRef.current.sendStop();
      for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
      pcRef.current?.close();
    },
    [],
  );

  return { state, remoteStream, start, stop, onFrame };
}
