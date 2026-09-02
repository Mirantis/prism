import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import { useAgent } from '@/lib/agent-context';
import { useWebSocket } from '@/hooks/use-websocket';
import { useVoiceCall, type VoiceCall } from '@/hooks/use-voice-call';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type CompactionEvent,
  type ContextUsage,
  type ConversationMessage,
} from '@/types';
import ChatMessageList from './ChatMessageList';
import ChatInput from './ChatInput';
import type { PendingAttachment } from './ChatAttachmentChip';
import { findExact, parseCommandLine, type SlashCommand } from './commands';

let attachmentSeq = 0;

export default function AgentChat({ threadId }: { threadId?: string }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [localMessages, setLocalMessages] = useState<ConversationMessage[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  // Terminal compaction frame pending a SYSTEM note. Staged as state (not
  // appended directly in the WS callback) so the note goes through
  // appendSystemMessage, which is declared further down.
  const [compactionNotice, setCompactionNotice] = useState<CompactionEvent | null>(null);

  // The socket hands out the senders and the call hands back the handlers, so one of the
  // two is read late. The socket's callbacks are bound once, so the call goes through a
  // ref and the socket is not re-bound as the call's state changes.
  const voiceRef = useRef<VoiceCall | null>(null);

  const {
    status,
    isTyping,
    sendFollowup,
    cancel,
    sendVoiceStart,
    sendVoiceStop,
    sendVoiceAudio,
  } = useWebSocket({
    onMessage: (msg) => {
      // Deliveries are broadcast to all of the user's connections tagged with
      // their own thread id — a heartbeat, a cron task, a Slack turn, or a turn
      // in another tab can all arrive for a *different* thread than the one on
      // screen. Only render messages that belong to the thread being viewed.
      if (msg.threadId === activeThreadId) {
        setLocalMessages((prev) => [...prev, msg]);
      }
      // Invalidate the message's own thread cache (never a possibly-stale
      // active id) so it's fresh whether it's open now or navigated to later.
      if (msg.threadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', agent.agentId, msg.threadId] });
      }
    },
    // A thread was just titled (the first message of a conversation) — refetch
    // the Recents list so a brand-new thread appears (and existing rows pick up
    // their title) immediately, not only after a page reload. A plain in-place
    // patch can't add a thread that wasn't already in the cached list.
    // Context-window occupancy for a thread. Filtered the same way as messages:
    // an off-screen goal/cron turn broadcasts for its own thread and must not
    // overwrite the reading for the thread being viewed.
    onContextUsage: (usage) => {
      if (usage.threadId === activeThreadId) setContextUsage(usage);
    },
    // Compaction progress for the on-screen thread: an indicator while it runs,
    // a SYSTEM note when it ends (auto compactions of other threads stay quiet).
    onCompaction: (event) => {
      if (event.threadId !== activeThreadId) return;
      setIsCompacting(event.status === 'started');
      if (event.status !== 'started') setCompactionNotice(event);
    },
    onThreadUpdate: () => {
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'recents'] });
    },
    onVoiceEvent: (event) => voiceRef.current?.handleEvent(event),
    onVoiceAudio: (frame) => voiceRef.current?.handleAudio(frame),
  });

  const voice = useVoiceCall({
    sendVoiceStart,
    sendVoiceStop,
    sendVoiceAudio,
    threadId: activeThreadId,
    isConnected: status === 'connected',
  });
  voiceRef.current = voice;

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
        isCompacted: false,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, [cancel, isTyping, activeThreadId]);

  // Only resolve/create the latest thread when no specific thread is in the URL
  // — deep-linking to /chat/<id> must not create a fresh thread.
  const { data: latestThread } = useQuery({
    queryKey: ['threads', agent.agentId, 'latest'],
    queryFn: () => runtimeApi.getOrCreateLatestThread(agent.agentId, agent.userId),
    enabled: !threadId,
  });

  // Drive the active thread from the route: the path thread when /chat/<id>,
  // else the latest. Reacts to navigation between threads.
  useEffect(() => {
    if (threadId) {
      setActiveThreadId(threadId);
    } else if (latestThread?.id) {
      setActiveThreadId(latestThread.id);
    }
  }, [threadId, latestThread]);

  // Clear the previous thread's messages when switching so they don't flash
  // before the new thread's history loads.
  useEffect(() => {
    setLocalMessages([]);
    // Drop the previous thread's reading too — it belongs to a different
    // conversation, and the new thread's is seeded from its own query below.
    setContextUsage(null);
    setIsCompacting(false);
    setCompactionNotice(null);
  }, [activeThreadId]);

  const { data: thread, isLoading: isLoadingThread, error: threadError } = useQuery({
    queryKey: ['thread', agent.agentId, activeThreadId],
    queryFn: () => runtimeApi.getThread(agent.agentId, agent.userId, activeThreadId!),
    enabled: Boolean(activeThreadId),
  });

  // A deep-linked thread that doesn't exist (deleted / not owned) → fall back to
  // the latest conversation. Guarded on threadId so a latest-thread error can't loop.
  useEffect(() => {
    if (threadId && threadError instanceof ApiError) {
      navigate({ to: '/chat', replace: true });
    }
  }, [threadId, threadError, navigate]);

  useEffect(() => {
    if (thread?.messages) {
      setLocalMessages(thread.messages);
    }
    // Restore the stored snapshot so a reload shows the last known percentage
    // rather than waiting for the next turn to measure again.
    if (thread) {
      setContextUsage(thread.contextUsage ?? null);
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

  // A client-only SYSTEM line (e.g. a slash-command result). Never stored, so it
  // doesn't pollute the history fed back to the model — same pattern as the
  // cancel marker above.
  const appendSystemMessage = useCallback(
    (content: string) => {
      setLocalMessages((prev) => [
        ...prev,
        {
          id: `cmd-${Date.now()}`,
          threadId: activeThreadId ?? '',
          role: 'SYSTEM',
          content,
          triggeredBy: 'USER_INPUT',
          toolCalls: null,
          blocks: null,
          isCompacted: false,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [activeThreadId],
  );

  // Surface the pending compaction result as a SYSTEM note. Auto-compaction
  // failures stay silent (server logs carry them) — the user never asked, so
  // there is nothing actionable to show.
  useEffect(() => {
    if (!compactionNotice) return;
    setCompactionNotice(null);
    if (compactionNotice.status === 'completed') {
      const n = compactionNotice.messagesCompacted ?? 0;
      appendSystemMessage(`Conversation compacted — ${n} older message${n === 1 ? '' : 's'} summarized.`);
    } else if (compactionNotice.status === 'skipped') {
      // A no-op, not an error: only worth saying when the user asked for it.
      if (compactionNotice.trigger === 'manual') {
        appendSystemMessage(compactionNotice.detail ?? 'Nothing to compact yet.');
      }
    } else if (compactionNotice.trigger === 'manual') {
      appendSystemMessage(`Compaction failed: ${compactionNotice.error ?? 'unknown error'}`);
    }
  }, [compactionNotice, appendSystemMessage]);

  // Run a slash command locally and surface its result as a SYSTEM message. The
  // command itself calls the runtime's REST endpoints (e.g. /skills run streams
  // the agent's reply back over WebSocket); we never send the slash text to the
  // engine as chat.
  const runSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string[], rawArgs: string) => {
      let result: string;
      try {
        result = await cmd.run({ args, rawArgs, threadId: activeThreadId });
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
      }
      if (result) appendSystemMessage(result);
    },
    [activeThreadId, appendSystemMessage],
  );

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    const userMessage = message.trim();

    // Slash-command dispatch: a registered leading command runs locally instead
    // of being sent to the agent. Staged attachments are untouched (only a chat
    // send consumes them), matching the TUI.
    if (userMessage.startsWith('/')) {
      const { headWord, args, rawArgs } = parseCommandLine(userMessage);
      const cmd = findExact(headWord);
      if (cmd) {
        setMessage('');
        void runSlashCommand(cmd, args, rawArgs);
        return;
      }
    }

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
      isCompacted: false,
      createdAt: new Date().toISOString(),
      attachments: tempAttachments,
    };
    setLocalMessages((prev) => [...prev, tempMessage]);

    // No `isTyping` guard: sending during a turn is steering, not a second
    // turn. The runtime hands the message to the turn that owns `activeThreadId`
    // — which is why the thread id has to travel with it, since the gateway only
    // offers a message to a live turn when it carries one.
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
        contextUsage={contextUsage}
        isCompacting={isCompacting}
        voice={voice}
      />
    </div>
  );
}
