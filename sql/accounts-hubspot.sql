-- ============================================================
-- HUBSPOT (PROJECT UNIFIED) FIELDS ON accounts
--
-- HubSpot's HM Account/HM Company custom objects are now the source of
-- truth for account identity, ARR, and the 12 integration flags —
-- previously Chargebee company-name matching. See scripts/sync.js and
-- lib/hubspot.js.
--
-- hm_account_id lets a record be traced back to its HubSpot HM Account
-- directly (https://app.hubspot.com/contacts/<portal>/record/<objectTypeId>/<hm_account_id>
-- isn't quite right since HubSpot's internal record id differs from
-- hm_account_id the custom property — kept mainly for support/debugging
-- cross-reference, not as a working deep link).
--
-- templates_edited_count / custom_questions_in_use_count are new — no
-- Metabase equivalent existed before. has_form_i9 / has_hr_logics /
-- has_wizardline / has_iconblocks are also new — 4 of the 12 HubSpot
-- integrations that had no Metabase-sourced equivalent at all.
--
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table public.accounts add column if not exists hm_account_id integer;

alter table public.accounts add column if not exists has_form_i9    boolean;
alter table public.accounts add column if not exists has_hr_logics  boolean;
alter table public.accounts add column if not exists has_wizardline boolean;
alter table public.accounts add column if not exists has_iconblocks boolean;

alter table public.accounts add column if not exists templates_edited_count        integer;
alter table public.accounts add column if not exists custom_questions_in_use_count integer;
