/**
 * Backfill: generate embeddings for existing memory entries.
 *
 * Queries all memory_entries where embedding IS NULL, generates embeddings
 * via Bedrock Titan Embed v2, and stores them in the database.
 *
 * Idempotent — skips entries that already have embeddings.
 * Processes one entry per call with a 1s pause between batches; serial
 * pacing keeps us under Titan v2's per-account rate limit on busy
 * backfills, paired with `embeddingService.generateEmbeddings`'s
 * `maxParallelCalls: 1`.
 * Errors are logged per-entry (does not abort the full backfill).
 *
 * Usage (dev):  npx tsx src/scripts/backfill-embeddings.ts
 * Usage (prod): node dist/scripts/backfill-embeddings.ts
 */

import prisma from '../lib/prisma';
import { serializeError } from '../lib/log-redaction';
import { embeddingService } from '../services/embedding.service';

const BATCH_SIZE = 1;
const PAGE_SIZE = 500;

interface BackfillEntry {
  id: string;
  agentId: string;
  content: string;
}

export interface BackfillResult {
  processed: number;
  failed: number;
  scanned: number;
}

export async function runBackfill(): Promise<BackfillResult> {
  let processed = 0;
  let failed = 0;
  let scanned = 0;
  let lastId: string | null = null;

  while (true) {
    // Paginate with cursor to avoid loading all rows into memory
    let entries: BackfillEntry[];
    if (lastId === null) {
      entries = await prisma.$queryRawUnsafe<BackfillEntry[]>(
        `SELECT "id", "agentId", "content" FROM "memory_entries" WHERE "embedding" IS NULL ORDER BY "id" ASC LIMIT $1`,
        PAGE_SIZE,
      );
    } else {
      entries = await prisma.$queryRawUnsafe<BackfillEntry[]>(
        `SELECT "id", "agentId", "content" FROM "memory_entries" WHERE "embedding" IS NULL AND "id" > $1 ORDER BY "id" ASC LIMIT $2`,
        lastId,
        PAGE_SIZE,
      );
    }

    if (entries.length === 0) {
      if (scanned === 0) {
        console.log('No entries need backfilling.');
        return { processed, failed, scanned };
      }
      break;
    }

    scanned += entries.length;
    lastId = entries[entries.length - 1].id;
    console.log(`Fetched page of ${entries.length} entries (total scanned: ${scanned})`);

    // Group by agentId to reuse provider setup.
    const byAgent = new Map<string, typeof entries>();
    for (const entry of entries) {
      const list = byAgent.get(entry.agentId) || [];
      list.push(entry);
      byAgent.set(entry.agentId, list);
    }

    for (const [agentId, agentEntries] of byAgent) {
      // Process in batches
      for (let i = 0; i < agentEntries.length; i += BATCH_SIZE) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const batch = agentEntries.slice(i, i + BATCH_SIZE);
        const texts = batch.map((e: BackfillEntry) => e.content);

        const embeddings = await embeddingService.generateEmbeddings(agentId, texts);
        if (!embeddings) {
          console.warn(
            `Could not generate embeddings for agent ${agentId} — skipping ${batch.length} entries`,
            '\nFailed entries:',
            batch.map((e, idx) => ({ index: i + idx, id: e.id, text: texts[idx] })),
          );
          failed += batch.length;
          continue;
        }

        if (embeddings.length !== batch.length) {
          console.error(`Embedding count mismatch: expected ${batch.length}, got ${embeddings.length} — skipping batch`);
          failed += batch.length;
          continue;
        }

        // Store each embedding through the provider-aware store.
        for (let j = 0; j < batch.length; j++) {
          try {
            await embeddingService.storeEmbedding(batch[j].id, embeddings[j]);
            processed++;
          } catch (err) {
            // Through the same serializer the logger uses. This script talks to the
            // embeddings endpoint, so a failure here is an SDK error carrying the
            // request that produced it — which is the memory entry's own text.
            console.error(`Failed to store embedding for entry ${batch[j].id}:`, serializeError(err));
            failed++;
          }
        }

        console.log(`Progress: scanned ${scanned}, completed ${processed + failed} (${processed} ok, ${failed} failed)`);
      }
    }
  }

  console.log(`\nDone. Processed: ${processed}, Failed: ${failed}, Scanned: ${scanned}`);
  return { processed, failed, scanned };
}

// Manual re-run entry point (`node dist/scripts/backfill-embeddings.js`). The
// runtime calls `runBackfill()` itself, so this stays quiet when imported. The
// `typeof` test covers the SEA bundle, an ES module where `module` does not
// exist and a bare reference to it throws.
if (typeof module !== 'undefined' && require.main === module) {
  runBackfill()
    .catch(err => {
      console.error('Backfill failed:', serializeError(err));
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
