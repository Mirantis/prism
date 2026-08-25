import { ApiError } from '../api-client.js';
import { editText, resolveEditor } from '../editor.js';
import type { SlashCommand } from './types.js';

/**
 * `/agent-guide` — edit the agent guide, the one identity document the agent
 * cannot write itself. Opens the user's editor on the stored document and
 * PATCHes what comes back.
 */
export const agentGuideCommand: SlashCommand = {
  name: '/agent-guide',
  description: 'Edit the agent guide in $EDITOR',
  run: async (ctx) => {
    let current: string;
    try {
      current = (await ctx.api.getDetails()).agentMd ?? '';
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }

    let result;
    try {
      // The editor takes the terminal, so the TUI stands down first.
      result = await ctx.suspendInput(() => editText(current, { suffix: '.md' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Could not open ${resolveEditor()}: ${msg}`;
    }

    if (!result.changed) return 'Agent guide unchanged.';

    try {
      await ctx.api.setAgentGuide(result.text);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // The edit is still on disk: say where, rather than losing the work.
      return `${err.message}\nYour edit is kept at ${result.file}`;
    }
    result.discard();
    return 'Agent guide saved. It reaches the agent on its next turn.';
  },
};
