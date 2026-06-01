CREATE TABLE IF NOT EXISTS ticklists (
  user_id TEXT NOT NULL,
  list_type TEXT NOT NULL,
  birds JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, list_type)
);
