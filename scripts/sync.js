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
// 10. Upsert location drill-down rows (one row per location)
// ============================================================

import { mbGetSession, buildMetabaseData, mbRunQuestion } from '../lib/metabase.js';
import { buildLocationRows, buildLocationConfigByAccount, LOCATION_QUESTION_ID } from '../lib/locations.js';
import { buildChargebeeData }                  from '../lib/chargebee.js';
import { fetchNpsResponses, fetchAccountActivity, fetchVisitorRoles, classifyRole } from '../lib/pendo.js';
import { normalizeName }                       from '../lib/normalize.js';
import { loadAmAssignments }                   from '../lib/am.js';
import { computeHealthBreakdown, healthStatus, computeHireRate, computeInterviewToHireRate,
         npsBand, npsTrend, SCORE_MODEL_VERSION } from '../lib/health.js';
import { computeFlags, FLAG_LABELS, URGENT_FLAGS } from '../lib/flags.js';
import { postAccountFlagAlert, postEscalationAlert } from '../lib/slack.js';
import {
  upsertAccounts,
  saveSnapshots,
  getYesterdaySnapshots,
  getSnapshotNDaysAgo,
  upsertNpsResponses,
  deleteStaleAccounts,
  getRecentEscalations,
  getAllAccounts,
  upsertLocations,
  deleteStaleLocations,
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

  // /question/1515 — LinkedIn enabled (one row per account, 1 = enabled)
  linkedin: {
    id: 1515,
    columns: ['account_id', 'account_name', 'linkedin_enabled'],
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

// DASHBOARD_URL is a GitHub Actions secret set to the production Vercel
// domain — deliberately not named VERCEL_URL, which is a variable Vercel
// itself injects automatically at build/runtime with a different meaning
// (the current deployment's own unique URL), so reusing that name here was
// silently reading an unset secret and falling back to the placeholder.
const DASHBOARD_BASE = process.env.DASHBOARD_URL
  ? `https://${process.env.DASHBOARD_URL.replace(/^https?:\/\//, '')}`
  : 'https://cx-dashboard-sync.vercel.app';

const TODAY     = new Date().toISOString().split('T')[0];
// One timestamp for the whole run — deleteStaleLocations() prunes any row
// whose last_synced is older, so every row this run writes must share it.
const SYNCED_AT = new Date().toISOString();

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
  const [mbMap, rawLocationRows, cbRows, npsResponses, pendoActivity, visitorRoles, existingAccounts] = await Promise.all([
    mbToken
      ? buildMetabaseData(METABASE_QUESTIONS, mbToken).catch(e => {
          console.error('Metabase buildData failed:', e.message); return {};
        })
      : Promise.resolve({}),

    // Q1513 runs outside METABASE_QUESTIONS: it returns one row per location,
    // and buildMetabaseData() would collapse those to one row per account.
    // Rows are stored as-is in the `locations` table (step 10).
    mbToken
      ? mbRunQuestion(LOCATION_QUESTION_ID, mbToken).catch(e => {
          console.error(`Metabase location drill-down (Q${LOCATION_QUESTION_ID}) failed:`, e.message); return [];
        })
      : Promise.resolve([]),

    buildChargebeeData(process.env.CHARGEBEE_API_KEY).catch(e => {
      console.error('Chargebee failed:', e.message); return [];
    }),

    fetchNpsResponses(process.env.PENDO_API_KEY).catch(e => {
      console.error('Pendo NPS fetch failed:', e.message); return [];
    }),

    fetchAccountActivity(process.env.PENDO_API_KEY).catch(e => {
      console.error('Pendo activity fetch failed:', e.message); return {};
    }),

    // Visitor roles — joined to NPS responses so the health score can weigh
    // company-admin sentiment separately from everyone else's.
    fetchVisitorRoles(process.env.PENDO_API_KEY).catch(e => {
      console.error('Pendo role fetch failed (NPS stays blended):', e.message);
      return { field: null, roles: {}, distinct: [] };
    }),

    // Existing accounts (for cx_gut_score — set directly via /api/gut-score,
    // never present in the merged sources below, so it must be re-attached
    // here or it stays neutral in every recomputed health score).
    getAllAccounts().catch(e => {
      console.error('Could not load existing accounts (cx_gut_score will be neutral this run):', e.message);
      return [];
    }),
  ]);

  const existingGutScoreByName = {};
  for (const row of existingAccounts) {
    if (row.cx_gut_score !== null && row.cx_gut_score !== undefined) {
      existingGutScoreByName[row.account_name] = row.cx_gut_score;
    }
  }

  // Fallback for Pendo activity (esp. pendo_last_active) when today's fetch
  // fails or omits an account (Pendo rate-limit/timeout, or the account
  // just isn't in this run's response). Without this, a transient gap
  // resets pendo_last_active to undefined for that account, daysSinceLogin
  // computes as null, and flag_login_stale_14/30/90 falsely evaluate to
  // false for the day — that false value gets written to the snapshot, so
  // the next successful run sees the flag go false→true and re-fires the
  // Slack alert as "newly triggered", even though the account's staleness
  // never actually changed.
  const existingPendoByName = {};
  for (const row of existingAccounts) {
    existingPendoByName[row.account_name] = {
      pendo_last_active:             row.pendo_last_active             ?? null,
      pendo_days_active_per_visitor: row.pendo_days_active_per_visitor ?? null,
      pendo_error_click_rate:        row.pendo_error_click_rate       ?? null,
    };
  }

  console.log(`Sources fetched — MB: ${Object.keys(mbMap).length} accounts, CB: ${cbRows.length} accounts, NPS responses: ${npsResponses.length}, Pendo accounts: ${Object.keys(pendoActivity).length}, location rows: ${rawLocationRows.length}`);

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
    // Live Chargebee ARR always wins when the account has billing data —
    // the CSV's arr column is a manually-maintained snapshot and only
    // serves as a fallback for accounts not yet found in Chargebee.
    merged[name].arr = cb.arr ?? 0;
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
    // LinkedIn (Q1515)
    'linkedin_enabled',
    // ── Not yet available — add when Metabase questions exist ──
    // 'job_boost_enabled', 'job_boost_last_used_days',
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
  // Tag every response with the respondent's role before grouping. Pendo
  // stores role on the visitor, so this is a join on visitorId.
  const roleDataAvailable = Boolean(visitorRoles.field);
  let taggedResponses = 0;
  for (const r of npsResponses) {
    const raw = visitorRoles.roles[r.pendo_visitor_id];
    r.role_raw  = raw || null;
    r.role_tier = raw ? classifyRole(raw) : null;
    if (raw) taggedResponses++;
  }
  if (roleDataAvailable) {
    console.log(`NPS roles: ${taggedResponses}/${npsResponses.length} responses matched to a visitor role`);
  }

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

    // ── Role split ───────────────────────────────────────────
    // Company-admin responses drive the health score; employer and other
    // responses are kept for the account page's role breakdown but never
    // scored — see factorSentiment() in lib/health.js.
    const byTier = { admin: [], employer: [], other: [] };
    for (const r of sorted) {
      if (!r.role_tier) continue;
      byTier[r.role_tier].push(r);
    }

    const breakdown = {};
    for (const [tier, list] of Object.entries(byTier)) {
      if (list.length === 0) continue;
      const scores = list.map(r => r.score);
      breakdown[tier] = {
        count:       list.length,
        avg:         Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10,
        latest:      list[0].score,
        latest_date: list[0].response_date || null,
        promoters:   scores.filter(v => v >= 9).length,
        passives:    scores.filter(v => v >= 7 && v < 9).length,
        detractors:  scores.filter(v => v < 7).length,
      };
    }

    const adminLatest = byTier.admin[0] || null;
    merged[name].nps_admin_score         = adminLatest ? adminLatest.score : null;
    merged[name].nps_admin_band          = adminLatest ? npsBand(adminLatest.score) : null;
    merged[name].nps_admin_response_date = adminLatest ? (adminLatest.response_date || null) : null;
    merged[name].nps_admin_count         = byTier.admin.length;
    merged[name].nps_role_breakdown      = Object.keys(breakdown).length ? breakdown : null;
    merged[name].nps_role_data_available = roleDataAvailable;
  }

  // Merge Pendo activity (keyed by Pendo account ID)
  for (const [pendoId, activity] of Object.entries(pendoActivity)) {
    const name = accountIdToName[pendoId];
    if (!name) continue;
    Object.assign(merged[name], activity);
  }

  // Carry forward last known Pendo activity for any account today's fetch
  // didn't cover — see existingPendoByName comment above for why.
  for (const acc of Object.values(merged)) {
    if (acc.pendo_last_active !== undefined) continue;
    const prev = existingPendoByName[acc.account_name];
    if (prev) Object.assign(acc, prev);
  }

  // ── Location rows + per-account config aggregates ────────────
  // Built here rather than at the upsert step because the health score's
  // readiness factor reads these aggregates; the same rows are written to
  // Supabase later without being rebuilt.
  let locationRows = [];
  try {
    const built = buildLocationRows(rawLocationRows, new Set(Object.keys(merged)), SYNCED_AT);
    locationRows = built.rows;
    if (built.skippedNoId > 0) {
      console.warn(`Locations: skipped ${built.skippedNoId} row(s) with no location_id or account_name.`);
    }
    if (built.skippedUnknownAccount.length > 0) {
      console.warn(`Locations: skipped rows for ${built.skippedUnknownAccount.length} account(s) not on the dashboard — ${built.skippedUnknownAccount.slice(0, 10).join(', ')}${built.skippedUnknownAccount.length > 10 ? ', …' : ''}`);
    }
    const locConfig = buildLocationConfigByAccount(locationRows);
    for (const [name, cfg] of Object.entries(locConfig)) {
      if (merged[name]) Object.assign(merged[name], cfg);
    }
    console.log(`Locations: ${locationRows.length} rows, config aggregates for ${Object.keys(locConfig).length} accounts`);
  } catch (e) {
    console.error('Location row build failed (health readiness falls back to job-level config):', e.message);
  }

  // Verbatim lookup: account_name → verbatims from the last 24h.
  // Built here rather than alongside the other flags because the health
  // score's sentiment factor reads the churn signal, and health is computed
  // before computeFlags() runs (which in turn depends on health_score).
  // computeFlags() recomputes the same flag from the same input, so the two
  // cannot drift.
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

  // Load 7-days-ago snapshots for billing grace-period check.
  // Used below to compute billing_balance_effective per account.
  const sevenDaysAgoMap = await getSnapshotNDaysAgo(7).catch(e => {
    console.error('Could not load 7-day snapshots (billing grace period disabled):', e.message);
    return {};
  });

  // ── Compute derived fields ────────────────────────────────────
  for (const acc of Object.values(merged)) {
    // Re-attach the manually-entered CX gut score so it's actually reflected
    // in this run's computeHealthScore() — it's never present in the merged
    // sources above since it's written directly to Supabase by /api/gut-score.
    acc.cx_gut_score = existingGutScoreByName[acc.account_name] ?? null;

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

    // perc_locs_no_tta: share of locations with no Text-to-Apply applications.
    // Q1329 is a filtered list — accounts absent from it simply have no row,
    // which means "unknown", not "zero", so this stays null for them.
    const ttaTotalLocs = Number(acc.total_locations) || 0;
    acc.perc_locs_no_tta = (ttaTotalLocs > 0 && acc.no_tta_apps_loc_count != null)
      ? Math.round((Number(acc.no_tta_apps_loc_count) || 0) / ttaTotalLocs * 1000) / 10
      : null;

    // Churn signal — set before scoring so factorSentiment() can see it.
    acc.flag_churn_verbatim = (recentVerbatimsMap[acc.account_name] || []).some(text =>
      CHURN_KEYWORDS.some(kw => String(text || '').toLowerCase().includes(kw)));

    // linkedin_enabled arrives from Q1515 as 1/0, not a boolean — coerce it so
    // the Supabase boolean column and the dashboard's checks agree. Accounts
    // absent from Q1515 stay null ("unknown"), not false.
    acc.linkedin_enabled = toBoolOrNull(acc.linkedin_enabled);

    // is_zero_roi: crossed 70% threshold on perc_locs_no_indeed OR perc_locs_no_active_jobs
    acc.is_zero_roi = (Number(acc.perc_locs_no_indeed) || 0) > 70
                   || (Number(acc.perc_locs_no_active_jobs) || 0) > 70;

    // hire_rate is now applications → hires. The old interview → hires ratio
    // exceeded 100% for accounts that hire straight from the application, so
    // it moves to its own field and stays a funnel metric only.
    acc.hire_rate             = computeHireRate(acc);
    acc.interview_to_hire_rate = computeInterviewToHireRate(acc);

    // billing_balance_effective: only penalise health score for balances that
    // (a) exceed 10% of ARR — filters out small ACH-in-transit invoices, and
    // (b) have been present for 7+ days — grace period for normal payment processing.
    const rawBalance   = Number(acc.outstanding_balance) || 0;
    const arrThreshold = (Number(acc.arr) || 0) * 0.10;
    const balanceWas7dAgo = Number(sevenDaysAgoMap[acc.account_name]?.outstanding_balance) || 0;
    acc.billing_balance_effective =
      (rawBalance > arrThreshold && balanceWas7dAgo > 0) ? rawBalance : 0;

    // health_score + health_status. The per-factor breakdown is persisted so
    // the dashboard can show why an account scores what it does.
    const breakdown         = computeHealthBreakdown(acc);
    acc.health_score        = breakdown.score;
    acc.health_status       = healthStatus(breakdown.score);
    acc.health_breakdown    = breakdown.factors;
    acc.health_base_score   = breakdown.baseScore;
    acc.health_bonus        = breakdown.bonus;
    acc.score_model_version = SCORE_MODEL_VERSION;

    acc.last_synced = new Date().toISOString();
  }

  // ── 5. Load yesterday's snapshots ────────────────────────────
  const yesterdayMap = await getYesterdaySnapshots().catch(e => {
    console.error('Could not load yesterday snapshots:', e.message);
    return {};
  });

  // ── 6. Compute flags + build Slack alerts ────────────────────
  const flagAlerts = []; // { flagKey, flagLabel, account, metricNote }

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
      const metric = flagMetricNote(flagKey, acc, yesterday);
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
    // Written explicitly (not just relied on as "omitted column survives the
    // upsert") so this can never be nulled out by an upsert whose payload
    // shape changes — it's re-attached from existingGutScoreByName above.
    cx_gut_score:                acc.cx_gut_score                ?? null,
    is_zero_roi:                 acc.is_zero_roi                 ?? false,
    hire_rate:                   acc.hire_rate                   ?? null,
    interview_to_hire_rate:      acc.interview_to_hire_rate      ?? null,
    health_breakdown:            acc.health_breakdown            ?? null,
    health_base_score:           acc.health_base_score           ?? null,
    health_bonus:                acc.health_bonus                ?? null,
    score_model_version:         acc.score_model_version         ?? null,
    nps_latest_score:            acc.nps_latest_score            ?? null,
    nps_latest_band:             acc.nps_latest_band             ?? null,
    nps_latest_verbatim:         acc.nps_latest_verbatim         ?? null,
    nps_latest_response_date:    acc.nps_latest_response_date    ?? null,
    nps_prior_score:             acc.nps_prior_score             ?? null,
    nps_trend:                   acc.nps_trend                   ?? null,
    nps_response_count:          acc.nps_response_count          ?? null,
    nps_score_stddev:            acc.nps_score_stddev            ?? null,
    nps_days_since_response:     acc.nps_days_since_response     ?? null,
    nps_admin_score:             acc.nps_admin_score             ?? null,
    nps_admin_band:              acc.nps_admin_band              ?? null,
    nps_admin_response_date:     acc.nps_admin_response_date     ?? null,
    nps_admin_count:             acc.nps_admin_count             ?? null,
    nps_role_breakdown:          acc.nps_role_breakdown          ?? null,
    nps_role_data_available:     acc.nps_role_data_available     ?? false,
    perc_locs_no_indeed:         acc.perc_locs_no_indeed         ?? null,
    perc_locs_no_job_boosts:     acc.perc_locs_no_job_boosts     ?? null,
    perc_locs_no_active_jobs:    acc.perc_locs_no_active_jobs    ?? null,
    perc_jobs_no_perks:          acc.perc_jobs_no_perks          ?? null,
    perc_jobs_no_salaries:       acc.perc_jobs_no_salaries       ?? null,
    no_tta_apps_loc_count:       acc.no_tta_apps_loc_count       ?? null,
    perc_locs_no_tta:            acc.perc_locs_no_tta            ?? null,
    total_locations:             acc.total_locations             ?? null,
    active_locations:            acc.active_locations            ?? null,
    locs_no_active_jobs:         acc.locs_no_active_jobs         ?? null,
    total_jobs_count:            acc.total_jobs_count            ?? null,
    jobs_without_salary:         acc.jobs_without_salary         ?? null,
    nextmatch_requested:         acc.nextmatch_requested         ?? null,
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
    linkedin_enabled:            acc.linkedin_enabled            ?? null,
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
    flag_login_stale_14:          acc.flag_login_stale_14          || false,
    flag_login_stale_30:          acc.flag_login_stale_30          || false,
    flag_login_stale_90:          acc.flag_login_stale_90          || false,
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
    score_model_version:          acc.score_model_version,
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
    flag_login_stale_14:          acc.flag_login_stale_14          || false,
    flag_login_stale_30:          acc.flag_login_stale_30          || false,
    flag_login_stale_90:          acc.flag_login_stale_90          || false,
  })).filter(row => row.account_name); // only rows with a resolved account name

  await saveSnapshots(snapshotRows);

  // ── 9. Upsert NPS responses ───────────────────────────────────
  // Attach account_name to each response (for weekly digest lookups)
  const enrichedResponses = npsResponses.map(r => ({
    ...r,
    account_name: accountIdToName[r.account_id] || null,
  }));
  await upsertNpsResponses(enrichedResponses);

  // ── 10. Upsert location drill-down rows ───────────────────────
  // One row per location, powering the dashboard's Locations tab.
  // Scoped to accounts already in `merged` — a location whose account isn't
  // on the dashboard can never be reached from the UI.
  let locationCount = 0;
  try {
    await upsertLocations(locationRows);
    locationCount = locationRows.length;
    await deleteStaleLocations(SYNCED_AT, locationRows.length);
  } catch (e) {
    console.error('Location drill-down sync failed (non-fatal):', e.message);
  }

  // ── 11. Post Slack alerts (urgent flags only — any day) ───────
  // Non-urgent flags are batched and posted Monday by weekly-digest.js.
  //
  // Grouped by account first: an account that trips several urgent flags the
  // same day (e.g. health score drop + renewal at risk) previously posted one
  // Slack message per flag, paging the channel repeatedly for one account.
  // Now every newly-triggered urgent flag for an account goes out as a single
  // message.
  const urgentByAccount = new Map(); // account_name -> { acc, entries: [{flagKey,label,metric}] }
  for (const { flagKey, label, acc, metric } of flagAlerts) {
    if (!URGENT_FLAGS.has(flagKey)) continue;   // non-urgent → Monday digest
    if (!acc.is_managed) continue;              // unmanaged accounts never get Slack alerts
    if (!urgentByAccount.has(acc.account_name)) {
      urgentByAccount.set(acc.account_name, { acc, entries: [] });
    }
    urgentByAccount.get(acc.account_name).entries.push({ flagKey, label, metric });
  }

  let urgentAlertCount = 0;
  let urgentAlertFailures = 0;
  for (const { acc, entries } of urgentByAccount.values()) {
    try {
      await postAccountFlagAlert(acc, entries, DASHBOARD_BASE);
      urgentAlertCount++;
    } catch (e) {
      urgentAlertFailures++;
      console.error(`Slack alert failed for ${acc.account_name} (${entries.map(f => f.flagKey).join(', ')}):`, e.message);
    }
  }
  console.log(`Urgent flag alerts: ${flagAlerts.length} newly triggered total, ${urgentAlertCount} Slack messages posted for ${urgentByAccount.size} accounts (urgent + managed), ${urgentAlertFailures} failed`);

  // ── 12. Post Slack alerts for newly added escalation notes ───
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
  console.log(`=== Daily Sync END — ${accountRows.length} accounts, ${locationCount} locations, ${snapshotRows.length} snapshots, ${flagAlerts.length} flag alerts, ${escalationAlertCount} escalation alerts in ${elapsed}s${hangingMbAccounts.length ? `, ${hangingMbAccounts.length} hanging MB accounts` : ''} ===`);
}

