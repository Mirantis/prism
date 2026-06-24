-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_cron_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "threadId" TEXT,
    "originChannel" TEXT,
    "originChannelId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cron_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "cron_tasks_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_cron_tasks" ("agentId", "createdAt", "id", "instruction", "isActive", "lastRunAt", "name", "nextRunAt", "schedule", "updatedAt", "userId") SELECT "agentId", "createdAt", "id", "instruction", "isActive", "lastRunAt", "name", "nextRunAt", "schedule", "updatedAt", "userId" FROM "cron_tasks";
DROP TABLE "cron_tasks";
ALTER TABLE "new_cron_tasks" RENAME TO "cron_tasks";
CREATE INDEX "cron_tasks_threadId_idx" ON "cron_tasks"("threadId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
