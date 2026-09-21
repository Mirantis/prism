/**
 * Claude Code as a coding agent.
 *
 * Runs the `claude` CLI with `--output-format stream-json` and reads its NDJSON
 * stream back as the neutral events of `CodingAgent`. Auth inherits from the
 * runtime's environment: the CLI picks up the same Bedrock or Anthropic
 * credentials the agent itself uses.
 *
 * Its home is the execution environment's `claudeHome`, pointed at through
 * `CLAUDE_CONFIG_DIR`, so the CLI's own state (sessions, `.claude.json`) stays
 * out of the data-dir root and the user's real `~/.claude` is never touched.
 * The CLI discovers skills under `$CLAUDE_CONFIG_DIR/skills`, a symlink to the
 * environment's skills dir: both read the same bytes.
 */

import { claudeCodeEnvironment, hasClaudeCodeCredentials } from './credentials';
import { config } from '../../../config';
import { runCli } from '../cli-run';
import { getExecutionEnvironment } from '../../execution-environments/get-execution-environment';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { prepareSharedSkillsHome } from '../shared-skills-home';
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentRun,
  CodingAgentStopReason,
  CodingAgentTask,
} from '../coding-agent';

/**
 * Plan mode's read-only promise needs an instruction, not just a permission mode.
 * In the off/observe gate branch the sub-agent runs with bypass permissions, and
 * Claude Code auto-approves writes under `--permission-mode plan` whenever bypass
 * is available — verified: a plan-mode run with both flags overwrote a file on
 * request. Appended rather than substituted, so the default harness survives.
 */
export const PLAN_ONLY_INSTRUCTION =
  'You are in plan mode: analyze and plan only. Do not create, modify or delete any files, and do not run commands that change state (installs, commits, pushes, deployments).';

const DISPLAY_NAME = 'Claude Code';
const COMMAND = 'claude';

/** One line of `--output-format stream-json`. */
interface StreamLine {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  subtype?: string;
  result?: string;
  num_turns?: number;
  session_id?: string;
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
    run: (task: CodingAgentTask): CodingAgentRun =>
      runCli(
        {
          taskId: task.taskId,
          displayName: DISPLAY_NAME,
          command: COMMAND,
          args: buildArgs(task),
          cwd: task.workdir,
          env: {
            ...claudeCodeEnvironment(task.env),
            // Stated on the task's env rather than inherited from this
            // process: the CLI runs in the execution environment.
            CLAUDE_CONFIG_DIR: (environment ?? getExecutionEnvironment()).paths().claudeHome,
          },
          parseLine,
        },
        environment,
      ),
  };
}

function buildArgs(task: CodingAgentTask): string[] {
  const args: string[] = [
    '-p',
    task.prompt,
    '--output-format',
    'stream-json',
    '--verbose', // required with --output-format stream-json + -p
    '--max-turns',
    String(task.maxTurns),
  ];

  // The outer tool-risk gate can only assess the delegation call itself, not
  // each action Claude Code takes after it starts. In enforce mode, delegate
  // those nested checks to Claude Code's auto-mode classifier and never retain
  // the permissions bypass. Plan mode is already more restrictive, so keep it
  // in plan without making bypass permissions available.
  if (task.gateMode === 'enforce') {
    args.push('--permission-mode', task.mode === 'plan' ? 'plan' : 'auto');
  } else {
    // Preserve existing behavior in off/observe mode. Observe mode promises to
    // measure policy decisions without changing whether calls execute.
    args.push('--dangerously-skip-permissions');
    if (task.mode === 'plan') {
      args.push('--permission-mode', 'plan');
    }
  }

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
    args.push('--model', config.codingAgentModels['claude-code'][task.modelTier]);
  }
  if (task.effort) args.push('--effort', task.effort);
  if (task.sessionId) {
    args.push('--resume', task.sessionId);
  }
  args.push('--disallowed-tools', 'AskUserQuestion');
  if (task.debug) args.push('--debug');

  return args;
}

function parseLine(line: string): CodingAgentEvent[] {
  const parsed = JSON.parse(line) as StreamLine;
  const events: CodingAgentEvent[] = [];

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
    const subtype = parsed.subtype ?? 'error';
    events.push({
      type: 'result',
      stopReason: stopReasonOf(subtype),
      turns: parsed.num_turns ?? 0,
      message: parsed.result ?? subtype,
    });
  }

  return events;
}

function stopReasonOf(subtype: string): CodingAgentStopReason {
  if (subtype === 'success') return 'end_turn';
  if (subtype === 'error_max_turns') return 'max_turns';
  return 'error';
}
