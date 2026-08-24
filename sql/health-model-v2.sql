-- ============================================================
-- HEALTH SCORE MODEL v2 + ROLE-WEIGHTED NPS
--
-- Adds the columns model v2 writes:
--   • per-factor score breakdown, so the dashboard can show why an account
--     scores what it does
--   • score_model_version on accounts AND snapshots — computeFlags() compares
--     the two and suppresses the health-drop Slack alerts on the run where
--     the model changes, which would otherwise fire across the whole book
--   • company-admin NPS, split out from the blended figure
--   • respondent role on individual NPS responses
--   • interview_to_hire_rate, which is the old hire_rate definition; hire_rate
--     itself is now applications → hires
--
-- Run once in the Supabase SQL editor.
-- ============================================================

-- ── accounts ────────────────────────────────────────────────
alter table public.accounts add column if not exists health_breakdown        jsonb;
alter table public.accounts add column if not exists score_model_version     integer;
alter table public.accounts add column if not exists interview_to_hire_rate  numeric;
alter table public.accounts add column if not exists nextmatch_requested     integer;

alter table public.accounts add column if not exists nps_admin_score         numeric;
alter table public.accounts add column if not exists nps_admin_band          text;
alter table public.accounts add column if not exists nps_admin_response_date date;
alter table public.accounts add column if not exists nps_admin_count         integer;
alter table public.accounts add column if not exists nps_role_breakdown      jsonb;
alter table public.accounts add column if not exists nps_role_data_available boolean default false;

-- ── snapshots ───────────────────────────────────────────────
alter table public.snapshots add column if not exists score_model_version    integer;

-- ── nps_responses ───────────────────────────────────────────
-- role_raw keeps Pendo's own string so a mis-bucketed value can be diagnosed
-- without re-querying Pendo; role_tier is the admin/employer/other bucket.
alter table public.nps_responses add column if not exists role_raw  text;
alter table public.nps_responses add column if not exists role_tier text;
