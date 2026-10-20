/**
 * Read and write the `runtime_state` rows. What that table is for, and why it
 * is a table, is on the model in `prisma/sqlite/schema.prisma`.
 */
import { prisma } from '../lib/prisma';

/** The environment the previous run finished in: `local` or `docker`. */
export const LAST_EXECUTION_ENVIRONMENT = 'lastExecutionEnvironment';

/** The id of single-thread mode's one conversation. */
export const SINGLE_THREAD = 'singleThread';

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
};
