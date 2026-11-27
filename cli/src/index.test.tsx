import { describe, it, expect, vi, beforeEach } from 'vitest';

// index.tsx has top-level side effects (it calls ink.render at import time),
// so we mock both ink and the config loader before importing it.
const renderMock = vi.fn();
vi.mock('ink', () => ({
  render: renderMock,
}));

const { config } = vi.hoisted(() => ({
  config: {
    agentName: 'TestBot',
    modelId: 'us.anthropic.claude-sonnet-4-5-20250929',
    hideCursor: true,
    hideStatusBar: false,
    httpUrl: 'http://localhost:3003',
    httpUrlFromEnv: false,
  },
}));

vi.mock('./config.js', () => ({
  loadConfig: () => config,
  wsUrlFromHttpUrl: (u: string) => u.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/ws',
}));

/** Import the entry afresh and return what it rendered. */
async function launch(): Promise<[{ props: Record<string, unknown> }, unknown]> {
  vi.resetModules();
  renderMock.mockClear();
  await import('./index.js');
  await vi.waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
  return renderMock.mock.calls[0] as [{ props: Record<string, unknown> }, unknown];
}

describe('index entry', () => {
  beforeEach(() => {
    config.httpUrlFromEnv = false;
    delete process.env.OSC7577_TOKEN;
  });

  it('renders <App /> with values resolved from loadConfig()', async () => {
    const [element, options] = await launch();
    expect(element.props.agent).toEqual({ id: 'remote', name: 'TestBot' });
    expect(element.props.modelId).toBe('us.anthropic.claude-sonnet-4-5-20250929');
    expect(element.props.hideCursor).toBe(true);
    expect(element.props.hideStatusBar).toBe(false);
    expect(element.props.userId).toBe('local');
    // No terminal token, no resume report.
    expect(element.props.resumeReporting).toBeUndefined();
    // Ink render options: ctrl+C handled in-app, force interactive.
    expect(options).toEqual({ exitOnCtrlC: false, interactive: true });
  });

  it("takes the terminal's resume token out of the environment and reports with it", async () => {
    process.env.OSC7577_TOKEN = 'dummy-token-replace-me';
    const [element] = await launch();
    expect(process.env.OSC7577_TOKEN).toBeUndefined();
    expect(element.props.resumeReporting).toEqual({
      token: 'dummy-token-replace-me',
      command: [process.execPath, ...process.execArgv, expect.any(String)],
      cwd: process.cwd(),
    });
  });

  it('clears the resume record when the launch fails, so a terminal does not run it again', async () => {
    process.env.OSC7577_TOKEN = 'dummy-token-replace-me';
    const argv = process.argv;
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const written: string[] = [];
    process.argv = [argv[0]!, argv[1]!, '--resume', '--continue'];
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    try {
      vi.resetModules();
      await expect(import('./index.js')).rejects.toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith('Use --resume or --continue, not both.');
      expect(written).toEqual([expect.stringMatching(/^\x1b\]7577;pid=\d+:time=\d+:clear=1:mac=[0-9a-f]{64}\x1b\\$/)]);
    } finally {
      process.argv = argv;
      if (isTTY) Object.defineProperty(process.stdout, 'isTTY', isTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      vi.restoreAllMocks();
    }
  });

  it('reports nothing when only PRISM_HTTP_URL names the runtime', async () => {
    process.env.OSC7577_TOKEN = 'dummy-token-replace-me';
    config.httpUrlFromEnv = true;
    const [element] = await launch();
    expect(process.env.OSC7577_TOKEN).toBeUndefined();
    expect(element.props.resumeReporting).toBeUndefined();
  });
});
