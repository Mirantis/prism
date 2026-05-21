-- Migrate existing data from ARCHIVED to NON_ACTIVE
UPDATE "conversation_threads" SET "status" = 'NON_ACTIVE' WHERE "status" = 'ARCHIVED';

-- Ensure Slack threads are never ACTIVE
UPDATE "conversation_threads" SET "status" = 'NON_ACTIVE' WHERE "externalThreadId" IS NOT NULL AND "status" = 'ACTIVE';
