/**
 * Slash command registry for the TUI.
 *
 * Commands are dispatched locally and never sent to the agent. Each command
 * receives a context with the chat state it needs and returns a short string
 * shown back to the user as a synthetic SYSTEM message in the chat.
 */

import { spawn } from 'child_process';
import path from 'path';
import { ApiClient, ApiError } from './api-client.js';
import { AttachmentMeta, expandPath, formatFileSize } from './attachments.js';

/** Panels that a command can ask the UI to open. */
export type PanelId = 'schedules' | 'config';

export interface CommandContext {
  /** Content of the most recent message in the chat (any role), or null. */
  lastMessageContent: string | null;
  /** Triggers the same graceful shutdown path as Ctrl+C. */
  requestShutdown: () => void;
  /** Whitespace-split arguments following the command word (empty if none). */
  args: string[];
  /** Everything after the command word, trimmed (preserves inner spaces). */
  rawArgs: string;
  /** Opens one of the full-screen panels (schedules, config). */
  openPanel: (id: PanelId) => void;
  /** Typed HTTP client for the agent-runtime management API. */
  api: ApiClient;
  /** Files staged to send with the next message (oldest first). */
  stagedAttachments: AttachmentMeta[];
  /** Adds an uploaded file to the staging area. */
  stageAttachment: (att: AttachmentMeta) => void;
  /** Empties the staging area (UI state only — server deletes are the command's job). */
  clearStagedAttachments: () => void;
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

/**
 * Split a trimmed input line into its command word and arguments.
 *
 * `headWord` is the first whitespace-delimited token (e.g. '/heartbeat').
 * `rawArgs` is everything after it, trimmed (so inner spaces survive, as in
 * '/rename My Agent'). `args` is `rawArgs` split on runs of whitespace, or an
 * empty array when there are no arguments.
 */
export function parseCommandLine(trimmed: string): {
  headWord: string;
  args: string[];
  rawArgs: string;
} {
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { headWord: trimmed, args: [], rawArgs: '' };
  }
  const headWord = trimmed.slice(0, firstSpace);
  const rawArgs = trimmed.slice(firstSpace + 1).trim();
  const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);
  return { headWord, args, rawArgs };
}

const MIN_INTERVAL_MS = 60_000; // 1 minute
const MAX_INTERVAL_MS = 604_800_000; // 7 days

/**
 * Parse a heartbeat interval token like '5m' or '2h' into milliseconds.
 *
 * Accepts a positive integer followed by 'm' (minutes) or 'h' (hours),
 * case-insensitive. Returns null when the token is malformed or the resulting
 * interval falls outside [1 minute, 7 days].
 */
export function parseInterval(token: string): number | null {
  const match = /^(\d+)(m|h)$/i.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? value * 60_000 : value * 3_600_000;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
  return ms;
}

/** Render a nullable ISO timestamp for status output. */
function formatTimestamp(iso: string | null): string {
  return iso ?? 'never';
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
    name: '/schedules',
    description: 'Manage scheduled cron tasks (list, create, delete)',
    run: async (ctx) => {
      ctx.openPanel('schedules');
      return '';
    },
  },
  {
    name: '/config',
    description: 'View agent identity and config files',
    run: async (ctx) => {
      ctx.openPanel('config');
      return '';
    },
  },
  {
    name: '/rename',
    description: 'Rename the agent (1-64 chars)',
    run: async (ctx) => {
      const name = ctx.rawArgs;
      if (name.length === 0) return 'Usage: /rename <new name> (1-64 chars).';
      if (name.length > 64) return 'Name too long — keep it to 64 characters or fewer.';
      try {
        const result = await ctx.api.setName(name);
        return `Renamed to "${result.name}".`;
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/model',
    description: 'Set the agent model (id or "reset")',
    run: async (ctx) => {
      const arg = ctx.args[0];
      if (!arg) return 'Usage: /model <model-id|reset>.';
      try {
        const result =
          arg === 'reset'
            ? await ctx.api.setModel(null)
            : await ctx.api.setModel(arg);
        return result.model
          ? `Model set to "${result.model}".`
          : 'Model reset to the server default.';
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/heartbeat',
    description: 'Control the heartbeat (status|start|stop|trigger|every Nm|Nh)',
    run: async (ctx) => {
      const sub = ctx.args[0];
      const usage =
        'Usage: /heartbeat <status|start|stop|trigger|every Nm|Nh>.';
      try {
        switch (sub) {
          case 'status': {
            const s = await ctx.api.getHeartbeatStatus();
            const interval =
              s.intervalMs === undefined ? 'unknown' : `${s.intervalMs}ms`;
            return [
              `active: ${s.isActive}`,
              `running: ${s.isRunning}`,
              `last run: ${formatTimestamp(s.lastRun)}`,
              `consecutive errors: ${s.consecutiveErrors}`,
              `interval: ${interval}`,
            ].join('\n');
          }
          case 'start': {
            const details = await ctx.api.getDetails();
            const result = await ctx.api.startHeartbeat(details);
            return result.message;
          }
          case 'stop': {
            const result = await ctx.api.stopHeartbeat();
            return result.message;
          }
          case 'trigger': {
            const result = await ctx.api.triggerHeartbeat();
            return result.success
              ? 'Heartbeat triggered.'
              : 'Heartbeat trigger reported failure.';
          }
          case 'every': {
            const ms = parseInterval(ctx.args[1] ?? '');
            if (ms === null) {
              return 'Use Nm or Nh, e.g. /heartbeat every 5m';
            }
            const s = await ctx.api.setHeartbeatInterval(ms);
            const interval =
              s.intervalMs === undefined ? `${ms}ms` : `${s.intervalMs}ms`;
            return `Heartbeat interval set to ${interval}.`;
          }
          default:
            return usage;
        }
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/attach',
    description: 'Attach a file to your next message (/attach <path>)',
    run: async (ctx) => {
      // No args: show what's staged (or usage).
      if (ctx.rawArgs.length === 0) {
        if (ctx.stagedAttachments.length === 0) {
          return 'No files staged. Usage: /attach <path>.';
        }
        return ctx.stagedAttachments
          .map((a) => `📎 ${a.filename} (${formatFileSize(a.sizeBytes)})`)
          .join('\n');
      }
      // rawArgs preserves inner spaces, so unquoted paths like
      // "My Notes/todo.txt" work without escaping.
      const abs = path.resolve(process.cwd(), expandPath(ctx.rawArgs));
      try {
        const att = await ctx.api.uploadAttachment(abs);
        ctx.stageAttachment(att);
        const count = ctx.stagedAttachments.length + 1;
        return (
          `Staged 📎 ${att.filename} (${formatFileSize(att.sizeBytes)}) — ` +
          `sends with your next message. ${count} file(s) staged.`
        );
      } catch (err) {
        if (err instanceof ApiError || err instanceof Error) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/detach',
    description: 'Remove all staged attachments',
    run: async (ctx) => {
      const staged = ctx.stagedAttachments;
      if (staged.length === 0) return 'No files staged.';
      // Best-effort server cleanup: unlinked uploads are also reaped by the
      // runtime's hourly orphan janitor (24h TTL), so per-file failures are
      // safe to swallow.
      for (const att of staged) {
        try {
          await ctx.api.deleteAttachment(att.id);
        } catch {
          // Janitor covers it.
        }
      }
      ctx.clearStagedAttachments();
      return `Removed ${staged.length} staged file(s).`;
    },
  },
  {
    name: '/help',
    description: 'List all commands',
    run: async () =>
      COMMANDS.map((c) => `${c.name} — ${c.description}`).join('\n'),
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
