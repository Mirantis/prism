/**
 * The coding-agent contract: what the runtime needs from a coding agent to
 * delegate a task to it, and nothing about how the agent is run.
 *
 * An adapter (one folder per agent, `get-coding-agent.ts` selects it from
 * credentials) gives the agent a home at boot and runs each task end to end:
 * it launches the agent however that agent is launched, reads whatever the
 * agent emits, and reports it as the neutral events below. The task manager in
 * `tools/shell/agent-task-manager.ts` buffers those events for the model's
 * polls, so a new agent is one adapter and no change to the tools.
 */

import type { CodingAgentName } from '../../config';

export interface CodingAgent {
  /** The adapter identifier. */
  readonly id: CodingAgentName;
  /** The name shown to the model in the tool description and in the startup log. */
  readonly displayName: string;
  /**
   * Boot-time setup: a home for the agent in the execution environment that
   * shares that environment's skills dir, so both work from one set of skills.
   * Asynchronous because the environment's filesystem may not be this
   * process's own.
   */
  prepareHome(): Promise<CodingAgentHome>;
  /**
   * Whether this agent has what it needs to run: its own credential rules,
   * answered against the execution environment, since that is where its binary
   * and its saved login are. Asked once at boot — see `availability.ts`.
   */
  isAvailable(env: NodeJS.ProcessEnv): Promise<boolean>;
  /**
   * Start one task. Never throws for a launch failure: that arrives as the run's
   * closing `result` event, so the caller has one path for every outcome.
   */
  run(task: CodingAgentTask): CodingAgentRun;
}

/**
 * Plan mode's read-only promise, stated to the agent's model. Where the CLI does
 * not enforce plan mode, it is the whole promise.
 */
export const PLAN_ONLY_INSTRUCTION =
  'You are in plan mode: analyze and plan only. Do not create, modify or delete any files, do not run commands that change state (installs, commits, pushes, deployments), and do not call tools that create, change or delete anything in another system (tickets, comments, pages, pull requests).';

export interface CodingAgentTask {
  /** The manager's id for the task, for log correlation. */
  taskId: string;
  prompt: string;
  workdir?: string;
  /** The environment the agent inherits; the manager supplies the shell sandbox's. */
  env: NodeJS.ProcessEnv;
  /** `plan` analyzes only; `edit` may change files and run commands. */
  mode: 'edit' | 'plan';
  modelTier?: 'small' | 'medium' | 'large';
  effort?: 'low' | 'medium' | 'high';
  maxTurns: number;
  /** Extra instructions for the agent, kept alongside its own defaults. */
  appendSystemPrompt?: string;
  /** A session id an earlier run reported, to resume its context. */
  sessionId?: string;
  debug?: boolean;
}

export interface CodingAgentRun {
  /**
   * The agent's events in order. The stream ends with exactly one `result`, also
   * when the agent failed to start or exited without reporting one.
   */
  readonly events: AsyncIterable<CodingAgentEvent>;
  /** True once the agent has exited. */
  readonly exited: boolean;
  /** Ask the run to end, gracefully first and then forced. The stream still ends with a `result`. */
  stop(): void;
}

export type CodingAgentStopReason = 'end_turn' | 'max_turns' | 'error';

/** An action the agent's own permission checks refused during a run. */
export interface CodingAgentRefusal {
  /** The tool or operation, in the agent's own name for it. */
  action: string;
  /** What the action was aimed at: a path, a command, or its input. */
  target: string;
}

export type CodingAgentEvent =
  /** Output for the caller, streamed as it is produced. */
  | { type: 'text'; text: string }
  /** The id a later task passes as `sessionId` to resume this one's context. */
  | { type: 'session'; sessionId: string }
  /**
   * The outcome. `message` is the agent's own closing text: its answer, or what
   * went wrong. `refusals` lists the actions the agent's permission checks refused.
   */
  | {
    type: 'result';
    stopReason: CodingAgentStopReason;
    turns: number;
    message: string;
    refusals?: CodingAgentRefusal[];
  };

export interface CodingAgentHome {
  configDir: string;
  /** Whether the agent reads the runtime's skills dir. */
  skillsLinked: boolean;
}
