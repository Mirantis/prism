import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, type TuiSession } from '../harness';
import { GraphicsPeer } from '../graphics-peer';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(readFileSync(join(import.meta.dirname, '../features/web-terminal.feature'), 'utf8'));
let env: RuntimeTestEnv;
let session: TuiSession | undefined;
let peer: GraphicsPeer;
let previousThreadId: string;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    const root = join(import.meta.dirname, '../../..');
    execFileSync('npm', ['run', 'build:web'], { cwd: root, stdio: 'pipe' });
    env = await setupRuntime({ runtimeEnvOverrides: {
      AGENT_NAME: 'Prism Demo', PRISM_WEB_DIR: join(root, 'web/dist'), SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '',
    } });
  });
  AfterAllScenarios(async () => { await env.cleanup(); });
  BeforeEachScenario(() => { peer = new GraphicsPeer(); });
  AfterEachScenario(async () => { await session?.stop(); session = undefined; });

  function start(httpUrl = env.prismEnv.PRISM_HTTP_URL, terminalProgram = 'kitty'): TuiSession {
    return startPrism({
      env: { ...env.prismEnv, PRISM_HTTP_URL: httpUrl, TMUX: undefined, STY: undefined, TERM_PROGRAM: terminalProgram },
      runtime: env.runtime, cols: peer.columns, rows: peer.rows, onData: peer.receive,
    });
  }

  Scenario('Use the web UI through terminal graphics and input', ({ Given, When, Then }) => {
    Given('the web UI fills a Kitty-compatible terminal', async () => {
      session = start();
      await expect.poll(() => peer.image?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(20_000);
      expect(peer.image!.subarray(1, 4).toString()).toBe('PNG');
      expect(peer.image!.readUInt32BE(16)).toBe(1200);
      expect(peer.image!.readUInt32BE(20)).toBe(800);
      expect(peer.placements.at(-1)).toEqual({ columns: 120, rows: 40 });
      expect(peer.files.length).toBeGreaterThan(0);
      expect(peer.pointer).toBe('>default');
      // The page opens separate sockets for chat and runtime notifications.
      await expect.poll(() => env.runtime.logTail(50_000).match(/WebSocket connected for user/g)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    });
    When('I move the mouse over a button and the composer', async () => {
      session!.send('\x1b[<35;10;5M');
      await expect.poll(() => peer.pointer).toBe('pointer');
      session!.send('\x1b[<35;60;35M');
    });
    Then('the pointer changes between a hand and a text cursor', async () => {
      await expect.poll(() => peer.pointer).toBe('text');
    });
    When('I paste a message and edit it with the keyboard', async () => {
      // The web composer focuses on mount. Bracketed paste keeps the newline in the draft.
      session!.send('\x1b[200~Reply OK.\nTerminal input 猫x\x1b[201~');
      session!.send('\x7f\x1b[13;2u');
      session!.send('Done.\r');
    });
    Then('the submitted message contains the edited text', async () => {
      await expect.poll(async () => {
        const messages = await runtimeRequest<Array<{ role: string; content: string }>>(env.port, 'GET', '/messages');
        return messages.filter((message) => message.role === 'USER').map((message) => message.content);
      }, { timeout: 20_000 }).toContain('Reply OK.\nTerminal input 猫\nDone.');
    });
    When('I click New chat with the terminal mouse', async () => {
      const latest = await runtimeRequest<{ threadId: string }>(env.port, 'GET', '/latest-thread');
      previousThreadId = latest.threadId;
      session!.send(peer.click(100, 90));
    });
    Then('a new conversation opens', async () => {
      await expect.poll(async () => (await runtimeRequest<{ threadId: string }>(env.port, 'GET', '/latest-thread')).threadId, { timeout: 10_000 }).not.toBe(previousThreadId);
    });
    When('I resize the terminal', () => {
      peer.columns = 100;
      peer.rows = 30;
      session!.resize(peer.columns, peer.rows);
    });
    Then('the web UI fills the resized terminal', async () => {
      await expect.poll(() => peer.placements.at(-1), { timeout: 10_000 }).toEqual({ columns: 100, rows: 30 });
      await expect.poll(() => [peer.image?.readUInt32BE(16), peer.image?.readUInt32BE(20)], { timeout: 10_000 }).toEqual([1000, 600]);
    });
    When('I press Ctrl+C in the graphical view', () => { session!.send('\x03'); });
    Then('the terminal modes are restored and the CLI exits successfully', async () => {
      expect(await session!.waitForExit(15_000)).toBe(0);
      expect(session!.rawOutput()).toContain('\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
      expect(peer.pointer).toBe('<');
      expect(peer.files.every((file) => !existsSync(file))).toBe(true);
    });
  });

  Scenario('Display the web UI when the terminal cannot read local files', ({ Given, Then }) => {
    Given('the terminal cannot read local frame files', () => {
      peer.sharedFiles = false;
      session = start(undefined, 'iTerm.app');
    });
    Then('the web UI fills the terminal using inline images', async () => {
      await expect.poll(() => peer.image?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(20_000);
      expect(peer.image!.subarray(1, 4).toString()).toBe('PNG');
      expect(peer.placements.at(-1)).toEqual({ columns: 120, rows: 40 });
      expect(peer.files).toHaveLength(0);
      expect(peer.pointer).toBe('left_ptr');
      session!.send('\x1b[<35;10;5M');
      await expect.poll(() => peer.pointer).toBe('hand2');
      session!.send('\x1b[<35;60;35M');
      await expect.poll(() => peer.pointer).toBe('xterm');
      session!.send('\x03');
      expect(await session!.waitForExit(15_000)).toBe(0);
      expect(peer.pointer).toBe('xterm');
    });
  });

  Scenario('Restore the terminal after a startup error', ({ Given, Then }) => {
    Given('the runtime is unavailable in a Kitty-compatible terminal', () => {
      session = start('http://127.0.0.1:1');
    });
    Then('the terminal modes are restored and the CLI reports the error', async () => {
      expect(await session!.waitForExit(20_000)).toBe(1);
      expect(session!.rawOutput()).toContain('\x1b[?1049l');
      expect(session!.output()).toContain('prism:');
    });
  });
});
