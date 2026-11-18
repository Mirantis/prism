/**
 * Channel files in the attachment store, against a database built from the
 * committed migrations: a live-read thread shows a file by its thread and the
 * channel's message id, with no stored message to link it to.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../test-utils/migrated-database';

const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock('../lib/prisma', () => ({
  default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) }),
}));

import { attachmentService } from './attachment.service';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: MigratedDatabase;

/** A two-day-old attachment row that no message holds. Its content has expired, so no media file is involved. */
function store(id: string, extra: { slackFileId?: string; threadId?: string; externalTs?: string } = {}) {
  return db.client.messageAttachment.create({
    data: {
      id,
      filename: `${id}.log`,
      mediaType: 'text/plain',
      sizeBytes: 3,
      category: 'text',
      source: 'slack',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      ...extra,
    },
  });
}

beforeEach(() => {
  db = openMigratedDatabase();
  database.client = db.client;
});

afterEach(async () => {
  await db.close();
});

describe('channel files in the attachment store', () => {
  it('keeps a channel file stored for a thread, and still shows it on its message after the orphan sweep', async () => {
    await store('upload');
    await store('no-thread', { slackFileId: 'F1' });
    await store('thread-file', { slackFileId: 'F2', threadId: 'thread-1', externalTs: '1700.0001' });

    expect(await attachmentService.deleteOrphans(DAY_MS)).toBe(2);

    const shown = await attachmentService.getMetaByExternalTs('thread-1', ['1700.0001']);
    expect(shown.get('1700.0001')?.map((file) => file.id)).toEqual(['thread-file']);
  });

  it('tells which channel file ids are stored', async () => {
    await store('a1', { slackFileId: 'F1' });

    expect(await attachmentService.storedExternalFileIds(['F1', 'F2'])).toEqual(new Set(['F1']));
  });
});
