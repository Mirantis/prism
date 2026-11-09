/**
 * Read and write the `runtime_state` rows. What that table is for, and why it
 * is a table, is on the model in `prisma/sqlite/schema.prisma`.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../logger';

/** The environment the previous run finished in: `local` or `docker`. */
export const LAST_EXECUTION_ENVIRONMENT = 'lastExecutionEnvironment';

/** The id of single-thread mode's one conversation. */
export const SINGLE_THREAD = 'singleThread';

/** This install's `deployment.id` on product telemetry. */
export const DEPLOYMENT_ID = 'deploymentId';

/** How the agent's names were read for its voice: a JSON object of name to reading. */
export const AGENT_VOICE_READINGS = 'agentVoiceReadings';

/** The end of the last closed hour that `llm usage aggregated` reported, as an ISO time. */
export const LLM_USAGE_REPORTED_THROUGH = 'llmUsageReportedThrough';

export const runtimeStateService = {
  /** The stored value, or null when nothing has written this key yet. */
  async get(key: string): Promise<string | null> {
    const row = await prisma.runtimeState.findUnique({ where: { key } });
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await prisma.runtimeState.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  },

  async delete(key: string): Promise<void> {
    await prisma.runtimeState.deleteMany({ where: { key } });
  },

  /**
   * This install's id: created on the first read and kept for as long as the
   * database is. Undefined when the database cannot be read, so telemetry goes
   * out without the attribute.
   */
  async deploymentId(): Promise<string | undefined> {
    try {
      const row = await prisma.runtimeState.upsert({
        where: { key: DEPLOYMENT_ID },
        update: {},
        create: { key: DEPLOYMENT_ID, value: randomUUID() },
      });
      return row.value;
    } catch (err) {
      logger.warn({ err }, '[RuntimeState] could not read or create the deployment id');
      return undefined;
    }
  },
};
