-- Compaction watermark: the provider-native position up to which this thread's
-- history is folded into `compactionSummary`. SLACK threads store a Slack ts
-- (passed as `oldest` to conversations.replies; the always-returned thread
-- parent is filtered by ts). DATABASE threads store the newest compacted row's
-- createdAt ISO string; the per-row isCompacted flag remains authoritative there.
-- AlterTable
ALTER TABLE "conversation_threads" ADD COLUMN "compactedThroughTs" TEXT;
