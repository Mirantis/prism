import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText, tool, Output } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalEnvironment } from '../../execution-environments/local/local-environment';
import { createClaudeSubscriptionProvider } from './claude-subscription-provider';
vi.mock('../../telemetry', () => ({ trackEvent: vi.fn() }));

const pidFile = path.join(os.tmpdir(), `claude-fixture-${process.pid}.pids`);
afterEach(() => fs.rmSync(pidFile, { force: true }));

/** Whether every CLI run of this test, including `claude auth status`, has exited. */
async function exited(): Promise<boolean> {
  const pids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : []);
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!pids().some(running)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const echo = () => ({ echo: tool({ inputSchema: z.object({ value: z.string() }), execute: async ({ value }: { value: string }) => `result:${value}` }) });

function provider(scenario = 'text') {
  const environment = createLocalEnvironment();
  const run = environment.runProgram;
  environment.baseEnv = () => ({ ...process.env, ANTHROPIC_API_KEY: 'test-only', CLAUDE_CODE_OAUTH_TOKEN: 'test-only', CLAUDE_CODE_USE_BEDROCK: '1' });
  environment.runProgram = (_command, args, options) => run(process.execPath, [path.join(__dirname, 'fixtures/cli.mjs'), scenario, ...args],
    { ...options, cwd: process.cwd(), env: { ...options?.env, FIXTURE_PID_FILE: pidFile } });
  return createClaudeSubscriptionProvider(environment)('sonnet');
}

describe('browser-authenticated subscription provider', () => {
  it('streams text and reports cache-inclusive token usage without inheriting API or setup tokens', async () => {
    const result = streamText({ model: provider(), prompt: 'Hello' });
    const chunks = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks).toEqual(['Hello ', 'from Claude']);
    expect((await result.usage).inputTokens).toBe(17);
  });
  it('returns MCP tools to the outer agent loop and resumes with its results', async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => `result:${value}`);
    const result = await generateText({ model: provider('tool'), prompt: 'Use echo', tools: { echo: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: ({ steps }) => steps.length >= 3 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Tool result received');
    expect(result.steps).toHaveLength(2);
    // Each step has its own call's input; an output reported after a tool call counts in the next step.
    expect(result.steps.map((step) => step.usage.inputTokens)).toEqual([35, 45]);
    expect(result.usage.outputTokens).toBe(9);
  });
  it('gives the CLI what Prism added while a tool ran, in the same turn, and names a file it cannot read', async () => {
    const result = await generateText({
      model: provider('tool-added'), prompt: 'Use echo', tools: echo(),
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
        model: provider('tool'), prompt: 'Use echo',
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
    await generateText({ model, prompt: 'Use echo', tools: echo(), stopWhen: ({ steps }) => steps.length >= 1 });
    await generateText({ model, prompt: 'Use echo', tools: echo(), stopWhen: ({ steps }) => steps.length >= 3 });
    expect(await exited()).toBe(true);
  });
  it('turns a file into a note the model can act on', async () => {
    const result = await generateText({ model: provider(), maxRetries: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Read this' }, { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'report.pdf' },
    ] }] });
    expect(result.text).toBe('Hello from Claude');
  });
  it('asks for a browser login when the CLI reports none', async () => {
    await expect(generateText({ model: provider('logged-out'), prompt: 'Hello', maxRetries: 0 })).rejects.toThrow('claude auth login');
  });
  it('returns tool errors to the CLI so the model can recover', async () => {
    const result = await generateText({ model: provider('tool-error'), prompt: 'Use echo', tools: { echo: tool({ inputSchema: z.object({ value: z.string() }), execute: async () => { throw new Error('Tool failure'); } }) }, stopWhen: ({ steps }) => steps.length >= 3 });
    expect(result.text).toBe('Tool result received');
  });
  it.each(['api_key', 'oauth_token', 'third_party', 'unsubscribed'])('refuses %s authentication', async (scenario) => {
    await expect(generateText({ model: provider(scenario), prompt: 'Hello', maxRetries: 0 })).rejects.toThrow('claude auth login');
  });
  it('names a CLI that could not report its login, instead of asking for a new login', async () => {
    await expect(generateText({ model: provider('auth-crash'), prompt: 'Hello', maxRetries: 0 }))
      .rejects.toThrow('The Claude CLI could not report its login in the agent environment: it exited with 5.');
  });
  it('propagates subscription limits and CLI exit failures', async () => {
    await expect(generateText({ model: provider('failed'), prompt: 'Hello', maxRetries: 0 })).rejects.toThrow('Subscription limit reached');
    await expect(generateText({ model: provider('exit'), prompt: 'Hello', maxRetries: 0 })).rejects.toThrow('exited (7)');
  });
  it('supports schema-constrained output', async () => {
    const result = await generateText({ model: provider('json'), prompt: 'Return verdict', output: Output.object({ schema: z.object({ verdict: z.string() }) }) });
    expect(result.output).toEqual({ verdict: 'ok' });
  });
  it('cancels an active CLI turn', async () => {
    const controller = new AbortController();
    const result = generateText({ model: provider('hang'), prompt: 'Hello', abortSignal: controller.signal, maxRetries: 0 });
    setTimeout(() => controller.abort(), 100);
    await expect(result).rejects.toThrow();
    expect(await exited()).toBe(true);
  });
});
