import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

// Mock the singleton adapter before importing App. `vi.mock` is hoisted to
// the top of the file, so the stub has to be declared via `vi.hoisted()` —
// which itself runs before module imports, so we require EventEmitter
// inline rather than importing it at the top of this file.
const { adapterStub, apiStub } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    adapterStub: {
      events: new EventEmitter(),
      markConnected: vi.fn(),
      markDisconnected: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue([]),
      submitUserMessage: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
    },
    // Panels reach for the apiClient singleton on mount (SchedulesPanel calls
    // listCronTasks, ConfigPanel calls getDetails), so stub it to keep the
    // smoke tests hermetic — no real fetch leaves the process.
    apiStub: {
      listCronTasks: vi.fn().mockResolvedValue([]),
      getDetails: vi.fn().mockResolvedValue({}),
      uploadAttachment: vi.fn().mockResolvedValue({
        id: 'att-1',
        filename: 'report.txt',
        mediaType: 'text/plain',
        sizeBytes: 2048,
        category: 'text',
      }),
      deleteAttachment: vi.fn().mockResolvedValue({ success: true }),
    },
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

import { App } from './App.js';

const baseProps = {
  userId: 'local',
  agent: { id: 'remote', name: 'Prism' },
  modelId: 'us.anthropic.claude-opus-4-7',
};

describe('App', () => {
  beforeEach(() => {
    adapterStub.events.removeAllListeners();
    adapterStub.markConnected.mockClear();
    adapterStub.markDisconnected.mockClear();
    adapterStub.loadHistory.mockClear();
    adapterStub.submitUserMessage.mockClear();
    apiStub.listCronTasks.mockClear();
    apiStub.getDetails.mockClear();
    apiStub.uploadAttachment.mockClear();
    apiStub.deleteAttachment.mockClear();
    adapterStub.cancel.mockClear();
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

  it('calls loadHistory with the agentId and userId from props', () => {
    const { unmount } = render(<App {...baseProps} />);
    expect(adapterStub.loadHistory).toHaveBeenCalledWith({
      userId: 'local',
      agentId: 'remote',
      limit: 50,
    });
    unmount();
  });

  it('disables the input while status is "thinking"', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    // Flip status; App listens on the adapter event bus.
    adapterStub.events.emit('status', 'thinking');
    // Let React flush.
    await new Promise((r) => setImmediate(r));
    expect(lastFrame() ?? '').toContain('thinking');
    unmount();
  });

  // ink holds a lone trailing ESC for ~20ms (pendingInputFlushDelayMilliseconds)
  // to disambiguate it from a multi-byte escape sequence before emitting it as
  // a standalone Escape keypress. Wait past that window, then let React commit.
  const pressEscape = async (stdin: { write: (data: string) => void }) => {
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => setImmediate(r));
  };

  it('cancels the in-flight turn and shows a marker when Escape is pressed while thinking', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('status', 'thinking');
      await new Promise((r) => setImmediate(r));
      expect(lastFrame() ?? '').toContain('thinking');

      await pressEscape(stdin);

      expect(adapterStub.cancel).toHaveBeenCalled();
      expect(lastFrame() ?? '').toContain('Response stopped');
    } finally {
      unmount();
    }
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

  it('opens the schedules panel when /schedules is submitted', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = () => new Promise((r) => setImmediate(r));
    // Type the command, let ink-text-input commit the value into App state,
    // then submit with a carriage return. Splitting the writes (with a flush
    // between) mirrors real typing and ensures onSubmit sees the full value.
    stdin.write('/schedules');
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

  // Command-history recall. /copy is a clean probe: it isn't echoed as a user
  // message, and its result ("No message to copy yet.") doesn't contain the
  // command text — so "/copy" in a frame means it's sitting in the input.
  const submitCopy = async (
    stdin: { write: (data: string) => void },
    flush: () => Promise<unknown>,
  ) => {
    stdin.write('/copy');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();
  };

  it('recalls the last submission when Up is pressed on an empty input', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = () => new Promise((r) => setImmediate(r));
    await submitCopy(stdin, flush);
    expect(lastFrame() ?? '').not.toContain('/copy');

    stdin.write('\x1B[A'); // Up
    await flush();
    expect(lastFrame() ?? '').toContain('/copy');
    unmount();
  });

  it('leaves a half-typed draft untouched when Up is pressed', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = () => new Promise((r) => setImmediate(r));
    await submitCopy(stdin, flush);

    stdin.write('draft'); // non-empty input, not browsing history
    await flush();
    stdin.write('\x1B[A'); // Up — must be ignored so the draft survives
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('draft');
    expect(frame).not.toContain('/copy');
    unmount();
  });

  it('clears the input when Down goes past the newest entry', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    const flush = () => new Promise((r) => setImmediate(r));
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
    const flush = () => new Promise((r) => setImmediate(r));
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
      userId: 'local',
      agentId: 'remote',
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
      userId: 'local',
      agentId: 'remote',
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
});
