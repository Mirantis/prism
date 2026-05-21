import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

// Mock the singleton adapter before importing App. `vi.mock` is hoisted to
// the top of the file, so the stub has to be declared via `vi.hoisted()` —
// which itself runs before module imports, so we require EventEmitter
// inline rather than importing it at the top of this file.
const { adapterStub } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    adapterStub: {
      events: new EventEmitter(),
      markConnected: vi.fn(),
      markDisconnected: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue([]),
      submitUserMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('./tui-adapter.js', () => ({
  tuiAdapterService: adapterStub,
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

  it('hides the status bar when hideStatusBar is true', () => {
    const { lastFrame, unmount } = render(<App {...baseProps} hideStatusBar />);
    expect(lastFrame() ?? '').not.toContain('Opus 4.7');
    unmount();
  });
});
