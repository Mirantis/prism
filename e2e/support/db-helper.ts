/**
 * Database Helper — Prisma client for e2e test setup/teardown.
 *
 * Points at the single SQLite database the runtime under test owns
 * (DATABASE_URL is pinned by global-setup to file:./e2e.db).
 */

import { PrismaClient } from '@prisma/client';
import { DEFAULT_AGENT_ID, TEST_USER, DEFAULT_AGENT_SEED } from '../fixtures/test-data';

// Tables in dependency-safe order (children first). resetAll() deletes them
// in this order; foreign keys are enforced under better-sqlite3 so the
// order matters.
const TABLES = [
  'pending_slack_messages',
  'slack_heartbeat_triggers',
  'slack_verification_codes',
  'slack_mappings',
  'agent_subagents',
  'cron_tasks',
  'memory_entries',
  'conversation_participants',
  'conversation_messages',
  'conversation_threads',
  'agent_workspaces',
];

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: { url: process.env.DATABASE_URL },
      },
    });
  }
  return prisma;
}

/**
 * Delete all rows from every Prisma-managed table.
 */
export async function resetAll(): Promise<void> {
  const db = getPrisma();
  for (const table of TABLES) {
    await db.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

/**
 * Seed minimal test data: one agent workspace pinned to DEFAULT_AGENT_ID.
 * Uses upsert so the per-scenario resetAll + seed loop keeps the same
 * row id — that id is also what the runtime caches in config.agentId
 * via AGENT_ID env, so the two stay in sync.
 */
export async function seed(): Promise<string> {
  const db = getPrisma();

  const data = {
    userId: TEST_USER.id,
    name: DEFAULT_AGENT_SEED.name,
    agentType: 'AGENT' as const,
    soulMd: DEFAULT_AGENT_SEED.soulMd,
    userMd: DEFAULT_AGENT_SEED.userMd,
    memoryMd: DEFAULT_AGENT_SEED.memoryMd,
    heartbeatMd: DEFAULT_AGENT_SEED.heartbeatMd,
    bootstrapMd: '',
    proactivity: 3,
    verbosity: 3,
  };

  const agent = await db.agentWorkspace.upsert({
    where: { id: DEFAULT_AGENT_ID },
    update: data,
    create: { id: DEFAULT_AGENT_ID, ...data },
  });

  return agent.id;
}

/**
 * Ensure an agent exists for the test user. Returns its ID.
 * If one already exists, returns the existing one.
 */
export async function ensureAgent(): Promise<string> {
  const db = getPrisma();
  const existing = await db.agentWorkspace.findFirst({
    where: { userId: TEST_USER.id, agentType: 'AGENT' },
  });
  if (existing) return existing.id;
  return seed();
}

/**
 * Create a subagent linked to the given parent agent.
 */
export async function createSubagent(parentAgentId: string, name: string): Promise<string> {
  const db = getPrisma();

  const child = await db.agentWorkspace.create({
    data: {
      userId: TEST_USER.id,
      name,
      agentType: 'SUBAGENT',
      soulMd: 'Subagent soul',
      userMd: '',
      memoryMd: '',
      heartbeatMd: '',
      bootstrapMd: '',
    },
  });

  await db.agentSubagent.create({
    data: {
      parentAgentId,
      childAgentId: child.id,
    },
  });

  return child.id;
}

/**
 * Create a conversation with messages for a given agent.
 */
export async function createConversation(
  agentId: string,
  messages: Array<{ role: 'USER' | 'AGENT'; content: string }>
): Promise<string> {
  const db = getPrisma();

  const thread = await db.conversationThread.create({
    data: {
      agentId,
      userId: TEST_USER.id,
      status: 'ACTIVE',
    },
  });

  for (const msg of messages) {
    await db.conversationMessage.create({
      data: {
        threadId: thread.id,
        role: msg.role,
        content: msg.content,
        triggeredBy: 'USER_INPUT',
      },
    });
  }

  return thread.id;
}

/**
 * Create a deactivated (NON_ACTIVE) conversation with messages.
 */
export async function createDeactivatedConversation(
  agentId: string,
  messages: Array<{ role: 'USER' | 'AGENT'; content: string }>
): Promise<string> {
  const db = getPrisma();

  const thread = await db.conversationThread.create({
    data: {
      agentId,
      userId: TEST_USER.id,
      status: 'NON_ACTIVE',
    },
  });

  for (const msg of messages) {
    await db.conversationMessage.create({
      data: {
        threadId: thread.id,
        role: msg.role,
        content: msg.content,
        triggeredBy: 'USER_INPUT',
      },
    });
  }

  return thread.id;
}

/**
 * Create a Slack-sourced conversation thread with messages.
 * Slack threads are always NON_ACTIVE with externalThreadId set.
 */
export async function createSlackConversation(
  agentId: string,
  messages: Array<{ role: 'USER' | 'AGENT'; content: string }>
): Promise<string> {
  const db = getPrisma();

  const thread = await db.conversationThread.create({
    data: {
      agentId,
      userId: TEST_USER.id,
      status: 'NON_ACTIVE',
      threadSource: 'SLACK',
      externalThreadId: `mock-slack-ts-${Date.now()}`,
      externalChannelId: 'C_MOCK_E2E',
    },
  });

  for (const msg of messages) {
    await db.conversationMessage.create({
      data: {
        threadId: thread.id,
        role: msg.role,
        content: msg.content,
        triggeredBy: 'USER_INPUT',
      },
    });
  }

  return thread.id;
}

/**
 * Disconnect the Prisma client. Call in global teardown.
 */
export async function disconnect(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
