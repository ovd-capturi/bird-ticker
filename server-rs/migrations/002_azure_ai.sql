-- Azure-only: enable azure_ai extension for in-DB embedding generation.
-- Locally (plain pgvector image) this file is skipped via the runner's try/catch.
CREATE EXTENSION IF NOT EXISTS azure_ai;
