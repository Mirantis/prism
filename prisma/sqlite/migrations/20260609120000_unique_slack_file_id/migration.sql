-- Replace the non-unique slackFileId index with a UNIQUE one. The Slack
-- ingest path de-dupes with a check-then-insert (existsBySlackFileId), which
-- is a TOCTOU fast-path; under at-least-once event redelivery two interleaved
-- handler runs can both pass the check and insert. The unique index is the
-- real guarantee. NULLs (web uploads) stay unconstrained in SQLite.

-- DropIndex
DROP INDEX "message_attachments_slackFileId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_slackFileId_key" ON "message_attachments"("slackFileId");
