#!/usr/bin/env node
// ============================================================
// DAILY SYNC
//
// Entry point called by GitHub Actions daily-sync.yml.
//
// Steps:
//  1. Authenticate to Metabase (session token)
//  2. Fetch all data sources in parallel:
//       - All Metabase questions (Promise.all)
//       - Chargebee customers + balances
//       - Pendo NPS responses + account activity
//  3. Normalize account names; merge into one record per account
//  4. Compute health scores and is_zero_roi
//  5. Load yesterday's snapshots from Supabase
//  6. Compute flags + diff (newly triggered → post to Slack)
//  7. Upsert accounts to Supabase
//  8. Save today's snapshot
//  9. Upsert NPS responses
// ============================================================

import { mbGetSession, buildMetabaseData }    from '../lib/metabase.js';
import { buildChargebeeData }                  from '../lib/chargebee.js';
import { fetchNpsResponses, fetchAccountActivity } from '../lib/pendo.js';
import { normalizeName }                       from '../lib/normalize.js';
import { loadAmAssignments }                   from '../lib/am.js';
import { computeHealthScore, healthStatus, computeHireRate, npsBand, npsTrend } from '../lib/health.js';
import { computeFlags, FLAG_LABELS, URGENT_FLAGS } from '../lib/flags.js';
import { postFlagAlert, postEscalationAlert }   from '../lib/slack.js';
import {
  upsertAccounts,
  saveSnapshots,
  getYesterdaySnapshots,
  upsertNpsResponses,
  deleteStaleAccounts,
  getRecentEscalations,
} from '../lib/supabase.js';

