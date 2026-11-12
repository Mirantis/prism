/**
 * The eval set's connection to the backend: `prism-server eval`, spoken to in JSON lines
 * over its stdin and stdout. The backend builds each request with its own prompt
 * builders, tools and gates; the eval set holds the scenarios, the tools' answers and
 * the grading.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

type EvalProcess = ChildProcessByStdio<Writable, Readable, null>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** What a tool call returns in a turn. Throwing makes the call fail with the message. */
export type ToolHandler = (tool: string, input: Record<string, unknown>) => unknown;

interface Waiting {
  resolve: (reply: { result: unknown; usage: Usage }) => void;
  reject: (error: Error & { usage?: Usage }) => void;
  onTool?: ToolHandler;
}

export class Backend {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private exited: Error | undefined;

  private constructor(private readonly child: EvalProcess) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    child.on('exit', (code, signal) => {
      this.exited = new Error(`prism-server eval exited (${signal ?? code})`);
      for (const waiting of this.waiting.values()) waiting.reject(this.exited);
      this.waiting.clear();
    });
  }

  /** Start `prism-server eval` with `env`; its logs go to this process's stderr. */
  static start(binary: string, env: NodeJS.ProcessEnv, cwd: string): Backend {
    const child = spawn(binary, ['eval'], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    return new Backend(child);
  }

  /** Run one operation; a tool call it makes goes to `onTool`. */
  request<T>(op: string, params: unknown = {}, onTool?: ToolHandler): Promise<{ result: T; usage: Usage }> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as Waiting['resolve'], reject, onTool });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  /** Close stdin, which ends the backend once its running operations finish. */
  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    await done;
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const call = message.toolCall as
      | { id: number; call: number; tool: string; input: Record<string, unknown> }
      | undefined;
    if (call) {
      void this.answerTool(call);
      return;
    }
    const id = message.id as number;
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    const usage = toUsage(message.usage);
    if (typeof message.error === 'string') {
      waiting.reject(Object.assign(new Error(message.error), { usage }));
    } else {
      waiting.resolve({ result: message.result, usage });
    }
  }

  private async answerTool(call: { id: number; call: number; tool: string; input: Record<string, unknown> }): Promise<void> {
    const handler = this.waiting.get(call.id)?.onTool;
    let reply: Record<string, unknown>;
    try {
      if (!handler) throw new Error(`No tool answers in this request (${call.tool}).`);
      reply = { call: call.call, output: (await handler(call.tool, call.input ?? {})) ?? null };
    } catch (error) {
      reply = { call: call.call, error: error instanceof Error ? error.message : String(error) };
    }
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ toolResult: reply })}\n`);
  }
}

function toUsage(value: unknown): Usage {
  const usage = (value ?? {}) as { input_tokens?: number; output_tokens?: number };
  return { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
}
