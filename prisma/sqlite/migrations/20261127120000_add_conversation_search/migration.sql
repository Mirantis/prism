-- CreateTable
CREATE TABLE "channel_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "senderExternalId" TEXT,
    "senderName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "channel_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_search_entries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" TEXT,
    "channelMessageId" TEXT,
    "threadId" TEXT NOT NULL,
    "createdAtMs" BIGINT NOT NULL,
    "personMessage" BOOLEAN NOT NULL,
    "automated" BOOLEAN NOT NULL,
    CONSTRAINT "message_search_entries_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_search_entries_channelMessageId_fkey" FOREIGN KEY ("channelMessageId") REFERENCES "channel_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_messages_threadId_externalMessageId_key" ON "channel_messages"("threadId", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_search_entries_messageId_key" ON "message_search_entries"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_search_entries_channelMessageId_key" ON "message_search_entries"("channelMessageId");

-- CreateIndex
CREATE INDEX "message_search_entries_threadId_createdAtMs_idx" ON "message_search_entries"("threadId", "createdAtMs");

