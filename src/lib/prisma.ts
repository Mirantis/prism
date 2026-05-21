import { PrismaClient as PrismaClientPg } from '@prisma/client';
import { config } from '../config';

// Provider selector:
// - Multi-tenant (default): the Postgres client generated from
//   prisma/schema.prisma.
// - Single-agent (SINGLE_AGENT_MODE=1): the SQLite client generated from
//   prisma/sqlite/schema.prisma, operating against DATABASE_URL=file:…
//
// The SQLite client is loaded lazily via require() so vitest (which
// doesn't set singleAgentMode) never resolves that path. Node's standard
// module resolution finds `.prisma/client-sqlite` at runtime once the
// postinstall-generated client exists in node_modules.
//
// Both clients are API-compatible for every model we use (schemas are
// kept in sync). We type the export as the Postgres client for editor
// ergonomics; runtime behavior is identical for all query methods we call.
type Prisma = PrismaClientPg;

const globalForPrisma = globalThis as unknown as {
  prisma: Prisma | undefined;
};

function buildClient(): Prisma {
  if (config.singleAgentMode) {
    // Lazy require — avoids resolving the SQLite client at import time,
    // which would trip vitest / tooling that doesn't know about it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { PrismaClient: PrismaClientSqlite } = require('.prisma/client-sqlite') as {
      PrismaClient: new (opts?: { log?: string[] }) => unknown;
    };
    return new PrismaClientSqlite({ log: ['error'] }) as Prisma;
  }
  return new PrismaClientPg({ log: ['error'] });
}

export const prisma = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
