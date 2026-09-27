import { useRef } from 'react';
import { useChatSocket } from './use-chat-socket';
import { useVoiceCall, type VoiceCall } from './use-voice-call';

export function useComputerVoice() {
  const ref = useRef<VoiceCall | null>(null);
  const { status, connection } = useChatSocket({
    voice: (event) => ref.current?.handleEvent(event),
    voiceAudio: (frame) => ref.current?.handleAudio(frame),
  });
  const call = useVoiceCall({
    sendVoiceStart: connection.voiceStart,
    sendVoiceStop: connection.voiceStop,
    sendVoiceAudio: connection.sendAudio,
    isConnected: status === 'connected',
    request: { computer: true },
    sampleRate: 48_000,
    startMuted: true,
  });
  ref.current = call;
  return call;
}
