import { describe, it, expect, vi } from 'vitest';

// index.tsx has top-level side effects (it calls ink.render at import time),
// so we mock both ink and the config loader before importing it.
const renderMock = vi.fn();
vi.mock('ink', () => ({
  render: renderMock,
}));

vi.mock('./config.js', () => ({
  loadConfig: () => ({
    agentName: 'TestBot',
    modelId: 'us.anthropic.claude-sonnet-4-5-20250929',
    hideCursor: true,
    hideStatusBar: false,
    httpUrl: 'http://localhost:3003',
  }),
  wsUrlFromHttpUrl: (u: string) => u.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/ws',
}));

describe('index entry', () => {
  it('renders <App /> with values resolved from loadConfig()', async () => {
    await import('./index.js');
    expect(renderMock).toHaveBeenCalledTimes(1);
    const [element, options] = renderMock.mock.calls[0]!;
    expect(element.props.agent).toEqual({ id: 'remote', name: 'TestBot' });
    expect(element.props.modelId).toBe('us.anthropic.claude-sonnet-4-5-20250929');
    expect(element.props.hideCursor).toBe(true);
    expect(element.props.hideStatusBar).toBe(false);
    expect(element.props.userId).toBe('local');
    // Ink render options: ctrl+C handled in-app, force interactive.
    expect(options).toEqual({ exitOnCtrlC: false, interactive: true });
  });
});
