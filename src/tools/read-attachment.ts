/**
 * read_attachment tool — pull a shared file's text back into the conversation.
 *
 * The INBOUND counterpart to `share_file`. Text attachments are inlined in full
 * on the turn they arrive, then replaced by a stub on later turns (see
 * `context-builder.ts`): history is rebuilt from scratch on every step of every
 * turn, so keeping a 100k-character file in context re-sends it up to
 * STEP_LIMIT times per user message, for as long as the conversation lives.
 *
 * Stubbing without this tool would be lossy — the agent would know a file
 * existed and have no way to read it. This is what makes the trade safe: the
 * bytes stay one tool call away instead of occupying every request.
 *
 * Only text is returned. Images and PDFs are model-native content that cannot
 * be handed back as a tool result, and binaries have nothing readable to give.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { MAX_INLINE_TEXT_CHARS } from '../constants';
import { attachmentService } from '../services/attachment.service';
import { logger } from '../logger';

export const readAttachmentInput = z.object({
  attachmentId: z
    .string()
    .describe(
      'Id of the attachment to read. Stubs in the conversation name it, e.g. "[Attached file: notes.txt (id: abc-123) …]".',
    ),
});

export function getReadAttachmentTools(): Record<string, Tool> {
  return {
    read_attachment: tool({
      description:
        'Read the text of a file shared earlier in this conversation. Use when a message shows a file stub instead of its contents. Returns text files only; images and PDFs are already visible where they were shared.',
      inputSchema: readAttachmentInput,
      execute: async ({ attachmentId }) => {
        const [attachment] = await attachmentService.loadByIds([attachmentId]);

        if (!attachment) {
          // The id came from a stub we wrote, so a miss means it was deleted or
          // the model invented one. Either way, say so plainly rather than
          // returning empty text the model would read as an empty file.
          return `No attachment found with id ${attachmentId}.`;
        }

        if (attachment.category !== 'text') {
          return `Attachment ${attachment.filename} is ${attachment.mediaType}, which has no readable text. Images and PDFs are shown directly in the message that shared them.`;
        }

        const raw = attachment.data.toString('utf8');
        // Same per-file cap as inlining: this is a way to see a file that is
        // out of context, not a way around the limit on how much of one fits.
        const truncated = raw.length > MAX_INLINE_TEXT_CHARS;
        const body = truncated ? raw.slice(0, MAX_INLINE_TEXT_CHARS) : raw;

        logger.info(
          { attachmentId, filename: attachment.filename, truncated },
          'read_attachment served a file back into context',
        );

        return truncated
          ? `${body}\n…[truncated — showing first ${MAX_INLINE_TEXT_CHARS} of ${raw.length} chars]`
          : body;
      },
    }),
  };
}
