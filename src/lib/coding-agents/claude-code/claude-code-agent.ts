/**
 * Claude Code as a coding agent.
 *
 * Runs the `claude` CLI with `--output-format stream-json` and reads its NDJSON
 * stream back as the neutral events of `CodingAgent`. Auth inherits from the
 * runtime's environment: the CLI picks up the same Bedrock or Anthropic
 * credentials the agent itself uses.
 *
 * Its home is `<data dir>/.claude`, pointed at through `CLAUDE_CONFIG_DIR`, so
 * the CLI's own state (sessions, `.claude.json`) stays out of the data-dir root
 * and the user's real `~/.claude` is never touched. The CLI discovers skills
 * under `$CLAUDE_CONFIG_DIR/skills`, which is a symlink to the runtime's skills
 * dir: both read the same bytes.
 */

import { claudeCodeEnvironment } from './credentials';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ensureSymlink } from '../../data-dir';
import { runCli, type Spawner } from '../cli-run';
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentHome,
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

/** The optional spawner is a test hook; production runs the real binary. */
export function createClaudeCodeAgent(spawner: Spawner = spawn): CodingAgent {
  return {
    id: 'claude-code',
    displayName: DISPLAY_NAME,
    prepareHome,
    run: (task: CodingAgentTask): CodingAgentRun =>
      runCli(
        {
          taskId: task.taskId,
          displayName: DISPLAY_NAME,
          command: COMMAND,
          args: buildArgs(task),
          cwd: task.workdir,
          env: claudeCodeEnvironment(task.env),
          parseLine,
        },
        spawner,
      ),
  };
}

function prepareHome(dirs: { dataDir: string; skillsDir: string }): CodingAgentHome {
  // Report the operator's home and whether it links to the shared skills.
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) {
    return { configDir: override, skillsLinked: pointsAt(path.join(override, 'skills'), dirs.skillsDir) };
  }

  const configDir = path.join(dirs.dataDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });

  // Only the skills dir is linked into the config dir. Claude Code's own plugin
  // layout is `plugins/repos/…` plus a `config.json`, so linking the runtime's
  // Agent Plugins dir there would present it a tree it can't read — and a
  // plugin's skills already reach the CLI through the skills catalog.
  const skillsLinked = ensureSymlink(dirs.skillsDir, path.join(configDir, 'skills'));

  // The spawned CLI inherits process.env, so this is how it finds the home.
  process.env.CLAUDE_CONFIG_DIR = configDir;

  return { configDir, skillsLinked };
}

/** Whether `candidate` resolves to the same directory as `target`. */
function pointsAt(candidate: string, target: string): boolean {
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(target);
  } catch {
    return false;
  }
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
