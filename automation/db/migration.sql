-- Props.cash Scraper — Database Schema
-- Target: Supabase (Postgres 15+)
--
-- Run this migration once via the Supabase SQL Editor or psql.

-- ─── Table 1: scrape_runs ───────────────────────────────────────────
-- One row per scrape execution.

CREATE TABLE IF NOT EXISTS scrape_runs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport       text        NOT NULL DEFAULT 'nba',
  date_iso    date        NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  props_attempted int     NOT NULL DEFAULT 0,
  props_succeeded int     NOT NULL DEFAULT 0,
  rows_total  int         NOT NULL DEFAULT 0,
  errors      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source      text        NOT NULL DEFAULT 'props.cash',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_date
  ON scrape_runs (sport, date_iso);

-- ─── Table 2: prop_rows ────────────────────────────────────────────
-- One row per player-prop-line snapshot.

CREATE TABLE IF NOT EXISTS prop_rows (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid        NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
  sport         text        NOT NULL DEFAULT 'nba',
  date_iso      date        NOT NULL,
  prop_key      text        NOT NULL,
  prop_label    text        NOT NULL,
  player_name   text        NOT NULL,
  team          text,
  status        text,
  line          numeric,
  odds_over     int,
  odds_under    int,
  projection    numeric,
  diff          numeric,
  dvp           text,
  hit_rates     jsonb,
  raw           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_signature text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint for safe UPSERT on re-scrape
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_rows_natural_key
  ON prop_rows (sport, date_iso, prop_key, player_name, COALESCE(line, -999), COALESCE(odds_over, -999), COALESCE(odds_under, -999));

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_prop_rows_date_prop
  ON prop_rows (sport, date_iso, prop_key);

CREATE INDEX IF NOT EXISTS idx_prop_rows_player
  ON prop_rows (player_name);

CREATE INDEX IF NOT EXISTS idx_prop_rows_run
  ON prop_rows (run_id);
