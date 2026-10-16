import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalEnvironment } from '../../execution-environments/local/local-environment';
import { createCodexSubscriptionProvider } from './codex-subscription-provider';

vi.mock('../../telemetry', () => ({ trackEvent: vi.fn() }));

const pidFile = path.join(os.tmpdir(), `codex-fixture-${process.pid}.pids`);
afterEach(() => fs.rmSync(pidFile, { force: true }));

function provider(scenario = 'text') {
  const environment = createLocalEnvironment();
  const runProgram = environment.runProgram;
  environment.runProgram = (_command, args, options) => runProgram(process.execPath, [
    path.join(__dirname, 'fixtures/app-server.mjs'), scenario, ...args,
  ], { ...options, cwd: process.cwd(), env: { ...options?.env, FIXTURE_PID_FILE: pidFile } });
  return createCodexSubscriptionProvider(environment)('test-model');
}

/** The fixture app-servers this test started, and whether each still runs. */
function children(): Array<{ pid: number; running: boolean }> {
  const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : [];
  return pids.map((pid) => {
    try { process.kill(pid, 0); return { pid, running: true }; } catch { return { pid, running: false }; }
  });
}

async function exited(): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (children().every((child) => !child.running)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('Codex subscription provider', () => {
  it('generates text through a subscription-authenticated app-server', async () => {
    const result = await generateText({ model: provider(), prompt: 'Hello' });
    expect(result.text).toBe('Hello from Codex');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(4);
  });

  it('streams model deltas as they arrive', async () => {
    const result = streamText({ model: provider(), prompt: 'Hello' });
    const chunks = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks).toEqual(['Hello ', 'from Codex']);
  });

  it('returns custom tools to Prism and continues the same Codex turn with their results', async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => `result:${value}`);
    const result = await generateText({
      model: provider('tool'), prompt: 'Use the echo tool',
      tools: { echo: tool({ inputSchema: z.object({ value: z.string() }), execute }) },
      stopWhen: ({ steps }) => steps.length >= 3,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ value: 'test' });
    expect(result.text).toBe('Tool result received');
    expect(result.steps).toHaveLength(2);
    // Codex reports the tool step's usage after the tool result: the last step carries it,
    // with the newest call's input and every call's output.
    expect(result.steps.map((step) => step.usage.inputTokens)).toEqual([undefined, 12]);
    expect(result.steps[1].usage.outputTokens).toBe(9);
    expect(result.usage.outputTokens).toBe(9);
  });

  it('gives Codex what Prism added while a tool ran, in the same turn, and names a file it cannot read', async () => {
    const result = await generateText({
      model: provider('tool-added'), prompt: 'Use the echo tool',
      tools: { echo: tool({ inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => `result:${value}` }) },
      prepareStep: ({ stepNumber, messages }) => stepNumber === 1
        ? { messages: [...messages, { role: 'user', content: [
          { type: 'text', text: 'MARKER' },
          { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'report.pdf' },
        ] }] } : undefined,
      stopWhen: ({ steps }) => steps.length >= 3,
    });
    expect(result.text).toBe('Tool result received');
  });

  it('keeps the turn while Prism runs a tool for longer than the idle limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = await generateText({
        model: provider('tool'), prompt: 'Use the echo tool',
        tools: { echo: tool({ inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => {
          vi.advanceTimersByTime(31 * 60_000);
          return `result:${value}`;
        } }) },
        stopWhen: ({ steps }) => steps.length >= 3,
      });
      expect(result.text).toBe('Tool result received');
    } finally { vi.useRealTimers(); }
  });

  it('stops the session of a turn that ended on a tool call when the next call starts', async () => {
    const model = provider('tool');
    const tools = { echo: tool({ inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => `result:${value}` }) };
    await generateText({ model, prompt: 'Use the echo tool', tools, stopWhen: ({ steps }) => steps.length >= 1 });
    expect(children()).toHaveLength(1);
    await generateText({ model, prompt: 'Use the echo tool', tools, stopWhen: ({ steps }) => steps.length >= 3 });
    expect(await exited()).toBe(true);
  });

  it('refuses an API-key account instead of falling back to billed API access', async () => {
    await expect(generateText({ model: provider('api'), prompt: 'Hello', maxRetries: 0 }))
      .rejects.toThrow('codex login --device-auth');
  });

  it('reports the original app-server startup failure', async () => {
    await expect(generateText({ model: provider('exit'), prompt: 'Hello', maxRetries: 0 }))
      .rejects.toThrow('Codex app-server exited (7)');
  });

  it('propagates failed turns instead of treating partial text as success', async () => {
    await expect(generateText({ model: provider('failed'), prompt: 'Hello', maxRetries: 0 }))
      .rejects.toThrow('Subscription limit reached');
  });

  it('cancels an in-flight app-server without leaving a child process running', async () => {
    const controller = new AbortController();
    const result = generateText({
      model: provider('hang'), prompt: 'Hello', abortSignal: controller.signal, maxRetries: 0,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(result).rejects.toThrow();
    expect(await exited()).toBe(true);
  });
});
