-- ============================================================
-- LINKEDIN FLAG ON accounts
--
-- Source: Metabase question 1515 ("LinkedIn Enabled"), which returns
-- linkedin_enabled as 1/0 per account. The sync coerces that to a boolean;
-- accounts absent from the question stay null, meaning "unknown" rather
-- than "not enabled", so the dashboard shows "No data" for them.
--
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table public.accounts add column if not exists linkedin_enabled boolean;
