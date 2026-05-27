CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  list_type TEXT NOT NULL,
  subscription_json JSONB NOT NULL,
  last_alert_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  list_type TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  settings JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  obs_date DATE NOT NULL,
  species TEXT NOT NULL,
  latin TEXT NOT NULL,
  location TEXT,
  loknr TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  observer TEXT,
  count INTEGER,
  behaviour TEXT,
  raw JSONB,
  embedding VECTOR(1536),
  inserted_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS obs_dedup_idx ON observations
  (obs_date, latin, loknr, observer, behaviour) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS obs_date_idx ON observations(obs_date);
CREATE INDEX IF NOT EXISTS obs_loknr_idx ON observations(loknr);
CREATE INDEX IF NOT EXISTS obs_latin_idx ON observations(latin);
CREATE INDEX IF NOT EXISTS obs_embedding_idx ON observations
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS scrape_log (
  obs_date DATE PRIMARY KEY,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  row_count INTEGER
);
