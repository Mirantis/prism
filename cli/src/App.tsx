import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { tuiAdapterService, TuiMessage, TuiStatus } from './tui-adapter.js';
import { Header } from './components/Header.js';
import { MessageList, ChatEntry } from './components/MessageList.js';
import { Input } from './components/Input.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandPopup } from './components/CommandPopup.js';
import { filterByPrefix, findExact, SlashCommand } from './commands.js';

export interface AppProps {
  userId: string;
  agent: { id: string; name: string };
  modelId: string;
  hideCursor?: boolean;
  hideStatusBar?: boolean;
}

export const App: React.FC<AppProps> = ({ userId, agent, modelId, hideCursor, hideStatusBar }) => {
  const { exit } = useApp();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
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

  // Replay the active thread's recent messages on mount so reopening the TUI
  // doesn't show a blank screen for an existing conversation. The adapter
  // fetches them from /single-agent/messages on the runtime.
  useEffect(() => {
    let cancelled = false;
    void tuiAdapterService
      .loadHistory({ userId, agentId: agent.id, limit: 50 })
      .then((history) => {
        if (cancelled || history.length === 0) return;
        setEntries((prev) => [
          ...history.map((m) => ({ kind: 'message' as const, message: m })),
          ...prev,
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, agent.id]);

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

  // Keep commandIndex within bounds as the filtered list shrinks/grows.
  useEffect(() => {
    if (commandIndex >= filteredCommands.length) {
      setCommandIndex(0);
    }
  }, [filteredCommands.length, commandIndex]);

  const safeIndex = filteredCommands.length === 0
    ? 0
    : Math.min(commandIndex, filteredCommands.length - 1);

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

  useEffect(() => {
    if (shuttingDown) exit();
  }, [shuttingDown, exit]);

  const runCommand = useCallback(
    async (cmd: SlashCommand) => {
      const lastEntry = entries[entries.length - 1];
      const ctx = {
        lastMessageContent: lastEntry?.message.content ?? null,
        requestShutdown: triggerShutdown,
      };
      const result = await cmd.run(ctx);
      appendSystemMessage(result);
    },
    [entries, appendSystemMessage, triggerShutdown],
  );

  // Ctrl+C / Ctrl+O / Up / Down / Tab handling. ink-text-input v6 explicitly
  // returns early for these keys so they don't conflict with the textbox.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      triggerShutdown();
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
    if (!slashMode || filteredCommands.length === 0) return;
    if (key.upArrow) {
      setCommandIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      return;
    }
    if (key.downArrow) {
      setCommandIndex((i) => (i + 1) % filteredCommands.length);
      return;
    }
    if (key.tab) {
      const chosen = filteredCommands[safeIndex];
      if (chosen) {
        setInputValue(chosen.name + ' ');
        setInputResetKey((k) => k + 1);
      }
    }
  });

  const onSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Slash-command dispatch: if the trimmed value is exactly a registered
      // command, run it locally instead of sending it to the agent.
      if (trimmed.startsWith('/')) {
        const headWord = trimmed.split(/\s+/)[0];
        if (headWord) {
          const cmd = findExact(headWord);
          if (cmd) {
            setInputValue('');
            await runCommand(cmd);
            return;
          }
        }
      }

      setInputValue('');
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
          },
        },
      ]);
      await tuiAdapterService.submitUserMessage({
        userId,
        agentId: agent.id,
        text: trimmed,
      });
    },
    [agent.id, userId, runCommand],
  );

  const handleInputChange = useCallback((newValue: string) => {
    if (swallowNextChangeRef.current) {
      swallowNextChangeRef.current = false;
      return;
    }
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header agentName={agent.name} />
      <MessageList
        agentName={agent.name}
        entries={entries}
        expandedMessageId={expandedMessageId}
      />
      <Input
        key={inputResetKey}
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={onSubmit}
        disabled={inputDisabled}
        hideCursor={hideCursor}
      />
      {slashMode && filteredCommands.length > 0 && (
        <CommandPopup commands={filteredCommands} selectedIndex={safeIndex} />
      )}
      {!hideStatusBar && <StatusBar modelId={modelId} status={status} detail={statusDetail} />}
    </Box>
  );
};
