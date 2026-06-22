import path from 'path';
import { ApiError } from '../api-client.js';
import { expandPath, formatFileSize, MAX_ATTACHMENTS_PER_MESSAGE } from '../attachments.js';
import { ATTACH_COMMAND, type SlashCommand } from './types.js';

export const attachCommand: SlashCommand = {
  name: ATTACH_COMMAND,
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
    // Cap staged files per message (the runtime re-enforces this at link
    // time; this is the friendly client-side guard).
    if (ctx.stagedAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      return `Already at the ${MAX_ATTACHMENTS_PER_MESSAGE}-file limit for one message. Send or /detach first.`;
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
};
