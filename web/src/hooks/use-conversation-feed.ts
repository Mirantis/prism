import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAgent } from '@/lib/agent-context';
import type { ChatConnection } from '@/lib/chat-socket/chat-connection';
import { upsertMessage } from '@/lib/chat-socket/transcript';
import type { ConversationThread } from '@/types';
import { useComputerStatusFeed } from './use-computer-status';
import { recentThreadsQueryKey } from './use-recent-threads';
import { threadQueryKey } from './use-thread';

/**
 * Write the chat socket's events into the caches the pages read: each message into its
 * thread, each new or retitled thread into Recents, and the desktop's state. A thread
 * that is not cached is left alone, and loads with the message when it is opened.
 */
export function useConversationFeed(connection: ChatConnection) {
  const { agentId, userId } = useAgent();
  const queryClient = useQueryClient();
  const writeComputerStatus = useComputerStatusFeed();

  useEffect(
    () =>
      connection.listen({
        message: (message) => {
          queryClient.setQueryData<ConversationThread>(threadQueryKey(agentId, message.threadId), (thread) =>
            thread ? { ...thread, messages: upsertMessage(thread.messages ?? [], message) } : thread,
          );
        },
        thread: ({ threadId, title, createdAt }) => {
          queryClient.setQueryData<ConversationThread>(threadQueryKey(agentId, threadId), (thread) =>
            thread ? { ...thread, title } : thread,
          );
          queryClient.setQueryData<ConversationThread[]>(recentThreadsQueryKey(agentId), (threads) => {
            if (!threads) return threads;
            if (threads.some((t) => t.id === threadId)) {
              return threads.map((t) => (t.id === threadId ? { ...t, title } : t));
            }
            // Only a created thread names its creation time. A title for a thread Recents
            // does not list belongs outside it: a Slack thread, or one older than the list.
            if (!createdAt) return threads;
            const created: ConversationThread = {
              id: threadId,
              agentId,
              userId,
              title,
              externalThreadId: null,
              threadSource: 'DATABASE',
              createdAt,
              updatedAt: createdAt,
            };
            return [created, ...threads];
          });
        },
        // Compaction rewrites older messages in place, and no event says which.
        compaction: ({ threadId, status }) => {
          if (status !== 'completed') return;
          void queryClient.invalidateQueries({ queryKey: threadQueryKey(agentId, threadId) });
        },
        computer: writeComputerStatus,
        resync: () =>
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['thread', agentId] }),
            queryClient.invalidateQueries({ queryKey: recentThreadsQueryKey(agentId) }),
          ]),
      }),
    [connection, queryClient, agentId, userId, writeComputerStatus],
  );
}
