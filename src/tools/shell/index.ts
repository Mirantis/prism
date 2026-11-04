/**
 * Shell tools — direct AI SDK tools.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { runShellExec, shellExecInput } from './exec';
import { resolveWorkspace } from '../../lib/execution-environments/workspace';
import {
  runReadFile,
  runWriteFile,
  runEditFile,
  readFileInput,
  writeFileInput,
  editFileInput,
} from './files';
import { resolvePath } from './workspace';
import type { PendingFileWrites } from '../../lib/pending-file-writes';
import type { TaskNotificationTarget } from '../../services/task-notification.service';
import { monitorInput, monitorStopInput, runMonitor, runMonitorStop } from './monitor';
import { BATCH_MS, MAX_MONITORS, MAX_NOTIFICATIONS_PER_MINUTE } from './monitor-manager';
import {
  runCodingAgent,
  runCodingAgentStatus,
  runCodingAgentStop,
  buildCodingAgentInput,
  codingAgentStatusInput,
  codingAgentStopInput,
} from './coding-agent';
import { config } from '../../config';
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
 *
 * `pendingWrites` lets a reader in the same step wait for a write to the file it
 * is about to read — see `lib/pending-file-writes.ts`. The two file tools register
 * their path; `shell_exec` registers none, since it can write any file. So a
 * `share_file` in the same step as any `shell_exec` waits for that command, and
 * one that runs past `PENDING_WRITE_TIMEOUT_MS` gets the share refused. A call the
 * tool risk gate blocks never reaches `execute`, so it holds its sibling shares
 * for that whole timeout. `coding_agent` and `shell_spawn` write after their call
 * returns, so no reader in the step can wait for them. Optional, because a caller
 * that passes none (the meeting tool bridge, tests) must keep today's behaviour.
 */
