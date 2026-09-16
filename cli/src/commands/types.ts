/**
 * Shared types for the TUI slash-command registry.
 *
 * Commands are dispatched locally and never sent to the agent. Each command
 * lives in its own file in this folder and receives a context with the chat
 * state it needs, returning a short string shown back to the user as a
 * synthetic SYSTEM message in the chat.
 */

import { ApiClient } from '../api-client.js';
import { AttachmentMeta } from '../attachments.js';

/** Panels that a command can ask the UI to open. */
export type PanelId = 'schedules' | 'config' | 'voice';

/**
 * Canonical name of the /attach command — single source of truth shared by
 * the command registration and App.tsx's path-completion trigger, so a
 * rename can't silently strand the completion logic.
 */
export const ATTACH_COMMAND = '/attach';

export interface CommandContext {
  availableCommands?: SlashCommand[];
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
  /** The active conversation thread, or null before one exists (e.g. /goal needs it). */
  threadId: string | null;
  /**
   * Files the agent shared on the most recent message that carried any
   * (oldest first) — the candidates for `/save`. Empty when none.
   */
  recentAttachments: AttachmentMeta[];
  /** Files staged to send with the next message (oldest first). */
  stagedAttachments: AttachmentMeta[];
  /** Adds an uploaded file to the staging area. */
  stageAttachment: (att: AttachmentMeta) => void;
  /** Empties the staging area (UI state only — server deletes are the command's job). */
  clearStagedAttachments: () => void;
  /**
   * Runs `fn` with the TUI's own input handling paused, for a child process
   * that needs the terminal itself (an editor). Ink holds stdin in raw mode, so
   * without this the editor and the composer read the same keystrokes.
   */
  suspendInput: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface SlashCommand {
  /** Including the leading '/' (e.g. '/copy'). */
  name: string;
  description: string;
  run: (ctx: CommandContext) => Promise<string>;
}
