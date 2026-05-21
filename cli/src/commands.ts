/**
 * Slash command registry for the TUI.
 *
 * Commands are dispatched locally and never sent to the agent. Each command
 * receives a context with the chat state it needs and returns a short string
 * shown back to the user as a synthetic SYSTEM message in the chat.
 */

import { spawn } from 'child_process';

export interface CommandContext {
  /** Content of the most recent message in the chat (any role), or null. */
  lastMessageContent: string | null;
  /** Triggers the same graceful shutdown path as Ctrl+C. */
  requestShutdown: () => void;
}

export interface SlashCommand {
  /** Including the leading '/' (e.g. '/copy'). */
  name: string;
  description: string;
  run: (ctx: CommandContext) => Promise<string>;
}

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

export const COMMANDS: SlashCommand[] = [
  {
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
  },
  {
    name: '/exit',
    description: 'Shut down the TUI',
    run: async (ctx) => {
      ctx.requestShutdown();
      return 'Shutting down…';
    },
  },
];

export function findExact(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function filterByPrefix(prefix: string): SlashCommand[] {
  if (!prefix.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}
