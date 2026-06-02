#!/usr/bin/env node
// ============================================================
// WEEKLY DIGEST
//
// Runs Monday only (enforced by workflow condition).
// Reads entirely from Supabase — no fresh external fetching.
//
// Posts to Slack (all to the same webhook):
//  1. Weekly NPS summary + ARR at-risk movement + repeat detractors
//  2. Individual flag alert per non-urgent flag newly triggered
//     this week (i.e. true in this week's snapshot, false last week)
//
// Urgent flags (churn verbatim, billing balance) are handled
// in sync.js on the day they fire — they do NOT appear here.
// ============================================================

import { getSnapshotRange, getNpsResponseRange, getAllAccounts } from '../lib/supabase.js';
import { postWeeklyDigest, postFlagAlert }                       from '../lib/slack.js';
import { WEEKLY_FLAGS, FLAG_LABELS }                              from '../lib/flags.js';

const DASHBOARD_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://your-dashboard.vercel.app';

async function main() {
  console.log('=== Weekly Digest START ===');

  const today      = new Date();
  const thisMonday = getMonday(today);
  const lastMonday = new Date(thisMonday); lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const prevMonday = new Date(lastMonday); prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);

  const fmt = d => d.toISOString().split('T')[0];

  const thisWeekStart = fmt(lastMonday);
  const thisWeekEnd   = fmt(new Date(thisMonday.getTime() - 1)); // yesterday
  const prevWeekStart = fmt(prevMonday);
  const prevWeekEnd   = fmt(new Date(lastMonday.getTime() - 1));

  console.log(`This week: ${thisWeekStart} → ${thisWeekEnd}`);
  console.log(`Prev week: ${prevWeekStart} → ${prevWeekEnd}`);

  // Fetch everything in parallel
  const [
    accounts,
    thisWeekResponses,
    prevWeekResponses,
    thisWeekSnaps,
    prevWeekSnaps,
  ] = await Promise.all([
    getAllAccounts(),
    getNpsResponseRange(thisWeekStart, thisWeekEnd),
    getNpsResponseRange(prevWeekStart, prevWeekEnd),
    getSnapshotRange(thisWeekStart, thisWeekEnd),
    getSnapshotRange(prevWeekStart, prevWeekEnd),
  ]);

  // Account lookup keyed by account_name (primary key)
  const accountMap = {};
  for (const a of accounts) accountMap[a.account_name] = a;

  // ── NPS summary ───────────────────────────────────────────────
  const thisDetractors = thisWeekResponses.filter(r => r.score <= 6);
  const prevDetractors = prevWeekResponses.filter(r => r.score <= 6);
  const avgScore = thisWeekResponses.length
    ? Math.round(thisWeekResponses.reduce((s, r) => s + r.score, 0) / thisWeekResponses.length * 10) / 10
    : null;

  const CHURN_KW = ['cancel', 'leaving', 'switching', 'last month', 'no improvement'];
  const verbatims = thisWeekResponses
    .filter(r => r.verbatim && r.verbatim.trim())
    .sort((a, b) => {
      const aChurn = CHURN_KW.some(kw => (a.verbatim || '').toLowerCase().includes(kw));
      const bChurn = CHURN_KW.some(kw => (b.verbatim || '').toLowerCase().includes(kw));
      return bChurn - aChurn;
    })
    .map(r => r.verbatim);

  // ── Repeat detractor watchlist ─────────────────────────────────
  // Accounts with a detractor NPS score in BOTH this week and last week
  const thisWeekDetractorNames = new Set(
    thisWeekResponses.filter(r => r.score <= 6).map(r => r.account_name).filter(Boolean)
  );
  const prevWeekDetractorNames = new Set(
    prevWeekResponses.filter(r => r.score <= 6).map(r => r.account_name).filter(Boolean)
  );

  const repeatDetractors = [...thisWeekDetractorNames]
    .filter(name => prevWeekDetractorNames.has(name))
    .map(name => accountMap[name])
    .filter(Boolean)
    .sort((a, b) => (b.arr || 0) - (a.arr || 0));

  // ── ARR at-risk movement ──────────────────────────────────────
  // "At-risk" = health_status red OR outstanding_balance > 0.
  // Compare latest snapshot in each week window.
  function buildAtRiskSet(snaps) {
    const latest = {};
    for (const s of snaps) {
      if (!latest[s.account_name] || s.snapshot_date > latest[s.account_name].snapshot_date) {
        latest[s.account_name] = s;
      }
    }
    const set = new Set();
    for (const snap of Object.values(latest)) {
      if (snap.health_status === 'red' || (snap.outstanding_balance || 0) > 0) {
        set.add(snap.account_name);
      }
    }
    return set;
  }

  const thisWeekAtRisk = buildAtRiskSet(thisWeekSnaps);
  const prevWeekAtRisk = buildAtRiskSet(prevWeekSnaps);

  const entered = [...thisWeekAtRisk]
    .filter(name => !prevWeekAtRisk.has(name))
    .map(name => accountMap[name]).filter(Boolean)
    .sort((a, b) => (b.arr || 0) - (a.arr || 0));

  const exited = [...prevWeekAtRisk]
    .filter(name => !thisWeekAtRisk.has(name))
    .map(name => accountMap[name]).filter(Boolean)
    .sort((a, b) => (b.arr || 0) - (a.arr || 0));

  const enteredArr = entered.reduce((s, a) => s + (a.arr || 0), 0);
  const exitedArr  = exited.reduce((s, a)  => s + (a.arr || 0), 0);

  // ── 1. Post weekly NPS / ARR digest ──────────────────────────
  await postWeeklyDigest({
    npsThisWeek: {
      totalResponses: thisWeekResponses.length,
      avgScore,
      detractorCount: thisDetractors.length,
      verbatims,
    },
    npsLastWeek: {
      detractorCount: prevDetractors.length,
    },
    repeatDetractors: repeatDetractors.map(a => ({
      account_name:    a.account_name,
      account_manager: a.account_manager,
      arr:             a.arr,
    })),
    arrAtRiskEntered: entered.map(a => ({
      account_name:    a.account_name,
      account_manager: a.account_manager,
      arr:             a.arr,
    })),
    arrAtRiskExited: exited.map(a => ({
      account_name:    a.account_name,
      account_manager: a.account_manager,
      arr:             a.arr,
    })),
    netArrRiskChange: enteredArr - exitedArr,
  });

  // ── 2. Post individual weekly flag alerts ─────────────────────
  // For each non-urgent flag: fire a separate message if the flag is
  // true in this week's latest snapshot but was false last week.
  // Same format as urgent flags — one message per account per flag.
  const latestThisWeek = {};
  for (const s of thisWeekSnaps) {
    if (!latestThisWeek[s.account_name] || s.snapshot_date > latestThisWeek[s.account_name].snapshot_date) {
      latestThisWeek[s.account_name] = s;
    }
  }
  const latestPrevWeek = {};
  for (const s of prevWeekSnaps) {
    if (!latestPrevWeek[s.account_name] || s.snapshot_date > latestPrevWeek[s.account_name].snapshot_date) {
      latestPrevWeek[s.account_name] = s;
    }
  }

  let weeklyFlagCount = 0;
  for (const acc of accounts) {
    if (!acc.is_managed) continue;              // unmanaged accounts never get Slack alerts
    const thisSnap = latestThisWeek[acc.account_name];
    const prevSnap = latestPrevWeek[acc.account_name];
    if (!thisSnap) continue;

    for (const flagKey of WEEKLY_FLAGS) {
      const isTrueNow   = Boolean(thisSnap[flagKey]);
      const wasTrueLast = Boolean(prevSnap?.[flagKey]);
      if (!isTrueNow || wasTrueLast) continue; // not newly triggered

      const label  = FLAG_LABELS[flagKey];
      const metric = weeklyFlagNote(flagKey, acc);
      try {
        await postFlagAlert(flagKey, label, acc, metric, DASHBOARD_BASE);
        weeklyFlagCount++;
      } catch (e) {
        console.error(`Weekly flag alert failed for ${flagKey} / ${acc.account_name}:`, e.message);
      }
    }
  }

  console.log(`Weekly flags posted: ${weeklyFlagCount}`);
  console.log('=== Weekly Digest END ===');
}