// ── Value coercion ────────────────────────────────────────────

/** 1/0, "Yes"/"No", "true"/"false" → boolean. Unknown/absent → null. */
function toBoolOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'enabled'].includes(s))   return true;
  if (['0', 'false', 'no', 'n', 'disabled'].includes(s))  return false;
  return null;
}

// ── Flag metric notes (human-readable trigger description) ────

function flagMetricNote(flagKey, acc, yesterday) {
  switch (flagKey) {
    case 'flag_churn_verbatim':
      return `NPS verbatim in last 24h: "${(acc.nps_latest_verbatim || '').slice(0, 120)}"`;

    case 'flag_promoter_flip':
      return `NPS: was ${acc.nps_prior_score} (promoter) → now ${acc.nps_latest_score} (detractor) — Δ${acc.nps_latest_score - acc.nps_prior_score}`;

    case 'flag_zero_roi_new':
      return `${acc.perc_locs_no_indeed || 0}% locs no Indeed apps, ${acc.perc_locs_no_active_jobs || 0}% locs no active jobs (crossed 70% threshold)`;

    case 'flag_paid_feature_lapsed':
      return `NextMatch: ${acc.nextmatch_requested || 0} requests, 0 completions in 90 days`;

    case 'flag_billing_balance':
      return `Outstanding balance: $${(acc.outstanding_balance || 0).toLocaleString()} (newly appeared)`;

    case 'flag_health_score_drop': {
      const prev  = yesterday?.health_score ?? acc._prevHealthScore;
      const drop  = (prev ?? 0) - acc.health_score;
      const drivers = healthDropDrivers(acc, yesterday);
      const driverStr = drivers.length ? `\nDrivers: ${drivers.join(' | ')}` : '';
      return `Score: ${prev ?? '?'} → ${acc.health_score} (↓${drop} pts)${driverStr}`;
    }

    case 'flag_health_tier_drop': {
      const prev = yesterday?.health_status ?? acc._prevHealthStatus;
      const drivers = healthDropDrivers(acc, yesterday);
      const driverStr = drivers.length ? `\nDrivers: ${drivers.join(' | ')}` : '';
      return `Tier: ${prev ?? '?'} → ${acc.health_status} (score: ${acc.health_score})${driverStr}`;
    }

    case 'flag_renewal_at_risk': {
      const renewalDate   = acc.renewal_date ? new Date(acc.renewal_date) : null;
      const daysToRenewal = renewalDate
        ? Math.floor((renewalDate.getTime() - Date.now()) / 86400000)
        : '?';
      const risks = [];
      if ((Number(acc.perc_locs_no_indeed) || 0) > 20)    risks.push(`${acc.perc_locs_no_indeed}% locs no Indeed`);
      if (acc.nps_latest_band === 'detractor')             risks.push(`NPS ${acc.nps_latest_score} (detractor)`);
      else if (acc.nps_latest_band === 'passive')          risks.push(`NPS ${acc.nps_latest_score} (passive)`);
      if ((Number(acc.outstanding_balance) || 0) > 0)     risks.push(`$${Number(acc.outstanding_balance).toLocaleString()} unpaid`);
      if ((Number(acc.applications_30d) || 0) === 0)      risks.push('0 apps in 30d');
      const riskStr = risks.length ? ` | ${risks.join(', ')}` : '';
      return `Renewal in ${daysToRenewal} days — health score: ${acc.health_score}${riskStr}`;
    }

    case 'flag_zero_apps_established': {
      const age = acc.create_date
        ? Math.floor((Date.now() - new Date(acc.create_date).getTime()) / 86400000)
        : '?';
      const ctx = [];
      if (acc.open_jobs_count   != null) ctx.push(`${acc.open_jobs_count} jobs open`);
      if (acc.active_locations  != null) ctx.push(`${acc.active_locations} active locs`);
      if ((Number(acc.perc_locs_no_active_jobs) || 0) > 0)
        ctx.push(`${acc.perc_locs_no_active_jobs}% locs no active jobs`);
      const ctxStr = ctx.length ? ` | ${ctx.join(', ')}` : '';
      return `${age} day-old account — 0 applications in last 30 days${ctxStr}`;
    }

    case 'flag_login_stale_14':
    case 'flag_login_stale_30':
    case 'flag_login_stale_90': {
      const days = acc.pendo_last_active
        ? Math.floor((Date.now() - new Date(acc.pendo_last_active).getTime()) / 86400000)
        : '?';
      return `No login in ${days} days (last active: ${acc.pendo_last_active || 'never'})`;
    }

    default:
      return '';
  }
}

