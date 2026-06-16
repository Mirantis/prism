/**
 * Database Helper — Prisma client for e2e test setup/teardown.
 *
 * Points at the single SQLite database the runtime under test owns
 * (DATABASE_URL is pinned by global-setup to file:./e2e.db).
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_AGENT_ID, TEST_USER, DEFAULT_AGENT_SEED } from '../fixtures/test-data';

let prisma: PrismaClient | null = null;
let cachedDeleteOrder: string[] | null = null;

/**
 * Derive tables to clear from Prisma DMMF + topo-sort so foreign-key-owning
 * rows (children) are deleted before the rows they reference (parents).
 * Beats a hand-maintained constant: adding a model to schema.prisma can't
 * silently rot into cross-scenario leakage.
 */
function getDeleteOrder(): string[] {
  if (cachedDeleteOrder) return cachedDeleteOrder;

  const models = Prisma.dmmf.datamodel.models;
  const modelToTable = new Map(models.map((m) => [m.name, m.dbName ?? m.name]));

  // adj[A] = [B, ...] when model A has an FK reference to model B.
  // (Owning side carries relationFromFields; the inverse side doesn't.)
  const adj = new Map<string, string[]>();
  for (const m of models) {
    const refs: string[] = [];
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0) {
        refs.push(f.type);
      }
    }
    adj.set(m.name, refs);
  }

  // DFS post-order, then reverse: yields A before B when A has FK to B,
  // i.e. delete A (child) before B (parent).
  const visited = new Set<string>();
  const postOrder: string[] = [];
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const ref of adj.get(name) ?? []) visit(ref);
    postOrder.push(name);
  };
  for (const name of adj.keys()) visit(name);

  cachedDeleteOrder = postOrder.reverse().map((n) => modelToTable.get(n)!);
  return cachedDeleteOrder;
}

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
  for (const table of getDeleteOrder()) {
    await db.$executeRawUnsafe(`DELETE FROM "${table}"`);
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
 * Create a conversation with messages for a given agent. Created "now", so it
 * is the latest database thread unless a newer one is created afterward.
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
 * Create an older database conversation with messages — backdated so that a
 * conversation created afterward (via createConversation) is the latest and
 * supersedes it. Used to verify the runtime uses the latest thread, not this.
 */
export async function createOlderConversation(
  agentId: string,
  messages: Array<{ role: 'USER' | 'AGENT'; content: string }>
): Promise<string> {
  const db = getPrisma();

  const thread = await db.conversationThread.create({
    data: {
      agentId,
      userId: TEST_USER.id,
      // Backdate so getOrCreateLatestThread (createdAt desc) never picks this.
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
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
 * Slack threads carry an externalThreadId and are excluded from the web/CLI
 * "latest thread" resolution.
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
 * Create a bare conversation thread with explicit attributes (no messages
 * required) — for tests that list threads (e.g. the Recents sidebar) where the
 * row is identified by its workspaceRoot basename, not message content.
 * Returns the thread id.
 */
export async function createThread(
  agentId: string,
  opts?: {
    workspaceRoot?: string | null;
    threadSource?: 'DATABASE' | 'SLACK';
    externalThreadId?: string;
    externalChannelId?: string;
    createdAt?: Date;
  },
): Promise<string> {
  const db = getPrisma();
  const thread = await db.conversationThread.create({
    data: {
      agentId,
      userId: TEST_USER.id,
      ...(opts?.workspaceRoot != null ? { workspaceRoot: opts.workspaceRoot } : {}),
      ...(opts?.threadSource ? { threadSource: opts.threadSource } : {}),
      ...(opts?.externalThreadId ? { externalThreadId: opts.externalThreadId } : {}),
      ...(opts?.externalChannelId ? { externalChannelId: opts.externalChannelId } : {}),
      ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
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
