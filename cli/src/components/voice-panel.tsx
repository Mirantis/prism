import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { VoiceController } from '../voice/controller.js';

export function VoicePanel({ controller, threadId, onClose }: {
  controller: VoiceController;
  threadId?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    controller.events.on('change', setState);
    return () => { controller.events.off('change', setState); };
  }, [controller]);
  useInput((input, key) => {
    if (key.escape) { controller.stop(); onClose(); return; }
    if (key.return) { void controller.start(threadId); return; }
    if (input.toLowerCase() === 'm') controller.mute();
  });
  const label = {
    ready: 'Ready', connecting: 'Connecting', live: `Live · ${state.muted ? 'muted' : 'microphone on'}`,
    ending: 'Ending', ended: 'Ended',
  }[state.status];
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>Voice chat</Text>
      <Text color={state.status === 'live' ? 'green' : 'cyan'}>{label}</Text>
      {state.error && <Text color="red">{state.error}</Text>}
      <Text>Use a headset to keep the agent’s voice out of your microphone.</Text>
      <Text dimColor>Enter starts · M mutes/unmutes · Esc ends and returns to chat</Text>
    </Box>
  );
}
