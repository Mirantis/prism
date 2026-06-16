/*
  Warnings:

  - You are about to drop the column `status` on the `conversation_threads` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_conversation_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "externalThreadId" TEXT,
    "threadSource" TEXT NOT NULL DEFAULT 'DATABASE',
    "externalChannelId" TEXT,
    "workspaceRoot" TEXT,
    "compactionSummary" TEXT,
    "compactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "conversation_threads_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_conversation_threads" ("agentId", "compactedAt", "compactionSummary", "createdAt", "externalChannelId", "externalThreadId", "id", "threadSource", "title", "updatedAt", "userId", "workspaceRoot") SELECT "agentId", "compactedAt", "compactionSummary", "createdAt", "externalChannelId", "externalThreadId", "id", "threadSource", "title", "updatedAt", "userId", "workspaceRoot" FROM "conversation_threads";
DROP TABLE "conversation_threads";
ALTER TABLE "new_conversation_threads" RENAME TO "conversation_threads";
CREATE UNIQUE INDEX "conversation_threads_agentId_userId_externalThreadId_key" ON "conversation_threads"("agentId", "userId", "externalThreadId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
