import { bedrockRegion } from '../bedrock-credentials';
import fs from 'fs';
import path from 'path';
import { config } from '../../../config';
import { trackEvent } from '../../telemetry';
import { ensureSymlink } from '../../data-dir';
import { runCli } from '../cli-run';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import type { CodingAgent, CodingAgentEvent, CodingAgentTask } from '../coding-agent';
import { codexApiKey, codexAuthMethod, resolveCodexHome } from './credentials';

interface StreamLine {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
  error?: { message: string };
  message?: string;
}

export function createCodexAgent(environment?: ExecutionEnvironment): CodingAgent {
  return {
    id: 'codex',
    displayName: 'Codex',
    prepareHome: ({ dataDir, skillsDir }) => {
      const configDir = resolveCodexHome(process.env, dataDir);
      fs.mkdirSync(configDir, { recursive: true });
      const skillsLinked = ensureSymlink(skillsDir, path.join(configDir, 'skills'));
      return { configDir, skillsLinked };
    },
    isAvailable: (env) => Promise.resolve(Boolean(codexAuthMethod(env))),
    run: (task) => {
      const authMethod = codexAuthMethod(task.env);
      const startedAt = Date.now();
      const props = { 'task.id': task.taskId, 'auth.method': authMethod ?? 'none' };
      trackEvent('codex task started', config.ownerUserId, props);
      const run = runCli({
        taskId: task.taskId,
        displayName: 'Codex',
        command: 'codex',
        args: buildArgs(task, authMethod),
        cwd: task.workdir,
        env: {
          ...task.env,
          CODEX_HOME: resolveCodexHome(task.env),
          CODEX_API_KEY: codexApiKey(task.env),
          ...(task.debug ? { RUST_LOG: 'debug' } : {}),
        },
        parseLine: createParser(),
      }, environment);
      let stopped = false;
      async function* events(): AsyncGenerator<CodingAgentEvent> {
        let status = 'error';
        try {
          for await (const event of run.events) {
            if (event.type === 'result') status = event.stopReason;
            yield event;
          }
        } finally {
          trackEvent('codex task finished', config.ownerUserId, {
            ...props, status: stopped ? 'stopped' : status,
            elapsed_ms: String(Date.now() - startedAt),
          });
        }
      }
      return {
        events: events(),
        get exited() { return run.exited; },
        stop: () => { stopped = true; run.stop(); },
      };
    },
  };
}

function buildArgs(task: CodingAgentTask, authMethod: ReturnType<typeof codexAuthMethod>): string[] {
  const sandbox = task.mode === 'plan'
    ? 'read-only'
    : task.gateMode === 'enforce' ? 'workspace-write' : 'danger-full-access';
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_mode="${sandbox}"`,
  ];
  const useBedrock = authMethod === 'bedrock';
  if (useBedrock) {
    // Bedrock identifies these models with the vendor prefix `openai.`; the
    // OpenAI endpoint uses bare ids. Tier defaults below follow the same rule.
    args.push('-c', 'model_provider="amazon-bedrock"');
    if (!task.modelTier) args.push('-c', 'model="openai.gpt-5.6-terra"');
    args.push('-c', `model_providers.amazon-bedrock.aws.region=${JSON.stringify(bedrockRegion(task.env))}`);
  } else {
    args.push('-c', 'model_provider="openai"');
    if (authMethod === 'api') args.push('-c', 'forced_login_method="api"');
    if (authMethod === 'saved') args.push('-c', 'cli_auth_credentials_store="file"');
  }
  // An omitted tier or effort must emit no selection flag here, preserving
  // deployment configuration and the existing Bedrock default above. Keep
  // both optional on resume too; a default tier would silently replace it.
  if (task.modelTier) {
    args.push('--model', config.codingAgentModels.codex[task.modelTier][useBedrock ? 'bedrock' : 'openai']);
  }
  if (task.effort) args.push('-c', `model_reasoning_effort="${task.effort}"`);
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
