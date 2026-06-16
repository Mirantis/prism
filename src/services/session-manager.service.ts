/**
 * Session Manager Service
 *
 * Manages agent session lifecycle:
 * - Daily reset at user-configured time (dailyResetHour)
 * - Optional idle timeout
 * - Unique session ID generation
 *
 * Session Rules (from molt.bot):
 * 1. DAILY RESET - Fresh context each day at dailyResetHour
 * 2. IDLE TIMEOUT - Optional sliding window reset on inactivity
 * 3. MANUAL RESET - User can explicitly start fresh
 *
 * Memory always persists across sessions; only conversation resets.
 */

import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import { conversationService } from './conversation.service';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  userId: string;
  sessionId: string;
  dailyResetTimeout?: NodeJS.Timeout;
  idleTimeout?: NodeJS.Timeout;
  lastActivity: Date;
}

// ============================================================================
// Session Manager Service
// ============================================================================

class SessionManagerService {
  private sessions: Map<string, SessionState> = new Map();
  private isInitialized: boolean = false;

  /**
   * Initialize session manager for all existing agents
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('Session manager already initialized');
      return;
    }

    logger.info('Initializing session manager...');

    try {
      // Get all agents
      const agents = await prisma.agentWorkspace.findMany({
        select: {
          userId: true,
          currentSessionId: true,
          dailyResetHour: true,
          idleTimeoutMins: true,
          timezone: true,
        },
      });

      // Set up daily reset schedules for each agent
      for (const agent of agents) {
        this.scheduleDailyReset(agent.userId, agent.dailyResetHour, agent.timezone);

        // Track current session
        if (agent.currentSessionId) {
          this.sessions.set(agent.userId, {
            userId: agent.userId,
            sessionId: agent.currentSessionId,
            lastActivity: new Date(),
          });
        }
      }

      this.isInitialized = true;
      logger.info('Session manager initialized for %d agent(s)', agents.length);
    } catch (error: any) {
      logger.error('Failed to initialize session manager: %s', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Start or resume a session for a user
   * Returns the current session ID
   */
  async startSession(userId: string): Promise<string> {
    const agent = await this.getAgentByUserId(userId);
    let state = this.sessions.get(userId);

    // If no session or session is stale, create new one
    if (!state || !agent.currentSessionId) {
      const sessionId = this.generateSessionId();

      await prisma.agentWorkspace.update({
        where: { id: agent.id },
        data: { currentSessionId: sessionId },
      });

      state = {
        userId,
        sessionId,
        lastActivity: new Date(),
      };

      this.sessions.set(userId, state);
      logger.info('Started new session %s for user %s', sessionId, userId);

      // Set up daily reset
      this.scheduleDailyReset(userId, agent.dailyResetHour, agent.timezone);

      // Set up idle timeout if configured
      if (agent.idleTimeoutMins) {
        this.startIdleTimeout(userId, agent.idleTimeoutMins);
      }
    } else {
      // Update last activity
      state.lastActivity = new Date();

      // Restart idle timeout if configured
      if (agent.idleTimeoutMins && state.idleTimeout) {
        clearTimeout(state.idleTimeout);
        this.startIdleTimeout(userId, agent.idleTimeoutMins);
      }
    }

    return state.sessionId;
  }

  /**
   * Record activity for a user (resets idle timeout)
   */
  recordActivity(userId: string): void {
    const state = this.sessions.get(userId);
    if (state) {
      state.lastActivity = new Date();

      // Restart idle timeout if active
      if (state.idleTimeout) {
        clearTimeout(state.idleTimeout);
        // Re-fetch agent to get idle timeout
        this.restartIdleTimeout(userId);
      }
    }
  }