// ── Weekly flag metric notes ──────────────────────────────────
// Describes what specifically triggered the flag, built from the
// current accounts table row (more complete than snapshot columns).

function weeklyFlagNote(flagKey, acc) {
  switch (flagKey) {
    case 'flag_promoter_flip':
      return `NPS: ${acc.nps_prior_score ?? '?'} (promoter) → ${acc.nps_latest_score ?? '?'} (${acc.nps_latest_band ?? 'detractor'})`;

    case 'flag_zero_roi_new':
      return `${acc.perc_no_indeed || 0}% locs no Indeed apps, ${acc.perc_no_active_jobs || 0}% locs no active jobs`;

    case 'flag_new_account_zero_apps': {
      const age = acc.create_date
        ? Math.floor((Date.now() - new Date(acc.create_date).getTime()) / 86400000)
        : '?';
      return `Account created ${age} days ago — 0 applications in last 30 days`;
    }

    case 'flag_paid_feature_lapsed': {
      const parts = [];
      if (acc.job_boost_enabled && (acc.job_boost_last_used_days || 0) >= 60)
        parts.push(`Job Boost last used ${acc.job_boost_last_used_days}d ago`);
      if (acc.nextmatch_enabled && (acc.nextmatch_calls_90d || 0) === 0)
        parts.push('NextMatch: 0 calls in 90d');
      return parts.join('; ') || 'Paid feature unused 60+ days';
    }

    case 'flag_hire_rate_low_streak':
      return `Hire rate ${Math.round((acc.hire_rate || 0) * 100)}% — below 15% for 2+ consecutive days`;

    case 'flag_time_to_invite_high':
      return `Avg time to invite: ${acc.avg_time_to_invite_days ?? '?'}d (threshold: 7d)`;

    default:
      return '';
  }
}

/** Returns the most recent Monday (UTC) at midnight. */
function getMonday(date) {
  const d   = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

main().catch(err => {
  console.error('Fatal digest error:', err);
  process.exit(1);
});
