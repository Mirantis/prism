-- CreateEnum
CREATE TYPE "ThreadSource" AS ENUM ('DATABASE', 'SLACK');

-- AlterTable
ALTER TABLE "conversation_threads" ADD COLUMN "threadSource" "ThreadSource" NOT NULL DEFAULT 'DATABASE';
ALTER TABLE "conversation_threads" ADD COLUMN "externalChannelId" TEXT;
