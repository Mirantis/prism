import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useWebSocket } from '@/hooks/use-websocket';
import { MAX_ATTACHMENTS_PER_MESSAGE, type Attachment, type ConversationMessage } from '@/types';
import ChatMessageList from './ChatMessageList';
import ChatInput from './ChatInput';
import type { PendingAttachment } from './ChatAttachmentChip';

let attachmentSeq = 0;

export default function AgentChat() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [localMessages, setLocalMessages] = useState<ConversationMessage[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const { status, isTyping, sendFollowup, cancel } = useWebSocket({
    onMessage: (msg) => {
      setLocalMessages((prev) => [...prev, msg]);
      if (activeThreadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', agent.agentId, activeThreadId] });
      }
    },
  });

  // Cancel the in-flight turn and drop an ephemeral marker so the user gets
  // explicit confirmation. The marker is client-only (never stored), so it
  // doesn't pollute the conversation history fed back to the model.
  const handleCancel = useCallback(() => {
    if (!isTyping) return;
    cancel();
    setLocalMessages((prev) => [
      ...prev,
      {
        id: `stopped-${Date.now()}`,
        threadId: activeThreadId ?? '',
        role: 'SYSTEM',
        content: 'Response stopped',
        triggeredBy: 'USER_INPUT',
        toolCalls: null,
        blocks: null,
        tokenCount: null,
        isCompacted: false,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, [cancel, isTyping, activeThreadId]);

  const { data: latestThread } = useQuery({
    queryKey: ['threads', agent.agentId, 'latest'],
    queryFn: () => runtimeApi.getOrCreateLatestThread(agent.agentId, agent.userId),
  });

  useEffect(() => {
    if (latestThread?.id && !activeThreadId) {
      setActiveThreadId(latestThread.id);
    }
  }, [latestThread, activeThreadId]);

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

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      // Cap staged files per message (the runtime re-enforces this at link
      // time; this is the UX guard so the user isn't surprised by silently
      // dropped files server-side).
      const remaining = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);
      const accepted = files.slice(0, remaining);
      const rejectedCount = files.length - accepted.length;
      if (rejectedCount > 0) {
        setAttachments((prev) => [
          ...prev,
          {
            localId: `att-limit-${Date.now()}-${attachmentSeq++}`,
            filename: `${rejectedCount} file(s) not added`,
            mediaType: '',
            sizeBytes: 0,
            category: 'unreadable',
            status: 'error',
            error: `Max ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
          },
        ]);
      }
      for (const file of accepted) {
        const localId = `att-${Date.now()}-${attachmentSeq++}`;
        setAttachments((prev) => [
          ...prev,
          {
            localId,
            filename: file.name,
            mediaType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            category: 'unreadable',
            status: 'uploading',
          },
        ]);

        runtimeApi
          .uploadAttachment(file, activeThreadId)
          .then((res) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.localId === localId
                  ? {
                      ...a,
                      id: res.id,
                      filename: res.filename,
                      mediaType: res.mediaType,
                      sizeBytes: res.sizeBytes,
                      category: res.category,
                      status: 'ready',
                    }
                  : a,
              ),
            );
          })
          .catch((err: unknown) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.localId === localId
                  ? { ...a, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
                  : a,
              ),
            );
          });
      }
    },
    [activeThreadId, attachments.length],
  );

  const handleRemoveAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      // Best-effort delete of the unlinked server row; ignore failures.
      if (target?.id) runtimeApi.deleteAttachment(target.id).catch(() => {});
      return prev.filter((a) => a.localId !== localId);
    });
  }, []);

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    const userMessage = message.trim();
    const ready = attachments.filter((a) => a.status === 'ready' && a.id);
    if (!userMessage && ready.length === 0) return;

    setMessage('');
    setAttachments([]);

    const tempAttachments: Attachment[] = ready.map((a) => ({
      id: a.id!,
      filename: a.filename,
      mediaType: a.mediaType,
      sizeBytes: a.sizeBytes,
      category: a.category,
    }));

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
      attachments: tempAttachments,
    };
    setLocalMessages((prev) => [...prev, tempMessage]);

    sendFollowup(
      userMessage,
      agent.agentId,
      activeThreadId,
      ready.map((a) => a.id!),
    );
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
        onCancel={handleCancel}
        connectionStatus={status}
        attachments={attachments}
        onFilesSelected={handleFilesSelected}
        onRemoveAttachment={handleRemoveAttachment}
      />
    </div>
  );
}