// ── Metabase question config ──────────────────────────────────
// `id`        — numeric ID from the Metabase question URL (/question/1234)
// `columns`   — exact column names as they appear in Metabase (spaces OK)
// `columnMap` — rename Metabase column → internal field name (optional)
//
// All questions run in parallel. Results are merged by account_name.
// Questions that return only flagged/filtered accounts (e.g. noTtaApps)
// are fine — absent accounts simply won't have those fields set.
const METABASE_QUESTIONS = {

  // /question/1438 — Jobs with no perks
  jobsNoPerks: {
    id: 1438,
    columns: ['Location_Count', 'Job_Count', 'Jobs_No_Perks', 'Pct_Jobs_No_Perks'],
    columnMap: {
      Job_Count:        'total_jobs_count',
      Jobs_No_Perks:    'jobs_no_perks',
      Pct_Jobs_No_Perks: 'perc_jobs_no_perks',
    },
  },

  // /question/1437 — Locations with no boosting
  locsNoBoosting: {
    id: 1437,
    columns: ['Location_Count', 'Locations_No_Boost', 'Pct_Locations_No_Boost'],
    columnMap: {
      Location_Count:        'active_locations',
      Pct_Locations_No_Boost: 'perc_locs_no_job_boosts',
    },
  },

  // /question/1436 — Locations with no Indeed apps
  locsNoIndeed: {
    id: 1436,
    columns: ['Locs_No_Indeed', 'Total_Locations', 'Perc_Locs_No_Indeed'],
    columnMap: {
      Total_Locations:    'total_locations',
      Perc_Locs_No_Indeed: 'perc_locs_no_indeed',
    },
  },

  // /question/1463 — Jobs with no salary
  jobsNoSalary: {
    id: 1463,
    columns: ['Location Count', 'Total Jobs Count', 'Jobs_without_salary'],
    columnMap: {
      'Total Jobs Count':  'total_jobs_count_salary', // separate — merged below into perc_jobs_no_salaries
      Jobs_without_salary: 'jobs_without_salary',
    },
  },

  // /question/1432 — Two-way messaging breakdown
  messaging: {
    id: 1432,
    columns: [
      'account_status', 'total_chats', 'applications_with_chat',
      'two_way_pct', 'employer_response_rate_pct',
      'hired_with_chat', 'hire_rate_with_chat_pct', 'locations_with_chat',
    ],
    // account_id omitted — Chargebee is source of truth for that
  },

  // /question/1464 — Locations with no published jobs
  locsNoPublishedJobs: {
    id: 1464,
    columns: ['Locs_w_no_published_job', 'Total_Locations', 'Percentage'],
    columnMap: {
      Locs_w_no_published_job: 'locs_no_active_jobs',
      Percentage:               'perc_locs_no_active_jobs',
    },
  },

  // /question/1329 — Accounts with no TTA applications in last 90 days
  // Filtered list — only accounts with ZERO TTA apps appear.
  // Absence from this question does NOT mean they have TTA apps (they may just not be filtered in).
  noTtaApps: {
    id: 1329,
    columns: ['Location_Count'],
    columnMap: { Location_Count: 'no_tta_apps_loc_count' },
  },

  // /question/1468 — AI usage by account (NextMatch)
  aiUsage: {
    id: 1468,
    columns: ['Requested', 'Completed', 'Expired', 'Credits_Used', 'Last_Billed_On'],
    columnMap: {
      Requested:      'nextmatch_requested',
      Completed:      'nextmatch_calls_90d',
      Last_Billed_On: 'nextmatch_last_used',
    },
  },

  // /question/1469 — Job stats (hiring funnel + time metrics)
  // Returns one row per location — must sum counts and avg rates across locations.
  // account_id here is the Chargebee customer ID — used as fallback
  // for accounts where Chargebee name matching failed (fixes Pendo NPS matching).
  jobStats: {
    id: 1469,
    columns: [
      'account_id', 'account_name',
      'total_applied', 'total_shortlisted', 'total_interviewed', 'total_hired',
      'apply_to_hire_pct', 'apply_to_interview_pct',
      'avg_time_to_interview_hrs', 'avg_time_to_hire_hrs', 'avg_time_to_review_hrs',
      'ai_screening_completion_pct', 'interview_completion_pct',
    ],
    columnMap: {
      total_interviewed:         'total_interviews',       // internal field name
      avg_time_to_interview_hrs: 'avg_time_to_invite_hrs', // converted to days in derived step
    },
    aggregate: {
      account_id:                   'first',
      total_applied:                'sum',
      total_shortlisted:            'sum',
      total_interviewed:            'sum',
      total_hired:                  'sum',
      apply_to_hire_pct:            'avg',
      apply_to_interview_pct:       'avg',
      avg_time_to_interview_hrs:    'avg',
      avg_time_to_hire_hrs:         'avg',
      avg_time_to_review_hrs:       'avg',
      ai_screening_completion_pct:  'avg',
      interview_completion_pct:     'avg',
    },
  },

  // /question/1470 — Application timing stats (time-to-contact, time-to-interview, time-to-hire)
  // Returns one row per location — avg times across locations, sum sample sizes.
  // avg_time_to_contact_hrs is the unique new field from this question.
  // avg_time_to_interview_hrs / avg_time_to_hire_hrs also appear in Q1469 — fine to overwrite
  // since Q1470 sample sizes are weighted and typically more accurate.
  appTimingStats: {
    id: 1470,
    columns: [
      'account_id', 'account_name', 'company_id', 'company_name',
      'contact_sample_n', 'avg_time_to_contact_hrs',
      'interview_sample_n', 'avg_time_to_interview_hrs',
      'hire_sample_n', 'avg_time_to_hire_hrs',
    ],
    aggregate: {
      avg_time_to_contact_hrs:   'avg',
      avg_time_to_interview_hrs: 'avg',
      avg_time_to_hire_hrs:      'avg',
      contact_sample_n:          'sum',
      interview_sample_n:        'sum',
      hire_sample_n:             'sum',
    },
  },

  // /question/1471 — Open jobs by company (rolled up per account)
  // Returns one row per location/company — sum across all locations.
  openJobs: {
    id: 1471,
    columns: ['account_id', 'account_name', 'company_id', 'company_name', 'open_jobs'],
    columnMap: {
      open_jobs: 'open_jobs_count',
    },
    aggregate: {
      open_jobs: 'sum',
    },
  },

  // /question/1472 — Application count (last 30 days) by company
  // Returns one row per location/company — sum across all locations.
  appCount30d: {
    id: 1472,
    columns: ['account_id', 'account_name', 'company_id', 'company_name', 'applications_last_30d'],
    columnMap: {
      applications_last_30d: 'applications_30d',
    },
    aggregate: {
      applications_last_30d: 'sum',
    },
  },

  // /question/1474 — Integrations + onboarding flag (one row per account)
  integrations: {
    id: 1474,
    columns: [
      'account_id', 'account_name',
      'has_netchex', 'has_checkr', 'has_adp', 'has_7shifts',
      'has_chickfila', 'has_paychex', 'has_clearview', 'has_hr_alliance',
      'total_integrations', 'onboarding_enabled',
    ],
  },
};

