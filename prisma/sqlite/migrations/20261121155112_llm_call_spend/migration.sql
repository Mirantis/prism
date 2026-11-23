-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_llm_calls" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "subagentId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "threadId" TEXT,
    "requestId" TEXT,
    "sourceKind" TEXT,
    "sourceId" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "noCacheTokens" INTEGER NOT NULL DEFAULT 0,
    "audioInputTokens" INTEGER NOT NULL DEFAULT 0,
    "audioOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER,
    "costSource" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bucket" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "llm_calls_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The runtime stores a DateTime as epoch milliseconds, so a row's 15-minute bucket is
-- its createdAt rounded down to a multiple of 900000. A row that took the column's
-- CURRENT_TIMESTAMP default holds text instead ('YYYY-MM-DD HH:MM:SS', UTC); it is
-- converted to epoch milliseconds first, so range queries and buckets see every row.
-- Text SQLite cannot read as a date becomes 0 (1970), outside any range, rather
-- than failing the upgrade.
INSERT INTO "new_llm_calls" ("agentId", "cacheReadTokens", "cacheWriteTokens", "createdAt", "id", "inputTokens", "model", "noCacheTokens", "outputTokens", "purpose", "subagentId", "threadId", "totalTokens", "bucket") SELECT "agentId", "cacheReadTokens", "cacheWriteTokens", "createdAtMs", "id", "inputTokens", "model", "noCacheTokens", "outputTokens", "purpose", "subagentId", "threadId", "totalTokens", "createdAtMs" - ("createdAtMs" % 900000) FROM (SELECT *, CASE WHEN typeof("createdAt") IN ('integer', 'real') THEN CAST("createdAt" AS INTEGER) ELSE COALESCE(CAST(ROUND((julianday("createdAt") - 2440587.5) * 86400000) AS INTEGER), 0) END AS "createdAtMs" FROM "llm_calls");
DROP TABLE "llm_calls";
ALTER TABLE "new_llm_calls" RENAME TO "llm_calls";
CREATE INDEX "llm_calls_agentId_createdAt_idx" ON "llm_calls"("agentId", "createdAt");
CREATE INDEX "llm_calls_agentId_threadId_createdAt_idx" ON "llm_calls"("agentId", "threadId", "createdAt");
CREATE INDEX "llm_calls_agentId_requestId_idx" ON "llm_calls"("agentId", "requestId");
CREATE INDEX "llm_calls_agentId_bucket_idx" ON "llm_calls"("agentId", "bucket");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
