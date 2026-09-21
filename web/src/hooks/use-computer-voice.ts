import { useRef } from 'react';
import { useWebSocket } from './use-websocket';
import { useComputerStatusFeed } from './use-computer-status';
import { useVoiceCall, type VoiceCall } from './use-voice-call';

export function useComputerVoice() {
  const ref = useRef<VoiceCall | null>(null);
  const writeComputerStatus = useComputerStatusFeed();
  const ws = useWebSocket({
    onVoiceEvent: (event) => ref.current?.handleEvent(event),
    onVoiceAudio: (frame) => ref.current?.handleAudio(frame),
    // The frame updates the desktop state the computer page reads, help requests
    // included.
    onComputerStatus: writeComputerStatus,
  });
  const call = useVoiceCall({
    sendVoiceStart: ws.sendVoiceStart,
    sendVoiceStop: ws.sendVoiceStop,
    sendVoiceAudio: ws.sendVoiceAudio,
    isConnected: ws.isConnected,
    request: { computer: true },
    sampleRate: 48_000,
    startMuted: true,
  });
  ref.current = call;
  return call;
}
