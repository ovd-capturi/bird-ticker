CREATE INDEX IF NOT EXISTS obs_latin_loknr_week_idx ON observations
  (latin, loknr, (EXTRACT(week FROM obs_date)::int));

CREATE INDEX IF NOT EXISTS obs_latin_date_idx ON observations
  (latin, obs_date DESC);
