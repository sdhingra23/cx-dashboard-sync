-- ============================================================
-- PARENT BRAND ON accounts
--
-- Source: Chargebee's cf_parent_brand custom field, which groups multiple
-- franchisee/location accounts under one brand (e.g. "Dunkin'"). Blank for
-- independent accounts not part of a multi-unit brand.
--
-- Powers the dashboard's brand-level rollup (Platform Health-style view
-- aggregated across every account tagged to the same brand).
--
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table public.accounts add column if not exists parent_brand text;
