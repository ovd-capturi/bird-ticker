-- Partial index for the social feed (GET /api/social-feed), whose query is:
--   WHERE (raw->'pictures' IS NOT NULL AND raw->'pictures' <> '[]'::jsonb)
--         OR coalesce(raw->>'note','') <> ''
--   ORDER BY obs_date DESC, coalesce(raw->>'time','') DESC, id DESC
--   [keyset: (obs_date, coalesce(raw->>'time',''), id) < ($date, $time, $id)]
-- The partial predicate matches the endpoint's WHERE clause exactly so only
-- picture-or-note rows are indexed, and the column list mirrors the sort/keyset
-- so the planner can walk the feed backwards in time without a full scan.

CREATE INDEX IF NOT EXISTS obs_social_feed_idx
  ON observations (
    obs_date DESC,
    (coalesce(raw->>'time', '')) DESC,
    id DESC
  )
  WHERE (raw->'pictures' IS NOT NULL AND raw->'pictures' <> '[]'::jsonb)
     OR coalesce(raw->>'note', '') <> '';
