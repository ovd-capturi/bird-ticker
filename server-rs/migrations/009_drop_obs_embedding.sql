-- Predictor no longer uses vector embeddings; bucket-based frequency
-- (obs_bucket_week / obs_bucket_month) is the sole ranking signal.
-- Drop the HNSW index and the column to reclaim space and remove
-- the async embedding backfill obligation.
DROP INDEX IF EXISTS obs_embedding_idx;
ALTER TABLE observations DROP COLUMN IF EXISTS embedding;
