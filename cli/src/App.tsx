import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import {
  tuiAdapterService,
  ContextUsage,
  SignInRequest,
  ThreadSummary,
  TuiMessage,
  TuiStatus,
} from './tui-adapter.js';
import { useCompaction } from './hooks/use-compaction.js';
import { useUpdateNotice } from './hooks/use-update-notice.js';
import { Header } from './components/Header.js';
import { MessageList, ChatEntry } from './components/MessageList.js';
import { Input } from './components/Input.js';
import { SpinnerRow } from './components/SpinnerRow.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandPopup, PopupItem } from './components/CommandPopup.js';
import { SchedulesPanel } from './components/SchedulesPanel.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { SignInPanel } from './components/SignInPanel.js';
import { ResumeList } from './components/ResumeList.js';
import { apiClient } from './api-client.js';
import {
  ATTACH_COMMAND,
  filterByPrefix,
  findExact,
  parseCommandLine,
  CommandContext,
  PanelId,
  SlashCommand,
} from './commands.js';
import { AttachmentMeta, formatFileSize, listPathSuggestions } from './attachments.js';

export interface AppProps {
  userId: string;
  agent: { id: string; name: string };
  modelId: string;
  hideCursor?: boolean;
  hideStatusBar?: boolean;
  /**
   * When set (the `--resume` flag), the CLI first shows a picker of these
   * prior threads instead of starting a fresh session. Selecting one resumes
   * it; `cwd` is the launch directory, shown for context.
   */
  resume?: { sessions: ThreadSummary[]; cwd: string };
}

/** Input prefix that switches the popup from commands to path suggestions. */
const ATTACH_PREFIX = `${ATTACH_COMMAND} `;

