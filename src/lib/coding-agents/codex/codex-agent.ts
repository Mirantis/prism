import { bedrockRegion } from '../bedrock-credentials';
import { config } from '../../../config';
import { trackEvent } from '../../telemetry';
import { runCli } from '../cli-run';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import {
  PLAN_ONLY_INSTRUCTION,
  type CodingAgent,
  type CodingAgentEvent,
  type CodingAgentTask,
} from '../coding-agent';
import {
  codexApiKey,
  codexAuthMethod,
  hasSavedCodexLogin,
  readCodexLogin,
  subscriptionEnvironment,
  SUBSCRIPTION_CONFIG_ARGS,
  type CodexAuthMethod,
} from './credentials';
import { deferredRun } from '../deferred-run';
import { usesSubscription } from '../subscription-switch';
import { notSignedInMessage } from '../subscription';
import {
  getExecutionEnvironment,
  getExecutionEnvironmentFor,
} from '../../execution-environments/get-execution-environment';
import { prepareSharedSkillsHome } from '../shared-skills-home';

interface StreamLine {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
  error?: { message: string };
  message?: string;
}

export function createCodexAgent(environment?: ExecutionEnvironment): CodingAgent {
  const target = () => environment ?? getExecutionEnvironment();
  // Read once, when availability is probed at boot: a task's argv is built
  // synchronously and the home may be a round trip away.
  let savedLogin = false;

  return {
    id: 'codex',
    displayName: 'Codex',
    prepareHome: () => {
      const env = target();
      return prepareSharedSkillsHome(env, env.paths().codexHome, process.env.CODEX_HOME);
    },
    isAvailable: async (env) => {
      savedLogin = await hasSavedCodexLogin(target());
      return Boolean(codexAuthMethod(env, savedLogin));
    },
    run: (task) => {
      const subscription = usesSubscription('codex');
      const authMethod: CodexAuthMethod | undefined = subscription
        ? 'subscription'
        : codexAuthMethod(task.env, savedLogin);
      const startedAt = Date.now();
      const props = { 'task.id': task.taskId, 'auth.method': authMethod ?? 'none' };
      trackEvent('codex task started', config.ownerUserId, props);
      // The environment the CLI runs in, which is also where its home is.
      const runIn = environment ?? getExecutionEnvironmentFor(task.workdir);
      const home = runIn.paths().codexHome;
      const launch = (env: NodeJS.ProcessEnv) => runCli({
        taskId: task.taskId,
        displayName: 'Codex',
        command: 'codex',
        args: buildArgs(task, authMethod),
        cwd: task.workdir,
        env: {
          ...env,
          CODEX_HOME: home,
          ...(task.debug ? { RUST_LOG: 'debug' } : {}),
        },
        parseLine: createParser(),
      }, runIn);
      const run = subscription
        ? deferredRun(task.taskId, 'Codex', async (signal) => {
          // Asked on every run, so a sign-in or a sign-out applies to the next task.
          // Anything but a ChatGPT login fails the task, which then bills nothing.
          const login = await readCodexLogin(runIn, task.env, home, signal);
          if (login !== 'chatgpt') {
            throw new Error(notSignedInMessage('codex'));
          }
          signal.throwIfAborted();
          return launch(subscriptionEnvironment(task.env));
        })
        : launch({ ...task.env, CODEX_API_KEY: codexApiKey(task.env) });
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
        get mark() { return run.mark; },
        started: run.started,
        stop: () => { stopped = true; run.stop(); },
      };
    },
  };
}

function buildArgs(task: CodingAgentTask, authMethod: CodexAuthMethod | undefined): string[] {
  // Every task runs without Codex's sandbox: in an unprivileged container, the
  // deployed shape, the sandbox cannot start and every command in it fails.
  // Nothing can answer an approval request, so none is asked.
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
  ];
  const useBedrock = authMethod === 'bedrock';
  if (useBedrock) {
    // Bedrock identifies these models with the vendor prefix `openai.`; the
    // OpenAI endpoint uses bare ids. Tier defaults below follow the same rule.
    args.push('-c', 'model_provider="amazon-bedrock"');
    if (!task.modelTier) args.push('-c', 'model="openai.gpt-5.6-terra"');
    args.push('-c', `model_providers.amazon-bedrock.aws.region=${JSON.stringify(bedrockRegion(task.env))}`);
  } else if (authMethod === 'subscription') {
    // A repository's `.codex/config.toml` cannot move the task off this login:
    // Codex 0.163 ignores its `model_provider`, `model_providers` and `profiles`.
    args.push(...SUBSCRIPTION_CONFIG_ARGS);
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
  // With no sandbox, the instruction is all that keeps a plan task read-only.
  const mode = task.mode === 'plan'
    ? PLAN_ONLY_INSTRUCTION
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
