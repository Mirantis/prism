/**
 * Goal Service (Agent-Runtime)
 *
 * Owns durable "goals" — objectives the agent pursues autonomously across many
 * turns, unattended, until a cheap classification gate (Haiku) judges them
 * complete or they hit a turn / token / stall cap. One active goal per thread.
 *
 * Design (mirrors heartbeat.service.ts + cron-scheduler.service.ts):
 * - Background continuation loop runs in-process, fire-and-forget, per goal.
 * - Completion is decided ONLY by the Haiku gate (no model-facing update tool),
 *   fail → CONTINUE so the loop never completes prematurely; caps bound it.
 * - Turns run through `threadTurnService.run()`, the per-thread mutex shared
 *   with conversation-engine's chat(), so a goal turn and an interactive user
 *   turn never invoke() the same thread concurrently. User turns interleave
 *   between goal turns. Goal turns never open a steerable window, so a message
 *   arriving mid-goal-turn is not injected into it.
 * - State of record is the `goals` table; the in-memory runtime map only holds
 *   the abort handle + running flag, so a restart cleanly resumes from the DB.
 */

import { generateText } from 'ai';
import { Goal } from '@prisma/client';
import { invoke } from '../invoke';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { messageDeliveryService } from './message-delivery.service';
import { threadTurnService } from './thread-turn.service';
import { getGateRequest } from '../lib/classification';

import { trackEvent, langfuseTelemetry } from '../lib/telemetry';
import { logger } from '../logger';
import { buildGoalContinuationPrompt, GOAL_COMPLETION_GATE_PROMPT } from '../prompts/goal-prompt';
import { GOAL_MAX_OBJECTIVE_CHARS, GOAL_MAX_STALL_TURNS, GOAL_TURN_DELAY_MS } from '../constants';
import { ToolCallRecord } from '../types';

/** Statuses a goal can be in while still "live" (loop should run / can resume). */
const LIVE_STATUSES = ['active', 'paused'] as const;

interface GoalRuntime {
  isRunning: boolean;
  aborted: boolean;
  /** Aborts the in-flight goal turn so stop/pause take effect immediately. */
  abort: AbortController;
}

export interface StartGoalInput {
  userId: string;
  agentId: string;
  threadId: string;
  objective: string;
  tokenBudget?: number | null;
  /** Originating channel for scoped delivery of goal-turn output. */
  originChannel: string;
  originChannelId?: string | null;
}

class GoalService {
  /** Per-goal runtime handles, keyed by goalId. DB is the source of truth. */
  private runtimes = new Map<string, GoalRuntime>();

  /** Whether any goal loop is live, including one sleeping between turns. */
  hasLiveLoops(): boolean {
    return this.runtimes.size > 0;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Create (or replace) the active goal on a thread and start its loop.
   * One active goal per thread: any existing active/paused goal is stopped.
   */
  async startGoal(input: StartGoalInput): Promise<Goal> {
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error('Goal objective is required');
    }
    if (objective.length > GOAL_MAX_OBJECTIVE_CHARS) {
      throw new Error(`Goal objective is too long (max ${GOAL_MAX_OBJECTIVE_CHARS} characters)`);
    }

    // Replace any live goal on this thread (one active per thread).
    await this.stopGoalsForThread(input.threadId);

    const goal = await prisma.goal.create({
      data: {
        agentId: input.agentId,
        userId: input.userId,
        threadId: input.threadId,
        objective,
        status: 'active',
        maxTurns: config.goalMaxTurns,
        tokenBudget: input.tokenBudget ?? config.goalDefaultTokenBudget,
        originChannel: input.originChannel,
        originChannelId: input.originChannelId ?? null,
      },
    });

    trackEvent('goal started', input.userId, {
      'agent.id': input.agentId,
      'goal.id': goal.id,
      'goal.max_turns': String(goal.maxTurns),
      ...(goal.tokenBudget != null ? { 'goal.token_budget': String(goal.tokenBudget) } : {}),
    });

    this.startLoop(goal.id);
    return goal;
  }

  /** Re-start loops for every active goal on boot (resets the stall counter). */
  async restoreActiveGoals(agentId: string): Promise<void> {
    const goals = await prisma.goal.findMany({ where: { agentId, status: 'active' } });
    for (const goal of goals) {
      await prisma.goal.update({ where: { id: goal.id }, data: { stallCount: 0 } });
      this.startLoop(goal.id);
    }
    logger.info(`[Goal] Restored ${goals.length} active goal(s)`);
  }

  /** Signal every running loop to stop after its current turn (graceful shutdown). */
  stopAll(): void {
    const count = this.runtimes.size;
    for (const [goalId, rt] of this.runtimes) {
      rt.aborted = true;
      rt.abort.abort();
      logger.info(`[Goal] ${goalId} loop signaled to stop (shutdown)`);
    }
    logger.info(`[Goal] ${count} goal loop(s) signaled to stop`);
  }

