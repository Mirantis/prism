/*
  Warnings:

  - You are about to drop the column `tokenCount` on the `conversation_messages` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "subagentId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "threadId" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "noCacheTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "llm_calls_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_conversation_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "toolCalls" JSONB,
    "blocks" JSONB,
    "senderExternalId" TEXT,
    "senderName" TEXT,
    "externalMessageId" TEXT,
    "isCompacted" BOOLEAN NOT NULL DEFAULT false,
    "internalStep" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_conversation_messages" ("blocks", "content", "createdAt", "externalMessageId", "id", "internalStep", "isCompacted", "role", "senderExternalId", "senderName", "threadId", "toolCalls", "triggeredBy") SELECT "blocks", "content", "createdAt", "externalMessageId", "id", "internalStep", "isCompacted", "role", "senderExternalId", "senderName", "threadId", "toolCalls", "triggeredBy" FROM "conversation_messages";
DROP TABLE "conversation_messages";
ALTER TABLE "new_conversation_messages" RENAME TO "conversation_messages";
CREATE INDEX "conversation_messages_role_createdAt_idx" ON "conversation_messages"("role", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "llm_calls_agentId_createdAt_idx" ON "llm_calls"("agentId", "createdAt");
