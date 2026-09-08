-- CreateTable
CREATE TABLE "agent_workspace_revisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_workspace_revisions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "agent_workspace_revisions_agentId_field_createdAt_idx" ON "agent_workspace_revisions"("agentId", "field", "createdAt");

-- An install upgraded from a build without this table holds documents and no
-- revisions, so each one gains a baseline here holding what it reads now.
-- Attributed to the user: the content either came from the template or predates
-- the history. `INSERT OR IGNORE` on a deterministic id makes a re-run a no-op.

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-soulMd', w."id", 'soulMd', w."soulMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-userMd', w."id", 'userMd', w."userMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-memoryMd', w."id", 'memoryMd', w."memoryMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-heartbeatMd', w."id", 'heartbeatMd', w."heartbeatMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-visionMd', w."id", 'visionMd', w."visionMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-agentMd', w."id", 'agentMd', w."agentMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;

INSERT OR IGNORE INTO "agent_workspace_revisions"
    ("id", "agentId", "field", "content", "actor", "method", "reason", "createdAt")
SELECT 'seed-' || w."id" || '-bootstrapMd', w."id", 'bootstrapMd', w."bootstrapMd",
       'user', 'seed', 'Recorded on upgrade. Earlier revisions were not kept.', w."updatedAt"
  FROM "agent_workspaces" w;
