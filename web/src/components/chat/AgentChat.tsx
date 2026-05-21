import { useState, useEffect, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useWebSocket } from '@/hooks/use-websocket';
import type { ConversationMessage } from '@/types';
import ChatMessageList from './ChatMessageList';
import ChatInput from './ChatInput';

export default function AgentChat() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [localMessages, setLocalMessages] = useState<ConversationMessage[]>([]);

  const { status, isTyping, sendFollowup } = useWebSocket({
    onMessage: (msg) => {
      setLocalMessages((prev) => [...prev, msg]);
      if (activeThreadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', agent.agentId, activeThreadId] });
      }
    },
  });

  const { data: activeThread } = useQuery({
    queryKey: ['threads', agent.agentId, 'active'],
    queryFn: () => runtimeApi.getOrCreateActiveThread(agent.agentId, agent.userId),
  });

  useEffect(() => {
    if (activeThread?.id && !activeThreadId) {
      setActiveThreadId(activeThread.id);
    }
  }, [activeThread, activeThreadId]);

  const { data: thread, isLoading: isLoadingThread } = useQuery({
    queryKey: ['thread', agent.agentId, activeThreadId],
    queryFn: () => runtimeApi.getThread(agent.agentId, agent.userId, activeThreadId!),
    enabled: !!activeThreadId,
  });

  useEffect(() => {
    if (thread?.messages) {
      setLocalMessages(thread.messages);
    }
  }, [thread]);

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    const userMessage = message.trim();
    setMessage('');

    const tempMessage: ConversationMessage = {
      id: `temp-${Date.now()}`,
      threadId: activeThreadId ?? '',
      role: 'USER',
      content: userMessage,
      triggeredBy: 'USER_INPUT',
      toolCalls: null,
      blocks: null,
      tokenCount: null,
      isCompacted: false,
      createdAt: new Date().toISOString(),
    };
    setLocalMessages((prev) => [...prev, tempMessage]);

    sendFollowup(userMessage, agent.agentId, activeThreadId);
  };

  return (
    <div className="flex h-full flex-col">
      <ChatMessageList
        messages={localMessages}
        agentName={agent.name}
        isTyping={isTyping}
        isLoading={isLoadingThread}
      />
      <ChatInput
        value={message}
        onChange={setMessage}
        onSend={handleSend}
        isPending={isTyping}
        connectionStatus={status}
      />
    </div>
  );
}