const DASHBOARD_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://your-dashboard.vercel.app'; // fallback; set VERCEL_URL secret

const TODAY = new Date().toISOString().split('T')[0];

// ── Churn keyword check (for verbatim flag) ───────────────────
const CHURN_KEYWORDS = ['cancel', 'leaving', 'switching', 'last month', 'no improvement'];

async function main() {
  console.log(`=== Daily Sync START — ${TODAY} ===`);
  const startMs = Date.now();

  // ── 1. Metabase session ──────────────────────────────────────
  let mbToken = null;
  try {
    mbToken = await mbGetSession();
  } catch (e) {
    console.error('Metabase auth failed:', e.message);
    // Continue — MB data will be empty but other sources still run
  }

  // ── 2. Fetch all sources in parallel ────────────────────────
  const [mbMap, cbRows, npsResponses, pendoActivity] = await Promise.all([
    mbToken
      ? buildMetabaseData(METABASE_QUESTIONS, mbToken).catch(e => {
          console.error('Metabase buildData failed:', e.message); return {};
        })
      : Promise.resolve({}),

    buildChargebeeData(process.env.CHARGEBEE_API_KEY).catch(e => {
      console.error('Chargebee failed:', e.message); return [];
    }),

    fetchNpsResponses(process.env.PENDO_API_KEY).catch(e => {
      console.error('Pendo NPS fetch failed:', e.message); return [];
    }),

    fetchAccountActivity(process.env.PENDO_API_KEY).catch(e => {
      console.error('Pendo activity fetch failed:', e.message); return {};
    }),
  ]);

  console.log(`Sources fetched — MB: ${Object.keys(mbMap).length} accounts, CB: ${cbRows.length} accounts, NPS responses: ${npsResponses.length}, Pendo accounts: ${Object.keys(pendoActivity).length}`);

  // ── 3. Merge into one map keyed by normalized account name ───
  //
  // CSV is the source of truth for which accounts exist on the dashboard.
  // Chargebee, Metabase, and Pendo data are merged in only for accounts
  // already in the CSV — Chargebee-only accounts are ignored.

  // Seed from AM assignments CSV (defines the account universe)
  const amMap = loadAmAssignments();
  const merged = {};

  for (const [name, am] of Object.entries(amMap)) {
    merged[name] = {
      account_name:    name,
      account_manager: am.account_manager,
      arr:             am.arr,       // null if not set — Chargebee fills in below
      is_managed:      am.is_managed,
    };
  }

  console.log(`CSV accounts loaded: ${Object.keys(merged).length}`);

  // Merge Chargebee billing data (CSV accounts only — skip Chargebee-only accounts)
  for (const cb of cbRows) {
    const name = cb.account_name; // already normalized by buildChargebeeData
    if (!merged[name]) continue;  // not in CSV — skip

    merged[name].account_id          = cb.account_id;
    merged[name].email               = cb.email;
    merged[name].outstanding_balance = cb.outstanding_balance;
    merged[name].cb_customer_count   = cb.cb_customer_count;
    merged[name].create_date         = cb.create_date  ?? null;
    merged[name].renewal_date        = cb.renewal_date ?? null;
    // Use Chargebee ARR only when the CSV didn't set an explicit value
    if (merged[name].arr === null) merged[name].arr = cb.arr ?? 0;
  }

  // Merge Metabase (auto columns)
  // Keys here are the TARGET field names (after columnMap renaming).
  // Add to this list whenever a new Metabase question is configured.
  const MB_AUTO_KEYS = [
    // Config gaps
    'perc_locs_no_indeed', 'perc_locs_no_job_boosts', 'perc_locs_no_active_jobs',
    'perc_jobs_no_perks',
    'total_locations', 'active_locations',
    'locs_no_active_jobs',
    // Jobs / salary (perc_jobs_no_salaries derived below)
    'total_jobs_count', 'total_jobs_count_salary', 'jobs_no_perks', 'jobs_without_salary',
    // Two-way messaging
    'account_status', 'total_chats', 'applications_with_chat',
    'two_way_pct', 'employer_response_rate_pct',
    'hired_with_chat', 'hire_rate_with_chat_pct', 'locations_with_chat',
    // TTA apps (filtered list — presence means zero TTA apps in 90d)
    'no_tta_apps_loc_count',
    // AI / NextMatch
    'nextmatch_requested', 'nextmatch_calls_90d', 'nextmatch_last_used',
    // Job stats (Q1469) — hiring funnel + time metrics
    // account_id included as fallback for accounts where Chargebee name matching failed
    'account_id',
    'total_applied', 'total_shortlisted', 'total_interviews', 'total_hired',
    'apply_to_hire_pct', 'apply_to_interview_pct',
    'avg_time_to_invite_hrs', 'avg_time_to_hire_hrs', 'avg_time_to_review_hrs',
    'ai_screening_completion_pct', 'interview_completion_pct',
    // Application timing (Q1470)
    'avg_time_to_contact_hrs',
    // Open jobs (Q1471)
    'open_jobs_count',
    // Applications last 30d (Q1472)
    'applications_30d',
    // Integrations + onboarding (Q1474)
    'has_netchex', 'has_checkr', 'has_adp', 'has_7shifts',
    'has_chickfila', 'has_paychex', 'has_clearview', 'has_hr_alliance',
    'total_integrations', 'onboarding_enabled',
    // ── Not yet available — add when Metabase questions exist ──
    // 'job_boost_enabled', 'job_boost_last_used_days',
    // 'linkedin_enabled',
  ];

  const hangingMbAccounts = [];
  for (const [name, mb] of Object.entries(mbMap)) {
    if (!merged[name]) {
      hangingMbAccounts.push(name); // in Metabase but not in CSV seed
      continue;
    }
    for (const key of MB_AUTO_KEYS) {
      if (mb[key] !== undefined) merged[name][key] = mb[key];
    }
  }

  if (hangingMbAccounts.length > 0) {
    console.warn(`\n⚠️  HANGING METABASE ACCOUNTS (${hangingMbAccounts.length}) — present in Metabase but missing from CSV seed:`);
    for (const name of hangingMbAccounts) {
      console.warn(`   • ${name}`);
    }
    console.warn('   → Add these to the AM assignments CSV or check for name normalisation mismatches.\n');
  }

  // ── 4. Build NPS per-account summary for merged map ──────────
  // Group responses by Pendo account ID, then match to CB account_id.
  // Pendo uses its own account IDs — we match by normalizing the account name
  // stored alongside each response (if available), or fall back to Pendo accountId.
  const npsByAccountId = {};
  for (const r of npsResponses) {
    const aid = r.account_id;
    if (!npsByAccountId[aid]) npsByAccountId[aid] = [];
    npsByAccountId[aid].push(r);
  }

  // Match Pendo account IDs to merged account names.
  // Strategy: Pendo accountId often matches Chargebee customer ID.
  // Build a reverse lookup from account_id → merged account name.
  const accountIdToName = {};
  for (const [name, acc] of Object.entries(merged)) {
    if (acc.account_id) accountIdToName[acc.account_id] = name;
  }

  // Attach NPS data to each merged account
  for (const [pendoId, responses] of Object.entries(npsByAccountId)) {
    const name = accountIdToName[pendoId];
    if (!name) continue;

    const sorted     = [...responses].sort((a, b) => new Date(b.response_date) - new Date(a.response_date));
    const latest     = sorted[0];
    const latestScore = latest?.score ?? null;
    const latestBand  = npsBand(latestScore);

    // Prior period: most recent response before the latest one
    const priorScore = sorted.length > 1 ? sorted[1].score : null;

    // NPS trend (based on the last two responses)
    const trend = npsTrend(latestScore, priorScore);

    // Score stddev (for accounts with 5+ responses)
    let stddev = null;
    if (responses.length >= 5) {
      const scores = responses.map(r => r.score);
      const mean   = scores.reduce((s, v) => s + v, 0) / scores.length;
      stddev = Math.sqrt(scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / scores.length);
      stddev = Math.round(stddev * 10) / 10;
    }

    // Days since last response
    const daysSinceResponse = latest?.response_date
      ? Math.floor((Date.now() - new Date(latest.response_date).getTime()) / 86400000)
      : null;

    merged[name].nps_latest_score        = latestScore;
    merged[name].nps_latest_band         = latestBand;
    merged[name].nps_latest_response_date = latest?.response_date || null;
    merged[name].nps_latest_verbatim     = latest?.verbatim || null;
    merged[name].nps_prior_score         = priorScore;
    merged[name].nps_trend               = trend;
    merged[name].nps_response_count      = responses.length;
    merged[name].nps_score_stddev        = stddev;
    merged[name].nps_days_since_response = daysSinceResponse;
  }

  // Merge Pendo activity (keyed by Pendo account ID)
  for (const [pendoId, activity] of Object.entries(pendoActivity)) {
    const name = accountIdToName[pendoId];
    if (!name) continue;
    Object.assign(merged[name], activity);
  }

  // ── Compute derived fields ────────────────────────────────────
  for (const acc of Object.values(merged)) {
    // perc_jobs_no_salaries: derived from jobs_without_salary ÷ total_jobs_count
    // Uses total_jobs_count_salary (from Q1463) if available, falls back to total_jobs_count (Q1438)
    const totalJobs = Number(acc.total_jobs_count_salary || acc.total_jobs_count) || 0;
    acc.perc_jobs_no_salaries = totalJobs > 0
      ? Math.round((Number(acc.jobs_without_salary) || 0) / totalJobs * 1000) / 10
      : null;

    // avg_time_to_invite_days / avg_time_to_hire_days / avg_time_to_contact_days:
    // convert from hours (Q1469 / Q1470) to days
    acc.avg_time_to_invite_days = acc.avg_time_to_invite_hrs != null
      ? Math.round(acc.avg_time_to_invite_hrs / 24 * 10) / 10
      : null;
    acc.avg_time_to_hire_days = acc.avg_time_to_hire_hrs != null
      ? Math.round(acc.avg_time_to_hire_hrs / 24 * 10) / 10
      : null;
    acc.avg_time_to_contact_days = acc.avg_time_to_contact_hrs != null
      ? Math.round(acc.avg_time_to_contact_hrs / 24 * 10) / 10
      : null;

    // is_zero_roi: crossed 70% threshold on perc_locs_no_indeed OR perc_locs_no_active_jobs
    acc.is_zero_roi = (Number(acc.perc_locs_no_indeed) || 0) > 70
                   || (Number(acc.perc_locs_no_active_jobs) || 0) > 70;

    // hire_rate (null when no interview data)
    acc.hire_rate = computeHireRate(acc);

    // health_score + health_status
    acc.health_score  = computeHealthScore(acc);
    acc.health_status = healthStatus(acc.health_score);

    acc.last_synced = new Date().toISOString();
  }

  // ── 5. Load yesterday's snapshots ────────────────────────────
  const yesterdayMap = await getYesterdaySnapshots().catch(e => {
    console.error('Could not load yesterday snapshots:', e.message);
    return {};
  });

  // ── 6. Compute flags + build Slack alerts ────────────────────
  const flagAlerts = []; // { flagKey, flagLabel, account, metricNote }

  // Build verbatim lookup: account_name → verbatims from last 24h
  // accountIdToName is already built above (Pendo ID → normalized name)
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000);
  const recentVerbatimsMap = {};
  for (const r of npsResponses) {
    if (r.response_date && new Date(r.response_date) >= cutoff24h && r.verbatim) {
      const name = accountIdToName[r.account_id];
      if (!name) continue;
      if (!recentVerbatimsMap[name]) recentVerbatimsMap[name] = [];
      recentVerbatimsMap[name].push(r.verbatim);
    }
  }

  for (const acc of Object.values(merged)) {
    const yesterday = yesterdayMap[acc.account_name] || null;
    const verbatims = recentVerbatimsMap[acc.account_name] || [];

    // Stash yesterday's health data for use in flagMetricNote (not written to DB)
    acc._prevHealthScore  = yesterday?.health_score  ?? null;
    acc._prevHealthStatus = yesterday?.health_status ?? null;

    const { flags, newlyTriggered } = computeFlags(acc, yesterday, verbatims);

    // Write flags back to the account object (for storage in accounts + snapshots)
    Object.assign(acc, flags);

    // Queue Slack alerts for newly triggered flags
    for (const [flagKey, isNew] of Object.entries(newlyTriggered)) {
      if (!isNew) continue;
      const label  = FLAG_LABELS[flagKey] || flagKey;
      const metric = flagMetricNote(flagKey, acc);
      flagAlerts.push({ flagKey, label, acc, metric });
    }
  }

  // ── 7. Upsert accounts ────────────────────────────────────────
  // Build explicit rows — only columns that exist in the Supabase schema.
  // This prevents unknown Metabase/intermediate fields from crashing the upsert.
  const accountRows = Object.values(merged).map(acc => ({
    account_name:                acc.account_name,
    account_id:                  acc.account_id                  ?? null,
    account_manager:             acc.account_manager             ?? 'Unassigned',
    is_managed:                  acc.is_managed                  ?? false,
    email:                       acc.email                       ?? null,
    arr:                         (Number.isFinite(acc.arr) ? acc.arr : null) ?? 0,
    outstanding_balance:         acc.outstanding_balance         ?? null,
    cb_customer_count:           acc.cb_customer_count           ?? null,
    create_date:                 acc.create_date                 ?? null,
    renewal_date:                acc.renewal_date                ?? null,
    health_score:                acc.health_score                ?? null,
    health_status:               acc.health_status               ?? null,
    is_zero_roi:                 acc.is_zero_roi                 ?? false,
    hire_rate:                   acc.hire_rate                   ?? null,
    nps_latest_score:            acc.nps_latest_score            ?? null,
    nps_latest_band:             acc.nps_latest_band             ?? null,
    nps_latest_verbatim:         acc.nps_latest_verbatim         ?? null,
    nps_latest_response_date:    acc.nps_latest_response_date    ?? null,
    nps_prior_score:             acc.nps_prior_score             ?? null,
    nps_trend:                   acc.nps_trend                   ?? null,
    nps_response_count:          acc.nps_response_count          ?? null,
    nps_score_stddev:            acc.nps_score_stddev            ?? null,
    nps_days_since_response:     acc.nps_days_since_response     ?? null,
    perc_locs_no_indeed:         acc.perc_locs_no_indeed         ?? null,
    perc_locs_no_job_boosts:     acc.perc_locs_no_job_boosts     ?? null,
    perc_locs_no_active_jobs:    acc.perc_locs_no_active_jobs    ?? null,
    perc_jobs_no_perks:          acc.perc_jobs_no_perks          ?? null,
    perc_jobs_no_salaries:       acc.perc_jobs_no_salaries       ?? null,
    total_locations:             acc.total_locations             ?? null,
    active_locations:            acc.active_locations            ?? null,
    locs_no_active_jobs:         acc.locs_no_active_jobs         ?? null,
    total_jobs_count:            acc.total_jobs_count            ?? null,
    jobs_without_salary:         acc.jobs_without_salary         ?? null,
    nextmatch_calls_90d:         acc.nextmatch_calls_90d         ?? null,
    nextmatch_last_used:         acc.nextmatch_last_used         ?? null,
    total_hired:                 acc.total_hired                 ?? null,
    total_interviews:            acc.total_interviews            ?? null,
    total_applied:               acc.total_applied               ?? null,
    avg_time_to_invite_days:     acc.avg_time_to_invite_days     ?? null,
    avg_time_to_hire_days:       acc.avg_time_to_hire_days       ?? null,
    avg_time_to_contact_days:    acc.avg_time_to_contact_days    ?? null,
    open_jobs_count:             acc.open_jobs_count             ?? null,
    applications_30d:            acc.applications_30d            ?? null,
    onboarding_enabled:          acc.onboarding_enabled          ?? null,
    has_netchex:                 acc.has_netchex                 ?? null,
    has_checkr:                  acc.has_checkr                  ?? null,
    has_adp:                     acc.has_adp                     ?? null,
    has_7shifts:                 acc.has_7shifts                 ?? null,
    has_chickfila:               acc.has_chickfila               ?? null,
    has_paychex:                 acc.has_paychex                 ?? null,
    has_clearview:               acc.has_clearview               ?? null,
    has_hr_alliance:             acc.has_hr_alliance             ?? null,
    total_integrations:          acc.total_integrations          ?? null,
    two_way_pct:                 acc.two_way_pct                 ?? null,
    employer_response_rate_pct:  acc.employer_response_rate_pct  ?? null,
    hire_rate_with_chat_pct:     acc.hire_rate_with_chat_pct     ?? null,
    pendo_last_active:           acc.pendo_last_active           ?? null,
    pendo_days_active_per_visitor: acc.pendo_days_active_per_visitor ?? null,
    pendo_error_click_rate:      acc.pendo_error_click_rate      ?? null,
    flag_churn_verbatim:          acc.flag_churn_verbatim          || false,
    flag_promoter_flip:           acc.flag_promoter_flip           || false,
    flag_zero_roi_new:            acc.flag_zero_roi_new            || false,
    flag_paid_feature_lapsed:     acc.flag_paid_feature_lapsed     || false,
    flag_time_to_invite_high:     acc.flag_time_to_invite_high     || false,
    flag_billing_balance:         acc.flag_billing_balance         || false,
    flag_health_score_drop:       acc.flag_health_score_drop       || false,
    flag_health_tier_drop:        acc.flag_health_tier_drop        || false,
    flag_renewal_at_risk:         acc.flag_renewal_at_risk         || false,
    flag_zero_apps_established:   acc.flag_zero_apps_established   || false,
    last_synced:                 acc.last_synced,
  })).filter(row => row.account_name);
  await upsertAccounts(accountRows);

  // Prune accounts that are no longer in the CSV
  await deleteStaleAccounts(accountRows.map(r => r.account_name)).catch(e =>
    console.error('deleteStaleAccounts failed (non-fatal):', e.message)
  );

  // ── 8. Save daily snapshots ───────────────────────────────────
  const snapshotRows = accountRows.map(acc => ({
    account_name:                 acc.account_name,
    snapshot_date:                TODAY,
    arr:                          acc.arr,
    health_score:                 acc.health_score,
    health_status:                acc.health_status,
    is_zero_roi:                  acc.is_zero_roi,
    outstanding_balance:          acc.outstanding_balance,
    nps_score:                    acc.nps_latest_score,
    nps_band:                     acc.nps_latest_band,
    perc_locs_no_indeed:          acc.perc_locs_no_indeed,
    perc_locs_no_active_jobs:     acc.perc_locs_no_active_jobs,
    applications_30d:             acc.applications_30d,
    hire_rate:                    acc.hire_rate,
    avg_time_to_invite_days:      acc.avg_time_to_invite_days,
    pendo_days_active_per_visitor: acc.pendo_days_active_per_visitor,
    flag_churn_verbatim:          acc.flag_churn_verbatim          || false,
    flag_promoter_flip:           acc.flag_promoter_flip           || false,
    flag_zero_roi_new:            acc.flag_zero_roi_new            || false,
    flag_paid_feature_lapsed:     acc.flag_paid_feature_lapsed     || false,
    flag_time_to_invite_high:     acc.flag_time_to_invite_high     || false,
    flag_billing_balance:         acc.flag_billing_balance         || false,
    flag_health_score_drop:       acc.flag_health_score_drop       || false,
    flag_health_tier_drop:        acc.flag_health_tier_drop        || false,
    flag_renewal_at_risk:         acc.flag_renewal_at_risk         || false,
    flag_zero_apps_established:   acc.flag_zero_apps_established   || false,
  })).filter(row => row.account_name); // only rows with a resolved account name

  await saveSnapshots(snapshotRows);

  // ── 9. Upsert NPS responses ───────────────────────────────────
  // Attach account_name to each response (for weekly digest lookups)
  const enrichedResponses = npsResponses.map(r => ({
    ...r,
    account_name: accountIdToName[r.account_id] || null,
  }));
  await upsertNpsResponses(enrichedResponses);

  // ── 10. Post Slack alerts (urgent flags only — any day) ───────
  // Non-urgent flags are batched and posted Monday by weekly-digest.js.
  for (const { flagKey, label, acc, metric } of flagAlerts) {
    if (!URGENT_FLAGS.has(flagKey)) continue;   // non-urgent → Monday digest
    if (!acc.is_managed) continue;              // unmanaged accounts never get Slack alerts
    try {
      await postFlagAlert(flagKey, label, acc, metric, DASHBOARD_BASE);
    } catch (e) {
      console.error(`Slack alert failed for ${flagKey} / ${acc.account_name}:`, e.message);
    }
  }

  // ── 11. Post Slack alerts for newly added escalation notes ───
  // Escalations are written to Supabase by the dashboard when an AM adds a note.
  // We detect ones created in the last 24h and post to Slack here.
  // Note: for real-time alerts consider a Supabase Database Webhook → SLACK_WEBHOOK_URL.
  let escalationAlertCount = 0;
  try {
    const recentEscalations = await getRecentEscalations();
    for (const esc of recentEscalations) {
      // Only alert for managed accounts (match to merged map if possible)
      const accName = esc.account_name;
      const isMgd   = accName ? (merged[accName]?.is_managed ?? true) : true;
      if (!isMgd) continue;
      try {
        await postEscalationAlert(esc, DASHBOARD_BASE);
        escalationAlertCount++;
      } catch (e) {
        console.error(`Escalation Slack alert failed for ${accName}:`, e.message);
      }
    }
    if (recentEscalations.length > 0) {
      console.log(`Escalations: ${recentEscalations.length} found in last 24h, ${escalationAlertCount} alerted`);
    }
  } catch (e) {
    console.error('getRecentEscalations failed (non-fatal):', e.message);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`=== Daily Sync END — ${accountRows.length} accounts, ${snapshotRows.length} snapshots, ${flagAlerts.length} flag alerts, ${escalationAlertCount} escalation alerts in ${elapsed}s${hangingMbAccounts.length ? `, ${hangingMbAccounts.length} hanging MB accounts` : ''} ===`);
}

