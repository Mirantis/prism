/**
 * Shell tools — direct AI SDK tools.
 */

import { Tool, tool } from 'ai';
import { runShellExec, shellExecInput } from './exec';
import {
  DEFAULT_EXEC_OUTPUT_LIMIT_BYTES,
  MAX_EXEC_OUTPUT_LIMIT,
  resolveWorkspace,
} from './config';
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
  runClaudeCodeStop,
  claudeCodeInput,
  claudeCodeStatusInput,
  claudeCodeStopInput,
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

/**
 * Build the shell tool set. `workspaceRoot` is the per-thread workspace (e.g.
 * persisted from the CLI's launch cwd); it's resolved once here via
 * `resolveWorkspace` — the single owner of the per-thread-vs-global fallback —
 * and the concrete path is handed to every tool's handler.
 */
export function getShellTools(workspaceRoot?: string): Record<string, Tool> {
  const workspace = resolveWorkspace(workspaceRoot);
  return {
    shell_exec: tool({
      description: `Run a single shell command. Returns { stdout, stderr, exitCode }. Each stream is capped (default ${DEFAULT_EXEC_OUTPUT_LIMIT_BYTES} bytes per stream; pass \`limit\` up to ${MAX_EXEC_OUTPUT_LIMIT} to read more). Truncated output ends with "... (truncated; exceeded N bytes)". For multi-step workflows or interactive tasks use claude_code instead.`,
      inputSchema: shellExecInput,
      // Forward the per-turn AbortSignal so a canceled turn kills the child
      // process instead of leaving it to run on to its own timeout.
      execute: async (input, { abortSignal }) => runShellExec(input, workspace, abortSignal),
    }),

    shell_read_file: tool({
      description:
        'Read a file. Default returns up to 2000 lines. Output is line-numbered. Use offset/limit to read specific sections.',
      inputSchema: readFileInput,
      execute: async (input) => runReadFile(input, workspace),
    }),

    shell_write_file: tool({
      description:
        'Write a file. Overwrites existing files. Use shell_edit_file for modifying existing files; only use this for new files or full rewrites.',
      inputSchema: writeFileInput,
      execute: async (input) => runWriteFile(input, workspace),
    }),

    shell_edit_file: tool({
      description:
        'Perform exact string replacement in a file. Must call shell_read_file first. Fails if old_string is not found, or matches multiple times without replace_all. Falls back to whitespace-tolerant matching if the exact match fails.',
      inputSchema: editFileInput,
      execute: async (input) => runEditFile(input, workspace),
    }),

    claude_code: tool({
      description:
        'Start Claude Code as an autonomous sub-agent. Returns { taskId } immediately; poll with claude_code_status to stream output and check completion, or claude_code_stop to abandon it. Use for multi-step code workflows, debugging, exploration, builds, and anything where the next step depends on the previous result. Plan-then-edit: call once with mode="plan" to produce a plan, then call again with mode="edit" and the sessionId from the plan response to implement it. Max 3 concurrent tasks.',
      inputSchema: claudeCodeInput,
      execute: async (input) => runClaudeCode(input, workspace),
    }),

    claude_code_status: tool({
      description:
        'Poll a running claude_code task. Returns { output, completed, result, turns, stopReason, sessionId } — output is drained on read, so subsequent calls return only new output. When completed is true, result/turns/stopReason/sessionId are populated.',
      inputSchema: claudeCodeStatusInput,
      execute: async (input) => runClaudeCodeStatus(input),
    }),

    claude_code_stop: tool({
      description:
        'Terminate a running claude_code task. Use when it is heading the wrong way, looping, stuck, or no longer needed, rather than waiting out its turn budget. Returns the same shape as claude_code_status: any output produced before termination, completed:true, and stopReason:"stopped". sessionId comes back whenever the sub-agent got far enough to report one — pass it to claude_code({ prompt, sessionId }) to resume the abandoned work with its context instead of starting over. The taskId is invalid afterwards and its concurrency slot is freed immediately.',
      inputSchema: claudeCodeStopInput,
      execute: async (input) => runClaudeCodeStop(input),
    }),

    shell_spawn: tool({
      description:
        'Start a long-running shell command as a background process. Returns { processId } immediately. Use for builds, watchers, test loops, anything that takes more than a few seconds OR that you want to interact with via stdin. Use shell_stdout to drain output and check status; shell_stdin to feed input; shell_kill to terminate. Max 10 concurrent processes. For one-shot commands use shell_exec instead.',
      inputSchema: shellSpawnInput,
      execute: async (input) => runShellSpawn(input, workspace),
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
