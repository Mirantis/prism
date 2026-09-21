/**
 * An MCP stdio transport that starts its server in the execution environment.
 *
 * The SDK's own stdio transport spawns the server as a child of this process,
 * which only works while the server's files are on this machine's filesystem.
 * A plugin's files belong to the environment, so the process does too: this
 * one runs the same command through `runProgram` and speaks the same protocol
 * over its pipes — newline-delimited JSON, one message per line, which is what
 * MCP stdio is.
 */
import type { MCPTransport } from '@ai-sdk/mcp';
import type { JSONRPCMessage } from '@ai-sdk/mcp';
import { logger } from '../../logger';
import type { ExecProcess, ExecutionEnvironment } from './execution-environment';

export interface ExecStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class ExecStdioTransport implements MCPTransport {
  private process: ExecProcess | null = null;
  private buffered = '';
  private closed = false;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;

  constructor(
    private readonly environment: ExecutionEnvironment,
    private readonly server: ExecStdioServer,
  ) {}

  start(): Promise<void> {
    if (this.process) throw new Error('the MCP server is already started');

    const proc = this.environment.runProgram(this.server.command, this.server.args ?? [], {
      cwd: this.server.cwd ?? this.environment.workspaceRoot(),
      env: { ...this.environment.baseEnv(), ...this.server.env },
      stdin: 'pipe',
      processGroup: true,
    });
    this.process = proc;

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.receive(chunk));
    // The server's diagnostics are its own; a line here is not a protocol
    // message, and an undrained pipe would eventually block the server.
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (line: string) =>
      logger.debug({ command: this.server.command, line: line.trimEnd() }, '[PluginMCP] server'),
    );

    void proc.closed.then((end) => {
      if (end.error) this.onerror?.(end.error);
      this.finish();
    });

    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin) return Promise.reject(new Error('the MCP server is not started'));

    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    proc.kill('SIGTERM');
    await proc.ended;
    this.finish();
  }

  /** Split the stream on newlines and hand each whole line up as a message. */
  private receive(chunk: string): void {
    this.buffered += chunk;
    let cut = this.buffered.indexOf('\n');
    while (cut !== -1) {
      const line = this.buffered.slice(0, cut).trim();
      this.buffered = this.buffered.slice(cut + 1);
      if (line) this.deliver(line);
      cut = this.buffered.indexOf('\n');
    }
  }

  private deliver(line: string): void {
    try {
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    } catch (error) {
      // One unreadable line is the server's bug, not the end of the session.
      this.onerror?.(error);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
