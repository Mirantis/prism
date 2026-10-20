-- CreateIndex
CREATE INDEX "conversation_messages_threadId_createdAt_id_idx" ON "conversation_messages"("threadId", "createdAt", "id");
