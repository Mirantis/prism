/**
 * Shared types for the web chat slash-command registry.
 *
 * Commands are parsed and dispatched client-side and never sent to the agent as
 * chat text (the UI parses the command and calls a runtime REST endpoint). Each
 * command lives in its own file in this folder and returns a short string shown
 * back to the user as a synthetic SYSTEM message in the chat.
 */

export interface CommandContext {
  /** Whitespace-split arguments after the command word (empty if none). */
  args: string[];
  /** Everything after the command word, trimmed (preserves inner spaces). */
  rawArgs: string;
  /** The thread currently being viewed (undefined before the first turn). */
  threadId?: string;
}

export interface SlashCommand {
  /** Including the leading '/' (e.g. '/skills'). */
  name: string;
  description: string;
  run: (ctx: CommandContext) => Promise<string>;
}
