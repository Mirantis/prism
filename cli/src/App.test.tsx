import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';

// Mock the singleton adapter before importing App. `vi.mock` is hoisted to
// the top of the file, so the stub has to be declared via `vi.hoisted()` —
// which itself runs before module imports, so we require EventEmitter
// inline rather than importing it at the top of this file.
const { adapterStub, apiStub, mockEditText } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    adapterStub: {
      events: new EventEmitter(),
      markConnected: vi.fn(),
      markDisconnected: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue(undefined),
      openConversation: vi.fn().mockResolvedValue('thread-mine'),
      listSessions: vi.fn().mockResolvedValue([]),
      submitUserMessage: vi.fn(),
      cancel: vi.fn().mockReturnValue(true),
    },
    // Panels reach for the apiClient singleton on mount (SchedulesPanel calls
    // listCronTasks, ConfigPanel calls getDetails), so stub it to keep the
    // smoke tests hermetic — no real fetch leaves the process.
    apiStub: {
      listCronTasks: vi.fn().mockResolvedValue([]),
      getDetails: vi.fn().mockResolvedValue({}),
      // The LLM provider warning asks once on mount; a configured provider keeps it hidden.
      getLlmProvider: vi.fn().mockResolvedValue({ provider: 'bedrock', missingSettings: [] }),
      createGoal: vi.fn().mockResolvedValue({ objective: 'x', maxTurns: 100 }),
      getThreadGoal: vi.fn().mockResolvedValue(null),
      uploadAttachment: vi.fn().mockResolvedValue({
        id: 'att-1',
        filename: 'report.txt',
        mediaType: 'text/plain',
        sizeBytes: 2048,
        category: 'text',
      }),
      deleteAttachment: vi.fn().mockResolvedValue({ success: true }),
      // useUpdateNotice fetches this once on mount; a disabled report keeps
      // the status-bar hint off in these smoke tests.
      updateStatus: vi.fn().mockResolvedValue({
        enabled: false,
        reason: 'not_sea_install',
        currentVersion: '',
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        applying: false,
        lastAttempt: null,
      }),
      applyUpdate: vi.fn().mockResolvedValue({ ok: true, version: 'v2026.1.1000000' }),
      listSlackChannels: vi.fn().mockResolvedValue([]),
      listWebhookSubscriptions: vi.fn().mockResolvedValue([
        {
          id: 'wh-1',
          name: 'alerts',
          description: null,
          events: null,
          prompt: 'Alert: {status}',
          deliverTo: 'all',
          deliverOnly: false,
          isActive: true,
          authType: 'none',
        },
      ]),
    },
    mockEditText: vi.fn(),
  };
});

vi.mock('./tui-adapter.js', () => ({
  tuiAdapterService: adapterStub,
}));

vi.mock('./api-client.js', () => ({
  apiClient: apiStub,
  // Re-export ApiError so the panels' `instanceof ApiError` checks compile.
  ApiError: class ApiError extends Error {},
}));

vi.mock('./editor.js', () => ({
  editText: mockEditText,
  resolveEditor: () => 'test-editor',
}));

import { App } from './App.js';

const baseProps = {
  userId: 'local',
  agent: { id: 'remote', name: 'Prism' },
  modelId: 'us.anthropic.claude-opus-4-7',
  graphics: { protocol: 'text', cell: null },
} as const;

