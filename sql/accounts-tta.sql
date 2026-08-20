-- ============================================================
-- TEXT-TO-APPLY COVERAGE ON accounts
--
-- Q1329 ("accounts with no TTA applications in last 90 days") was already
-- being fetched by the sync but never written to Supabase, so the dashboard's
-- Text-to-Apply row and the new AM usage filters had nothing to read.
--
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table public.accounts add column if not exists no_tta_apps_loc_count integer;
alter table public.accounts add column if not exists perc_locs_no_tta       numeric;
