-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add nullable embedding column to memory_entries
ALTER TABLE "memory_entries" ADD COLUMN "embedding" vector(1024);

-- Create HNSW index for cosine similarity search
-- Partial index: only index rows that have an embedding
CREATE INDEX "memory_entries_embedding_hnsw_idx"
  ON "memory_entries"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