export function getShellTools(
  workspaceRoot?: string,
  pendingWrites?: PendingFileWrites,
  taskNotifications?: TaskNotificationTarget,
): Record<string, Tool> {
  const workspace = resolveWorkspace(workspaceRoot);
  // Named in the tool description so the model knows what it is delegating
  // to. Fixed per process, so the description is byte-identical every turn.
  const availableAgents = config.availableCodingAgents.join(', ') || 'none detected';

  /**
   * Announce the write before the step's tools start, to `pathOf(input)` or, with
   * no `pathOf`, to any file, and release it once the write has returned —
   * including when it returns an error, so a failed write never strands a reader
   * for the whole timeout.
   */
  const tracked = <I, R>(
    toolName: string,
    run: (input: I, abortSignal?: AbortSignal) => Promise<R>,
    pathOf?: (input: I) => string,
  ) => ({
    onInputAvailable: ({ input, toolCallId }: { input: I; toolCallId: string }) => {
      const fullPath = pathOf ? resolvePath(workspace, pathOf(input)) : undefined;
      pendingWrites?.register(toolCallId, toolName, fullPath);
    },
    execute: async (
      input: I,
      { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal },
    ) => {
      try {
        return await run(input, abortSignal);
      } finally {
        pendingWrites?.settle(toolCallId);
      }
    },
  });

  return {
    shell_exec: tool({
      description:
        'Run a single shell command. Returns { stdout, stderr, exitCode }. Each stream is capped; ' +
        'pass `limit` to read more. Truncated output ends with "... (truncated; exceeded N bytes)". ' +
        'Credentials and config files for any integrations connected to this project are injected ' +
        'into your sandbox automatically. When a user asks you to interact with external resources, ' +
        "run the appropriate CLI with this tool — don't refuse based on assumed lack of access. If " +
        "the CLI isn't on `$PATH`, try installing it via `mise install <tool>@latest` and then " +
        "re-run. If an integration isn't wired up for a task, the CLI will return a clear error you " +
        'can relay back. For multi-step workflows or interactive tasks use coding_agent instead.',
      inputSchema: shellExecInput,
      // Forward the per-turn AbortSignal so a canceled turn kills the child
      // process instead of leaving it to run on to its own timeout.
      ...tracked('shell_exec', (input: z.infer<typeof shellExecInput>, abortSignal) =>
        runShellExec(input, workspace, abortSignal),
      ),
    }),

    shell_read_file: tool({
      description:
        'Read a file. Output is line-numbered. Use offset/limit to read specific sections.',
      inputSchema: readFileInput,
      execute: async (input) => runReadFile(input, workspace),
    }),

    shell_write_file: tool({
      description:
        'Write a file. Overwrites existing files. Use shell_edit_file for modifying existing files; only use this for new files or full rewrites.',
      inputSchema: writeFileInput,
      ...tracked(
        'shell_write_file',
        (input: z.infer<typeof writeFileInput>) => runWriteFile(input, workspace),
        (input) => input.path,
      ),
    }),

    shell_edit_file: tool({
      description:
        'Perform exact string replacement in a file. Read the file with shell_read_file first. Fails if old_string is not found, or matches multiple times without replace_all. Falls back to whitespace-tolerant matching if the exact match fails; replace_all needs an exact match.',
      inputSchema: editFileInput,
      ...tracked(
        'shell_edit_file',
        (input: z.infer<typeof editFileInput>) => runEditFile(input, workspace),
        (input) => input.path,
      ),
    }),

    coding_agent: tool({
      description: `Start an autonomous sub-agent with its own shell, file access, web access where the sandbox allows it, and an agentic loop. Use it for any task of many dependent steps, not only for code. For example: research a topic on the internet, or across files, logs, documents and data; analyze command output, test results, metrics or a database, and investigate an incident; create reports, summaries, comparisons and HTML overviews; produce diagrams (Mermaid, Graphviz, SVG), charts, slides, spreadsheets and web pages; draft or review a document, a ticket, a specification or a plan; process, convert or transform files; write, debug, build and test code. When a Task subagent's description matches the work, use Task instead.

Prefer it over a long chain of hand-run shell calls, because the sub-agent keeps those steps in its own context. A task runs for minutes, so for a single command or a short, fixed sequence, use the shell tools directly. When the result is a file for the user, have the sub-agent write it to the workspace, then share it with share_file if you have that tool.

mode="edit" (the default) can create and change files. mode="plan" tells the sub-agent to analyze and report without changing anything: use it to analyze or research files, logs and data. For a self-contained deliverable, such as a report, a diagram or a converted file, one mode="edit" call is enough. For a change to existing work, plan, then edit: call once with mode="plan", then call again with mode="edit" and the sessionId from the plan response. If a plan comes back with open questions, settle them (ask the user if you cannot) and resume the same session in mode="plan" with your answers in the prompt. Switch to edit only when no open questions remain. To continue earlier work, resume its sessionId instead of starting cold.

Available agent values: ${availableAgents}. Default agent: ${config.codingAgent}; pass agent to override it, and use the same agent when you resume a session. Returns { taskId, agent } immediately. In a chat conversation, the task's result arrives as a task notification that starts a new turn when the task ends: after starting it, end your turn unless you have other work, and do not sleep, poll or schedule a check for it. In other runs, poll with coding_agent_status. Stop a task with coding_agent_stop. Choose model and effort for each task: their fields say what each tier is for, and an omitted value keeps the deployment default. Max 3 concurrent tasks.`,
      inputSchema: buildCodingAgentInput(),
      execute: async (input) => runCodingAgent(input, workspace, taskNotifications),
    }),

    coding_agent_status: tool({
      description:
        'Read a coding_agent task\'s progress, and its result once it ends. In a chat conversation the result also arrives as a task notification, so there is no need to wait for it here. Returns { agent, output, completed, result, turns, stopReason, sessionId, refusals } — output is drained on read, so subsequent calls return only new output. When completed is true, result/turns/stopReason/sessionId are populated. refusals lists each action the sub-agent\'s permission checks refused; a task that otherwise finished then has stopReason "refused".',
      inputSchema: codingAgentStatusInput,
      execute: async (input) => runCodingAgentStatus(input),
    }),

    coding_agent_stop: tool({
      description:
        'Terminate a running coding_agent task. Use when it is heading the wrong way, looping, stuck, or no longer needed, rather than waiting out its turn budget. Returns the same shape as coding_agent_status: any output produced before termination, completed:true, and stopReason:"stopped". sessionId comes back whenever the sub-agent got far enough to report one — pass it to coding_agent({ prompt, agent, sessionId }) to resume the abandoned work with its context instead of starting over. The taskId is invalid afterwards and its concurrency slot is freed immediately.',
      inputSchema: codingAgentStopInput,
      execute: async (input) => runCodingAgentStop(input),
    }),

    shell_spawn: tool({
      description:
        'Start a long-running shell command as a background process. Returns { processId } immediately. Use for builds, watchers, test loops, anything that takes more than a few seconds or that you want to interact with via stdin. Use shell_stdout to drain output and check status; shell_stdin to feed input; shell_kill to terminate. Max 10 concurrent processes. For one-shot commands use shell_exec instead.',
      inputSchema: shellSpawnInput,
      execute: async (input) => runShellSpawn(input, workspace),
    }),

    shell_stdin: tool({
      description:
        'Write data to a running process\'s stdin. Returns { ok: true } or { error }.',
      inputSchema: shellStdinInput,
      execute: async (input) => runShellStdin(input),
    }),

    shell_stdout: tool({
      description:
        'Drain accumulated output from a running process. Returns { stdout, stderr, exitCode, signal, running, truncated }. Output is drained-on-read — subsequent calls return only new bytes. exitCode is null while running.',
      inputSchema: shellStdoutInput,
      execute: async (input) => runShellStdout(input),
    }),

    shell_kill: tool({
      description:
        'Send a signal to a running process. Default SIGTERM; pass SIGKILL for force-kill, SIGINT for Ctrl-C semantics, SIGHUP for hangup. Returns { ok: true } if the signal was delivered to a running process, { ok: false } if the process was already gone.',
      inputSchema: shellKillInput,
      execute: async (input) => runShellKill(input),
    }),

    // A monitor reports to a chat conversation, so only a chat turn has one.
    ...(taskNotifications ? getMonitorTools(workspace, taskNotifications) : {}),
  };
}

