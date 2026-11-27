import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import {
  tuiAdapterService,
  ContextUsage,
  SendFailure,
  SignInRequest,
  ThreadSummary,
  TuiMessage,
  TuiStatus,
  TurnEventPayload,
} from './tui-adapter.js';
import { MAX_MESSAGE_CHARS, TURN_FAILED_TEXT, TurnState, type Viewer } from './chat-protocol.js';
import { appendLocal, ChatEntry, markFailed, upsertMessage, withHistory } from './transcript.js';
import { useCompaction } from './hooks/use-compaction.js';
import { useUpdateNotice } from './hooks/use-update-notice.js';
import { useProgramStatus } from './hooks/use-program-status.js';
import { Header } from './components/Header.js';
import { LlmProviderWarning } from './components/llm-provider-warning.js';
import { MessageList } from './components/MessageList.js';
import { Input } from './components/Input.js';
import { SpinnerRow } from './components/SpinnerRow.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandPopup, PopupItem } from './components/CommandPopup.js';
import { SchedulesPanel } from './components/SchedulesPanel.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { WebhooksPanel } from './components/webhooks-panel.js';
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
import { AttachmentMeta, formatFileSize, latestTurnAttachments, listPathSuggestions } from './attachments.js';
import { formatShellRecord, runShellCommand, shellCommandOf, type ShellRun } from './shell-command.js';
import type { TerminalGraphics } from './images/terminal-graphics.js';
import type { OpenThread } from './launch.js';

export interface AppProps {
  userId: string;
  agent: { id: string; name: string };
  modelId: string;
  hideCursor?: boolean;
  hideStatusBar?: boolean;
  /** How this terminal draws an image, asked of it at start-up. */
  graphics: TerminalGraphics;
  /**
   * When set (the `--resume` flag), the CLI first shows a picker of these
   * prior threads instead of starting a fresh session. Selecting one resumes
   * it; `cwd` is the launch directory, shown for context.
   */
  resume?: { sessions: ThreadSummary[]; cwd: string };
  /** The conversation the launch flags named (`--resume <id>`), opened with no picker. */
  thread?: OpenThread;
}

/** Input prefix that switches the popup from commands to path suggestions. */
const ATTACH_PREFIX = `${ATTACH_COMMAND} `;

/** How long to wait before asking the runtime again for this session's conversation. */
const THREAD_RETRY_MS = 2_000;

function spinnerLabel(turn: TurnState): string {
  if (turn === 'running') return 'thinking… (esc to stop · enter sends)';
  if (turn === 'queued') return 'waiting for another conversation to finish… (esc to cancel)';
  return 'compacting conversation…';
}

