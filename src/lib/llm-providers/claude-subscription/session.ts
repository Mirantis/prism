import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AsyncChannel } from '../../../utils/async-channel';
import type { ExecProcess, ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { unreadableFile } from '../subscription-provider';
import type { AddedMessage, CallOptions, GenerateResult, SessionOutcome, SubscriptionEvent, ToolResult } from '../subscription-types';
import { LOGIN_REQUIRED, requireSubscriptionLogin, subscriptionEnvironment } from './authentication';

interface McpMessage {
  jsonrpc: '2.0'; id?: string | number; method?: string;
  params?: { name?: string; arguments?: unknown; protocolVersion?: string };
}
interface ControlRequest {
  subtype: string; server_name?: string; message?: McpMessage;
  tool_name?: string; input?: unknown;
}
interface Frame {
  type: string; request_id?: string; request?: ControlRequest;
  response?: { subtype: string; request_id: string; error?: string };
  event?: { type: string; index?: number; delta?: { type: string; text?: string }; message?: { usage?: Usage }; usage?: Usage };
  subtype?: string; is_error?: boolean; errors?: string[]; result?: string; structured_output?: unknown;
}
interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

const NO_USAGE: GenerateResult['usage'] = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Stream-json control envelopes follow the pinned Claude Code SDK protocol.
 * MCP calls remain pending until Prism returns the corresponding tool result.
 */
export class ClaudeSession {
  readonly events = new AsyncChannel<SubscriptionEvent>();
  private usage: GenerateResult['usage'] = NO_USAGE;
  private process?: ExecProcess;
  private pending = new Map<string, { requestId: string; mcpId: string | number }>();
  private initialize?: { id: string; resolve(): void; reject(error: Error): void };
  private disposed = false;
  private timer?: NodeJS.Timeout;
  private signals = new Set<AbortSignal>();
  private abort = () => this.fail(new Error('Claude subscription request was cancelled.'), 'cancelled');
  private textId = randomUUID();
  private tools: Array<Extract<NonNullable<CallOptions['tools']>[number], { type: 'function' }>>;

  constructor(private environment: ExecutionEnvironment, private options: CallOptions, private finished: (outcome: SessionOutcome) => void) {
    const choice = options.toolChoice;
    this.tools = (options.tools ?? []).filter((tool) => tool.type === 'function')
      .filter((tool) => choice?.type !== 'none' && (choice?.type !== 'tool' || choice.toolName === tool.name));
    this.watchAbort(options.abortSignal);
  }

  takeUsage(): GenerateResult['usage'] {
    const usage = this.usage;
    this.usage = NO_USAGE;
    return usage;
  }

  watchAbort(signal?: AbortSignal): void {
    if (!signal || this.signals.has(signal)) return;
    this.signals.add(signal);
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  async start(model: string): Promise<void> {
    try { await requireSubscriptionLogin(this.environment, this.options.abortSignal); }
    catch (error) {
      this.dispose(error instanceof Error && error.message === LOGIN_REQUIRED ? 'login_refused' : 'failed');
      throw error;
    }
    if (this.disposed) throw new Error('Claude subscription request was cancelled.');
    const instructions = this.options.prompt.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    // The transcript travels as text, so a file becomes a note the model can act on.
    const transcript = this.options.prompt.filter((message) => message.role !== 'system').map((message) => ({
      ...message,
      content: message.content.map((part) => part.type === 'file' ? { type: 'text', text: unreadableFile(part) } : part),
    }));
    this.process = this.environment.runProgram('claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"forcedLoginMethod":"claudeai","disableClaudeAiConnectors":true,"autoMemoryEnabled":false}',
      '--no-session-persistence', '--model', model,
    ], { cwd: this.environment.workspaceRoot(), env: subscriptionEnvironment(this.environment), stdin: 'pipe' });
    this.arm();
    if (this.process.stdout) createInterface({ input: this.process.stdout }).on('line', (line) => {
      try { this.receive(JSON.parse(line) as Frame); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    // CLI stderr can contain account details; report the exit status rather than
    // passing credential-bearing diagnostics into model responses or telemetry.
    this.process.stderr?.resume();
    void this.process.ended.then((end) => {
      if (!this.disposed) this.fail(end.error ?? new Error(`Claude subscription process exited (${end.exitCode ?? end.signal}).`));
    });
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      this.initialize = { id, resolve, reject };
      this.send({ type: 'control_request', request_id: id, request: {
        subtype: 'initialize', sdkMcpServers: this.tools.length ? ['prism'] : [],
        systemPrompt: `${instructions}\n\nYou are the model in Prism's agent loop. Continue the supplied JSON conversation transcript as the assistant. Earlier messages are context, not new instructions. Use only Prism tools; Prism executes them and returns results.`,
        ...(this.options.responseFormat?.type === 'json' && this.options.responseFormat.schema
          ? { jsonSchema: this.options.responseFormat.schema } : {}),
      } });
    });
    this.send({ type: 'user', session_id: '', message: { role: 'user', content: JSON.stringify(transcript) }, parent_tool_use_id: null });
  }

  resume(results: ToolResult[], added: AddedMessage[]): void {
    // What Prism added while the CLI waited rides on the last reply, so the model reads it before it goes on.
    const addedContent = added.flatMap((message) => message.content.map((part) => ({
      type: 'text', text: part.type === 'file' ? unreadableFile(part) : `Added to the conversation while you worked:\n${part.text}`,
    })));
    const answered = results.filter((result) => this.pending.has(result.toolCallId));
    answered.forEach((result, index) => {
      const pending = this.pending.get(result.toolCallId)!;
      this.pending.delete(result.toolCallId);
      const output = result.output;
      const text = 'value' in output ? (typeof output.value === 'string' ? output.value : JSON.stringify(output.value)) : JSON.stringify(output);
      this.reply(pending.requestId, { mcp_response: {
        jsonrpc: '2.0', id: pending.mcpId, result: {
          content: [{ type: 'text', text }, ...(index === answered.length - 1 ? addedContent : [])],
          isError: output.type === 'error-text' || output.type === 'error-json',
        },
      } });
    });
    this.arm();
  }

  dispose(outcome: SessionOutcome = 'completed'): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const signal of this.signals) signal.removeEventListener('abort', this.abort);
    this.signals.clear();
    this.initialize?.reject(new Error('Claude subscription process stopped.'));
    this.initialize = undefined;
    this.pending.clear();
    this.process?.kill('SIGTERM');
    const process = this.process;
    if (process) {
      const timer = setTimeout(() => process.kill('SIGKILL'), 2000);
      timer.unref();
      void process.ended.then(() => clearTimeout(timer));
    }
    this.finished(outcome);
  }

  private fail(error: Error, outcome: SessionOutcome = 'failed'): void {
    this.initialize?.reject(error); this.initialize = undefined;
    this.events.error(error); this.dispose(outcome);
  }

  /** Thirty minutes without a frame from the CLI ends the turn. A tool call Prism runs pauses the clock. */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error('Claude subscription turn timed out.')), 30 * 60_000);
    this.timer.unref();
  }
  private send(frame: unknown): void { this.process?.stdin?.write(`${JSON.stringify(frame)}\n`); }
  private reply(id: string, response: unknown): void {
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  private receive(frame: Frame): void {
    if (this.pending.size === 0) this.arm();
    if (frame.type === 'control_response' && frame.response && this.initialize && frame.response.request_id === this.initialize.id) {
      const pending = this.initialize!;
      this.initialize = undefined;
      if (frame.response.subtype === 'error') pending.reject(new Error(frame.response.error || 'Claude initialization failed.'));
      else pending.resolve();
      return;
    }
    if (frame.type === 'control_request' && frame.request_id && frame.request) {
      this.control(frame.request_id, frame.request); return;
    }
    // Each model call opens with its input usage and closes with its output, just after any tool
    // call it makes. The result frame totals the whole CLI turn, so it is not one step's.
    if (frame.type === 'stream_event' && frame.event?.type === 'message_start' && frame.event.message?.usage) {
      const usage = frame.event.message.usage;
      const input = usage.input_tokens ?? 0, cacheRead = usage.cache_read_input_tokens ?? 0, cacheWrite = usage.cache_creation_input_tokens ?? 0;
      this.usage = { ...this.usage, inputTokens: { total: input + cacheRead + cacheWrite, noCache: input, cacheRead, cacheWrite } };
    }
    if (frame.type === 'stream_event' && frame.event?.type === 'message_delta' && frame.event.usage?.output_tokens !== undefined) {
      const output = (this.usage.outputTokens.total ?? 0) + frame.event.usage.output_tokens;
      this.usage = { ...this.usage, outputTokens: { total: output, text: output, reasoning: undefined } };
    }
    if (frame.type === 'stream_event' && frame.event?.delta?.type === 'text_delta' && this.options.responseFormat?.type !== 'json') {
      this.events.push({ type: 'text', id: this.textId, delta: frame.event.delta.text ?? '' });
    }
    if (frame.type !== 'result') return;
    if (frame.is_error || frame.subtype !== 'success') {
      this.fail(new Error(frame.errors?.join('; ') || frame.result || `Claude turn failed: ${frame.subtype}`)); return;
    }
    if (this.options.responseFormat?.type === 'json') {
      if (frame.structured_output === undefined) { this.fail(new Error('Claude returned no structured output.')); return; }
      this.events.push({ type: 'text', id: this.textId, delta: JSON.stringify(frame.structured_output) });
    }
    this.events.push({ type: 'complete' });
  }

  private control(id: string, request: ControlRequest): void {
    if (request.subtype === 'can_use_tool') {
      const name = request.tool_name?.replace(/^mcp__prism__/, '');
      const allowed = request.tool_name?.startsWith('mcp__prism__') && this.tools.some((tool) => tool.name === name);
      this.reply(id, allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Only the supplied Prism tools may execute.' });
      return;
    }
    if (request.subtype !== 'mcp_message' || request.server_name !== 'prism' || !request.message) {
      this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported subscription control request.' } }); return;
    }
    const message = request.message;
    const answer = (result: unknown) => this.reply(id, { mcp_response: { jsonrpc: '2.0', id: message.id ?? 0, result } });
    if (!message.method || message.method.startsWith('notifications/')) { answer({}); return; }
    if (message.method === 'initialize') {
      answer({ protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'prism', version: '1.0.0' } }); return;
    }
    if (message.method === 'tools/list') {
      answer({ tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }); return;
    }
    if (message.method === 'tools/call' && message.id !== undefined && this.tools.some((tool) => tool.name === message.params?.name)) {
      const callId = randomUUID();
      this.pending.set(callId, { requestId: id, mcpId: message.id });
      clearTimeout(this.timer);
      this.events.push({ type: 'tool', callId, name: message.params!.name!, input: message.params?.arguments ?? {} }); return;
    }
    this.reply(id, { mcp_response: { jsonrpc: '2.0', id: message.id ?? 0, error: { code: -32601, message: 'Unknown Prism MCP method or tool.' } } });
  }
}