export const App: React.FC<AppProps> = ({ userId, agent, modelId, hideCursor, hideStatusBar, resume }) => {
  const { exit } = useApp();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // In resume mode, the thread picker owns the screen until the user selects a
  // thread (→ 'chat') or cancels (→ exit). Without `resume` we go straight to chat.
  const [resumePhase, setResumePhase] = useState<'select' | 'chat'>(resume ? 'select' : 'chat');
  // The thread the user picked in the --resume picker. Pinned onto every send
  // (and the history replay) so the turn routes to it. Undefined for a fresh
  // session, where the runtime resolves the latest thread instead.
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<TuiStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  // Context-window occupancy for the active thread, pushed by the runtime.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  // The adapter subscription below is bound once ([] deps), so it can't read
  // `activeThreadId` directly without freezing the first render's value.
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // The thread whose frame set `thinking`, so its end is taken even when it arrived
  // before this session pinned a thread of its own.
  const thinkingThreadRef = useRef<string | undefined>(undefined);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  // Bumped when Tab or Enter accepts a completion, to force <Input> to remount,
  // which is the only way to move ink-text-input's internal cursor to the end of
  // the new value — the library otherwise keeps the previous offset.
  const [inputResetKey, setInputResetKey] = useState(0);
  // Tracks which agent message currently has its tool-call details expanded
  // inline. Only one message can be expanded at a time; Ctrl+O toggles the
  // latest agent message that has tool calls.
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  // When non-null, a full-screen panel replaces the chat surface (MessageList +
  // Input + popup). Panel commands set this via openPanel; the panels call
  // closePanel (wired to onClose) to return to chat.
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  // The sign-in the agent is blocked on, while this session is answering it. Its own
  // state rather than a `PanelId`: no slash command opens it, the request opens it.
  const [signInRequest, setSignInRequest] = useState<SignInRequest | null>(null);
  // Files staged by /attach, sent with (and cleared by) the next chat message.
  const [staged, setStaged] = useState<AttachmentMeta[]>([]);
  // Submitted-input history for Up/Down recall (oldest → newest). historyIndex
  // is null when not browsing; otherwise it's the index of the entry currently
  // shown in the input. Up enters history only from an empty input, then walks
  // to older entries; editing the input exits browsing.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // Mark adapter connected so any future runtime broadcasts can reach us.
  useEffect(() => {
    tuiAdapterService.markConnected(userId);
    return () => tuiAdapterService.markDisconnected();
  }, [userId]);

  // Start a fresh conversation thread on every CLI open. The runtime creates a
  // new thread (which becomes the latest), so the TUI opens to a clean slate
  // instead of resuming the last conversation. Fires once per launch (not on
  // WebSocket reconnect, which is handled separately).
  // Skipped in resume mode — there we pin the picked thread and replay its
  // history on selection instead of creating a new one.
  useEffect(() => {
    if (resume) return;
    // Pin the freshly-created session thread id so slash commands that need a
    // thread (e.g. /goal) work immediately, before any message is sent.
    void tuiAdapterService.startNewSession().then((threadId) => {
      if (threadId) setActiveThreadId(threadId);
    });
  }, [userId, agent.id, resume]);

  // Subscribe to adapter event bus.
  useEffect(() => {
    const onMessage = (msg: TuiMessage) => {
      setEntries((prev) => [...prev, { kind: 'message', message: msg }]);
    };
    // A frame naming another thread is a turn in another conversation — Slack's, or the
    // Web UI's. A frame with no thread (a cancel, a connection change) is this session's.
    // The one exception is the end of the turn that set `thinking`: a frame that arrived
    // before the thread was pinned is ended by that same thread's frame.
    const onStatus = (s: TuiStatus, detail?: string, threadId?: string) => {
      const thread = activeThreadIdRef.current;
      const endsThinking = threadId !== undefined && threadId === thinkingThreadRef.current;
      if (threadId && thread && threadId !== thread && !endsThinking) return;
      thinkingThreadRef.current = s === 'thinking' ? threadId : undefined;
      setStatus(s);
      setStatusDetail(detail);
    };
    // Only fills a gap: a thread we already pinned (--resume, or the session
    // created at launch) wins, since an autonomous delivery can name another one.
    const onThread = (threadId: string) => {
      setActiveThreadId((cur) => cur ?? threadId);
    };
    const onContextUsage = (usage: ContextUsage) => {
      // On a fresh (non-resume) launch activeThreadId is undefined until the
      // runtime resolves the latest thread (or a `thread` frame names it), so
      // strict equality would drop the first frames. Accept anything until we
      // know which thread we're on.
      setContextUsage((prev) =>
        activeThreadIdRef.current === undefined || usage.threadId === activeThreadIdRef.current
          ? usage
          : prev,
      );
    };
    // The newest request of this conversation wins: the agent asks for one sign-in at a
    // time, and a second means the first is no longer what it is waiting for. A delivery
    // reaches every one of the user's clients, so a request from another conversation —
    // the Web UI's, or Slack's — is not this session's to answer.
    const onSignIn = (request: SignInRequest) => {
      const thread = activeThreadIdRef.current;
      if (request.threadId && thread && request.threadId !== thread) return;
      setSignInRequest(request);
    };
    tuiAdapterService.events.on('message', onMessage);
    tuiAdapterService.events.on('status', onStatus);
    tuiAdapterService.events.on('thread', onThread);
    tuiAdapterService.events.on('contextUsage', onContextUsage);
    tuiAdapterService.events.on('signIn', onSignIn);
    return () => {
      tuiAdapterService.events.off('message', onMessage);
      tuiAdapterService.events.off('status', onStatus);
      tuiAdapterService.events.off('thread', onThread);
      tuiAdapterService.events.off('contextUsage', onContextUsage);
      tuiAdapterService.events.off('signIn', onSignIn);
    };
  }, []);

  // Slash-command popup: visible while the input starts with '/' and no space
  // has been typed yet. After Tab or Enter accepts a row (which appends a
  // space), the popup hides and the user is free to type arguments.
  const slashMode = inputValue.startsWith('/') && !inputValue.includes(' ');
  const filteredCommands = useMemo<SlashCommand[]>(
    () => (slashMode ? filterByPrefix(inputValue.length === 1 ? '/' : inputValue) : []),
    [slashMode, inputValue],
  );

  // Path-completion popup: once '/attach ' has been typed (slashMode is then
  // false — a space is present), suggest local filesystem paths for the
  // partial argument. Mutually exclusive with slashMode by construction.
  const attachMode = inputValue.startsWith(ATTACH_PREFIX);
  const pathSuggestions = useMemo(
    () => (attachMode ? listPathSuggestions(inputValue.slice(ATTACH_PREFIX.length)) : []),
    [attachMode, inputValue],
  );

  // The popup renders whichever item set is active.
  const popupItems = useMemo<PopupItem[]>(
    () =>
      slashMode
        ? filteredCommands
        : pathSuggestions.map((s) => ({
            name: s.display,
            description: s.isDirectory ? 'dir' : '',
          })),
    [slashMode, filteredCommands, pathSuggestions],
  );

  // Keep commandIndex within bounds as the visible list shrinks/grows.
  useEffect(() => {
    if (commandIndex >= popupItems.length) {
      setCommandIndex(0);
    }
  }, [popupItems.length, commandIndex]);

  const safeIndex = popupItems.length === 0
    ? 0
    : Math.min(commandIndex, popupItems.length - 1);

  // Accept the highlighted slash command into the composer as "<name> ". The
  // trailing space ends slash mode, so the popup closes and arguments can be
  // typed. Shared by Tab and Enter.
  const acceptHighlightedCommand = useCallback(() => {
    const chosen = filteredCommands[safeIndex];
    if (!chosen) return;
    setInputValue(chosen.name + ' ');
    setInputResetKey((k) => k + 1);
  }, [filteredCommands, safeIndex]);

  const appendSystemMessage = useCallback((text: string) => {
    setEntries((prev) => [
      ...prev,
      {
        kind: 'message',
        message: {
          id: `system-${Date.now()}`,
          threadId: '',
          role: 'SYSTEM',
          content: text,
          triggeredBy: 'USER_INPUT',
          toolCalls: null,
          blocks: null,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
  }, []);

  // A compaction is running for the active thread (auto post-turn or /compact).
  // Shown as the spinner-row label — compaction runs outside a chat turn, so
  // the ordinary thinking spinner is idle while it works.
  const compacting = useCompaction(activeThreadId, appendSystemMessage);

  // A newer release the runtime announced (status-bar hint), plus SYSTEM lines
  // when the backend restarts to apply one or a manual update fails.
  const updateAvailableVersion = useUpdateNotice(appendSystemMessage);

  // Centralized shutdown trigger shared by Ctrl+C and the /exit command.
  // Only flips state here; the effect below calls Ink's `exit()` AFTER the
  // "Shutting down…" render commits, so the frame is visible before the
  // tree unmounts and the process exits.
  const triggerShutdown = useCallback(() => {
    setShuttingDown(true);
  }, []);

  // Resume picker → chat: pin the chosen thread, replay its history into the
  // chat surface, then hand over to the normal chat UI. The thread id is sent
  // explicitly on every subsequent send (and the history fetch), so the turn
  // routes to this thread without mutating any server-side "latest" pointer.
  const handleResumeSelect = useCallback(
    async (threadId: string) => {
      setActiveThreadId(threadId);
      // Seed from the picker's own row so the status bar shows a percentage
      // before the resumed thread's next turn is measured. Looked up here rather
      // than passed through ResumeList, whose onSelect deliberately only carries
      // the id.
      setContextUsage(resume?.sessions.find((s) => s.id === threadId)?.contextUsage ?? null);
      const messages = await tuiAdapterService.loadHistory({ userId, agentId: agent.id, threadId });
      setEntries(messages.map((message) => ({ kind: 'message' as const, message })));
      setResumePhase('chat');
    },
    [userId, agent.id, resume],
  );

  // Escape in the picker exits the CLI (clean shutdown → exit code 0).
  const handleResumeCancel = useCallback(() => {
    triggerShutdown();
  }, [triggerShutdown]);

  useEffect(() => {
    if (shuttingDown) exit();
  }, [shuttingDown, exit]);

  const openPanel = useCallback((id: PanelId) => setActivePanel(id), []);

  // Hand the whole terminal to a child process that needs it (an editor), then
  // take it back. Two things have to stop, not one:
  //
  // - **Input.** Ink refcounts raw mode: `setRawMode(false)` from one holder
  //   decrements a counter and only leaves raw mode at zero. Three hooks hold
  //   it here (the Ctrl+C hook, the chat-mode hook, the composer), so going
  //   through Ink would leave the child on a raw tty — no line editing, no
  //   echo, and Ctrl+C never arriving as SIGINT. `suspended` deactivates this
  //   component's hooks and unmounts the composer with them, and the tty mode
  //   is then set directly, so the child gets a cooked terminal whatever
  //   Ink's counter says.
  // - **Output.** A WebSocket delivery mid-edit — an agent reply, a heartbeat,
  //   a cron result — repaints Ink's frame on top of the editor. Rendering
  //   nothing while suspended means Ink erases its frame once and then writes
  //   nothing more, because the output stops changing.
  const { stdin, isRawModeSupported } = useStdin();
  const [suspended, setSuspended] = useState(false);
  const suspendInput = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (!isRawModeSupported) return fn();
      setSuspended(true);
      // Let that render commit — the hooks unsubscribe and the frame clears —
      // before the child takes the screen.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const wasRaw = stdin.isRaw === true;
      if (wasRaw) stdin.setRawMode(false);
      stdin.pause();
      try {
        return await fn();
      } finally {
        stdin.resume();
        if (wasRaw) stdin.setRawMode(true);
        setSuspended(false);
      }
    },
    [stdin, isRawModeSupported],
  );
  const stageAttachment = useCallback(
    (att: AttachmentMeta) => setStaged((prev) => [...prev, att]),
    [],
  );
  const clearStagedAttachments = useCallback(() => setStaged([]), []);
  // Closing a panel remounts <Input> (via inputResetKey) so its internal
  // cursor offset starts fresh on the empty value left from the slash command.
  const closePanel = useCallback(() => {
    setActivePanel(null);
    setInputResetKey((k) => k + 1);
  }, []);

  const runCommand = useCallback(
    async (cmd: SlashCommand, args: string[], rawArgs: string) => {
      const lastEntry = entries[entries.length - 1];
      // Files from the most recent agent message that shared any — the /save
      // candidates. Walk newest→oldest so /save targets the latest delivery.
      let recentAttachments: AttachmentMeta[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = entries[i]!.message;
        if (m.role === 'AGENT' && Array.isArray(m.attachments) && m.attachments.length > 0) {
          recentAttachments = m.attachments;
          break;
        }
      }
      const ctx: CommandContext = {
        lastMessageContent: lastEntry?.message.content ?? null,
        requestShutdown: triggerShutdown,
        args,
        rawArgs,
        openPanel,
        api: apiClient,
        threadId: activeThreadId ?? null,
        recentAttachments,
        stagedAttachments: staged,
        stageAttachment,
        clearStagedAttachments,
        suspendInput,
      };
      const result = await cmd.run(ctx);
      // Panel commands return '' (the panel is their output); only surface a
      // synthetic SYSTEM message when there's actual text to show.
      if (result) appendSystemMessage(result);
    },
    [entries, appendSystemMessage, triggerShutdown, openPanel, staged, stageAttachment, clearStagedAttachments, activeThreadId, suspendInput],
  );

  // Ctrl+C must work everywhere, including while a panel owns the screen, so
  // it lives in its own hook that handles nothing else. It stands down only
  // while a child process owns the terminal, where Ctrl+C belongs to the child.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') triggerShutdown();
    },
    { isActive: !suspended },
  );

  // Ctrl+O / Up / Down / Tab handling. ink-text-input v6 explicitly returns
  // early for these keys so they don't conflict with the textbox. Disabled
  // while a panel is open so the panel's own useInput owns the keyboard.
  useInput((input, key) => {
    // Escape while the agent is working cancels the in-flight turn: tells the
    // runtime to abort the LLM generation and drops a client-only marker so
    // the user gets explicit confirmation (the in-flight text is discarded).
    if (key.escape && status === 'thinking') {
      tuiAdapterService.cancel();
      appendSystemMessage('⏹ Response stopped');
      return;
    }
    // Ctrl+O — toggle expansion of the latest agent message that has tool
    // calls. If a different message is currently expanded, this implicitly
    // collapses it by switching the id.
    if (key.ctrl && input === 'o') {
      // The composer ignores every Ctrl chord (see components/TextInput.tsx), so
      // this cannot leak an 'o' into the draft and the value is left untouched.
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = entries[i]!.message;
        if (
          m.role === 'AGENT' &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.length > 0
        ) {
          setExpandedMessageId((cur) => (cur === m.id ? null : m.id));
          break;
        }
      }
      return;
    }
    // While a popup is open (slash commands or /attach path suggestions),
    // Up/Down move its selection and Tab autocompletes — that takes
    // precedence over history recall.
    if ((slashMode || attachMode) && popupItems.length > 0) {
      if (key.upArrow) {
        setCommandIndex((i) => (i - 1 + popupItems.length) % popupItems.length);
        return;
      }
      if (key.downArrow) {
        setCommandIndex((i) => (i + 1) % popupItems.length);
        return;
      }
      if (key.tab) {
        if (slashMode) {
          acceptHighlightedCommand();
        } else {
          const s = pathSuggestions[safeIndex];
          if (s) {
            // Directory: keep completing inside it (no trailing space, popup
            // stays open listing its contents). File: append a space so the
            // popup hides and the path is ready to submit.
            setInputValue(ATTACH_PREFIX + s.insert + (s.isDirectory ? '' : ' '));
            setInputResetKey((k) => k + 1);
          }
        }
      }
      return;
    }

    // Command history recall (popup not showing). Up enters history from an
    // empty input and walks to older entries; Down walks back toward the
    // newest and clears the input past the end. Each recall remounts <Input>
    // so ink-text-input's cursor lands at the end of the value.
    if (key.upArrow) {
      if (history.length === 0) return;
      // From an idle (non-browsing) state, only hijack Up when the input is
      // empty so a half-typed draft is never clobbered.
      if (historyIndex === null && inputValue.length > 0) return;
      const nextIndex =
        historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInputValue(history[nextIndex] ?? '');
      setInputResetKey((k) => k + 1);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        setInputValue('');
        setInputResetKey((k) => k + 1);
        return;
      }
      setHistoryIndex(nextIndex);
      setInputValue(history[nextIndex] ?? '');
      setInputResetKey((k) => k + 1);
    }
  }, {
    isActive: !suspended && activePanel === null && signInRequest === null && resumePhase === 'chat',
  });

  const onSubmit = useCallback(
    async (text: string) => {
      // The slash popup is open: Enter accepts the highlighted row, the same as
      // Tab, and sends nothing. A second Enter — the popup now closed by the
      // trailing space — runs the command. This has to sit here rather than in a
      // `key.return` case: Ink dispatches child handlers first, so the
      // composer's Enter reaches `onSubmit` before App's `useInput` runs (see
      // components/TextInput.tsx).
      if (slashMode && filteredCommands.length > 0) {
        acceptHighlightedCommand();
        return;
      }

      const trimmed = text.trim();
      // Empty text is still a valid send when files are staged — the runtime
      // accepts file-only messages (gateway allows empty content + ids).
      if (!trimmed && staged.length === 0) return;

      // Record the submission for Up/Down recall (skip consecutive dupes and
      // empty file-only sends) and reset the browse cursor.
      if (trimmed) {
        setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]));
      }
      setHistoryIndex(null);

      // Slash-command dispatch: if the head word is a registered command, run
      // it locally (with any arguments) instead of sending it to the agent.
      // Staged files survive slash commands — only a chat send consumes them.
      if (trimmed.startsWith('/')) {
        const { headWord, args, rawArgs } = parseCommandLine(trimmed);
        const cmd = findExact(headWord);
        if (cmd) {
          setInputValue('');
          await runCommand(cmd, args, rawArgs);
          return;
        }
      }

      setInputValue('');
      // Consume staging synchronously before the awaited send so a rapid
      // second Enter can't double-send the same attachments. If the WS isn't
      // connected the send is dropped (same as text today) and the staged
      // files are lost client-side — the server janitor reaps the uploads.
      const toSend = staged;
      setStaged([]);
      // Optimistically render the user line — the adapter only sees AGENT
      // messages back through deliver(), and we want immediate feedback.
      setEntries((prev) => [
        ...prev,
        {
          kind: 'message',
          message: {
            id: `local-${Date.now()}`,
            threadId: '',
            role: 'USER',
            content: trimmed,
            triggeredBy: 'USER_INPUT',
            toolCalls: null,
            blocks: null,
            createdAt: new Date().toISOString(),
            attachments: toSend.length > 0 ? toSend : null,
          },
        },
      ]);
      await tuiAdapterService.submitUserMessage({
        userId,
        agentId: agent.id,
        text: trimmed,
        threadId: activeThreadId,
        attachmentIds: toSend.map((a) => a.id),
      });
    },
    [
      agent.id,
      userId,
      runCommand,
      staged,
      activeThreadId,
      slashMode,
      filteredCommands,
      acceptHighlightedCommand,
    ],
  );

  const handleInputChange = useCallback((newValue: string) => {
    // Real typing exits history browsing — programmatic recalls set the value
    // directly and never route through onChange, so they keep the cursor.
    setHistoryIndex(null);
    setInputValue(newValue);
  }, []);

  if (shuttingDown) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text color="yellow">Shutting down…</Text>
      </Box>
    );
  }

  if (resume && resumePhase === 'select') {
    return (
      <ResumeList
        sessions={resume.sessions}
        cwd={resume.cwd}
        onSelect={handleResumeSelect}
        onCancel={handleResumeCancel}
      />
    );
  }

  // A child process owns the terminal: draw nothing, so Ink's frame does not
  // land on top of the editor when state changes underneath it.
  if (suspended) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header agentName={agent.name} />
      {signInRequest ? (
        <SignInPanel
          api={apiClient}
          request={signInRequest}
          onClose={() => setSignInRequest(null)}
        />
      ) : activePanel === 'schedules' ? (
        <SchedulesPanel api={apiClient} onClose={closePanel} />
      ) : activePanel === 'config' ? (
        <ConfigPanel api={apiClient} onClose={closePanel} />
      ) : (
        <>
          <MessageList
            agentName={agent.name}
            entries={entries}
            expandedMessageId={expandedMessageId}
          />
          {staged.length > 0 && (
            <Box paddingX={2}>
              <Text dimColor>
                {staged
                  .map((a) => `📎 ${a.filename} (${formatFileSize(a.sizeBytes)})`)
                  .join('  ')}
                {'  ·  /detach to remove'}
              </Text>
            </Box>
          )}
          <SpinnerRow
            active={status === 'thinking' || compacting}
            label={
              status === 'thinking'
                ? 'thinking… (esc to stop · enter sends)'
                : 'compacting conversation…'
            }
          />
          <Input
            key={inputResetKey}
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={onSubmit}
            hideCursor={hideCursor}
          />
          {(slashMode || attachMode) && popupItems.length > 0 && (
            <CommandPopup items={popupItems} selectedIndex={safeIndex} />
          )}
        </>
      )}
      {!hideStatusBar && (
        <StatusBar
          // Prefer the model the runtime actually ran: `modelId` comes from local
          // ~/.prism/settings.json and can disagree with the agent's real model.
          modelId={contextUsage?.modelId ?? modelId}
          status={status}
          detail={statusDetail}
          contextUsedPercent={contextUsage?.usedPercent ?? null}
          updateAvailableVersion={updateAvailableVersion}
        />
      )}
    </Box>
  );
};
