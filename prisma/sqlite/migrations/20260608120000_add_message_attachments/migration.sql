-- CreateTable
CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT,
    "threadId" TEXT,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "source" TEXT NOT NULL,
    "slackFileId" TEXT,
    "externalTs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");

-- CreateIndex
CREATE INDEX "message_attachments_threadId_idx" ON "message_attachments"("threadId");

-- CreateIndex
CREATE INDEX "message_attachments_externalTs_idx" ON "message_attachments"("externalTs");

-- CreateIndex
CREATE INDEX "message_attachments_slackFileId_idx" ON "message_attachments"("slackFileId");
