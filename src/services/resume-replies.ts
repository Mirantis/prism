/**
 * Continue the replies a restart interrupted: one exchange per thread, which
 * answers every message the thread was owed. A channel with a queue of its own
 * (`ChannelAdapter.continueReply`) takes the reply into that queue. Every other
 * thread's turn starts at once.
 */

import prisma from '../lib/prisma';
import { logger } from '../logger';
import { conversationEngineService, type ChatWork } from './conversation-engine.service';
import { attachmentService } from './attachment.service';
import { messageDeliveryService } from './message-delivery.service';
import { pendingWorkService, type PendingWorkItem } from './pending-work.service';

export async function resumeReplies(items: PendingWorkItem[]): Promise<void> {
  if (items.length === 0) return;

  const work = new Map(items.map((item) => [item.key, item.payload as unknown as ChatWork]));
  const found = await prisma.conversationMessage.findMany({
    where: { id: { in: items.map((item) => item.key) } },
    select: { id: true },
  });
  const stored = new Set(found.map((message) => message.id));
  for (const item of items) {
    const owed = work.get(item.key)!;
    if (stored.has(item.key)) await linkUploads(item.key, owed);
    else if (await storeMessage(item.key, owed)) stored.add(item.key);
  }
  // A row whose message cannot be stored has nothing to answer: its thread is gone.
  pendingWorkService.end(
    'chat',
    items.filter((item) => !stored.has(item.key)).map((item) => item.key),
  );

  const owed = await prisma.conversationMessage.findMany({
    where: { id: { in: [...stored] } },
    orderBy: { createdAt: 'asc' },
  });
  const threads = new Map<string, typeof owed>();
  for (const message of owed) {
    threads.set(message.threadId, [...(threads.get(message.threadId) ?? []), message]);
  }
  for (const [threadId, messages] of threads) {
    const newest = messages[messages.length - 1];
    const { agentId, userId, metadata } = work.get(newest.id) as ChatWork;
    const messageIds = messages.map((message) => message.id);
    const unsaved = messageIds.flatMap((id) => work.get(id)?.unsaved ?? []);
    // A restart while a resumed exchange moves these to its first row lists some twice.
    const unsentAttachmentIds = [...new Set(messageIds.flatMap((id) => work.get(id)?.unsentAttachmentIds ?? []))];
    logger.info('Continuing the reply to %d message(s) on thread %s', messageIds.length, threadId);

    const queue = metadata?.channel ? messageDeliveryService.getAdapter(metadata.channel) : undefined;
    if (queue?.continueReply) {
      queue.continueReply(newest, { messageIds, unsaved, unsentAttachmentIds });
      continue;
    }
    void conversationEngineService
      .chat({
        agentId,
        userId,
        threadId,
        message: newest.content,
        stored: { id: newest.id, titleSet: null },
        resumed: { messageIds, unsaved, unsentAttachmentIds },
        metadata,
      })
      .catch((err) => logger.error({ err, threadId }, 'Could not continue the interrupted reply'));
  }
}

/**
 * Link the uploads of a stored message, which a restart between its insert and
 * the link leaves unlinked. The link claims only uploads that no message holds.
 */
async function linkUploads(id: string, work: ChatWork): Promise<void> {
  const uploads = work.message?.attachmentIds ?? [];
  if (uploads.length === 0) return;
  try {
    await attachmentService.linkToMessage(uploads, id, work.threadId);
  } catch (err) {
    logger.warn({ err, messageId: id }, 'Could not link the uploads of a message a restart interrupted');
  }
}

/** Store a message a restart stopped before its insert, from its row. False when it cannot be stored. */
async function storeMessage(id: string, work: ChatWork): Promise<boolean> {
  if (!work.message) return false;
  try {
    await conversationEngineService.acceptUserMessage(
      { agentId: work.agentId, userId: work.userId, metadata: work.metadata, ...work.message },
      work.threadId,
      id,
    );
    return true;
  } catch (err) {
    logger.warn({ err, messageId: id }, 'Could not store a message a restart interrupted');
    return false;
  }
}
