/**
 * The deployment id against a database built from the committed migrations,
 * since the upsert is what keeps one install's id across restarts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../test-utils/migrated-database';

const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock('../lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) }),
}));

import { DEPLOYMENT_ID, runtimeStateService } from './runtime-state.service';

const opened: MigratedDatabase[] = [];

function useFreshDatabase(): MigratedDatabase {
  const db = openMigratedDatabase();
  opened.push(db);
  database.client = db.client;
  return db;
}

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe('runtimeStateService.deploymentId', () => {
  it('creates the id on the first read and returns the same id on every later read', async () => {
    useFreshDatabase();

    const first = await runtimeStateService.deploymentId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await runtimeStateService.deploymentId()).toBe(first);
    expect(await runtimeStateService.get(DEPLOYMENT_ID)).toBe(first);
  });

  it('gives two installs two ids', async () => {
    useFreshDatabase();
    const mine = await runtimeStateService.deploymentId();
    useFreshDatabase();
    const theirs = await runtimeStateService.deploymentId();

    expect(theirs).not.toBe(mine);
  });

  it('returns undefined when the database cannot be read', async () => {
    const db = useFreshDatabase();
    await db.client.$executeRawUnsafe('DROP TABLE runtime_state');

    expect(await runtimeStateService.deploymentId()).toBeUndefined();
  });
});
