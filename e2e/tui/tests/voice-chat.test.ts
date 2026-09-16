import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, BOOT_FRAME_TIMEOUT_MS, type TuiSession } from '../harness';
import { setupRuntime, findFreePort, type RuntimeTestEnv } from '../setup';
import { createVoiceAudio } from '../support/voice-audio';

const root = path.resolve(import.meta.dirname, '../../..');
const feature = loadFeatureFromText(readFileSync(path.join(import.meta.dirname, '../features/voice-chat.feature'), 'utf8'));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
let runtime: RuntimeTestEnv;
let tui: TuiSession;
let audio: Awaited<ReturnType<typeof createVoiceAudio>>;
let model: ChildProcess;
let port: number;
let mutedMs = 0;
async function modelState(): Promise<{ sessions: number; inboundMs: number }> {
  return (await fetch(`http://127.0.0.1:${port}/state`)).json();
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Voice state did not arrive within 20 seconds.');
}

// PulseAudio supplies real virtual devices on the Linux e2e runner.
describe.skipIf(process.platform !== 'linux')('Linux audio devices', () => {
  describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
    BeforeAllScenarios(async () => {
      execFileSync(process.execPath, ['scripts/build-cli-audio.mjs'], { cwd: root, stdio: 'pipe' });
      port = await findFreePort();
      model = spawn(process.execPath, [tsx, 'e2e/support/mock-realtime-server.ts'], { cwd: root, env: { ...process.env, MOCK_REALTIME_PORT: String(port) }, stdio: 'ignore' });
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
      runtime = await setupRuntime({ runtimeEnvOverrides: { OPENAI_API_KEY: 'test-voice-key', OPENAI_REALTIME_URL: `ws://127.0.0.1:${port}/v1/realtime` } });
    });
    AfterAllScenarios(async () => { await runtime?.cleanup(); model?.kill(); });
    BeforeEachScenario(async () => { audio = await createVoiceAudio(); });
    AfterEachScenario(async () => { await tui?.stop(); audio?.cleanup(); });

    const startTerminal = async () => {
      tui = startPrism({ env: { ...runtime.prismEnv, PULSE_SERVER: audio.env.PULSE_SERVER }, runtime: runtime.runtime });
      await tui.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
    };
    const open = async () => {
      tui.send('/voice');
      await tui.waitForFrame(/Talk to the agent by voice/, 10_000);
      tui.send(KEYS.ENTER);
      await tui.waitForFrame(/› \/voice-chat /, 5_000);
      tui.send(KEYS.ENTER);
      await tui.waitForFrame(/Use a headset/, 5_000);
    };
    const start = async () => {
      tui.send(KEYS.ENTER);
      await tui.waitForFrame(/Live · microphone on/, 20_000);
    };
    const exchange = async () => { await until(() => audio.audibleSamples() > 1_000); expect((await modelState()).inboundMs).toBeGreaterThan(500); };

    Scenario('Talk, mute, and end a call', ({ Given, When, Then }) => {
      Given('a terminal with virtual input and output audio', startTerminal);
      When('I open the voice panel', open);
      Then('the microphone waits for Enter', async () => { expect((await modelState()).sessions).toBe(0); });
      When('I start the call', start);
      Then('audio flows in both directions', exchange);
      When('I mute the microphone', async () => { tui.send('m'); await tui.waitForFrame(/Live · muted/, 5_000); });
      Then('microphone audio stops and the call stays live', async () => {
        await new Promise((r) => setTimeout(r, 300));
        mutedMs = (await modelState()).inboundMs;
        await new Promise((r) => setTimeout(r, 300));
        expect((await modelState()).inboundMs).toBe(mutedMs);
        expect((await modelState()).sessions).toBe(1);
      });
      When('I unmute the microphone', () => { tui.send('m'); });
      Then('microphone audio resumes', async () => { await until(async () => (await modelState()).inboundMs > mutedMs + 200); });
      When('I leave the voice panel', () => { tui.send(KEYS.ESC); });
      Then('the voice session ends and text commands still work', async () => {
        await until(async () => (await modelState()).sessions === 0);
        tui.send('/copy ');
        await tui.waitForFrame(/› \/copy /, 5_000);
        await tui.sendUntilFrame(KEYS.ENTER, /No message to copy yet/, { timeoutMs: 5_000 });
      });
    });

    Scenario('Audio devices are unavailable', ({ Given, When, Then }) => {
      Given('a terminal without audio devices', async () => { audio.removeDevices(); await startTerminal(); });
      When('I ask for command help', async () => {
        tui.send('/help ');
        await tui.waitForFrame(/› \/help /, 5_000);
        await tui.sendUntilFrame(KEYS.ENTER, /Shut down the TUI/, { timeoutMs: 5_000 });
      });
      Then('voice chat is hidden and text commands still work', () => { expect(tui.rawOutput()).not.toContain('/voice-chat'); });
      When('I type the unavailable voice command', async () => {
        tui.send('/voice-chat ');
        await tui.waitForFrame(/› \/voice-chat /, 5_000);
        tui.send(KEYS.ENTER);
      });
      Then('the terminal explains the audio requirement locally', async () => {
        await tui.waitForFrame(/Voice chat needs an available microphone/, 5_000);
        expect((await modelState()).sessions).toBe(0);
      });
    });

    Scenario('An audio device disappears during a call', ({ Given, When, Then, And }) => {
      Given('a terminal with virtual input and output audio', startTerminal);
      When('I open the voice panel', open);
      And('I start the call', start);
      Then('audio flows in both directions', exchange);
      When('the audio server stops', () => { audio.cleanup(); });
      Then('the call ends with an audio error', async () => {
        await tui.waitForFrame(/Audio stopped/, 20_000);
        await until(async () => (await modelState()).sessions === 0);
      });
    });
  });

});
