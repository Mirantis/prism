import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useChatConnection } from '@/lib/chat-socket/chat-connection-context';
import { compareMessages, upsertMessage } from '@/lib/chat-socket/transcript';
import type { ConversationMessage, ConversationThread } from '@/types';

/** How many messages one page of history holds. */
export const HISTORY_PAGE = 50;

/** How long a failed page of older messages waits before the list asks for it again. */
const OLDER_RETRY_MS = 3000;

/**
 * A conversation with the newest part of its history, oldest first and without a gap.
 * Older pages are added at the front as the reader scrolls back.
 */
export interface LoadedThread extends ConversationThread {
  messages: ConversationMessage[];
  /** True while the runtime holds messages before the first one here. */
  hasOlder: boolean;
}

export function threadQueryKey(agentId: string, threadId: string | undefined) {
  return ['thread', agentId, threadId] as const;
}

/**
 * Put a live message into a conversation's cached history. While older pages remain,
 * a message older than the first one cached waits for its page: kept now, it would
 * stand above a gap.
 */
export function upsertIntoHistory(thread: LoadedThread, message: ConversationMessage): LoadedThread {
  const first = thread.messages[0];
  if (thread.hasOlder && first && compareMessages(message, first) < 0) return thread;
  return { ...thread, messages: upsertMessage(thread.messages, message) };
}

/** One page of a conversation: the newest messages, or those before the message `before`. */
type PageReader = (before?: string) => Promise<ConversationThread>;

/**
 * A conversation's newest pages, read until they hold `depth` messages or start at its
 * first message.
 */
export async function loadHistory(readPage: PageReader, depth: number): Promise<LoadedThread> {
  const thread = await readPage();
  let messages = thread.messages ?? [];
  let hasOlder = messages.length === HISTORY_PAGE;
  while (hasOlder && messages.length < depth) {
    const older = (await readPage(messages[0].id)).messages ?? [];
    messages = [...older, ...messages];
    hasOlder = older.length === HISTORY_PAGE;
  }
  return { ...thread, messages, hasOlder };
}

/**
 * One conversation with the newest part of its history. A reload, after compaction or a
 * resync, reads as many messages as the cache held, so a reader who scrolled back keeps
 * their place. The chat socket's events are held while it loads and applied to the
 * result, so a message that arrives during the request is kept.
 */
export function useThread(threadId: string | undefined, enabled = true) {
  const agent = useAgent();
  const connection = useChatConnection();
  const queryClient = useQueryClient();
  const queryKey = threadQueryKey(agent.agentId, threadId);
  return useQuery({
    queryKey,
    queryFn: (): Promise<LoadedThread> => {
      const depth = queryClient.getQueryData<LoadedThread>(queryKey)?.messages.length ?? 0;
      const readPage = (before?: string) =>
        runtimeApi.getThread(agent.agentId, agent.userId, threadId!, { limit: HISTORY_PAGE, before });
      return connection.holdEvents(loadHistory(readPage, depth));
    },
    enabled: enabled && Boolean(threadId),
  });
}

/**
 * Load the page before the first message of a conversation's cached history. A page
 * that arrives after the cache was loaded again is dropped, since it would follow a
 * different first message and leave a gap. `retries` changes a while after a page
 * fails, and the list then asks again if the reader is still at the top.
 */
export function useOlderMessages(threadId: string | undefined) {
  const { agentId, userId } = useAgent();
  const queryClient = useQueryClient();
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [retries, setRetries] = useState(0);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  const loadOlder = useCallback(async () => {
    const key = threadQueryKey(agentId, threadId);
    const first = queryClient.getQueryData<LoadedThread>(key);
    const oldest = first?.messages[0];
    if (!threadId || !first?.hasOlder || !oldest || inFlight.current) return;
    inFlight.current = true;
    setIsLoadingOlder(true);
    try {
      const page = await runtimeApi.getThread(agentId, userId, threadId, { limit: HISTORY_PAGE, before: oldest.id });
      const older = page.messages ?? [];
      queryClient.setQueryData<LoadedThread>(key, (thread) =>
        thread?.messages[0]?.id === oldest.id
          ? { ...thread, messages: [...older, ...thread.messages], hasOlder: older.length === HISTORY_PAGE }
          : thread,
      );
    } catch {
      retryTimer.current = setTimeout(() => setRetries((count) => count + 1), OLDER_RETRY_MS);
    } finally {
      inFlight.current = false;
      setIsLoadingOlder(false);
    }
  }, [agentId, userId, threadId, queryClient]);

  return { loadOlder, isLoadingOlder, retries };
}