// ── Diagnose which health-score components drove a drop ───────
// Compares today's acc fields against yesterday's snapshot.
// Returns an array of human-readable driver strings (may be empty).

function healthDropDrivers(acc, yesterday) {
  const drivers = [];

  // Pipeline (25%): perc_locs_no_indeed
  const noIndeedNow  = Number(acc.perc_locs_no_indeed) || 0;
  const noIndeedPrev = yesterday?.perc_locs_no_indeed != null
    ? Number(yesterday.perc_locs_no_indeed) : noIndeedNow;
  if (acc.is_zero_roi && !yesterday?.is_zero_roi) {
    drivers.push(`Pipeline: newly Zero-ROI (${noIndeedNow}% locs no Indeed)`);
  } else if (noIndeedNow - noIndeedPrev >= 10) {
    drivers.push(`Pipeline ↓ (Indeed gap: ${noIndeedPrev}% → ${noIndeedNow}%)`);
  }

  // NPS (20%): band change or newly detractor+declining
  const bandNow  = acc.nps_latest_band;
  const bandPrev = yesterday?.nps_band;
  if (bandNow && bandPrev && bandNow !== bandPrev) {
    drivers.push(`NPS ↓ (${bandPrev} → ${bandNow}, score: ${acc.nps_latest_score})`);
  } else if (acc.nps_trend === 'declining' && bandNow === 'detractor') {
    drivers.push(`NPS declining (detractor, score: ${acc.nps_latest_score})`);
  }

  // Billing (15%): newly appeared balance
  const balNow  = Number(acc.outstanding_balance) || 0;
  const balPrev = yesterday?.outstanding_balance != null
    ? Number(yesterday.outstanding_balance) : balNow;
  if (balNow > 0 && balPrev === 0) {
    drivers.push(`Billing: new $${balNow.toLocaleString()} balance`);
  }

  // Activity (25%): applications_30d dropped to 0
  const appsNow  = Number(acc.applications_30d);
  const appsPrev = yesterday?.applications_30d != null
    ? Number(yesterday.applications_30d) : appsNow;
  if (!isNaN(appsNow) && !isNaN(appsPrev) && appsNow === 0 && appsPrev > 0) {
    drivers.push(`Activity ↓ (0 apps this month, was ${appsPrev})`);
  }

  // Pendo engagement (15%): significant drop
  const pendoNow  = Number(acc.pendo_days_active_per_visitor);
  const pendoPrev = yesterday?.pendo_days_active_per_visitor != null
    ? Number(yesterday.pendo_days_active_per_visitor) : pendoNow;
  if (!isNaN(pendoNow) && !isNaN(pendoPrev) && pendoPrev - pendoNow >= 5) {
    drivers.push(`Engagement ↓ (${pendoNow.toFixed(1)} days/visitor, was ${pendoPrev.toFixed(1)})`);
  }

  return drivers;
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