  /**
   * Reset session (manual or automatic)
   * Starts a fresh conversation thread (which becomes the latest).
   */
  async resetSession(userId: string, reason: 'daily' | 'idle' | 'manual' = 'manual'): Promise<string> {
    logger.info('Resetting session for user %s (reason: %s)', userId, reason);

    const agent = await this.getAgentByUserId(userId);

    // Start a fresh thread so the next message opens a clean conversation.
    // Carry the current thread's workspaceRoot forward — daily/idle resets can
    // fire while a CLI session is connected, and the CLI only sends its cwd
    // once per launch; without this the agent would silently fall back to the
    // global SHELL_WORKSPACE_ROOT after a reset.
    try {
      const latest = await conversationService.getLatestThread(userId);
      await conversationService.startNewThread(agent.id, userId, {
        workspaceRoot: latest?.workspaceRoot ?? undefined,
      });
    } catch {
      logger.warn('Failed to start a new thread on session reset for user %s', userId);
    }

    // Generate new session ID
    const newSessionId = this.generateSessionId();

    await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { currentSessionId: newSessionId },
    });

    // Update local state
    const state = this.sessions.get(userId);
    if (state) {
      state.sessionId = newSessionId;
      state.lastActivity = new Date();
    } else {
      this.sessions.set(userId, {
        userId,
        sessionId: newSessionId,
        lastActivity: new Date(),
      });
    }

    logger.info('Created new session %s for user %s', newSessionId, userId);
    return newSessionId;
  }

  /**
   * Get current session ID for a user
   */
  getSessionId(userId: string): string | null {
    const state = this.sessions.get(userId);
    return state?.sessionId || null;
  }

  /**
   * Check if user has an active session
   */
  hasActiveSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /**
   * Schedule daily reset for a user
   */
  private scheduleDailyReset(userId: string, resetHour: number, timezone: string): void {
    const state = this.sessions.get(userId);

    // Clear existing timeout
    if (state?.dailyResetTimeout) {
      clearTimeout(state.dailyResetTimeout);
    }

    // Calculate time until next reset
    const msUntilReset = this.calculateMsUntilReset(resetHour, timezone);

    const timeout = setTimeout(async () => {
      await this.resetSession(userId, 'daily');
      // Schedule next daily reset
      this.scheduleDailyReset(userId, resetHour, timezone);
    }, msUntilReset);

    // Update state
    if (state) {
      state.dailyResetTimeout = timeout;
    }

    const hoursUntil = Math.round(msUntilReset / (1000 * 60 * 60) * 10) / 10;
    logger.info('Scheduled daily reset for user %s in %s hours', userId, hoursUntil);
  }

  /**
   * Calculate milliseconds until next reset hour
   */
  private calculateMsUntilReset(resetHour: number, timezone: string): number {
    const now = new Date();

    // Get current time in user's timezone
    const userTimeStr = now.toLocaleString('en-US', {
      timeZone: timezone,
      hour12: false,
    });
    const userTime = new Date(userTimeStr);
    const currentHour = userTime.getHours();
    const currentMinutes = userTime.getMinutes();
    const currentSeconds = userTime.getSeconds();

    // Calculate hours until reset
    let hoursUntilReset = resetHour - currentHour;
    if (hoursUntilReset <= 0) {
      hoursUntilReset += 24; // Tomorrow
    }

    // Convert to milliseconds
    const msUntilReset = (
      (hoursUntilReset * 60 * 60) -
      (currentMinutes * 60) -
      currentSeconds
    ) * 1000;

    return msUntilReset;
  }

  /**
   * Start idle timeout for a user
   */
  private startIdleTimeout(userId: string, idleTimeoutMins: number): void {
    const state = this.sessions.get(userId);
    if (!state) return;

    // Clear existing timeout
    if (state.idleTimeout) {
      clearTimeout(state.idleTimeout);
    }

    const timeoutMs = idleTimeoutMins * 60 * 1000;

    state.idleTimeout = setTimeout(async () => {
      logger.info('Idle timeout reached for user %s', userId);
      await this.resetSession(userId, 'idle');
    }, timeoutMs);

    logger.info('Started idle timeout for user %s: %d minutes', userId, idleTimeoutMins);
  }

  /**
   * Restart idle timeout after activity
   */
  private async restartIdleTimeout(userId: string): Promise<void> {
    const agent = await prisma.agentWorkspace.findFirst({
      where: { userId },
      select: { idleTimeoutMins: true },
    });

    if (agent?.idleTimeoutMins) {
      this.startIdleTimeout(userId, agent.idleTimeoutMins);
    }
  }

  /**
   * Get the agent for a user (direct DB access)
   */
  private async getAgentByUserId(userId: string) {
    const agent = await prisma.agentWorkspace.findFirst({
      where: { userId, agentType: 'AGENT' },
    });

    if (!agent) {
      throw new Error(`No agent found for user ${userId}`);
    }

    return agent;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `sess_${uuidv4().replace(/-/g, '')}`;
  }

  /**
   * Clean up session for a user (on logout or removal)
   */
  cleanup(userId: string): void {
    const state = this.sessions.get(userId);
    if (state) {
      if (state.dailyResetTimeout) {
        clearTimeout(state.dailyResetTimeout);
      }
      if (state.idleTimeout) {
        clearTimeout(state.idleTimeout);
      }
      this.sessions.delete(userId);
    }
  }

  /**
   * Stop all sessions (for shutdown)
   */
  stopAll(): void {
    for (const [_userId, state] of this.sessions) {
      if (state.dailyResetTimeout) {
        clearTimeout(state.dailyResetTimeout);
      }
      if (state.idleTimeout) {
        clearTimeout(state.idleTimeout);
      }
    }
    this.sessions.clear();
    logger.info('All sessions stopped');
  }
}

// Export singleton instance
export const sessionManagerService = new SessionManagerService();
