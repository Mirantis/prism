import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { TerminalInput } from './input.js';
import type { TerminalSize } from './terminal.js';
import { pointerScript } from './pointer.js';

function browserExecutable(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((key) => process.env[key]
      ? [path.join(process.env[key]!, 'Google/Chrome/Application/chrome.exe'), path.join(process.env[key]!, 'Microsoft/Edge/Application/msedge.exe')]
      : []),
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap((dir) =>
      ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].map((name) => path.join(dir, name))),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Install Google Chrome or Chromium to display the web UI in the terminal.');
  return executable;
}

/** Chromium's debugging pipe keeps browser control local to this child process. */
export class TerminalBrowser extends EventEmitter {
  private id = 0;
  private sessionId?: string;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = '';
  private closing = false;
  private viewport = { width: 800, height: 600 };
  private mouseButton: 'left' | 'middle' | 'right' | 'none' = 'none';
  private exited: Promise<void>;

  private constructor(private child: ChildProcess, private profile: string) {
    super();
    const output = child.stdio[4] as Readable;
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        } else if (message.sessionId === this.sessionId) {
          this.emit(message.method, message.params);
        }
      }
    });
    child.stdout?.resume();
    child.stderr?.resume();
    this.exited = new Promise((resolve) => {
      child.once('error', (error) => { this.failed(error); resolve(); });
      child.once('exit', () => {
        this.failed(new Error('The terminal browser closed.'));
        resolve();
      });
    });
    (child.stdio[3] as Writable).on('error', (error) => this.failed(error));
  }

  static async launch(): Promise<TerminalBrowser> {
    const executable = browserExecutable();
    const profile = await mkdtemp(path.join(os.tmpdir(), 'prism-terminal-browser-'));
    const child = spawn(executable, [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      // Chromium requires this when the CLI runs as root in a container.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const browser = new TerminalBrowser(child, profile);
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      browser.sessionId = sessionId;
      await browser.send('Page.enable');
      await browser.send('Runtime.enable');
      await browser.send('Runtime.addBinding', { name: '__prismPointer', executionContextName: 'prism-terminal' });
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: pointerScript, worldName: 'prism-terminal' });
      browser.on('Runtime.bindingCalled', ({ name, payload }: { name: string; payload: string }) => {
        if (name === '__prismPointer') browser.emit('pointer', payload);
      });
      return browser;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The terminal browser did not answer ${method}.`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      (this.child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, sessionId: this.sessionId }) + '\0');
    });
  }

  async resize(size: TerminalSize): Promise<void> {
    // Keep web text close to terminal text size on high-density displays.
    const scale = size.height / size.rows / 20;
    this.viewport = { width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
    await this.send('Emulation.setDeviceMetricsOverride', {
      ...this.viewport, deviceScaleFactor: scale, mobile: false,
    });
  }

  async input(input: TerminalInput, size: TerminalSize): Promise<void> {
    if (input.type === 'text') {
      await this.send('Input.insertText', { text: input.text });
      return;
    }
    if (input.type === 'mouse') {
      const x = Math.min(this.viewport.width - 1, (input.x - 0.5) * this.viewport.width / size.columns);
      const y = Math.min(this.viewport.height - 1, (input.y - 0.5) * this.viewport.height / size.rows);
      const modifiers = ((input.button & 4) ? 8 : 0) | ((input.button & 8) ? 1 : 0) | ((input.button & 16) ? 2 : 0);
      if (input.button & 64) {
        const horizontal = (input.button & 2) !== 0;
        const delta = (input.button & 1) ? 100 : -100;
        await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, modifiers, deltaX: horizontal ? delta : 0, deltaY: horizontal ? 0 : delta });
        return;
      }
      const move = (input.button & 32) !== 0;
      const button = (['left', 'middle', 'right', 'none'] as const)[input.button & 3]!;
      if (!move && !input.release) this.mouseButton = button;
      await this.send('Input.dispatchMouseEvent', {
        type: move ? 'mouseMoved' : input.release ? 'mouseReleased' : 'mousePressed',
        x, y, modifiers, button: move ? this.mouseButton : button,
        buttons: input.release ? 0 : ({ none: 0, left: 1, right: 2, middle: 4 })[this.mouseButton],
        clickCount: move ? 0 : 1,
      });
      if (input.release) this.mouseButton = 'none';
      return;
    }
    if (input.type !== 'key') return;
    const { key, modifiers: flags } = input;
    const modifiers = ((flags & 1) ? 8 : 0) | ((flags & 2) ? 1 : 0) | ((flags & 4) ? 2 : 0) | ((flags & 8) ? 4 : 0);
    const keyCodes: Record<string, number> = {
      Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35,
      Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
    };
    const windowsVirtualKeyCode = keyCodes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = key === 'Enter' ? '\r' : [...key].length === 1 && !(flags & 14) ? key : undefined;
    const commands = (flags & 12) && key.toLowerCase() === 'a' ? ['selectAll'] : undefined;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, modifiers, windowsVirtualKeyCode, text, commands });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
    await this.exited;
    clearTimeout(timer);
    await rm(this.profile, { recursive: true, force: true });
  }

  private failed(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.emit('failure', error);
  }
}
