-- ============================================================
-- LOCATIONS TABLE
--
-- One row per location (Metabase question 1513 — "Location drill downs").
-- Accounts have many locations; account_name matches accounts.account_name
-- after normalizeName(), so the dashboard can join the two client-side.
--
-- Rewritten in full by scripts/sync.js on every daily run: rows are upserted
-- on location_id, then any row whose last_synced predates the run is pruned.
--
-- Run this once in the Supabase SQL editor before deploying the sync change.
-- ============================================================

create table if not exists public.locations (
  location_id                 bigint primary key,
  account_id                  bigint,
  account_name                text not null,
  company_name                text,
  location_name               text,

  -- Job Boost
  boosts_30d                  integer default 0,
  last_boost_at               timestamptz,
  has_boosted_30d             boolean default false,

  -- Jobs
  published_jobs              integer default 0,
  jobs_no_salary              integer default 0,

  -- Applications
  signage_apps_30d            integer default 0,
  last_signage_app_at         timestamptz,
  indeed_status               text,
  indeed_apps_30d             integer default 0,
  last_indeed_app_at          timestamptz,
  total_apps_30d              integer default 0,   -- derived: indeed + signage

  -- AI screenings (NextMatch)
  screenings_requested_30d    integer default 0,
  screenings_completed_30d    integer default 0,
  screenings_expired_30d      integer default 0,

  -- Two-way messaging
  total_chats_30d             integer default 0,
  chats_employer_replied_30d  integer default 0,
  two_way_chats_30d           integer default 0,

  last_synced                 timestamptz not null default now()
);

-- RLS on, no policies: the sync and /api/locations both connect with the
-- service-role key, which bypasses RLS, while the anon key gets nothing.
-- `create table` leaves RLS off by default (unlike the Table Editor), so
-- this line is what keeps the table unreadable from the browser.
alter table public.locations enable row level security;

-- The dashboard always reads locations filtered by account, and the sync
-- prunes by last_synced — index both.
create index if not exists locations_account_name_idx on public.locations (account_name);
create index if not exists locations_last_synced_idx  on public.locations (last_synced);
