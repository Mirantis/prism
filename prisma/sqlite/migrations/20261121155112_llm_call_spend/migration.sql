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
-- its createdAt rounded down to a multiple of 900000.
INSERT INTO "new_llm_calls" ("agentId", "cacheReadTokens", "cacheWriteTokens", "createdAt", "id", "inputTokens", "model", "noCacheTokens", "outputTokens", "purpose", "subagentId", "threadId", "totalTokens", "bucket") SELECT "agentId", "cacheReadTokens", "cacheWriteTokens", "createdAt", "id", "inputTokens", "model", "noCacheTokens", "outputTokens", "purpose", "subagentId", "threadId", "totalTokens", CASE WHEN typeof("createdAt") = 'integer' THEN "createdAt" - ("createdAt" % 900000) ELSE "createdAt" END FROM "llm_calls";
DROP TABLE "llm_calls";
ALTER TABLE "new_llm_calls" RENAME TO "llm_calls";
CREATE INDEX "llm_calls_agentId_createdAt_idx" ON "llm_calls"("agentId", "createdAt");
CREATE INDEX "llm_calls_agentId_threadId_createdAt_idx" ON "llm_calls"("agentId", "threadId", "createdAt");
CREATE INDEX "llm_calls_agentId_requestId_idx" ON "llm_calls"("agentId", "requestId");
CREATE INDEX "llm_calls_agentId_bucket_idx" ON "llm_calls"("agentId", "bucket");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
