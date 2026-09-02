-- One step's assistant content parts, as the provider produced them: reasoning
-- (with the provider metadata carrying its signature), text, tool calls. Replay
-- sends them back verbatim, so the assistant message a later turn carries is the
-- one the provider cached during the live turn, and the cached prefix holds past
-- it. Null on every existing row, which replays from `content` + `toolCalls` as
-- before.
-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN "assistantParts" JSONB;
