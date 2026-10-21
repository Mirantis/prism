/**
 * Claude Code as a coding agent.
 *
 * Runs the `claude` CLI with `--output-format stream-json` and reads its NDJSON
 * stream back as the neutral events of `CodingAgent`. With
 * `CLAUDE_CODE_SUBSCRIPTION` on, every task runs on the Claude subscription
 * signed in to the CLI's home. Otherwise auth inherits from the runtime's
 * environment: the CLI picks up the same Bedrock or Anthropic credentials the
 * agent itself uses.
 *
 * Its home is the execution environment's `claudeHome`, pointed at through
 * `CLAUDE_CONFIG_DIR`, so the CLI's own state (sessions, `.claude.json`) stays
 * out of the data-dir root and the user's real `~/.claude` is never touched.
 * The CLI discovers skills under `$CLAUDE_CONFIG_DIR/skills`, a symlink to the
 * environment's skills dir: both read the same bytes. Its MCP servers are the
 * runtime's own, given in a config file written for each task (`mcp-config.ts`).
 */

import { claudeCodeEnvironment, hasClaudeCodeCredentials } from './credentials';
import { readSavedLogin, subscriptionEnvironment, SUBSCRIPTION_SETTINGS } from './authenticated-home';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { runCli } from '../cli-run';
import { deferredRun } from '../deferred-run';
import {
  getExecutionEnvironment,
  getExecutionEnvironmentFor,
} from '../../execution-environments/get-execution-environment';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { prepareSharedSkillsHome } from '../shared-skills-home';
import { startWithMcpConfig } from './mcp-config';
import {
  PLAN_ONLY_INSTRUCTION,
  type CodingAgent,
  type CodingAgentEvent,
  type CodingAgentRefusal,
  type CodingAgentRun,
  type CodingAgentStopReason,
  type CodingAgentTask,
} from '../coding-agent';

const DISPLAY_NAME = 'Claude Code';
const COMMAND = 'claude';

/** The input fields that name what a refused tool call was aimed at, most specific first. */
const TARGET_FIELDS = ['file_path', 'notebook_path', 'command', 'url', 'path', 'pattern'];

/** A refused call's target is cut here: a shell command can be a whole script. */
const MAX_TARGET_CHARS = 200;

