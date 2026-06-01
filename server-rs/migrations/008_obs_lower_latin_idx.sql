-- Functional index matching the fetchEvidence WHERE clause:
--   WHERE lower(o.latin) = ANY($1)
--     AND o.loknr = ANY($2)
--     AND EXTRACT(week FROM o.obs_date)::int = ANY($3)
--     AND o.obs_date >= $4::date
-- Existing obs_latin_loknr_week_idx uses raw `latin` so lower() makes it
-- unusable; predictor scans the whole observations table per request.

CREATE INDEX IF NOT EXISTS obs_lower_latin_loknr_week_date_idx
  ON observations (
    lower(latin),
    loknr,
    (EXTRACT(week FROM obs_date)::int),
    obs_date DESC
  );
