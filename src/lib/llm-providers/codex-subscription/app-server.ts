import { createInterface } from 'node:readline';
import { AsyncChannel } from '../../../utils/async-channel';
import type { ExecProcess, ExecutionEnvironment } from '../../execution-environments/execution-environment';
import type { AddedMessage, SessionOutcome } from '../subscription-types';
import type { CallOptions, GenerateResult, RpcMessage, SessionEvent, ToolResult, ToolCallParams, UsageParams } from './types';
import { unreadableFile } from '../subscription-provider';
import { codexPrompt, imageUrl } from './prompt';
import { CODEX_DEFAULT_MODEL } from './default-model';

const NO_USAGE: GenerateResult['usage'] = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export class CodexSession {
  readonly events = new AsyncChannel<SessionEvent>();
  readonly calls = new Map<string, number>();
  private usage: GenerateResult['usage'] = NO_USAGE;
  private process: ExecProcess;
  private sequence = 0;
  private requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private disposed = false;
  private stderr = '';
  private idleTimer?: NodeJS.Timeout;
  private abort: () => void;
  private abortSignals = new Set<AbortSignal>();

  constructor(environment: ExecutionEnvironment, private options: CallOptions, private finished: (outcome: SessionOutcome) => void) {
    const env: NodeJS.ProcessEnv = { ...environment.baseEnv(), CODEX_HOME: environment.paths().codexHome };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) delete env[key];
    this.process = environment.runProgram('codex', [
      'app-server', '--listen', 'stdio://',
      '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
      '-c', 'cli_auth_credentials_store="file"', '-c', 'web_search="disabled"',
      '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false',
      '-c', 'features.apps=false', '-c', 'features.plugins=false',
      '-c', 'features.view_image=false', '-c', 'features.sleep_tool=false',
      '-c', 'features.skill_search=false', '-c', 'mcp_servers={}',
    ], { cwd: environment.workspaceRoot(), env, stdin: 'pipe' });
    this.abort = () => this.fail(new Error('Codex subscription request was cancelled.'), 'cancelled');
    this.watchAbort(options.abortSignal);
    this.arm();
    if (this.process.stdout) {
      const reader = createInterface({ input: this.process.stdout });
      reader.on('line', (line) => {
        try { this.receive(JSON.parse(line) as RpcMessage); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      });
    }
    this.process.stderr?.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-4096); });
    void this.process.ended.then((end) => {
      if (!this.disposed) this.fail(end.error ?? new Error(`Codex app-server exited (${end.exitCode ?? end.signal}): ${this.stderr}`));
    });
  }

  watchAbort(signal?: AbortSignal): void {
    if (!signal || this.abortSignals.has(signal)) return;
    this.abortSignals.add(signal);
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  async start(model: string): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'prism_agent', title: 'Prism Agent', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
    // Codex refreshes the login when it needs to; a forced refresh on every call rotates the
    // refresh token under the coding agent and the other sessions that share the login.
    const account = await this.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') {
      this.dispose('login_refused');
      throw new Error('Codex subscription login is required. Run codex login --device-auth in the agent sandbox; API-key access is disabled.');
    }
    const prompt = codexPrompt(this.options);
    const choice = this.options.toolChoice;
    const tools = (this.options.tools ?? []).filter((tool) => tool.type === 'function')
      .filter((tool) => choice?.type !== 'none' && (choice?.type !== 'tool' || choice.toolName === tool.name));
    const thread = await this.request<{ thread: { id: string } }>('thread/start', {
      model: model === CODEX_DEFAULT_MODEL ? null : model,
      modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      baseInstructions: prompt.instructions,
      config: { project_doc_max_bytes: 0 },
      dynamicTools: tools.length ? [{
        type: 'namespace', name: 'prism', description: 'Tools executed by the Prism agent harness.',
        tools: tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema })),
      }] : [],
    });
    await this.request('turn/start', {
      threadId: thread.thread.id, input: prompt.input,
      ...(this.options.responseFormat?.type === 'json' && this.options.responseFormat.schema
        ? { outputSchema: this.options.responseFormat.schema } : {}),
    });
  }

  resume(results: ToolResult[], added: AddedMessage[]): void {
    // What Prism added while Codex waited rides on the last reply, so Codex reads it before it goes on.
    const addedItems = added.flatMap((message) => message.content.map((part) => {
      if (part.type !== 'file') return { type: 'inputText', text: `Added to the conversation while you worked:\n${part.text}` };
      const url = imageUrl(part);
      return url ? { type: 'inputImage', imageUrl: url } : { type: 'inputText', text: unreadableFile(part) };
    }));
    const answered = results.filter((result) => this.calls.has(result.toolCallId));
    answered.forEach((result, index) => {
      const id = this.calls.get(result.toolCallId)!;
      const output = result.output;
      const text = 'value' in output ? (typeof output.value === 'string' ? output.value : JSON.stringify(output.value)) : JSON.stringify(output);
      this.calls.delete(result.toolCallId);
      this.send({ id, result: {
        contentItems: [{ type: 'inputText', text }, ...(index === answered.length - 1 ? addedItems : [])],
        success: output.type !== 'error-text' && output.type !== 'error-json',
      } });
    });
    this.arm();
  }

  dispose(outcome: SessionOutcome = 'completed'): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    for (const signal of this.abortSignals) signal.removeEventListener('abort', this.abort);
    this.abortSignals.clear();
    this.process.kill('SIGTERM');
    const killTimer = setTimeout(() => this.process.kill('SIGKILL'), 2000);
    killTimer.unref();
    void this.process.ended.then(() => clearTimeout(killTimer));
    for (const pending of this.requests.values()) pending.reject(new Error('Codex app-server stopped.'));
    this.requests.clear();
    this.finished(outcome);
  }

  fail(error: Error, outcome: SessionOutcome = 'failed'): void {
    this.events.error(error);
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    this.dispose(outcome);
  }

  takeUsage(): GenerateResult['usage'] {
    const usage = this.usage;
    this.usage = NO_USAGE;
    return usage;
  }

  /** Thirty minutes without a word from Codex ends the turn. A tool call Prism runs pauses the clock. */
  private arm(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail(new Error('Codex subscription turn timed out.')), 30 * 60_000);
    this.idleTimer.unref();
  }

  private send(message: RpcMessage): void {
    this.process.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private request<Result = unknown>(method: string, params: Record<string, unknown>): Promise<Result> {
    if (this.disposed) return Promise.reject(new Error('Codex app-server stopped.'));
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.send({ id, method, params });
    }).then((result) => result as Result);
  }

  private receive(message: RpcMessage): void {
    // While Prism runs a tool, the clock stays paused, whatever Codex reports meanwhile.
    if (this.calls.size === 0) this.arm();
    if (message.id !== undefined && !message.method) {
      const pending = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    if (message.method === 'item/tool/call' && message.id !== undefined) {
      const params = message.params as ToolCallParams;
      this.calls.set(params.callId, message.id);
      clearTimeout(this.idleTimer);
      this.events.push({ type: 'tool', id: message.id, callId: params.callId, name: params.tool, input: params.arguments });
    } else if (message.id !== undefined) {
      this.send({ id: message.id, error: { code: -32601, message: `Unsupported Codex request: ${message.method}` } });
      this.fail(new Error(`Codex requested ${message.method}; only Prism tools are supported.`));
    } else if (message.method === 'item/agentMessage/delta') {
      const params = message.params as { itemId: string; delta: string };
      this.events.push({ type: 'text', id: params.itemId, delta: params.delta });
    } else if (message.method === 'thread/tokenUsage/updated') {
      const usage = (message.params as UsageParams).tokenUsage.last;
      // Codex reports a call's usage only after Prism answers its tool, so a tool step carries the
      // calls before it. The input is the newest call's, which is the context size; the output adds up.
      const output = (this.usage.outputTokens.total ?? 0) + usage.outputTokens;
      const reasoning = (this.usage.outputTokens.reasoning ?? 0) + usage.reasoningOutputTokens;
      this.usage = {
        inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens - usage.cachedInputTokens, cacheRead: usage.cachedInputTokens, cacheWrite: usage.cacheWriteInputTokens },
        outputTokens: { total: output, text: output - reasoning, reasoning },
      };
    } else if (message.method === 'turn/completed') {
      const params = message.params as { turn: { status: string; error?: { message: string } } };
      if (params.turn.status !== 'completed') {
        this.fail(new Error(params.turn.error?.message ?? `Codex turn ${params.turn.status}.`));
      } else {
        this.events.push({ type: 'complete' });
        this.events.close();
      }
    }
  }
}
