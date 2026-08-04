/**
 * read_attachment tool — pull a shared file's text back into the conversation.
 *
 * The INBOUND counterpart to `share_file`. Text attachments are inlined in full
 * on the turns they arrive, then replaced by a stub (see `context-builder.ts`):
 * history is rebuilt from scratch on every step of every turn, so keeping a
 * 100k-character file in context re-sends it up to STEP_LIMIT times per user
 * message, for as long as the conversation lives.
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
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Character offset to start from. Omit for the beginning. A read returns at most ${MAX_INLINE_TEXT_CHARS} characters and says how many remain, so pass the next offset to continue through a large file.`,
    ),
});

/**
 * @param threadId Conversation the calling turn belongs to. Attachments outside
 *   it are not readable — an id supplied by the MODEL is untrusted input, so it
 *   cannot be the sole authority for handing back file contents. Autonomous
 *   turns with no thread (heartbeat, cron) get no tool at all rather than an
 *   unscoped one.
 */
export function getReadAttachmentTools(threadId?: string): Record<string, Tool> {
  if (!threadId) return {};

  return {
    read_attachment: tool({
      description:
        'Read the text of a file shared earlier in this conversation. Use when a message shows a file stub instead of its contents. Returns text files only; images and PDFs are already visible where they were shared.',
      inputSchema: readAttachmentInput,
      execute: async ({ attachmentId, offset = 0 }) => {
        const attachment = await attachmentService.loadByIdForThread(attachmentId, threadId);

        if (!attachment) {
          // Deliberately the same answer for "no such id" and "not yours": a
          // distinguishable response would let the model (or whatever injected
          // the id into it) probe which uuids exist in other conversations.
          return `No attachment found with id ${attachmentId} in this conversation.`;
        }

        if (attachment.category !== 'text') {
          return `Attachment ${attachment.filename} is ${attachment.mediaType}, which has no readable text. Images and PDFs are shown directly in the message that shared them.`;
        }

        const raw = attachment.data.toString('utf8');
        if (offset >= raw.length) {
          return `Offset ${offset} is past the end of ${attachment.filename} (${raw.length} characters).`;
        }

        // Same per-read cap as inlining, but with an offset the model can walk:
        // stubbing is only non-lossy if the whole file is reachable, and a
        // single capped read would strand everything past the first chunk.
        const body = raw.slice(offset, offset + MAX_INLINE_TEXT_CHARS);
        const nextOffset = offset + body.length;
        const remaining = raw.length - nextOffset;

        logger.info(
          { attachmentId, filename: attachment.filename, offset, remaining },
          'read_attachment served a file back into context',
        );

        return remaining > 0
          ? `${body}\n…[${remaining} characters remain; call read_attachment again with offset ${nextOffset}]`
          : body;
      },
    }),
  };
}