// ── Flag metric notes (human-readable trigger description) ────

function flagMetricNote(flagKey, acc) {
  switch (flagKey) {
    case 'flag_churn_verbatim':
      return `NPS verbatim in last 24h: "${(acc.nps_latest_verbatim || '').slice(0, 100)}"`;
    case 'flag_promoter_flip':
      return `NPS: was ${acc.nps_prior_score} (promoter), now ${acc.nps_latest_score} (detractor) — Δ${acc.nps_latest_score - acc.nps_prior_score}`;
    case 'flag_zero_roi_new':
      return `${acc.perc_locs_no_indeed || 0}% locs no Indeed apps, ${acc.perc_locs_no_active_jobs || 0}% locs no active jobs (crossed 70% threshold)`;
    case 'flag_paid_feature_lapsed':
      return `NextMatch: ${acc.nextmatch_requested || 0} requests, 0 completions in 90 days`;
    case 'flag_time_to_invite_high':
      return `Avg time to invite: ${acc.avg_time_to_invite_days}d — newly crossed 7-day threshold`;
    case 'flag_billing_balance':
      return `Outstanding balance: $${(acc.outstanding_balance || 0).toLocaleString()} (newly appeared)`;
    case 'flag_health_score_drop':
      return `Health score dropped from ${acc._prevHealthScore ?? '?'} → ${acc.health_score} (≥10 point drop)`;
    case 'flag_health_tier_drop':
      return `Health tier: ${acc._prevHealthStatus ?? '?'} → ${acc.health_status}`;
    case 'flag_renewal_at_risk': {
      const renewalDate   = acc.renewal_date ? new Date(acc.renewal_date) : null;
      const daysToRenewal = renewalDate
        ? Math.floor((renewalDate.getTime() - Date.now()) / 86400000)
        : '?';
      return `Renewal in ${daysToRenewal} days — health score: ${acc.health_score}`;
    }
    case 'flag_zero_apps_established': {
      const age = acc.create_date
        ? Math.floor((Date.now() - new Date(acc.create_date).getTime()) / 86400000)
        : '?';
      return `${age} day-old account — 0 applications in last 30 days`;
    }
    default:
      return '';
  }
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
