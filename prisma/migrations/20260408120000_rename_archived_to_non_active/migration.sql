-- Rename ThreadStatus enum value: ARCHIVED -> NON_ACTIVE
-- PostgreSQL doesn't support DROP VALUE from enums, so we add the new value and migrate data.
-- The old 'ARCHIVED' value remains in the DB enum but will never be used by the application.

-- ADD VALUE cannot run inside a transaction — this migration is in its own file
-- so Prisma runs it as a separate migration step before the data migration.
ALTER TYPE "ThreadStatus" ADD VALUE IF NOT EXISTS 'NON_ACTIVE';