/** One tool call the CLI's permission checks refused, as the `result` line lists it. */
interface PermissionDenial {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** One line of `--output-format stream-json`. */
interface StreamLine {
  type?: string;
  /** On the opening `system`/`init` line: what the CLI really started with. */
  model?: string;
  permissionMode?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  session_id?: string;
  permission_denials?: PermissionDenial[];
}

/** The optional environment is a test hook; production runs the real binary. */
export function createClaudeCodeAgent(environment?: ExecutionEnvironment): CodingAgent {
  return {
    id: 'claude-code',
    displayName: DISPLAY_NAME,
    prepareHome: () => {
      const env = environment ?? getExecutionEnvironment();
      return prepareSharedSkillsHome(env, env.paths().claudeHome, process.env.CLAUDE_CONFIG_DIR);
    },
    isAvailable: hasClaudeCodeCredentials,
    run: (task: CodingAgentTask): CodingAgentRun => {
      // The environment the CLI runs in, which is also where its home and its
      // MCP config have to be.
      const target = environment ?? getExecutionEnvironmentFor(task.workdir);
      const home = target.paths().claudeHome;
      return deferredRun(task.taskId, DISPLAY_NAME, async (signal) => {
        const subscription = config.claudeCodeSubscription;
        // Asked on every run, so a sign-in or a sign-out applies to the next task.
        // Anything but a subscription login fails the task, which then bills nothing.
        if (subscription && (await readSavedLogin(target, task.env, home, signal)) !== 'subscription') {
          throw new Error(
            `CLAUDE_CODE_SUBSCRIPTION is on, and the Claude home ${home} has no subscription login: sign in to it with claude auth login`,
          );
        }
        signal.throwIfAborted();
        const env = subscription ? subscriptionEnvironment(task.env) : claudeCodeEnvironment(task.env);
        const launch = (mcpConfigPath?: string): CodingAgentRun =>
          runCli(
            {
              taskId: task.taskId,
              displayName: DISPLAY_NAME,
              command: COMMAND,
              args: buildArgs(task, env.CLAUDE_CODE_USE_BEDROCK === '1', subscription, mcpConfigPath),
              cwd: task.workdir,
              env: {
                ...env,
                // Stated on the task's env rather than inherited from this
                // process: the CLI runs in the execution environment.
                CLAUDE_CONFIG_DIR: home,
              },
              parseLine: (line) => parseLine(line, task),
            },
            target,
          );
        return task.mcpServers.length === 0
          ? launch()
          : startWithMcpConfig(task, target, signal, launch);
      });
    },
  };
}

function buildArgs(
  task: CodingAgentTask,
  onBedrock: boolean,
  subscription: boolean,
  mcpConfigPath?: string,
): string[] {
  const args: string[] = [
    '-p',
    task.prompt,
    '--output-format',
    'stream-json',
    '--verbose', // required with --output-format stream-json + -p
    '--max-turns',
    String(task.maxTurns),
  ];

  // The CLI's own checks decide each action: its classifier in auto mode, the
  // read-only rule in plan mode. With no terminal a refused action is skipped,
  // the run goes on, and the result line lists it.
  args.push('--permission-mode', task.mode === 'plan' ? 'plan' : 'auto');
  // On the subscription the CLI takes the claude.ai login and no other, also
  // when the repository's own settings name another provider or key.
  if (subscription) args.push('--settings', SUBSCRIPTION_SETTINGS);

  // The CLI enforces plan mode too; stating it keeps the model planning instead of
  // spending turns on actions the CLI refuses.
  // Always append, never replace: --system-prompt would substitute Claude Code's
  // default harness (tool selection, todo discipline, search conventions), which is
  // what a plan-mode delegation most needs. Both the plan constraint and a caller's
  // own framing ride one flag, so neither can drop the other.
  const appended = [task.mode === 'plan' ? PLAN_ONLY_INSTRUCTION : undefined, task.appendSystemPrompt]
    .filter(Boolean)
    .join('\n\n');
  if (appended) {
    args.push('--append-system-prompt', appended);
  }
  // An omitted tier or effort must emit no selection flag: the deployment's
  // configured model and effort stay in force. Keep both optional, including
  // on resume; a default tier would silently override that configuration.
  if (task.modelTier) {
    const models = config.codingAgentModels['claude-code'][task.modelTier];
    args.push('--model', onBedrock ? models.bedrock : models.default);
  }
  if (task.effort) args.push('--effort', task.effort);
  if (task.sessionId) {
    args.push('--resume', task.sessionId);
  }
  args.push('--disallowed-tools', 'AskUserQuestion');
  // Strict, so the CLI's MCP servers are the runtime's alone: an `.mcp.json` in
  // the working directory adds none, also when the runtime has none to give.
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  args.push('--strict-mcp-config');
  if (task.debug) args.push('--debug');

  return args;
}

function parseLine(line: string, task: CodingAgentTask): CodingAgentEvent[] {
  const parsed = JSON.parse(line) as StreamLine;
  const events: CodingAgentEvent[] = [];

  // Where auto mode is unavailable, most often for the model, the CLI starts in
  // Manual mode and refuses every action that needs approval; the refusals alone
  // read like a policy decision.
  if (parsed.subtype === 'init' && task.mode === 'edit' && parsed.permissionMode !== 'auto') {
    logger.warn(
      { taskId: task.taskId, model: parsed.model, permissionMode: parsed.permissionMode },
      '[AgentTask] Claude Code did not start in auto mode, so it refuses every action that needs approval; check that its model supports auto mode',
    );
  }

  // The CLI announces the session on its opening line (`system`/`init`), long
  // before the `result` line, and repeats it on every line after. Reporting it
  // as it appears is what lets a *stopped* task be resumed.
  if (typeof parsed.session_id === 'string') {
    events.push({ type: 'session', sessionId: parsed.session_id });
  }

  if (parsed.type === 'assistant' && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ type: 'text', text: block.text });
      }
    }
  } else if (parsed.type === 'result') {
    const refusals = (parsed.permission_denials ?? []).map(refusalOf);
    events.push({
      type: 'result',
      stopReason: stopReasonOf(parsed),
      turns: parsed.num_turns ?? 0,
      message: parsed.result ?? parsed.subtype ?? 'error',
      ...(refusals.length > 0 ? { refusals } : {}),
    });
  }

  return events;
}

function stopReasonOf(line: StreamLine): CodingAgentStopReason {
  if (line.subtype === 'error_max_turns') return 'max_turns';
  // A failed model call ends the run with subtype `success` and `is_error` set.
  if (line.subtype === 'success' && !line.is_error) return 'end_turn';
  return 'error';
}

function refusalOf({ tool_name, tool_input }: PermissionDenial): CodingAgentRefusal {
  const field = TARGET_FIELDS.find((name) => typeof tool_input[name] === 'string');
  // One line per refusal in the result, so a multi-line command is folded.
  const target = (field ? String(tool_input[field]) : JSON.stringify(tool_input)).replace(/\s+/g, ' ').trim();
  return {
    action: tool_name,
    target: target.length > MAX_TARGET_CHARS ? `${target.slice(0, MAX_TARGET_CHARS)}…` : target,
  };
}
