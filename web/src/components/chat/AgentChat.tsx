import { ComputerWaiting } from '@/components/computer/computer-waiting';
import { ChatComputerPanel } from '@/components/computer/chat-computer-panel';
import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { runtimeApi } from '@/api/runtime-client';
import {
  ApiError,
  buildTranscript,
  compareMessages,
  type TranscriptNote,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type CompactionEvent,
  type ContextUsage,
  computerHelpBlocks,
} from '@lensapp/prism-client';
import { useAgent } from '@/lib/agent-context';
import { useChatSocket } from '@/hooks/use-chat-socket';
import { useThread } from '@/hooks/use-thread';
import { useDictation, type Dictation } from '@/hooks/use-dictation';
import { useVoiceCall, type VoiceCall } from '@/hooks/use-voice-call';
import { HeaderActions } from '@/components/layout/header-actions';
import ChatMessageList from './ChatMessageList';
import ChatInput from './ChatInput';
import VoiceCallBar from './voice-call-bar';
import VoiceCallControl from './voice-call-control';
import type { PendingAttachment } from './ChatAttachmentChip';
import { findExact, parseCommandLine, type SlashCommand } from './commands';

let attachmentSeq = 0;
let noteSeq = 0;

export default function AgentChat({ threadId }: { threadId?: string }) {
  const agent = useAgent();
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  // Client-only SYSTEM lines: a slash-command result, the stop marker, a failed turn.
  // Never stored, so they stay out of the history fed back to the model.
  const [notes, setNotes] = useState<TranscriptNote[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [computerPanelRequest, setComputerPanelRequest] = useState<{
    id: string;
    token: number;
  }>();
  const [computerPanelWidth, setComputerPanelWidth] = useState<string | null>(null);
  const [computerPanelResizing, setComputerPanelResizing] = useState(false);
  // Terminal compaction event pending a SYSTEM note. Staged as state (not appended
  // directly in the socket handler) so the note goes through appendSystemMessage,
  // which is declared further down.
  const [compactionNotice, setCompactionNotice] = useState<CompactionEvent | null>(null);
  // A failed turn on the thread on screen, pending its note, for the same reason.
  const [turnError, setTurnError] = useState<string | null>(null);

  // The socket hands out the senders and the call and the dictation hand back the
  // handlers, so one of the two is read late, through refs.
  const voiceRef = useRef<VoiceCall | null>(null);
  const dictationRef = useRef<Dictation | null>(null);

  const { status, you, turns, pending, connection } = useChatSocket({
    // Context-window occupancy is thread-scoped: an off-screen goal or cron turn reports
    // for its own thread and must not overwrite the reading for the thread on screen.
    context: (usage) => {
      if (usage.threadId === activeThreadId) setContextUsage(usage);
    },
    // Compaction progress for the on-screen thread: an indicator while it runs, a SYSTEM
    // note when it ends. Auto compactions of other threads stay quiet.
    compaction: (event) => {
      if (event.threadId !== activeThreadId) return;
      setIsCompacting(event.status === 'started');
      if (event.status !== 'started') setCompactionNotice(event);
    },
    turn: (event) => {
      if (event.threadId !== activeThreadId || event.outcome !== 'failed') return;
      setTurnError(event.error ?? 'The agent could not finish its reply.');
    },
    voice: (event) => voiceRef.current?.handleEvent(event),
    voiceAudio: (frame) => voiceRef.current?.handleAudio(frame),
    dictation: (event) => dictationRef.current?.handleEvent(event),
  });

  const turnState = (activeThreadId && turns[activeThreadId]) || 'idle';
  const isWorking = turnState !== 'idle';

  const voice = useVoiceCall({
    sendVoiceStart: connection.voiceStart,
    sendVoiceStop: connection.voiceStop,
    sendVoiceAudio: connection.sendAudio,
    threadId: activeThreadId,
    isConnected: status === 'connected',
  });
  voiceRef.current = voice;

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

  // The thread's stored reading is where the meter starts, once per thread. The thread's
  // data changes with every message, and the socket's reading is the newer one by then.
  const seededUsageFor = useRef<string | undefined>(undefined);

  // The previous thread's notes and readings belong to a different conversation.
  useEffect(() => {
    setNotes([]);
    setContextUsage(null);
    setIsCompacting(false);
    setCompactionNotice(null);
    setTurnError(null);
    seededUsageFor.current = undefined;
  }, [activeThreadId]);

  const { data: thread, isLoading: isLoadingThread, error: threadError } = useThread(activeThreadId);

  // A deep-linked thread that doesn't exist (deleted / not owned) → fall back to
  // the latest conversation. Guarded on threadId so a latest-thread error can't loop.
  useEffect(() => {
    if (threadId && threadError instanceof ApiError) {
      navigate({ to: '/chat', replace: true });
    }
  }, [threadId, threadError, navigate]);

  useEffect(() => {
    if (!thread || seededUsageFor.current === thread.id) return;
    seededUsageFor.current = thread.id;
    setContextUsage(thread.contextUsage ?? null);
  }, [thread]);

  // Read by `appendNote` when it writes a note, without rebuilding it on every message.
  const storedRef = useRef(thread?.messages);
  storedRef.current = thread?.messages;

  const threadPending = useMemo(
    () => pending.filter((m) => m.threadId === activeThreadId),
    [pending, activeThreadId],
  );
  const transcript = useMemo(
    () => buildTranscript(thread?.messages ?? [], notes, threadPending),
    [thread?.messages, notes, threadPending],
  );

  const computerHelp = transcript.flatMap(computerHelpBlocks);
  // A sign-in is answered in the message itself, so it never slides the live desktop over
  // the chat.
  const desktopHelp = computerHelp.filter((help) => !help.credentials);
  const openComputerPanel = useCallback((id: string) => {
    setComputerPanelRequest((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  }, []);

  const appendNote = useCallback(
    (kind: 'cmd' | 'stopped' | 'error', content: string) => {
      noteSeq++;
      const last = [...(storedRef.current ?? [])].sort(compareMessages).at(-1);
      setNotes((prev) => [
        ...prev,
        {
          after: last?.id ?? null,
          id: `${kind}-${noteSeq}`,
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
  const appendSystemMessage = useCallback((content: string) => appendNote('cmd', content), [appendNote]);

  // Any client may stop a thread's work, a queued thread's included. The marker confirms it.
  const handleCancel = useCallback(() => {
    if (!activeThreadId || !isWorking) return;
    if (connection.cancel(activeThreadId)) appendNote('stopped', 'Response stopped');
  }, [activeThreadId, isWorking, connection, appendNote]);

  useEffect(() => {
    if (!turnError) return;
    setTurnError(null);
    appendNote('error', turnError);
  }, [turnError, appendNote]);

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

  // A failed message goes back into the composer, attachments included, and out of the thread.
  // Read through a ref so the handler stays the same as messages come and go, and the
  // memoized rows do not render again for it.
  const pendingRef = useRef(threadPending);
  pendingRef.current = threadPending;
  const handleEditFailed = useCallback(
    (id: string) => {
      const failed = pendingRef.current.find((m) => m.id === id);
      if (!failed) return;
      setMessage(failed.content);
      setAttachments((prev) => [
        ...prev,
        ...(failed.attachments ?? []).map(
          (a): PendingAttachment => ({ ...a, localId: `att-${Date.now()}-${attachmentSeq++}`, status: 'ready' }),
        ),
      ]);
      connection.discard(id);
    },
    [connection],
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

    setMessage('');
    sendChat(userMessage);
  };

  /**
   * Send text as the user's message, with whatever is attached and ready. A dictated
   * message goes out here too, so it is drawn and steers a running turn the same way.
   *
   * No guard on a running turn: a message sent then goes to the turn that owns the
   * thread, which reads it at its next step.
   */
  const sendChat = (userMessage: string) => {
    if (!activeThreadId) return;
    const ready = attachments.filter((a) => a.status === 'ready' && a.id);
    if (!userMessage && ready.length === 0) return;

    setAttachments([]);
    const sent: Attachment[] = ready.map((a) => ({
      id: a.id!,
      filename: a.filename,
      mediaType: a.mediaType,
      sizeBytes: a.sizeBytes,
      category: a.category,
    }));
    connection.send(activeThreadId, userMessage, sent);
  };

  const dictation = useDictation({
    sendDictationStart: connection.dictationStart,
    sendDictationStop: connection.dictationStop,
    sendAudio: connection.sendAudio,
    isConnected: status === 'connected',
    onTranscript: sendChat,
  });
  dictationRef.current = dictation;

  // One microphone per socket: the runtime refuses a call while this page dictates, and
  // a dictation while it calls. The controls say so before the user finds out that way.
  // A call also waits for the thread, so the agent's tools in it have one.
  const callBlockedReason =
    status !== 'connected' || !activeThreadId
      ? 'Not connected'
      : dictation.status !== 'idle'
        ? 'Finish the voice message first'
        : null;
  const dictationBlockedReason = voice.status !== 'idle' ? 'End the call to record a voice message' : null;

  return (
    <div className="flex h-full flex-col">
      <HeaderActions>
        <VoiceCallControl call={voice} blockedReason={callBlockedReason} />
      </HeaderActions>
      <VoiceCallBar call={voice} agentName={agent.name} />
      <ChatMessageList
        messages={transcript}
        agentName={agent.name}
        viewer={you}
        turnState={turnState}
        isLoading={isLoadingThread}
        threadId={activeThreadId}
        onSuggestion={status === 'connected' && activeThreadId ? sendChat : undefined}
        onOpenComputerHelp={openComputerPanel}
        onRetry={connection.retry}
        onEdit={handleEditFailed}
      />
      {desktopHelp.length > 0 && (
        <ChatComputerPanel
          requests={desktopHelp}
          reopenRequest={computerPanelRequest}
          onLayoutChange={setComputerPanelWidth}
          onResizingChange={setComputerPanelResizing}
        />
      )}
      <div className="mx-auto w-full max-w-3xl px-4 empty:hidden">
        <ComputerWaiting threadId={activeThreadId} />
      </div>
      <div
        style={{ marginRight: computerPanelWidth ?? undefined }}
        className={computerPanelResizing
          ? 'transition-none'
          : 'transition-[margin-right] duration-[1200ms] ease-in-out motion-reduce:transition-none'}
      >
        <ChatInput
          value={message}
          onChange={setMessage}
          onSend={handleSend}
          isPending={isWorking}
          onCancel={handleCancel}
          // Nothing is sent before a thread exists: a message needs one to belong to.
          connectionStatus={activeThreadId || status === 'update-required' ? status : 'connecting'}
          attachments={attachments}
          onFilesSelected={handleFilesSelected}
          onRemoveAttachment={handleRemoveAttachment}
          contextUsage={contextUsage}
          isCompacting={isCompacting}
          dictation={dictation}
          dictationBlockedReason={dictationBlockedReason}
        />
      </div>
    </div>
  );
}
