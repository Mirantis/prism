import { useRef } from 'react';
import { useWebSocket } from './use-websocket';
import { useVoiceCall, type VoiceCall } from './use-voice-call';

export function useComputerVoice() {
  const ref = useRef<VoiceCall | null>(null);
  const ws = useWebSocket({
    onVoiceEvent: (event) => ref.current?.handleEvent(event),
    onVoiceAudio: (frame) => ref.current?.handleAudio(frame),
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
