import { spawn } from 'child_process';
import type { SlashCommand } from './types.js';

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[] = [];
    if (process.platform === 'darwin') {
      cmd = 'pbcopy';
    } else if (process.platform === 'win32') {
      cmd = 'clip';
    } else {
      // Linux/BSD — try xclip first; the user can install it via apt/brew.
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
    child.stdin.end(text);
  });
}

export const copyCommand: SlashCommand = {
  name: '/copy',
  description: 'Copy the last message to the clipboard',
  run: async (ctx) => {
    if (!ctx.lastMessageContent) return 'No message to copy yet.';
    try {
      await copyToClipboard(ctx.lastMessageContent);
      return 'Copied last message to clipboard.';
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Failed to copy: ${detail}`;
    }
  },
};
