import { TerminalBrowser } from './browser.js';
import { KittyTerminal } from './terminal.js';
import type { TerminalInput } from './input.js';

async function lifecycle(baseUrl: string, event: 'started' | 'finished', elapsed: number, status?: 'success' | 'error'): Promise<void> {
  await fetch(`${baseUrl}/agents/terminal-view/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, elapsedMs: elapsed, status }), signal: AbortSignal.timeout(1500),
  }).catch(() => {});
}

export async function runWebTerminal(httpUrl: string, resume: boolean): Promise<boolean> {
  const terminal = await KittyTerminal.open();
  if (!terminal) return false;
  const baseUrl = httpUrl.replace(/\/$/, '');
  const started = Date.now();
  let browser: TerminalBrowser | undefined;
  let status: 'success' | 'error' = 'success';
  let stopped = false;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // A browser failure can arrive while startup is still awaiting navigation.
  void done.catch(() => {});
  const stop = () => { stopped = true; finish(); };
  const onFailure = (error: Error) => { stopped = true; fail(error); };
  let work = Promise.resolve();
  let painting = Promise.resolve();
  let latestFrame: { data: string; sessionId: number } | undefined;
  let paintingActive = false;
  const enqueue = (action: () => Promise<unknown>) => {
    work = work.then(async () => { if (!stopped) await action(); }).catch(onFailure);
  };
  terminal.on('input', (input: TerminalInput) => {
    if (input.type === 'key' && input.key.toLowerCase() === 'c' && (input.modifiers & 4)) { stop(); return; }
    if (browser) enqueue(() => browser!.input(input, terminal.size));
  });
  terminal.on('resize', () => { if (browser) enqueue(() => browser!.resize(terminal.size)); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    await lifecycle(baseUrl, 'started', 0);
    if (stopped) return true;
    browser = await TerminalBrowser.launch();
    browser.on('failure', onFailure);
    browser.on('pointer', (shape: string) => { if (!stopped) terminal.pointer(shape); });
    if (stopped) return true;
    await browser.resize(terminal.size);
    let route = '/';
    if (!resume) {
      const response = await fetch(`${baseUrl}/threads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: process.cwd() }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Could not create a conversation (${response.status}).`);
      const { threadId } = await response.json() as { threadId: string };
      route = `/chat/${encodeURIComponent(threadId)}`;
    }
    const url = `${baseUrl}${route}`;
    if (stopped) return true;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('The runtime must serve the web UI. For a source checkout, run npm run build:web first.');
    }
    browser.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
      if (stopped) return;
      // Capture the next frame while painting, keeping only the newest pending frame.
      void browser!.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(onFailure);
      latestFrame = frame;
      if (paintingActive) return;
      paintingActive = true;
      painting = (async () => {
        while (latestFrame && !stopped) {
          const next = latestFrame;
          latestFrame = undefined;
          await terminal.frame(next.data);
        }
      })().catch(onFailure).finally(() => { paintingActive = false; });
    });
    await browser.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    const navigation = await browser.send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`Could not open the web UI: ${navigation.errorText}`);
    await done;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    stopped = true;
    await Promise.all([work, painting]);
    try { await browser?.close(); } finally {
      await terminal.close();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      await lifecycle(baseUrl, 'finished', Date.now() - started, status);
    }
  }
  return true;
}
