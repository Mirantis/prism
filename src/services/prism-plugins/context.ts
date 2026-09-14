/**
 * Builds the context handed to a plugin's factory.
 *
 * Every read here delegates to the service that owns the data, so a plugin sees
 * the same values the rest of the runtime does and gains no path of its own into
 * the database. Reads only: a plugin that wrote agent state would sit outside
 * the services that own those writes, and the invariants they hold — heartbeat
 * restarts on an interval change, locked-in mode, telemetry — would not run.
 */

import fs from 'fs';
import { logger } from '../../logger';
import { config } from '../../config';
import { resolvePrismPluginDataDir } from '../../lib/data-dir';
import { agentWorkspaceService } from '../agent-workspace.service';
import { conversationService } from '../conversation.service';
import { llmUsageService } from '../llm-usage.service';
import type { PrismPluginAgentApi, PrismPluginContext, PrismPluginLogger } from './types';

/** Ceilings on what one call can pull back, so a page cannot ask for everything. */
const MAX_THREADS = 200;
const MAX_MESSAGES = 500;
const DEFAULT_THREADS = 20;
const DEFAULT_MESSAGES = 100;
const DEFAULT_USAGE_WINDOW_HOURS = 24;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * A plugin's logger. Tagged with the plugin id so its lines are attributable,
 * and routed through the runtime's logger so the `err` redaction serializer
 * still applies to anything a plugin passes as an error.
 */
function pluginLogger(id: string): PrismPluginLogger {
  const tag = `[PrismPlugin:${id}]`;
  // An Error goes in under `err`, which is the key the global redaction
  // serializer covers — so a plugin logging a provider error cannot write that
  // error's request body into the log.
  const at =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, data?: unknown): void => {
      if (data === undefined) {
        logger[level](`${tag} ${message}`);
        return;
      }
      const fields = data instanceof Error ? { err: data } : { data };
      logger[level](fields, `${tag} ${message}`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function agentApi(): PrismPluginAgentApi {
  return {
    async get() {
      const agent = await agentWorkspaceService.getAgent();
      return {
        id: agent.id,
        name: agent.name,
        userId: agent.userId,
        heartbeatStatus: agent.heartbeatStatus,
        heartbeatIntervalMs: agent.heartbeatIntervalMs,
      };
    },

    async listThreads(limit) {
      const agent = await agentWorkspaceService.getAgent();
      const threads = await conversationService.listThreads(agent.userId, agent.id, {
        limit: clamp(limit, DEFAULT_THREADS, MAX_THREADS),
      });
      return threads.map((t) => ({
        id: t.id,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    },

    async listMessages(threadId, limit) {
      const agent = await agentWorkspaceService.getAgent();
      // getThread carries the ownership check, so a plugin cannot read a thread
      // belonging to anyone but this runtime's owner.
      const thread = await conversationService.getThread(agent.userId, agent.id, threadId);
      if (!thread) return [];
      const take = clamp(limit, DEFAULT_MESSAGES, MAX_MESSAGES);
      return thread.messages.slice(-take).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
    },

    async llmUsage(windowHours) {
      const summary = await llmUsageService.summarize(
        clamp(windowHours, DEFAULT_USAGE_WINDOW_HOURS, 24 * 90),
      );
      return {
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        cacheWriteTokens: summary.cacheWriteTokens,
        calls: summary.calls,
      };
    },
  };
}

/**
 * Build the context for one plugin. The data directory is created here rather
 * than lazily, so a factory can write to it on its first line without checking.
 */
export function buildPluginContext(id: string, pluginDir: string): PrismPluginContext {
  const dataDir = resolvePrismPluginDataDir(id);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error: unknown) {
    logger.warn({ err: error }, `[PrismPlugins] could not create the data dir for "${id}"`);
  }

  return {
    id,
    dataDir,
    pluginDir,
    logger: pluginLogger(id),
    agent: agentApi(),
  };
}

/** Exposed so a test can assert the clamps without a database. */
export const __test = { clamp, agentIdFromConfig: () => config.agentId };
