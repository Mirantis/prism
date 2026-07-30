-- Per-turn context-occupancy snapshot for the "% context left" indicator.
-- `contextTokens` is the provider-reported prompt size (input tokens, already
-- inclusive of cache reads/writes, plus that step's output) — a snapshot, not a
-- running total. `contextModel` records which model produced it so the
-- percentage is recomputed against the right window on read.

-- AlterTable
ALTER TABLE "conversation_threads" ADD COLUMN "contextTokens" INTEGER;

-- AlterTable
ALTER TABLE "conversation_threads" ADD COLUMN "contextModel" TEXT;
