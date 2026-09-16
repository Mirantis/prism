import type { SlashCommand } from './types.js';

export const voiceChatCommand: SlashCommand = {
  name: '/voice-chat',
  description: 'Talk to the agent by voice',
  run: async ({ openPanel }) => { openPanel('voice'); return ''; },
};
