import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { tuiAdapterService, ThreadSummary, TuiMessage, TuiStatus } from './tui-adapter.js';
import { Header } from './components/Header.js';
import { MessageList, ChatEntry } from './components/MessageList.js';
import { Input } from './components/Input.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandPopup, PopupItem } from './components/CommandPopup.js';
import { SchedulesPanel } from './components/SchedulesPanel.js';
import { ConfigPanel } from './components/ConfigPanel.js';
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
  const [shuttingDown, setShuttingDown] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  // Bumped on Tab autocomplete to force <Input> to remount, which is the only
  // way to move ink-text-input's internal cursor to the end of the new value
  // — the library otherwise keeps the previous offset.
  const [inputResetKey, setInputResetKey] = useState(0);
  // Tracks which agent message currently has its tool-call details expanded
  // inline. Only one message can be expanded at a time; Ctrl+O toggles the
  // latest agent message that has tool calls.
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  // When non-null, a full-screen panel replaces the chat surface (MessageList +
  // Input + popup). Panel commands set this via openPanel; the panels call
  // closePanel (wired to onClose) to return to chat.
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  // Files staged by /attach, sent with (and cleared by) the next chat message.
  const [staged, setStaged] = useState<AttachmentMeta[]>([]);
  // Submitted-input history for Up/Down recall (oldest → newest). historyIndex
  // is null when not browsing; otherwise it's the index of the entry currently
  // shown in the input. Up enters history only from an empty input, then walks
  // to older entries; editing the input exits browsing.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // Swallow the next onChange from <Input>. ink-text-input does not filter
  // Ctrl-modifier keys other than Ctrl+C, so Ctrl+O would otherwise append
  // 'o' to the input value via its own useInput → onChange path. We set the
  // flag in the App-level useInput (which fires first) and consume the
  // following onChange before it reaches setInputValue.
  const swallowNextChangeRef = useRef(false);

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
    void tuiAdapterService.startNewSession();
  }, [userId, agent.id, resume]);

  // Subscribe to adapter event bus.
  useEffect(() => {
    const onMessage = (msg: TuiMessage) => {
      setEntries((prev) => [...prev, { kind: 'message', message: msg }]);
    };
    const onStatus = (s: TuiStatus, detail?: string) => {
      setStatus(s);
      setStatusDetail(detail);
    };
    tuiAdapterService.events.on('message', onMessage);
    tuiAdapterService.events.on('status', onStatus);
    return () => {
      tuiAdapterService.events.off('message', onMessage);
      tuiAdapterService.events.off('status', onStatus);
    };
  }, []);

  // Slash-command popup: visible while the input starts with '/' and no space
  // has been typed yet. After Tab autocompletes (which appends a space), the
  // popup hides and the user is free to type arguments.
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
      const messages = await tuiAdapterService.loadHistory({ userId, agentId: agent.id, threadId });
      setEntries(messages.map((message) => ({ kind: 'message' as const, message })));
      setResumePhase('chat');
    },
    [userId, agent.id],
  );

  // Escape in the picker exits the CLI (clean shutdown → exit code 0).
  const handleResumeCancel = useCallback(() => {
    triggerShutdown();
  }, [triggerShutdown]);

  useEffect(() => {
    if (shuttingDown) exit();
  }, [shuttingDown, exit]);

  const openPanel = useCallback((id: PanelId) => setActivePanel(id), []);
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
        recentAttachments,
        stagedAttachments: staged,
        stageAttachment,
        clearStagedAttachments,
      };
      const result = await cmd.run(ctx);
      // Panel commands return '' (the panel is their output); only surface a
      // synthetic SYSTEM message when there's actual text to show.
      if (result) appendSystemMessage(result);
    },
    [entries, appendSystemMessage, triggerShutdown, openPanel, staged, stageAttachment, clearStagedAttachments],
  );

  // Ctrl+C must work everywhere, including while a panel owns the screen, so
  // it lives in its own always-active hook that handles nothing else.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') triggerShutdown();
    },
    { isActive: true },
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
      // Block ink-text-input from appending 'o' to the value as it processes
      // the same keypress, and remount Input so its internal cursor offset
      // doesn't drift past the (unchanged) value.
      swallowNextChangeRef.current = true;
      setInputResetKey((k) => k + 1);
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
          const chosen = filteredCommands[safeIndex];
          if (chosen) {
            setInputValue(chosen.name + ' ');
            setInputResetKey((k) => k + 1);
          }
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
  }, { isActive: activePanel === null && resumePhase === 'chat' });

  const onSubmit = useCallback(
    async (text: string) => {
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
    [agent.id, userId, runCommand, staged, activeThreadId],
  );

  const handleInputChange = useCallback((newValue: string) => {
    if (swallowNextChangeRef.current) {
      swallowNextChangeRef.current = false;
      return;
    }
    // Real typing exits history browsing — programmatic recalls set the value
    // directly and never route through onChange, so they keep the cursor.
    setHistoryIndex(null);
    setInputValue(newValue);
  }, []);

  const inputDisabled = useMemo(() => status === 'thinking', [status]);

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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header agentName={agent.name} />
      {activePanel === 'schedules' ? (
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
          <Input
            key={inputResetKey}
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={onSubmit}
            disabled={inputDisabled}
            hideCursor={hideCursor}
          />
          {(slashMode || attachMode) && popupItems.length > 0 && (
            <CommandPopup items={popupItems} selectedIndex={safeIndex} />
          )}
        </>
      )}
      {!hideStatusBar && <StatusBar modelId={modelId} status={status} detail={statusDetail} />}
    </Box>
  );
};