  // ==========================================================================
  // Queries + user-controlled state changes
  // ==========================================================================

  /** The current live (active or paused) goal on a thread, if any. */
  async getGoalForThread(threadId: string): Promise<Goal | null> {
    return prisma.goal.findFirst({
      where: { threadId, status: { in: [...LIVE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getGoalById(goalId: string): Promise<Goal | null> {
    return prisma.goal.findUnique({ where: { id: goalId } });
  }

  /** All goals for an agent, newest first (management/list view). */
  async listGoals(agentId: string): Promise<Goal[]> {
    return prisma.goal.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' } });
  }

  /** Stop a goal by id; aborts its loop. No-op if already terminal. */
  async stopGoal(goalId: string): Promise<Goal | null> {
    this.signalAbort(goalId);
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return null;
    if (!LIVE_STATUSES.includes(goal.status as (typeof LIVE_STATUSES)[number])) return goal;
    const stopped = await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'stopped', lastReason: 'Stopped by user.', completedAt: new Date() },
    });
    this.recordStopped(stopped, 'user');
    return stopped;
  }

  /**
   * Stop every live (active/paused) goal on a thread. Currently called when a
   * new goal supersedes the existing one (one active goal per thread).
   */
  async stopGoalsForThread(threadId: string): Promise<void> {
    const goals = await prisma.goal.findMany({
      where: { threadId, status: { in: [...LIVE_STATUSES] } },
    });
    if (goals.length === 0) return;

    for (const goal of goals) {
      this.signalAbort(goal.id);
      this.recordStopped(goal, 'replaced');
    }

    await prisma.goal.updateMany({
      where: { threadId, status: { in: [...LIVE_STATUSES] } },
      data: { status: 'stopped', lastReason: 'Replaced by a new goal.', completedAt: new Date() },
    });
  }

  async pauseGoal(goalId: string): Promise<Goal | null> {
    this.signalAbort(goalId);
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal || goal.status !== 'active') return goal;
    const paused = await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'paused', lastReason: 'Paused by user.' },
    });
    logger.info(`[Goal] ${goalId} paused by user after ${paused.turnCount} turn(s)`);
    trackEvent('goal paused', paused.userId, {
      'agent.id': paused.agentId,
      'goal.id': paused.id,
      'goal.turns': String(paused.turnCount),
    });
    return paused;
  }

  async resumeGoal(goalId: string): Promise<Goal | null> {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal || goal.status !== 'paused') return goal;
    const updated = await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'active', stallCount: 0, lastReason: 'Resumed by user.' },
    });
    logger.info(`[Goal] ${goalId} resumed by user at turn ${updated.turnCount}/${updated.maxTurns}`);
    trackEvent('goal resumed', updated.userId, {
      'agent.id': updated.agentId,
      'goal.id': updated.id,
      'goal.turns': String(updated.turnCount),
    });
    this.startLoop(goalId);
    return updated;
  }

  // ==========================================================================
  // Background continuation loop
  // ==========================================================================

  private signalAbort(goalId: string): void {
    const rt = this.runtimes.get(goalId);
    if (rt) {
      rt.aborted = true;
      rt.abort.abort();
    }
  }

  /**
   * Single owner of the 'goal stopped' telemetry event — covers both a
   * user-initiated stop and a goal superseded by a new one. Logs the stop and
   * emits the event; never the objective text (PII).
   */
  private recordStopped(goal: Goal, reason: 'user' | 'replaced'): void {
    logger.info(
      `[Goal] ${goal.id} stopped (${reason}) after ${goal.turnCount} turn(s), ${goal.tokensUsed} token(s)`,
    );
    trackEvent('goal stopped', goal.userId, {
      'agent.id': goal.agentId,
      'goal.id': goal.id,
      'goal.reason': reason,
      'goal.turns': String(goal.turnCount),
      'goal.tokens': String(goal.tokensUsed),
    });
  }

  private startLoop(goalId: string): void {
    this.runGoalLoop(goalId).catch((err) => {
      logger.error({ err }, `[Goal] Loop crashed for ${goalId}`);
    });
  }

  private async runGoalLoop(goalId: string): Promise<void> {
    const existing = this.runtimes.get(goalId);
    // Bail only for a genuinely live loop. A still-running but *aborted* runtime
    // is mid-teardown (a pause/stop landed during an in-flight invoke that hasn't
    // returned yet) — replacing it here avoids the resume race where the row is
    // flipped back to 'active' but the old loop's `existing.isRunning` guard
    // would otherwise drop the restart, leaving the goal stuck with no loop. We
    // install a fresh runtime; the old loop's finally won't delete it (it guards
    // on identity), and its queued turn serializes behind ours on the thread lock.
    if (existing?.isRunning && !existing.aborted) {
      logger.info(`[Goal] Loop already running for ${goalId}`);
      return;
    }

    const runtime: GoalRuntime = { isRunning: true, aborted: false, abort: new AbortController() };
    this.runtimes.set(goalId, runtime);

    try {
      while (!runtime.aborted) {
        // Re-load each iteration so user-driven stop/pause takes effect promptly.
        const goal = await prisma.goal.findUnique({ where: { id: goalId } });
        if (!goal || goal.status !== 'active') {
          logger.info(`[Goal] ${goalId} not active (${goal?.status ?? 'deleted'}) — stopping loop`);
          return;
        }

        // Hard caps, checked before spending another turn.
        if (goal.turnCount >= goal.maxTurns) {
          await this.finalize(goal, 'turn_limited', `Reached the ${goal.maxTurns}-turn limit.`);
          return;
        }
        // Soft cap, not a hard ceiling: checked before a turn, so the turn that
        // crosses the budget runs to completion and only the next iteration
        // stops here. tokensUsed can therefore overshoot tokenBudget by up to
        // one full turn's spend.
        if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
          await this.finalize(goal, 'budget_limited', `Reached the ${goal.tokenBudget}-token budget.`);
          return;
        }

        logger.info(`[Goal] ${goalId} starting turn ${goal.turnCount + 1}/${goal.maxTurns}`);

        const turn = await this.runOneTurn(goal, runtime);
        if (runtime.aborted) return;
        if (!turn) continue;

        const newTokensUsed = goal.tokensUsed + turn.tokens;
        const newTurnCount = goal.turnCount + 1;

        // Account-level spending limit reached — stop and notify.
        if (turn.budgetExceeded) {
          logger.info(`[Goal] ${goalId} stopping — account spending limit reached on turn ${newTurnCount}`);
          await prisma.goal.update({
            where: { id: goalId },
            data: { tokensUsed: newTokensUsed, turnCount: newTurnCount },
          });
          await this.finalize(
            { ...goal, tokensUsed: newTokensUsed, turnCount: newTurnCount },
            'budget_limited',
            "Your organization's AI spending limit has been reached.",
          );
          return;
        }

        const complete = await this.shouldDeclareGoalComplete(goal.objective, turn.text);

        const budgetLabel = goal.tokenBudget ? `/${goal.tokenBudget}` : '';

        if (complete) {
          await prisma.goal.update({
            where: { id: goalId },
            data: { tokensUsed: newTokensUsed, turnCount: newTurnCount, stallCount: 0 },
          });
          logger.info(
            `[Goal] ${goalId} turn ${newTurnCount}/${goal.maxTurns} — gate=COMPLETE, tokens ${newTokensUsed}${budgetLabel}`,
          );
          await this.finalize(
            { ...goal, tokensUsed: newTokensUsed, turnCount: newTurnCount },
            'complete',
            'Objective achieved.',
          );
          return;
        }

        // Zero-progress turn = no tool calls. Two in a row → blocked.
        const newStall = turn.hadToolCalls ? 0 : goal.stallCount + 1;
        await prisma.goal.update({
          where: { id: goalId },
          data: {
            tokensUsed: newTokensUsed,
            turnCount: newTurnCount,
            stallCount: newStall,
            lastReason: 'In progress.',
          },
        });
        logger.info(
          `[Goal] ${goalId} turn ${newTurnCount}/${goal.maxTurns} — gate=CONTINUE, ` +
            `tokens ${newTokensUsed}${budgetLabel}, toolCalls=${turn.hadToolCalls}, stall=${newStall}/${GOAL_MAX_STALL_TURNS}`,
        );

        if (newStall >= GOAL_MAX_STALL_TURNS) {
          await this.finalize(
            { ...goal, tokensUsed: newTokensUsed, turnCount: newTurnCount },
            'blocked',
            `No progress (no tool use) for ${newStall} consecutive turns.`,
          );
          return;
        }

        if (GOAL_TURN_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, GOAL_TURN_DELAY_MS));
        }
      }
    } finally {
      runtime.isRunning = false;
      // Drop our entry so the map doesn't grow unbounded — but only if it's
      // still ours (a resume/replace may have installed a newer runtime).
      if (this.runtimes.get(goalId) === runtime) {
        this.runtimes.delete(goalId);
      }
    }
  }

  /**
   * Run a single goal turn under the per-thread lock and deliver its output.
   * Returns null if aborted before the turn ran.
   */
  private async runOneTurn(
    goal: Goal,
    runtime: GoalRuntime,
  ): Promise<{ text: string; tokens: number; hadToolCalls: boolean; budgetExceeded: boolean } | null> {
    return threadTurnService.run(goal.threadId, async () => {
      if (runtime.aborted) return null;

      const result = await invoke({
        userId: goal.userId,
        agentId: goal.agentId,
        mode: 'goal',
        threadId: goal.threadId,
        prompt: buildGoalContinuationPrompt({
          objective: goal.objective,
          turnCount: goal.turnCount,
          maxTurns: goal.maxTurns,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
        }),
        abortSignal: runtime.abort.signal,
      });

      const budgetExceeded = result.error?.type === 'budget_exceeded';
      const lastStep = result.steps[result.steps.length - 1];
      const text = (lastStep?.text ?? result.response ?? '').trim();

      // Deliver inside the lock so goal output and user messages stay ordered.
      if (!budgetExceeded && text) {
        await this.deliver(goal, text, result.toolCalls, result.attachmentIds);
      }

      return {
        text,
        tokens: result.usage?.totalTokens ?? 0,
        hadToolCalls: result.toolCalls.length > 0,
        budgetExceeded,
      };
    });
  }

  /** Mark a goal terminal, persist the reason, and notify the user. */
  private async finalize(goal: Goal, status: string, reason: string): Promise<void> {
    const elapsedMs = Date.now() - new Date(goal.createdAt).getTime();

    await prisma.goal.update({
      where: { id: goal.id },
      data: { status, lastReason: reason, completedAt: new Date() },
    });

    logger.info(
      `[Goal] ${goal.id} finished: status=${status}, turns=${goal.turnCount}, ` +
        `tokens=${goal.tokensUsed}, elapsed=${elapsedMs}ms — ${reason}`,
    );

    const label =
      status === 'complete'
        ? '✅ Goal complete'
        : status === 'blocked'
          ? '⚠️ Goal blocked'
          : status === 'turn_limited'
            ? '⏹️ Goal stopped (turn limit reached)'
            : status === 'budget_limited'
              ? '⏹️ Goal stopped (budget reached)'
              : 'Goal ended';

    // Deliver the terminal notice under the per-thread lock so it can't
    // interleave with an in-flight user chat turn's messages (the gate runs
    // between the last turn's delivery and here, outside the lock).
    await threadTurnService.run(goal.threadId, () =>
      this.deliver(goal, `**${label}**\n\nObjective: ${goal.objective}\n\n${reason}`),
    );

    // Single owner of the 'goal finished' event — fires for completion and for
    // error/cap stops (blocked, turn_limited, budget_limited). Carries the turn
    // count and elapsed wall-clock time; never the objective text (PII).
    trackEvent('goal finished', goal.userId, {
      'agent.id': goal.agentId,
      'goal.id': goal.id,
      'goal.status': status,
      'goal.turns': String(goal.turnCount),
      'goal.tokens': String(goal.tokensUsed),
      'goal.elapsed_ms': String(elapsedMs),
    });
  }

  /** Deliver goal-turn output scoped to the originating channel. */
  private async deliver(
    goal: Goal,
    content: string,
    toolCalls?: ToolCallRecord[],
    attachmentIds?: string[],
  ): Promise<void> {
    await messageDeliveryService.publish(goal.userId, goal.threadId, content, 'GOAL', {
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      channelContext: {
        channel: goal.originChannel === 'slack' ? 'slack' : 'websocket',
        channelId: goal.originChannelId ?? undefined,
        threadId: goal.threadId,
      },
    });
  }

  /**
   * Haiku completion gate — the sole completion signal. Fail → CONTINUE so a
   * gate error can never prematurely complete a goal (the turn/stall caps bound
   * the loop regardless). Mirrors heartbeat.service.ts#shouldDeliverAlert.
   */
  private async shouldDeclareGoalComplete(objective: string, latestTurnText: string): Promise<boolean> {
    if (!latestTurnText.trim()) return false;

    try {
      const { model, providerOptions, samplingParams } = getGateRequest();
      const result = await generateText({
        model,
        providerOptions,
        system: GOAL_COMPLETION_GATE_PROMPT,
        messages: [
          { role: 'user' as const, content: `## Objective\n${objective}\n\n## Agent's Latest Update\n${latestTurnText}` },
        ],
        // 16 is the OpenAI Responses API minimum (a cap — the verdict is one word).
        maxOutputTokens: 16,
        ...samplingParams,
        ...langfuseTelemetry('goal-completion-gate'),
      });
      const complete = result.text.trim().toUpperCase().startsWith('COMPLETE');
      logger.info(`[Goal:Gate] Decision: ${result.text.trim()} (complete=${complete})`);
      return complete;
    } catch (error) {
      logger.error({ err: error }, '[Goal:Gate] Gate call failed, defaulting to CONTINUE');
      return false; // fail → CONTINUE (never prematurely complete)
    }
  }
}

// Export singleton instance
export const goalService = new GoalService();
