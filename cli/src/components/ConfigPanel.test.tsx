import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ConfigPanel } from './ConfigPanel.js';
import type { ApiClient, AgentDetails } from '../api-client.js';

const DETAILS: AgentDetails = {
  id: 'a',
  userId: 'u',
  name: 'Prism',
  model: null,
  soulMd: '# Soul\n\nBe helpful.',
  userMd: 'user notes',
  memoryMd: 'memory',
  heartbeatMd: 'heartbeat',
  visionMd: '',
  agentMd: '',
  bootstrapMd: 'bootstrap',
  proactivity: 3,
  verbosity: 3,
  timezone: 'UTC',
  heartbeatIntervalMs: 28_800_000,
  heartbeatStatus: 'ENABLED',
  status: 'IDLE',
  lastHeartbeat: null,
  createdAt: '',
  updatedAt: '',
};

// Only getDetails is exercised by ConfigPanel; the rest of ApiClient is unused.
function stubApi(): ApiClient {
  return { getDetails: vi.fn().mockResolvedValue(DETAILS) } as unknown as ApiClient;
}

const flush = () => new Promise((r) => setImmediate(r));

// Arrow keys move through Ink's input parser cleanly under ink-testing-library
// (the node-pty escape-sequence quirk that the e2e suite avoids doesn't apply
// to the mock stdin used here), so the focus indicator can be asserted exactly.
const RIGHT = '\x1B[C';
const LEFT = '\x1B[D';

describe('ConfigPanel focus indicator', () => {
  it('shows the focus bar on the file list, moves it to content on →, and back on ←', async () => {
    const { lastFrame, stdin, unmount } = render(
      <ConfigPanel api={stubApi()} onClose={vi.fn()} />,
    );
    // Let the getDetails promise resolve and the panel render its loaded view.
    await flush();
    await flush();

    // On mount the list pane is focused: its header carries the ▌ bar and the
    // footer offers to move into the content pane.
    const initial = lastFrame() ?? '';
    expect(initial).toContain('▌ Files');
    expect(initial).not.toContain('▌ Soul');
    expect(initial).toContain('→/tab content');

    // → focuses the content pane: the bar moves to the doc header.
    stdin.write(RIGHT);
    await flush();
    const onContent = lastFrame() ?? '';
    expect(onContent).toContain('▌ Soul');
    expect(onContent).not.toContain('▌ Files');
    expect(onContent).toContain('←/tab files');

    // ← returns focus to the file list.
    stdin.write(LEFT);
    await flush();
    expect(lastFrame() ?? '').toContain('▌ Files');

    unmount();
  });
});
