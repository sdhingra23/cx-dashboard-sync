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
import { computeHealthScore, healthStatus, computeHireRate, npsBand, npsTrend } from '../lib/health.js';
import { computeFlags, FLAG_LABELS, URGENT_FLAGS } from '../lib/flags.js';
import { postFlagAlert }                       from '../lib/slack.js';
import {
  upsertAccounts,
  saveSnapshots,
  getYesterdaySnapshots,
  upsertNpsResponses,
} from '../lib/supabase.js';

// ── Metabase question config (placeholder — fill IDs when ready) ──
// Shape mirrors METABASE_QUESTIONS from Config.gs.
// Set `id` to the numeric question ID from the Metabase URL.
const METABASE_QUESTIONS = {
  // productUsage: {
  //   id: 0,
  //   columns: [
  //     'account_name',
  //     'active_locations', 'total_locations', 'open_jobs_count',
  //     'applications_30d', 'tta_apps_count_90d', 'no_tta_apps_90d',
  //     'nextmatch_calls_90d', 'job_boost_enabled', 'job_boost_last_used_days',
  //     'no_connected_calendars', 'total_hired', 'total_interviews',
  //     'avg_time_to_invite_days', 'avg_time_to_hire_days',
  //     'feature_onboarding', 'feature_nextmatch', 'linkedin_enabled',
  //   ],
  // },
  // configGaps: {
  //   id: 0,
  //   columns: [
  //     'account_name',
  //     'perc_locs_no_indeed', 'perc_locs_no_job_boosts', 'perc_locs_no_active_jobs',
  //     'perc_jobs_no_perks', 'perc_jobs_no_salaries',
  //   ],
  // },
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
  const merged = {}; // { normalizedName: accountObject }

  // Seed from Chargebee (billing source of truth for ARR and account_id)
  for (const cb of cbRows) {
    const name = cb.account_name; // already normalized by buildChargebeeData
    merged[name] = {
      account_name:        name,
      account_id:          cb.account_id,
      email:               cb.email,
      arr:                 cb.arr,
      outstanding_balance: cb.outstanding_balance,
      cb_customer_count:   cb.cb_customer_count,
    };
  }

  // Merge Metabase (auto columns)
  const MB_AUTO_KEYS = [
    'account_manager', 'brand_name',
    'perc_locs_no_indeed', 'perc_locs_no_job_boosts', 'perc_locs_no_active_jobs',
    'perc_jobs_no_perks', 'perc_jobs_no_salaries',
    'active_locations', 'total_locations', 'open_jobs_count',
    'applications_30d', 'no_tta_apps_90d', 'tta_apps_count_90d',
    'no_connected_calendars', 'total_hired', 'total_interviews',
    'avg_time_to_invite_days', 'avg_time_to_hire_days',
    'feature_onboarding', 'feature_nextmatch', 'linkedin_enabled',
    'job_boost_enabled', 'job_boost_last_used_days', 'nextmatch_calls_90d',
    'create_date',
  ];

  for (const [name, mb] of Object.entries(mbMap)) {
    if (!merged[name]) merged[name] = { account_name: name };
    for (const key of MB_AUTO_KEYS) {
      if (mb[key] !== undefined) merged[name][key] = mb[key];
    }
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
  const accountRows = Object.values(merged);
  await upsertAccounts(accountRows);

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
    flag_churn_verbatim:          acc.flag_churn_verbatim || false,
    flag_promoter_flip:           acc.flag_promoter_flip || false,
    flag_zero_roi_new:            acc.flag_zero_roi_new || false,
    flag_new_account_zero_apps:   acc.flag_new_account_zero_apps || false,
    flag_paid_feature_lapsed:     acc.flag_paid_feature_lapsed || false,
    flag_hire_rate_low_streak:    acc.flag_hire_rate_low_streak || false,
    flag_time_to_invite_high:     acc.flag_time_to_invite_high || false,
    flag_billing_balance:         acc.flag_billing_balance || false,
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
    if (!URGENT_FLAGS.has(flagKey)) continue;
    try {
      await postFlagAlert(flagKey, label, acc, metric, DASHBOARD_BASE);
    } catch (e) {
      console.error(`Slack alert failed for ${flagKey} / ${acc.account_name}:`, e.message);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`=== Daily Sync END — ${accountRows.length} accounts, ${snapshotRows.length} snapshots, ${flagAlerts.length} alerts posted in ${elapsed}s ===`);
}

// ── Flag metric notes (human-readable trigger description) ────

function flagMetricNote(flagKey, acc) {
  switch (flagKey) {
    case 'flag_churn_verbatim':
      return `NPS verbatim in last 24h: "${(acc.nps_latest_verbatim || '').slice(0, 100)}"`;
    case 'flag_promoter_flip':
      return `NPS: was ${acc.nps_prior_score} (promoter), now ${acc.nps_latest_score} (detractor) — Δ${(acc.nps_latest_score - acc.nps_prior_score)}`;
    case 'flag_zero_roi_new':
      return `${acc.perc_locs_no_indeed || 0}% locs no Indeed apps, ${acc.perc_locs_no_active_jobs || 0}% locs no active jobs (crossed 70% threshold)`;
    case 'flag_new_account_zero_apps': {
      const age = acc.create_date
        ? Math.floor((Date.now() - new Date(acc.create_date).getTime()) / 86400000)
        : '?';
      return `Account created ${age} days ago — 0 applications received in last 30 days`;
    }
    case 'flag_paid_feature_lapsed': {
      const notes = [];
      if (acc.job_boost_enabled && (acc.job_boost_last_used_days || 0) >= 60)
        notes.push(`Job Boost last used ${acc.job_boost_last_used_days}d ago`);
      if (acc.feature_nextmatch && (acc.nextmatch_calls_90d || 0) === 0)
        notes.push('NextMatch: 0 AI calls in 90 days');
      return notes.join('; ');
    }
    case 'flag_hire_rate_low_streak':
      return `Hire rate: ${Math.round((acc.hire_rate || 0) * 100)}% (below 15% for 2 consecutive days)`;
    case 'flag_time_to_invite_high':
      return `Avg time to invite: ${acc.avg_time_to_invite_days}d (threshold: 7d)`;
    case 'flag_billing_balance':
      return `Outstanding balance: $${(acc.outstanding_balance || 0).toLocaleString()} (newly appeared)`;
    default:
      return '';
  }
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
