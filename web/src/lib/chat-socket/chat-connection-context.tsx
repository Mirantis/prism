import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { webSocketUrl } from '@/api/runtime-client';
import { useConversationFeed } from '@/hooks/use-conversation-feed';
import { ChatConnection } from '@lensapp/prism-client';

const ChatConnectionContext = createContext<ChatConnection | null>(null);

/**
 * The tab's one chat socket, shared by every surface that needs it: the chat, a call,
 * a dictation, the update strip and the presence mark. Mounted inside the agent, since
 * the feed writes the socket's events into that agent's caches.
 */
export function ChatConnectionProvider({ children }: { children: ReactNode }) {
  const [connection] = useState(() => new ChatConnection(webSocketUrl));
  useEffect(() => {
    connection.start();
    return connection.stop;
  }, [connection]);
  useConversationFeed(connection);
  return <ChatConnectionContext.Provider value={connection}>{children}</ChatConnectionContext.Provider>;
}

export function useChatConnection(): ChatConnection {
  const connection = useContext(ChatConnectionContext);
  if (!connection) throw new Error('useChatConnection must be used inside <ChatConnectionProvider>');
  return connection;
}
