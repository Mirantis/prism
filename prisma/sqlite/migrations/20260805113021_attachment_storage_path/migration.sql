-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_message_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT,
    "threadId" TEXT,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "data" BLOB,
    "storagePath" TEXT,
    "source" TEXT NOT NULL,
    "slackFileId" TEXT,
    "externalTs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_message_attachments" ("category", "createdAt", "data", "externalTs", "filename", "id", "mediaType", "messageId", "sizeBytes", "slackFileId", "source", "threadId") SELECT "category", "createdAt", "data", "externalTs", "filename", "id", "mediaType", "messageId", "sizeBytes", "slackFileId", "source", "threadId" FROM "message_attachments";
DROP TABLE "message_attachments";
ALTER TABLE "new_message_attachments" RENAME TO "message_attachments";
CREATE UNIQUE INDEX "message_attachments_slackFileId_key" ON "message_attachments"("slackFileId");
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");
CREATE INDEX "message_attachments_threadId_idx" ON "message_attachments"("threadId");
CREATE INDEX "message_attachments_externalTs_idx" ON "message_attachments"("externalTs");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
