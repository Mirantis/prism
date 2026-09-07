import { bedrockRegion, hasBedrockCredentials } from '../bedrock-credentials';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ensureSymlink } from '../../data-dir';
import { runCli, type Spawner } from '../cli-run';
import type { CodingAgent, CodingAgentEvent, CodingAgentTask } from '../coding-agent';

interface StreamLine {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
  error?: { message: string };
  message?: string;
}

export function createCodexAgent(spawner: Spawner = spawn): CodingAgent {
  return {
    id: 'codex',
    displayName: 'Codex',
    prepareHome: ({ dataDir, skillsDir }) => {
      const configDir = process.env.CODEX_HOME || path.join(dataDir, '.codex');
      fs.mkdirSync(configDir, { recursive: true });
      const skillsLinked = ensureSymlink(skillsDir, path.join(configDir, 'skills'));
      process.env.CODEX_HOME = configDir;
      return { configDir, skillsLinked };
    },
    run: (task) => runCli({
      taskId: task.taskId,
      displayName: 'Codex',
      command: 'codex',
      args: buildArgs(task),
      cwd: task.workdir,
      env: {
        ...task.env,
        CODEX_API_KEY: task.env.OPENAI_API_KEY,
        ...(task.debug ? { RUST_LOG: 'debug' } : {}),
      },
      parseLine: createParser(),
    }, spawner),
  };
}

function buildArgs(task: CodingAgentTask): string[] {
  const sandbox = task.mode === 'plan'
    ? 'read-only'
    : task.gateMode === 'enforce' ? 'workspace-write' : 'danger-full-access';
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_mode="${sandbox}"`,
  ];
  if (!task.env.OPENAI_API_KEY && hasBedrockCredentials(task.env)) {
    args.push('-c', 'model_provider="amazon-bedrock"', '-c', 'model="openai.gpt-5.6-terra"');
    args.push('-c', `model_providers.amazon-bedrock.aws.region=${JSON.stringify(bedrockRegion(task.env))}`);
  } else {
    args.push('-c', 'model_provider="openai"', '-c', 'forced_login_method="api"');
  }
  if (task.appendSystemPrompt) {
    args.push('-c', `developer_instructions=${JSON.stringify(task.appendSystemPrompt)}`);
  }
  if (task.sessionId) args.push('resume', task.sessionId);
  // Mode is a per-turn instruction; developer instructions persist across resume.
  const mode = task.mode === 'plan'
    ? 'Analyze and plan only. Do not change files or run commands that change state.'
    : 'Implement the requested changes and verify the result.';
  args.push('--', `${mode}\n\n${task.prompt}`);
  return args;
}

// Codex reports one turn for the whole exec task, including its tool calls.
function createParser(): (line: string) => CodingAgentEvent[] {
  let answer = '';
  let error = '';
  return (line) => {
    const event = JSON.parse(line) as StreamLine;
    if (event.type === 'thread.started' && event.thread_id) {
      return [{ type: 'session', sessionId: event.thread_id }];
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      answer = event.item.text ?? '';
      return [{ type: 'text', text: answer }];
    }
    if (event.type === 'error') {
      // Connection retries can emit errors before a successful terminal event.
      error = event.message ?? '';
      return [];
    }
    if (event.type === 'turn.failed') {
      return [{ type: 'result', stopReason: 'error', turns: 1,
        message: event.error?.message || error || 'Codex task failed' }];
    }
    if (event.type === 'turn.completed') {
      return [{ type: 'result', stopReason: 'end_turn', turns: 1, message: answer }];
    }
    return [];
  };
}
