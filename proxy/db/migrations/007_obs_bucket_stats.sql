-- Materialised weekly and monthly aggregate buckets over observations.
-- The predictor reads from these instead of scanning the raw observations
-- table on every request. Week keys use ISO year (not calendar year) so
-- week 1/53 boundary days are bucketed correctly.

CREATE TABLE IF NOT EXISTS obs_bucket_week (
  latin       TEXT    NOT NULL,
  loknr       TEXT    NOT NULL DEFAULT '',
  iso_year    INT     NOT NULL,
  iso_week    INT     NOT NULL,
  n_obs       INT     NOT NULL DEFAULT 0,
  sum_count   BIGINT  NOT NULL DEFAULT 0,
  last_obs    DATE,
  lat         NUMERIC,
  lng         NUMERIC,
  location    TEXT,
  species     TEXT,
  PRIMARY KEY (latin, loknr, iso_year, iso_week)
);

CREATE INDEX IF NOT EXISTS obs_bucket_week_latin_week_idx
  ON obs_bucket_week (latin, iso_week);

CREATE TABLE IF NOT EXISTS obs_bucket_month (
  latin       TEXT    NOT NULL,
  loknr       TEXT    NOT NULL DEFAULT '',
  year        INT     NOT NULL,
  month       INT     NOT NULL,
  n_obs       INT     NOT NULL DEFAULT 0,
  sum_count   BIGINT  NOT NULL DEFAULT 0,
  last_obs    DATE,
  lat         NUMERIC,
  lng         NUMERIC,
  location    TEXT,
  species     TEXT,
  PRIMARY KEY (latin, loknr, year, month)
);

CREATE INDEX IF NOT EXISTS obs_bucket_month_latin_month_idx
  ON obs_bucket_month (latin, month);

-- Backfill from existing observations. NULL-safe loknr handled via
-- COALESCE(-1) so the PK works; readers must map -1 back to NULL.
INSERT INTO obs_bucket_week
  (latin, loknr, iso_year, iso_week, n_obs, sum_count, last_obs, lat, lng, location, species)
SELECT
  latin,
  COALESCE(loknr, ''),
  EXTRACT(isoyear FROM obs_date)::int,
  EXTRACT(week    FROM obs_date)::int,
  count(*)::int,
  sum(coalesce(count, 1))::bigint,
  max(obs_date),
  avg(lat) FILTER (WHERE lat IS NOT NULL),
  avg(lng) FILTER (WHERE lng IS NOT NULL),
  max(location),
  max(species)
FROM observations
WHERE latin IS NOT NULL AND latin <> ''
GROUP BY latin, COALESCE(loknr, ''),
         EXTRACT(isoyear FROM obs_date)::int,
         EXTRACT(week    FROM obs_date)::int
ON CONFLICT DO NOTHING;

INSERT INTO obs_bucket_month
  (latin, loknr, year, month, n_obs, sum_count, last_obs, lat, lng, location, species)
SELECT
  latin,
  COALESCE(loknr, ''),
  EXTRACT(year  FROM obs_date)::int,
  EXTRACT(month FROM obs_date)::int,
  count(*)::int,
  sum(coalesce(count, 1))::bigint,
  max(obs_date),
  avg(lat) FILTER (WHERE lat IS NOT NULL),
  avg(lng) FILTER (WHERE lng IS NOT NULL),
  max(location),
  max(species)
FROM observations
WHERE latin IS NOT NULL AND latin <> ''
GROUP BY latin, COALESCE(loknr, ''),
         EXTRACT(year  FROM obs_date)::int,
         EXTRACT(month FROM obs_date)::int
ON CONFLICT DO NOTHING;