function getMonitorTools(workspace: string, notify: TaskNotificationTarget): Record<string, Tool> {
  return {
    monitor: tool({
      description: `Start a monitor: a shell command whose stdout lines are events. Each line it prints reaches this conversation as a task notification that starts a new turn, so you can end your turn and react when something happens. Lines printed within ${BATCH_MS} ms of the first arrive as one notification. The monitor ends when the command exits (one last notification, with the exit code), when timeoutMs passes (default 5 minutes, at most 30, with one last notification: start it again if the watch is still needed), or when it prints more than ${MAX_NOTIFICATIONS_PER_MINUTE} times a minute.

Use it instead of a sleep, a polling loop or a scheduled check whenever you wait for something to happen:
- One notification per occurrence: a command that runs until the deadline, such as \`tail -f app.log | grep --line-buffered ERROR\`.
- One notification when a condition holds: a command that exits then, such as \`until curl -sf https://host/health; do sleep 5; done; echo healthy\`.

Every stage of a pipe must flush each line, or the lines wait in its buffer: grep needs --line-buffered, awk needs fflush(). Match the failures as well as the success you wait for (Error|FAIL|Traceback|exited), because a monitor that stays silent looks the same as one still waiting. Only stdout is an event: add 2>&1 to see a command's errors. Poll a remote API at most every 30 seconds. Returns { monitorId }; stop a monitor with monitor_stop. At most ${MAX_MONITORS} run at once.`,
      inputSchema: monitorInput,
      execute: async (input) => runMonitor(input, workspace, notify),
    }),

    monitor_stop: tool({
      description:
        'Stop a monitor you no longer need. No notification follows. Returns { ok: true } if it was running, { ok: false } if it had already ended.',
      inputSchema: monitorStopInput,
      execute: async (input) => runMonitorStop(input),
    }),
  };
}