export const App: React.FC<AppProps> = ({ userId, agent, modelId, hideCursor, hideStatusBar, graphics, resume, thread }) => {
  const { exit } = useApp();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // In resume mode, the thread picker owns the screen until the user selects a
  // thread (→ 'chat') or cancels (→ exit). Without `resume` we go straight to chat.
  const [resumePhase, setResumePhase] = useState<'select' | 'chat'>(resume ? 'select' : 'chat');
  // The conversation this session shows: the one created at launch, or the one
  // picked in the --resume picker. Undefined until it exists.
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  // The connection, for the status bar.
  const [status, setStatus] = useState<TuiStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  // What this conversation is doing, as every client of the agent sees it, and how
  // its last turn ended.
  const [lastTurn, setLastTurn] = useState<TurnEventPayload | null>(null);
  const turnState = lastTurn?.state ?? 'idle';
  // The name the runtime gave this connection. A USER message by anyone else shows their name.
  const [self, setSelf] = useState<Viewer | undefined>(undefined);
  // Context-window occupancy for the active thread, pushed by the runtime.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
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
  // The sign-in the agent waits for, until a client answers or dismisses it. Its own
  // state rather than a `PanelId`: no slash command opens it, the request opens it.
  const [signInRequest, setSignInRequest] = useState<SignInRequest | null>(null);
  // The request whose panel this session closed. The agent still waits for it.
  const [closedSignInId, setClosedSignInId] = useState<string | null>(null);
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

  const appendSystemMessage = useCallback((text: string) => {
    setEntries((prev) =>
      appendLocal(prev, {
        id: `system-${randomUUID()}`,
        threadId: '',
        role: 'SYSTEM',
        content: text,
        triggeredBy: 'USER_INPUT',
        toolCalls: null,
        blocks: null,
        createdAt: new Date().toISOString(),
      }),
    );
  }, []);

  // Start a fresh conversation thread on every CLI open, so the TUI opens to a
  // clean slate, or open the agent's one conversation in single-thread mode. Its
  // id is known before anything is sent, so slash commands that need a thread
  // (e.g. /goal) work at once and every message names it. A runtime that is not
  // up yet is asked again until it answers. Skipped in resume mode, where the
  // picked thread is shown instead, and when the launch named a thread.
  useEffect(() => {
    if (resume || thread) return;
    let stopped = false;
    let retry: NodeJS.Timeout | undefined;
    const start = async () => {
      const threadId = await tuiAdapterService.openConversation();
      if (stopped) return;
      if (threadId) {
        setActiveThreadId(threadId);
        return;
      }
      retry = setTimeout(() => void start(), THREAD_RETRY_MS);
    };
    void start();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [userId, agent.id, resume, thread]);

  // Subscribe to the adapter's event bus. Every event here belongs to this
  // session's conversation: the adapter drops the others.
  useEffect(() => {
    const onStatus = (s: TuiStatus, detail?: string) => {
      setStatus(s);
      setStatusDetail(detail);
    };
    const onWelcome = (you: Viewer) => setSelf(you);
    const onHistory = (messages: TuiMessage[]) => setEntries((prev) => withHistory(prev, messages));
    const onMessage = (msg: TuiMessage) => setEntries((prev) => upsertMessage(prev, msg));
    const onTurn = (turn: TurnEventPayload) => {
      // Each reconnect restates an idle conversation without an outcome, which keeps
      // how its last turn ended.
      setLastTurn((prev) =>
        turn.state === 'idle' && !turn.outcome && prev?.state === 'idle' ? prev : turn,
      );
      if (turn.outcome === 'cancelled') appendSystemMessage('⏹ Response stopped');
      if (turn.outcome === 'failed') appendSystemMessage(`⚠ ${turn.error ?? TURN_FAILED_TEXT}`);
    };
    const onSendFailed = (failure: SendFailure) => {
      setEntries((prev) => markFailed(prev, failure.messageId, failure.message));
    };
    const onContextUsage = (usage: ContextUsage) => setContextUsage(usage);
    // The newest request wins: the agent asks for one sign-in at a time, and a
    // second means the first is no longer what it is waiting for.
    const onSignIn = (request: SignInRequest) => setSignInRequest(request);
    const onSignInEnded = (id: string) => setSignInRequest((open) => (open?.id === id ? null : open));
    const onUnsupported = (notice: string) => appendSystemMessage(notice);
    const bus = tuiAdapterService.events;
    bus.on('status', onStatus);
    bus.on('welcome', onWelcome);
    bus.on('history', onHistory);
    bus.on('message', onMessage);
    bus.on('turn', onTurn);
    bus.on('sendFailed', onSendFailed);
    bus.on('contextUsage', onContextUsage);
    bus.on('signIn', onSignIn);
    bus.on('signInEnded', onSignInEnded);
    bus.on('unsupported', onUnsupported);
    return () => {
      bus.off('status', onStatus);
      bus.off('welcome', onWelcome);
      bus.off('history', onHistory);
      bus.off('message', onMessage);
      bus.off('turn', onTurn);
      bus.off('sendFailed', onSendFailed);
      bus.off('contextUsage', onContextUsage);
      bus.off('signIn', onSignIn);
      bus.off('signInEnded', onSignInEnded);
      bus.off('unsupported', onUnsupported);
    };
  }, [appendSystemMessage]);

  // The launch named a thread: show it, as the picker shows a picked one. This effect
  // runs after the subscription above, so the thread's history reaches the transcript.
  useEffect(() => {
    if (!thread) return;
    setActiveThreadId(thread.id);
    void tuiAdapterService.resumeThread(thread.id);
  }, [thread]);

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

  // A compaction is running for the active thread (auto post-turn or /compact).
  // Shown as the spinner-row label — compaction runs outside a chat turn, so
  // the ordinary thinking spinner is idle while it works.
  const compacting = useCompaction(appendSystemMessage);

  useProgramStatus({ turn: lastTurn, compacting, signIn: signInRequest });
  const signInOpen = signInRequest !== null && signInRequest.id !== closedSignInId;

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

  // Resume picker → chat: show the chosen thread. The adapter loads its history
  // (the `history` event) and names the thread on every send, so the turn
  // routes to it without mutating any server-side "latest" pointer.
  const handleResumeSelect = useCallback(
    async (threadId: string) => {
      setActiveThreadId(threadId);
      // Seed from the picker's own row so the status bar shows a percentage
      // before the resumed thread's next turn is measured. Looked up here rather
      // than passed through ResumeList, whose onSelect deliberately only carries
      // the id.
      setContextUsage(resume?.sessions.find((s) => s.id === threadId)?.contextUsage ?? null);
      await tuiAdapterService.resumeThread(threadId);
      setResumePhase('chat');
    },
    [resume],
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
      // Ink reports raw mode as supported only for a TTY stdin.
      const tty = stdin as NodeJS.ReadStream;
      const wasRaw = tty.isRaw === true;
      if (wasRaw) tty.setRawMode(false);
      tty.pause();
      try {
        return await fn();
      } finally {
        tty.resume();
        if (wasRaw) tty.setRawMode(true);
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
      // The /save candidates: the files of the latest turn that delivered any,
      // across all of its messages.
      const recentAttachments = latestTurnAttachments(entries.map((e) => e.message));
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
    // Escape while the conversation is working stops it. A running turn ends
    // in a `turn` event whose outcome draws the marker, whoever stopped it. A
    // queued message is only dropped, which ends with no outcome, so its marker
    // is drawn here.
    if (key.escape && turnState !== 'idle') {
      if (!tuiAdapterService.cancel()) {
        appendSystemMessage('Not connected, so the response could not be stopped.');
        return;
      }
      if (turnState === 'queued') appendSystemMessage('⏹ Response stopped');
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
    isActive: !suspended && activePanel === null && !signInOpen && resumePhase === 'chat',
  });

  // Drawn at once under the id it is sent with. The runtime's copy arrives with
  // the same id and takes this row's place.
  const sendMessage = useCallback(
    (text: string, attachments: AttachmentMeta[]) => {
      const id = randomUUID();
      setEntries((prev) =>
        appendLocal(prev, {
          id,
          threadId: activeThreadId ?? '',
          role: 'USER',
          content: text,
          triggeredBy: 'USER_INPUT',
          toolCalls: null,
          blocks: null,
          createdAt: new Date().toISOString(),
          attachments: attachments.length > 0 ? attachments : null,
        }),
      );
      tuiAdapterService.submitUserMessage({
        id,
        text,
        attachmentIds: attachments.map((a) => a.id),
      });
    },
    [activeThreadId],
  );

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

      // `! <command>` runs in this terminal, and the command with its output
      // goes to the agent as the user's message. Staged files wait for a chat send.
      const shellCommand = shellCommandOf(trimmed);
      if (shellCommand !== null) {
        setInputValue('');
        if (!shellCommand) {
          appendSystemMessage('Type a shell command after !, for example: ! aws sso login');
          return;
        }
        let run: ShellRun;
        try {
          run = await suspendInput(() => runShellCommand(shellCommand));
        } catch (err) {
          appendSystemMessage(`Could not run the command: ${(err as Error).message}`);
          return;
        }
        sendMessage(formatShellRecord(run), []);
        return;
      }

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

      // The draft stays in the composer, so nothing typed is lost.
      if (trimmed.length > MAX_MESSAGE_CHARS) {
        appendSystemMessage(
          `That message has ${trimmed.length} characters. The limit is ${MAX_MESSAGE_CHARS}.`,
        );
        return;
      }

      setInputValue('');
      // Consume staging synchronously so a rapid second Enter can't send the
      // same attachments twice.
      const toSend = staged;
      setStaged([]);
      sendMessage(trimmed, toSend);
    },
    [
      runCommand,
      sendMessage,
      suspendInput,
      staged,
      slashMode,
      filteredCommands,
      acceptHighlightedCommand,
      appendSystemMessage,
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
  // land on top of the editor when state changes underneath it. An open panel
  // stays mounted in a hidden box instead, so a form that opened the editor
  // keeps what was typed into it. The panel turns its own input off.
  if (suspended && activePanel === null) return null;

  // A sign-in waits until the editor returns the terminal, because its input
  // hook would put the tty back in raw mode under the editor. It then covers an
  // open panel, which stays mounted with its input off and keeps its form.
  const showSignIn = signInOpen && !suspended;

  // The key makes React mount a new root Box for the shutdown frame instead of
  // updating this one: Ink hides a Box whose update drops its `display` prop.
  return (
    <Box key="chat" flexDirection="column" paddingX={1} display={suspended ? 'none' : 'flex'}>
      <Header agentName={agent.name} />
      <LlmProviderWarning api={apiClient} />
      {showSignIn && (
        <SignInPanel
          api={apiClient}
          request={signInRequest}
          onClose={() => setClosedSignInId(signInRequest.id)}
        />
      )}
      {activePanel !== null ? (
        <Box flexDirection="column" display={showSignIn ? 'none' : 'flex'}>
          {activePanel === 'schedules' ? (
            <SchedulesPanel api={apiClient} onClose={closePanel} inputActive={!showSignIn} />
          ) : activePanel === 'config' ? (
            <ConfigPanel api={apiClient} onClose={closePanel} inputActive={!showSignIn} />
          ) : (
            <WebhooksPanel
              api={apiClient}
              onClose={closePanel}
              suspendInput={suspendInput}
              inputActive={!showSignIn}
            />
          )}
        </Box>
      ) : showSignIn ? null : (
        <>
          <MessageList
            agentName={agent.name}
            self={self}
            entries={entries}
            expandedMessageId={expandedMessageId}
            graphics={graphics}
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
          <SpinnerRow active={turnState !== 'idle' || compacting} label={spinnerLabel(turnState)} />
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
