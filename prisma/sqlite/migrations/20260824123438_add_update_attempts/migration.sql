-- CreateTable
CREATE TABLE "update_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionFrom" TEXT NOT NULL,
    "versionTo" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "update_attempts_startedAt_idx" ON "update_attempts"("startedAt");
