import { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { createSqliteAdapter } from './prisma-adapter';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: createSqliteAdapter(config.databaseUrl), log: ['error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
