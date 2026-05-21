/**
 * Shell tools — direct AI SDK tools (single-agent mode only).
 *
 * In multi-tenant mode the same tool surface is served by the
 * Nexus-hosted shell sandbox (reached via the per-agent Nexus MCP
 * token) — so this factory returns an empty record there.
 */

import { Tool, tool } from 'ai';
import { config } from '../../config';
import { runShellExec, shellExecInput } from './exec';
import { DEFAULT_EXEC_OUTPUT_LIMIT_BYTES, MAX_EXEC_OUTPUT_LIMIT } from './config';
import {
  runReadFile,
  runWriteFile,
  runEditFile,
  readFileInput,
  writeFileInput,
  editFileInput,
} from './files';
import {
  runClaudeCode,
  runClaudeCodeStatus,
  claudeCodeInput,
  claudeCodeStatusInput,
} from './claude-code';
import {
  runShellSpawn,
  runShellStdin,
  runShellStdout,
  runShellKill,
  shellSpawnInput,
  shellStdinInput,
  shellStdoutInput,
  shellKillInput,
} from './spawn';

export function getShellTools(): Record<string, Tool> {
  return {
    shell_exec: tool({
      description: `Run a single shell command. Returns { stdout, stderr, exitCode }. Each stream is capped (default ${DEFAULT_EXEC_OUTPUT_LIMIT_BYTES} bytes per stream; pass \`limit\` up to ${MAX_EXEC_OUTPUT_LIMIT} to read more). Truncated output ends with "... (truncated; exceeded N bytes)". For multi-step workflows or interactive tasks use claude_code instead.`,
      inputSchema: shellExecInput,
      execute: async (input) => runShellExec(input),
    }),

    shell_read_file: tool({
      description:
        'Read a file. Default returns up to 2000 lines. Output is line-numbered. Use offset/limit to read specific sections.',
      inputSchema: readFileInput,
      execute: async (input) => runReadFile(input),
    }),

    shell_write_file: tool({
      description:
        'Write a file. Overwrites existing files. Use shell_edit_file for modifying existing files; only use this for new files or full rewrites.',
      inputSchema: writeFileInput,
      execute: async (input) => runWriteFile(input),
    }),

    shell_edit_file: tool({
      description:
        'Perform exact string replacement in a file. Must call shell_read_file first. Fails if old_string is not found, or matches multiple times without replace_all. Falls back to whitespace-tolerant matching if the exact match fails.',
      inputSchema: editFileInput,
      execute: async (input) => runEditFile(input),
    }),

    claude_code: tool({
      description:
        'Start Claude Code as an autonomous sub-agent. Returns { taskId } immediately; poll with claude_code_status to stream output and check completion. Use for multi-step code workflows, debugging, exploration, builds, and anything where the next step depends on the previous result. Plan-then-edit: call once with mode="plan" to produce a plan, then call again with mode="edit" and the sessionId from the plan response to implement it. Max 3 concurrent tasks.',
      inputSchema: claudeCodeInput,
      execute: async (input) => runClaudeCode(input),
    }),

    claude_code_status: tool({
      description:
        'Poll a running claude_code task. Returns { output, completed, result, turns, stopReason, sessionId } — output is drained on read, so subsequent calls return only new output. When completed is true, result/turns/stopReason/sessionId are populated.',
      inputSchema: claudeCodeStatusInput,
      execute: async (input) => runClaudeCodeStatus(input),
    }),

    shell_spawn: tool({
      description:
        'Start a long-running shell command as a background process. Returns { processId } immediately. Use for builds, watchers, test loops, anything that takes more than a few seconds OR that you want to interact with via stdin. Use shell_stdout to drain output and check status; shell_stdin to feed input; shell_kill to terminate. Max 10 concurrent processes. For one-shot commands use shell_exec instead.',
      inputSchema: shellSpawnInput,
      execute: async (input) => runShellSpawn(input),
    }),

    shell_stdin: tool({
      description:
        'Write data to a running process\'s stdin. Pass the exact bytes (include newlines explicitly). Returns { ok: true } or { error }.',
      inputSchema: shellStdinInput,
      execute: async (input) => runShellStdin(input),
    }),

    shell_stdout: tool({
      description:
        'Drain accumulated output from a running process. Returns { stdout, stderr, exitCode, signal, running, truncated }. Output is drained-on-read — subsequent calls return only new bytes. Pass drainStderr:true to drain stderr instead of stdout (call once per stream). exitCode is null while running.',
      inputSchema: shellStdoutInput,
      execute: async (input) => runShellStdout(input),
    }),

    shell_kill: tool({
      description:
        'Send a signal to a running process and forget it. Default SIGTERM; pass SIGKILL for force-kill, SIGINT for Ctrl-C semantics, SIGHUP for hangup. Returns { ok: true } if the signal was delivered to a running process, { ok: false } if the process was already gone.',
      inputSchema: shellKillInput,
      execute: async (input) => runShellKill(input),
    }),
  };
}
