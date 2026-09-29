-- ============================================================
-- HUBSPOT (PROJECT UNIFIED) APPLICANT FUNNEL ON locations
--
-- HubSpot's Location custom object carries a full applicant funnel per
-- location (new/contacted/uncontacted/interviewed/offered/hired/rejected/
-- auto-rejected/pending onboarding/future candidate/with video, all in the
-- last 30 days) that Metabase's Q1513 does not have. location_id is the
-- same numeric ID space Q1513 already uses, so this merges into the
-- existing row for a location rather than needing a parallel table — see
-- scripts/sync.js's HubSpot location merge step.
--
-- hs_status/hs_paused_at/hs_churned_at/hs_deleted_at/hs_brand_id/
-- hs_brand_name are prefixed hs_ to avoid colliding with any future
-- Metabase-sourced columns of a similar name; the funnel counts have no
-- Metabase equivalent to collide with, so are unprefixed.
--
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table public.locations add column if not exists hs_status     text;
alter table public.locations add column if not exists hs_paused_at  date;
alter table public.locations add column if not exists hs_churned_at date;
alter table public.locations add column if not exists hs_deleted_at date;
alter table public.locations add column if not exists hs_brand_id   integer;
alter table public.locations add column if not exists hs_brand_name text;

alter table public.locations add column if not exists active_job_count               integer;
alter table public.locations add column if not exists applicant_count_30d            integer;
alter table public.locations add column if not exists completed_application_count    integer;
alter table public.locations add column if not exists indeed_applicant_count_30d     integer;
alter table public.locations add column if not exists jobs_without_wage_count        integer;
alter table public.locations add column if not exists multi_status_application_count integer;
alter table public.locations add column if not exists onboarded_employee_count       integer;
alter table public.locations add column if not exists last_requested_boost           date;

alter table public.locations add column if not exists funnel_new_30d                 integer;
alter table public.locations add column if not exists funnel_contacted_30d           integer;
alter table public.locations add column if not exists funnel_uncontacted_30d         integer;
alter table public.locations add column if not exists funnel_interviewed_30d         integer;
alter table public.locations add column if not exists funnel_offered_30d             integer;
alter table public.locations add column if not exists funnel_will_offer_30d          integer;
alter table public.locations add column if not exists funnel_hired_30d               integer;
alter table public.locations add column if not exists funnel_rejected_30d            integer;
alter table public.locations add column if not exists funnel_auto_rejected_30d       integer;
alter table public.locations add column if not exists funnel_pending_onboarding_30d  integer;
alter table public.locations add column if not exists funnel_future_candidate_30d    integer;
alter table public.locations add column if not exists funnel_with_video_30d          integer;