describe('App', () => {
  beforeEach(() => {
    adapterStub.events.removeAllListeners();
    adapterStub.markConnected.mockClear();
    adapterStub.markDisconnected.mockClear();
    adapterStub.resumeThread.mockReset();
    adapterStub.resumeThread.mockResolvedValue(undefined);
    adapterStub.openConversation.mockReset();
    adapterStub.openConversation.mockResolvedValue('thread-mine');
    adapterStub.listSessions.mockClear();
    adapterStub.submitUserMessage.mockClear();
    apiStub.listCronTasks.mockClear();
    apiStub.getDetails.mockClear();
    apiStub.createGoal.mockClear();
    apiStub.getThreadGoal.mockClear();
    apiStub.uploadAttachment.mockClear();
    apiStub.deleteAttachment.mockClear();
    adapterStub.cancel.mockReset();
    adapterStub.cancel.mockReturnValue(true);
  });

  /** Let Ink settle: an adapter event and the frame it causes are more than one macrotask apart. */
  const settle = async (times = 3) => {
    for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
  };

  const turn = (state: 'queued' | 'running' | 'idle', extra: Record<string, unknown> = {}) =>
    adapterStub.events.emit('turn', { threadId: 'thread-mine', state, ...extra });

  const stored = (overrides: Record<string, unknown>) => ({
    id: 'm1',
    threadId: 'thread-mine',
    role: 'AGENT',
    content: 'stored',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    createdAt: new Date().toISOString(),
    senderName: null,
    ...overrides,
  });

  it('renders the header, input box, and status bar on mount', () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    const frame = lastFrame() ?? '';
    // Header: "chat with <agentName>" hint
    expect(frame).toContain('chat with Prism');
    // Input box: ›-prefixed prompt
    expect(frame).toContain('›');
    // StatusBar: prettified model id
    expect(frame).toContain('Opus 4.7');
    unmount();
  });

  it('marks the adapter connected with the userId on mount', () => {
    const { unmount } = render(<App {...baseProps} userId="alice" />);
    expect(adapterStub.markConnected).toHaveBeenCalledWith('alice');
    unmount();
  });

  describe('context indicator wiring', () => {
    // The gap these close: StatusBar and the adapter's frame coercion were each
    // covered in isolation, but nothing exercised adapter event -> App state ->
    // StatusBar. A bug anywhere in that seam (missed subscription, an over-eager
    // threadId filter) would have shipped invisible, and the PTY e2e that would
    // have caught it can't run on every dev machine.
    const usage = (overrides: Record<string, unknown> = {}) => ({
      threadId: 'thread-1',
      modelId: 'us.anthropic.claude-opus-5',
      usedTokens: 580_000,
      windowTokens: 1_000_000,
      usedPercent: 58,
      ...overrides,
    });

    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };

    it('shows no percentage until a frame arrives', () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      expect(lastFrame() ?? '').not.toContain('context');
      unmount();
    });

    it('renders a context frame from the adapter in the status bar', async () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      await flush();

      adapterStub.events.emit('contextUsage', usage());
      await flush();

      expect(lastFrame() ?? '').toContain('| context 58%');
      unmount();
    });

    it('prefers the model the runtime reports over the local settings copy', async () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      await flush();

      adapterStub.events.emit('contextUsage', usage({ modelId: 'us.anthropic.claude-haiku-4-5' }));
      await flush();

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Haiku 4.5');
      expect(frame).not.toContain('Opus 4.7');
      unmount();
    });
  });

  it('opens the session\'s conversation on mount', () => {
    const { unmount } = render(<App {...baseProps} />);
    expect(adapterStub.openConversation).toHaveBeenCalledTimes(1);
    // The adapter opens it: no picked thread is resumed.
    expect(adapterStub.resumeThread).not.toHaveBeenCalled();
    unmount();
  });

  it('asks for the conversation again while the runtime cannot make one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    adapterStub.openConversation.mockResolvedValueOnce(undefined);
    const { unmount } = render(<App {...baseProps} />);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(adapterStub.openConversation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(adapterStub.openConversation).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('shows the in-flight row while the turn is running', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    turn('running');
    await settle();
    expect(lastFrame() ?? '').toContain('thinking');
    unmount();
  });

  it('shows that a queued message is waiting', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    turn('queued');
    await settle();
    expect(lastFrame() ?? '').toContain('waiting for another conversation');
    unmount();
  });

  it('keeps the spinner through a reply, and clears it only when the turn goes idle', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    try {
      turn('running');
      adapterStub.events.emit('message', stored({ content: 'first step done' }));
      await settle();
      expect(lastFrame() ?? '').toContain('first step done');
      expect(lastFrame() ?? '').toContain('thinking');

      turn('idle', { outcome: 'completed' });
      await settle();
      expect(lastFrame() ?? '').not.toContain('thinking');
    } finally {
      unmount();
    }
  });

  it('shows why a turn failed', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    turn('running');
    turn('idle', { outcome: 'failed', error: 'The model is not available.' });
    await settle();
    expect(lastFrame() ?? '').toContain('The model is not available.');
    unmount();
  });

  it('draws a sent message at once, and takes the stored copy in its place', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      await settle();
      stdin.write('hello-once');
      await settle();
      stdin.write('\r');
      await settle();

      const [{ id }] = adapterStub.submitUserMessage.mock.calls[0] as [{ id: string }];
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      adapterStub.events.emit('message', stored({ id, role: 'USER', content: 'hello-once' }));
      await settle();

      expect((lastFrame() ?? '').split('hello-once')).toHaveLength(2);
    } finally {
      unmount();
    }
  });

  it('says a message was not sent when the runtime refuses it', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      stdin.write('refused-one');
      await settle();
      stdin.write('\r');
      await settle();

      const [{ id }] = adapterStub.submitUserMessage.mock.calls[0] as [{ id: string }];
      adapterStub.events.emit('sendFailed', { messageId: id, code: 'failed', message: 'It could not be stored.' });
      await settle();

      expect(lastFrame() ?? '').toContain('not sent: It could not be stored.');
    } finally {
      unmount();
    }
  });

  it('labels a message by someone else in the conversation with their name', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('welcome', { id: 'grace@example.com', name: 'grace@example.com' });
      adapterStub.events.emit('message', stored({ id: 'u1', role: 'USER', content: 'from the web', senderId: 'ada@example.com', senderName: 'ada@example.com' }));
      adapterStub.events.emit('message', stored({ id: 'u2', role: 'USER', content: 'from here', senderId: 'grace@example.com', senderName: 'grace@example.com' }));
      await settle();

      const frame = lastFrame() ?? '';
      expect(frame).toContain('▌ ada@example.com');
      expect(frame).toContain('▌ You');
    } finally {
      unmount();
    }
  });

  it('replaces the stored messages with a reloaded history, keeping its own notices', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('message', stored({ id: 'old', content: 'compacted-away' }));
      turn('idle', { outcome: 'failed', error: 'a-local-notice' });
      await settle();
      expect(lastFrame() ?? '').toContain('a-local-notice');

      adapterStub.events.emit('history', [stored({ id: 'new', content: 'summary-tail' })]);
      await settle();

      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('compacted-away');
      expect(frame).toContain('summary-tail');
      expect(frame).toContain('a-local-notice');
    } finally {
      unmount();
    }
  });

  it('tells the person to update when the runtime refuses this protocol', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    adapterStub.events.emit('unsupported', 'Update prism-cli, then start it again.');
    adapterStub.events.emit('status', 'error', 'update prism-cli');
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Update prism-cli, then start it again.');
    expect(frame).toContain('error: update prism-cli');
    unmount();
  });

  it('keeps the composer live while thinking, so typing still lands in it', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      turn('running');
      await new Promise((r) => setImmediate(r));

      stdin.write('wait, not that');
      await new Promise((r) => setImmediate(r));

      // The draft is visible in the composer even though a turn is running.
      expect(lastFrame() ?? '').toContain('wait, not that');
    } finally {
      unmount();
    }
  });

  it('sends a message typed while the agent is responding', async () => {
    // The whole point of the mid-turn composer: Enter hands the message to the
    // runtime, which folds it into the turn already running on the thread.
    const { stdin, unmount } = render(<App {...baseProps} />);
    try {
      turn('running');
      await new Promise((r) => setImmediate(r));

      stdin.write('actually, skip the tests');
      await new Promise((r) => setImmediate(r));
      stdin.write('\r');
      await new Promise((r) => setImmediate(r));

      expect(adapterStub.submitUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'actually, skip the tests' }),
      );
    } finally {
      unmount();
    }
  });

  it('does not leak an "o" into the draft on the first Ctrl+O of a session', async () => {
    // Ink dispatches useInput handlers child-before-parent, so the composer sees
    // a chord before App does. Our vendored TextInput ignores every Ctrl chord
    // (components/TextInput.tsx); ink-text-input only filtered Ctrl+C, which put
    // a literal 'o' in the value — and this is a *fresh* mount, the case no
    // remount can mask.
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      stdin.write('\x0f'); // Ctrl+O
      await new Promise((r) => setImmediate(r));
      stdin.write('hi');
      await new Promise((r) => setImmediate(r));

      const frame = lastFrame() ?? '';
      expect(frame).toContain('hi');
      // Neither the leaked character nor a swallowed first keystroke.
      expect(frame).not.toContain('ohi');
      expect(frame).not.toContain('oi');
    } finally {
      unmount();
    }
  });

  // ink holds a lone trailing ESC for ~20ms (pendingInputFlushDelayMilliseconds)
  // to disambiguate it from a multi-byte escape sequence before emitting it as
  // a standalone Escape keypress. Wait past that window, then let React commit.
  const pressEscape = async (stdin: { write: (data: string) => void }) => {
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => setImmediate(r));
  };

  it('cancels the running turn on Escape, and marks it stopped when the turn ends so', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      turn('running');
      await settle();
      expect(lastFrame() ?? '').toContain('thinking');

      await pressEscape(stdin);
      expect(adapterStub.cancel).toHaveBeenCalled();

      turn('idle', { outcome: 'cancelled' });
      await settle();
      expect(lastFrame() ?? '').toContain('Response stopped');
      expect(lastFrame() ?? '').not.toContain('thinking');
    } finally {
      unmount();
    }
  });

  it('marks a queued message stopped at once on Escape', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      turn('queued');
      await settle();

      await pressEscape(stdin);

      expect(adapterStub.cancel).toHaveBeenCalled();
      expect(lastFrame() ?? '').toContain('Response stopped');
    } finally {
      unmount();
    }
  });

  it('marks a turn stopped from another device', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    turn('running');
    turn('idle', { outcome: 'cancelled' });
    await settle();
    expect(lastFrame() ?? '').toContain('Response stopped');
    unmount();
  });

  it('ignores Escape when the agent is idle (nothing to cancel)', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    try {
      await pressEscape(stdin); // Escape while idle
      expect(adapterStub.cancel).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('hides the status bar when hideStatusBar is true', () => {
    const { lastFrame, unmount } = render(<App {...baseProps} hideStatusBar />);
    expect(lastFrame() ?? '').not.toContain('Opus 4.7');
    unmount();
  });

  it('draws the shutdown frame when /exit is submitted', async () => {
    const { frames, stdin, unmount } = render(<App {...baseProps} />);
    await settle();
    // The trailing space closes the slash popup, so one Enter runs the command.
    stdin.write('/exit ');
    await settle();
    stdin.write('\r');
    await settle(5);
    expect(frames.some((frame) => frame.includes('Shutting down'))).toBe(true);
    unmount();
  });

  it('opens the schedules panel when /schedules is submitted', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    // Type the command, let ink-text-input commit the value into App state,
    // then submit with a carriage return. Splitting the writes (with a flush
    // between) mirrors real typing and ensures onSubmit sees the full value.
    stdin.write('/schedules');
    await flush();
    // The popup is open, so the first Enter accepts "/schedules " into the
    // composer (as Tab does) and the second one runs it.
    stdin.write('\r');
    await flush();
    stdin.write('\r');
    // Let the command's async run() resolve and React flush, then let the
    // panel's mount fetch (listCronTasks) settle into the ready frame.
    await flush();
    await flush();
    await flush();
    const frame = lastFrame() ?? '';
    // Panel header replaces the chat surface.
    expect(frame).toContain('Schedules');
    expect(apiStub.listCronTasks).toHaveBeenCalled();
    unmount();
  });

  it('keeps the webhook form through a sign-in that arrives while the editor is open', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    let closeEditor: (text: string) => void = () => {};
    mockEditText.mockImplementation(
      () =>
        new Promise((resolve) => {
          closeEditor = (text) => resolve({ text, changed: true, file: '/tmp/p/d.md', discard: vi.fn() });
        }),
    );
    await settle();
    stdin.write('/webhooks ');
    await settle();
    stdin.write('\r');
    await settle(5);
    expect(lastFrame()).toContain('alerts');

    // Edit the selected webhook and open its prompt, the fifth row, in the editor.
    for (const key of ['\r', '\t', '\t', '\t', '\t', ' ']) {
      stdin.write(key);
      await settle(1);
    }
    await settle();
    expect(mockEditText).toHaveBeenCalledWith('Alert: {status}', { suffix: '.md' });

    adapterStub.events.emit('signIn', { id: 'sign-in-1', reason: 'The dashboard asks for a sign-in.' });
    await settle();
    expect(lastFrame()).not.toContain('Prism needs a sign-in');

    closeEditor('Edited: {status}');
    await settle(5);
    expect(lastFrame()).toContain('Prism needs a sign-in');
    expect(lastFrame()).not.toContain('Edit webhook alerts');

    // Esc closes the sign-in alone; the form under it keeps the edited prompt.
    await pressEscape(stdin);
    await settle();
    expect(lastFrame()).not.toContain('Prism needs a sign-in');
    expect(lastFrame()).toContain('Edit webhook alerts');
    expect(lastFrame()).toContain('Edited: {status}');
    unmount();
  });

  it('Enter accepts the highlighted command instead of sending or running it', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    stdin.write('/');
    await flush();
    stdin.write('\x1B[B'); // Down → second row, /schedules
    await flush();
    stdin.write('\r');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/schedules '); // accepted into the composer
    expect(frame).not.toContain('/copy'); // popup closed (it listed /copy)
    expect(adapterStub.submitUserMessage).not.toHaveBeenCalled(); // nothing sent
    expect(apiStub.listCronTasks).not.toHaveBeenCalled(); // nothing run
    unmount();
  });

  it('/goal works on a fresh session with no prior message (thread pinned from startup)', async () => {
    // The fresh-launch session creates a thread server-side; the CLI pins its
    // id so /goal has a thread immediately, without sending a message first.
    adapterStub.openConversation.mockResolvedValueOnce('thread-startup');
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await flush(); // let openConversation().then(pin) settle
    await flush();
    stdin.write('/goal make the tests pass');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();
    expect(apiStub.createGoal).toHaveBeenCalledWith({
      threadId: 'thread-startup',
      objective: 'make the tests pass',
    });
    expect(lastFrame() ?? '').not.toContain('Start a conversation');
    unmount();
  });

  // Command-history recall. /copy is a clean probe: it isn't echoed as a user
  // message, and its result ("No message to copy yet.") doesn't contain the
  // command text — so "/copy" in a frame means it's sitting in the input.
  const submitCopy = async (
    stdin: { write: (data: string) => void },
    flush: () => Promise<unknown>,
  ) => {
    stdin.write('/copy');
    await flush();
    // The popup is open, so the first Enter accepts "/copy " into the composer
    // (as Tab does) and the second one runs it.
    stdin.write('\r');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();
  };

  it('recalls the last submission when Up is pressed on an empty input', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await submitCopy(stdin, flush);
    expect(lastFrame() ?? '').not.toContain('/copy');

    stdin.write('\x1B[A'); // Up
    await flush();
    expect(lastFrame() ?? '').toContain('/copy');
    unmount();
  });

  it('recalls history from a draft and brings the draft back with Down', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    stdin.write('gamma-msg');
    await flush();
    stdin.write('\r');
    await flush();

    stdin.write('half-typed');
    await flush();
    stdin.write('\x1B[A'); // Up on the only row → recall
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(2); // message list + input
    expect(lastFrame() ?? '').not.toContain('half-typed');

    stdin.write('\x1B[B'); // Down past the newest → the draft comes back
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(1);
    expect(lastFrame() ?? '').toContain('half-typed');
    unmount();
  });

  it('moves up through a multi-row draft before it recalls history', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    stdin.write('gamma-msg');
    await flush();
    stdin.write('\r');
    await flush();

    for (const key of ['first-row', '\n', 'second-row']) {
      // '\n' is Ctrl+J, which the composer keeps as a newline.
      stdin.write(key);
      await flush();
    }
    stdin.write('\x1B[A'); // Up from the second row → first row, no recall
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(1);
    expect(lastFrame() ?? '').toContain('second-row');

    stdin.write('\x1B[A'); // Up on the first row → recall
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(2);
    expect(lastFrame() ?? '').not.toContain('second-row');

    stdin.write('\x1B[B'); // Down past the newest → the draft comes back
    await flush();
    const frame = lastFrame() ?? '';
    expect(count(frame, 'gamma-msg')).toBe(1);
    expect(frame).toMatch(/first-row[^\n]*\n[^\n]*second-row/);
    unmount();
  });

  it('brings the draft back with Down from a recalled slash command', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await submitCopy(stdin, flush);

    stdin.write('half-typed');
    await flush();
    stdin.write('\x1B[A'); // Up → "/copy", which opens the popup
    await flush();
    expect(lastFrame() ?? '').toContain('/copy');
    expect(lastFrame() ?? '').not.toContain('half-typed');

    stdin.write('\x1B[B'); // Down is the history walk's, not the popup's
    await flush();
    expect(lastFrame() ?? '').toContain('half-typed');
    expect(lastFrame() ?? '').not.toContain('/copy');
    unmount();
  });

  it('walks Up past a recalled slash command', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    stdin.write('gamma-msg');
    await flush();
    stdin.write('\r');
    await flush();
    await submitCopy(stdin, flush);

    stdin.write('\x1B[A'); // Up → "/copy"
    await flush();
    stdin.write('\x1B[A'); // Up → "gamma-msg", not a popup row
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(2); // message list + input
    unmount();
  });

  it('gives Up and Down back to the popup after Tab completes a recalled path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-walk-'));
    fs.mkdirSync(path.join(dir, 'alpha', 'one'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'alpha', 'two'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'beta'));
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = async (times = 4) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    try {
      stdin.write(`/attach ${dir}/`);
      await flush();
      stdin.write('\r'); // history now holds the /attach line
      await flush();

      stdin.write('draft-x');
      await flush();
      stdin.write('\x1B[A'); // Up → the /attach line, popup lists alpha and beta
      await flush();
      stdin.write('\t'); // Tab → into alpha, popup lists one and two
      await flush();
      stdin.write('\x1B[B'); // Down moves the selection, not back to the draft
      await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('alpha/');
      expect(frame).not.toContain('draft-x');
    } finally {
      unmount();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the input when Down goes past the newest entry', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    // A plain chat message (not a slash command) so recall doesn't open the
    // command popup, which would otherwise capture the Down key.
    stdin.write('gamma-msg');
    await flush();
    stdin.write('\r');
    await flush();

    stdin.write('\x1B[A'); // Up → recall into the input
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(2); // message list + input

    stdin.write('\x1B[B'); // Down → past the newest, clears the input
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(1); // message list only
    unmount();
  });

  it('walks back through multiple entries with repeated Up', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    for (const msg of ['alpha-msg', 'beta-msg']) {
      stdin.write(msg);
      await flush();
      stdin.write('\r');
      await flush();
    }
    stdin.write('\x1B[A'); // Up → newest (beta-msg)
    await flush();
    stdin.write('\x1B[A'); // Up → older (alpha-msg)
    await flush();
    // alpha-msg now appears twice: once in the message list, once in the input.
    expect(count(lastFrame() ?? '', 'alpha-msg')).toBeGreaterThanOrEqual(2);
    unmount();
  });

  // ---- /attach staging flow ----

  const flushAll = async (n = 4) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  const attachFile = async (stdin: { write: (data: string) => void }) => {
    stdin.write('/attach /tmp/report.txt');
    await flushAll();
    stdin.write('\r');
    await flushAll();
  };

  it('/attach uploads the file and renders the staged chip line', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    expect(apiStub.uploadAttachment).toHaveBeenCalledWith('/tmp/report.txt');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('📎 report.txt (2.0 KB)');
    expect(frame).toContain('/detach to remove');
    unmount();
  });

  it('the next message carries the staged attachmentIds and clears the chips', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    stdin.write('summarize this');
    await flushAll();
    stdin.write('\r');
    await flushAll();

    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      id: expect.any(String),
      text: 'summarize this',
      attachmentIds: ['att-1'],
    });
    // Chips line is gone; the optimistic user row shows the 📎 suffix instead.
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('/detach to remove');
    expect(frame).toContain('· 📎 report.txt (2.0 KB)');
    unmount();
  });

  it('a bare Enter with staged files sends a file-only message', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    stdin.write('\r'); // empty input, staged file present
    await flushAll();

    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      id: expect.any(String),
      text: '',
      attachmentIds: ['att-1'],
    });
    unmount();
  });

  it('a bare Enter with nothing staged sends nothing', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    stdin.write('\r');
    await flushAll();
    expect(adapterStub.submitUserMessage).not.toHaveBeenCalled();
    unmount();
  });

  // ---- --resume flow ----

  const resumeSessions = [
    {
      id: 'thread-alpha',
      title: null,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      workspaceRoot: '/home/me/.claude/worktrees/ability-to-cancel',
      branch: 'worktree/ability-to-cancel',
      contextUsage: {
        threadId: 'thread-alpha',
        modelId: 'us.anthropic.claude-opus-5',
        usedTokens: 300_000,
        windowTokens: 1_000_000,
        usedPercent: 30,
      },
    },
    {
      id: 'thread-beta',
      title: null,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      workspaceRoot: null,
      branch: null,
      contextUsage: null,
    },
  ];
  const resumeProps = { ...baseProps, resume: { sessions: resumeSessions, cwd: '/home/me/cwd' } };

  it('shows the resume picker first and does NOT start a fresh session', () => {
    const { lastFrame, unmount } = render(<App {...resumeProps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume session (1 of 2)');
    expect(frame).toContain('/home/me/cwd');
    expect(frame).toContain('ability-to-cancel (worktree/ability-to-cancel)');
    // Picker owns the screen — the chat surface isn't rendered yet.
    expect(frame).not.toContain('chat with Prism');
    expect(adapterStub.openConversation).not.toHaveBeenCalled();
    unmount();
  });

  it('resumes the highlighted thread on Enter and replays its history', async () => {
    adapterStub.resumeThread.mockImplementationOnce(async () => {
      adapterStub.events.emit('history', [
        {
          id: 'm1',
          threadId: 'thread-alpha',
          role: 'AGENT',
          content: 'earlier reply',
          triggeredBy: 'USER_INPUT',
          toolCalls: null,
          blocks: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    });
    const { lastFrame, stdin, unmount } = render(<App {...resumeProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    stdin.write('\r'); // Enter selects the first (highlighted) session
    await flush();
    await flush();

    // The adapter shows the picked thread: its history, and every send names it.
    expect(adapterStub.resumeThread).toHaveBeenCalledWith('thread-alpha');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('chat with Prism'); // chat surface now showing
    expect(frame).toContain('earlier reply'); // replayed history

    stdin.write('continue please');
    await flush();
    stdin.write('\r');
    await flush();
    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      id: expect.any(String),
      text: 'continue please',
      attachmentIds: [],
    });
    expect(adapterStub.openConversation).not.toHaveBeenCalled();
    unmount();
  });

  it('dismisses the picker without resuming anything when Escape is pressed', async () => {
    // Escape triggers a clean shutdown (the e2e asserts the actual exit code 0);
    // here we verify the picker is dismissed and no history was loaded.
    const { lastFrame, stdin, unmount } = render(<App {...resumeProps} />);
    await pressEscape(stdin);
    expect(adapterStub.resumeThread).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').not.toContain('Resume session');
    unmount();
  });

  describe('terminal status', () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    let written: string[];

    beforeEach(() => {
      written = [];
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      vi.mocked(process.stdout.write).mockRestore();
      if (isTTY) Object.defineProperty(process.stdout, 'isTTY', isTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    });

    /** Every OSC 7501 report written so far, with `msg` decoded. */
    const reports = () =>
      written.flatMap((chunk) => {
        if (!chunk.startsWith('\x1b]7501;') || !chunk.endsWith('\x1b\\')) return [];
        const body = chunk.slice('\x1b]7501;'.length, -2);
        const pairs = Object.fromEntries(
          body.split(':').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
        );
        if (pairs.msg !== undefined) pairs.msg = Buffer.from(pairs.msg, 'base64').toString('utf8');
        return [pairs];
      });

    it('reports each change of the session state once, and clears it on exit', async () => {
      const { unmount } = render(<App {...baseProps} />);
      await settle();
      turn('running');
      await settle();
      turn('running');
      await settle();
      turn('idle', { outcome: 'completed' });
      await settle();
      unmount();

      expect(reports()).toEqual([
        { state: 'idle', app: 'prism' },
        { state: 'working', app: 'prism', msg: 'Thinking' },
        { state: 'done', app: 'prism', msg: 'Reply ready' },
        { state: 'clear' },
      ]);
    });

    it('keeps a done report when a reconnect restates the idle conversation', async () => {
      const { unmount } = render(<App {...baseProps} />);
      try {
        turn('running');
        turn('idle', { outcome: 'completed' });
        await settle();
        turn('idle');
        await settle();
        expect(reports().at(-1)).toEqual({ state: 'done', app: 'prism', msg: 'Reply ready' });
      } finally {
        unmount();
      }
    });

    it('reports a sign-in as blocked after its panel is closed, until the request ends', async () => {
      const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
      try {
        turn('running');
        adapterStub.events.emit('signIn', { id: 'sign-in-1', reason: 'The dashboard asks for a sign-in.' });
        await settle();
        expect(reports().at(-1)).toEqual({
          state: 'blocked',
          kind: 'auth',
          app: 'prism',
          msg: 'The dashboard asks for a sign-in.',
        });

        await pressEscape(stdin);
        await settle();
        expect(lastFrame()).not.toContain('Prism needs a sign-in');
        expect(reports().at(-1)).toMatchObject({ state: 'blocked', kind: 'auth' });

        // A reload restates the request that still waits. The panel stays closed.
        adapterStub.events.emit('signIn', { id: 'sign-in-1', reason: 'The dashboard asks for a sign-in.' });
        await settle();
        expect(lastFrame()).not.toContain('Prism needs a sign-in');

        stdin.write('typed after closing');
        await settle();
        expect(lastFrame()).toContain('typed after closing');

        adapterStub.events.emit('signInEnded', 'sign-in-1');
        await settle();
        expect(reports().at(-1)).toEqual({ state: 'working', app: 'prism', msg: 'Thinking' });
      } finally {
        unmount();
      }
    });

    it('ends the blocked report when the sign-in is answered in another client', async () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      try {
        turn('running');
        adapterStub.events.emit('signIn', { id: 'sign-in-1', reason: 'The dashboard asks for a sign-in.' });
        turn('idle', { outcome: 'completed' });
        await settle();
        expect(reports().at(-1)).toMatchObject({ state: 'blocked', kind: 'auth' });

        adapterStub.events.emit('signInEnded', 'sign-in-1');
        await settle();
        expect(lastFrame()).not.toContain('Prism needs a sign-in');
        expect(reports().at(-1)).toEqual({ state: 'done', app: 'prism', msg: 'Reply ready' });
      } finally {
        unmount();
      }
    });

    it('reports a failed turn as an error and a cancelled one as idle', async () => {
      const { unmount } = render(<App {...baseProps} />);
      try {
        turn('running');
        turn('idle', { outcome: 'failed', error: 'The agent could not answer. Try again.' });
        await settle();
        expect(reports().at(-1)).toEqual({
          state: 'error',
          app: 'prism',
          msg: 'The agent could not answer. Try again.',
        });

        turn('running');
        await settle();
        turn('idle', { outcome: 'cancelled' });
        await settle();
        expect(reports().at(-1)).toEqual({ state: 'idle', app: 'prism' });
      } finally {
        unmount();
      }
    });

    it('reports a compaction and a queued message as work', async () => {
      const { unmount } = render(<App {...baseProps} />);
      try {
        adapterStub.events.emit('compaction', { threadId: 'thread-mine', status: 'started', trigger: 'manual' });
        await settle();
        expect(reports().at(-1)).toEqual({ state: 'working', app: 'prism', msg: 'Compacting the conversation' });

        adapterStub.events.emit('compaction', { threadId: 'thread-mine', status: 'completed', trigger: 'manual' });
        turn('queued');
        await settle();
        expect(reports().at(-1)).toEqual({
          state: 'working',
          app: 'prism',
          msg: 'Waiting for another conversation to finish',
        });
      } finally {
        unmount();
      }
    });

    it('writes nothing when stdout is not a terminal', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const { unmount } = render(<App {...baseProps} />);
      turn('running');
      await settle();
      unmount();

      expect(reports()).toEqual([]);
    });
  });
});
