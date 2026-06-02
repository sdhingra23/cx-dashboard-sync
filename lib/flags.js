// ============================================================
// FLAG COMPUTATION
//
// computeFlags(account, yesterdaySnap, recentVerbatims)
//   → { flags, newlyTriggered }
//
// `flags`          — full flag state for today's snapshot row
// `newlyTriggered` — subset of flags that were NOT true yesterday
//                    (these are posted to Slack)
//
// Daily flags (per spec):
//  1. Churn-signal verbatim  — NPS response in last 24h with churn keywords
//  2. Promoter → detractor flip
//  3. New zero-ROI account   — crossed 70% threshold for the first time
//  4. New account (<90d) with zero applications received
//  5. Paid feature lapsed    — job boost or NextMatch enabled but unused 60+ days
//  6. Hire rate below 15%    — for two consecutive daily snapshots
//  7. Time-to-invite over 7 days
//  8. Outstanding billing balance — newly appeared since last snapshot
// ============================================================

const CHURN_KEYWORDS = ['cancel', 'leaving', 'switching', 'last month', 'no improvement'];

/**
 * @param {object} account        — today's merged account row (pre-save)
 * @param {object|null} yesterday — yesterday's snapshot row (null = first run)
 * @param {Array}  recentVerbatims — verbatim strings from NPS responses in last 24h
 *                                   for this account
 * @returns {{ flags: object, newlyTriggered: object }}
 */
export function computeFlags(account, yesterday, recentVerbatims = []) {
  const flags = {};

  // ── 1. Churn-signal verbatim ────────────────────────────────
  flags.flag_churn_verbatim = recentVerbatims.some(text => {
    const lower = String(text || '').toLowerCase();
    return CHURN_KEYWORDS.some(kw => lower.includes(kw));
  });

  // ── 2. Promoter → detractor flip ────────────────────────────
  const wasPromoter  = yesterday?.nps_band === 'promoter';
  const isDetractor  = account.nps_latest_band === 'detractor';
  flags.flag_promoter_flip = wasPromoter && isDetractor;

  // ── 3. New zero-ROI account ─────────────────────────────────
  flags.flag_zero_roi_new =
    Boolean(account.is_zero_roi) && !Boolean(yesterday?.is_zero_roi);

  // ── 4. New account (<90d) with zero applications ────────────
  const accountAgeDays = account.create_date
    ? Math.floor((Date.now() - new Date(account.create_date).getTime()) / 86400000)
    : null;
  flags.flag_new_account_zero_apps =
    accountAgeDays !== null &&
    accountAgeDays < 90 &&
    (Number(account.applications_30d) || 0) === 0;

  // ── 5. NextMatch lapsed ─────────────────────────────────────
  // Fires when the account has requested AI screening (Q1468 Requested > 0)
  // but has zero completed calls in the last 90 days.
  // Proxy for "feature purchased but unused" without requiring a feature-flag field.
  const nmLapsed =
    (Number(account.nextmatch_requested) || 0) > 0 &&
    (Number(account.nextmatch_calls_90d) || 0) === 0;
  flags.flag_paid_feature_lapsed = nmLapsed;

  // ── 6. Hire rate low — two consecutive snapshots ─────────────
  const hireRate          = Number(account.hire_rate) || 0;
  const hireRateLowToday  = account.hire_rate !== null && hireRate < 0.15;
  const hireRateLowYday   =
    yesterday?.hire_rate !== null &&
    yesterday?.hire_rate !== undefined &&
    Number(yesterday.hire_rate) < 0.15;
  flags.flag_hire_rate_low_streak = hireRateLowToday && hireRateLowYday;

  // ── 7. Time-to-invite over 7 days ────────────────────────────
  flags.flag_time_to_invite_high =
    (Number(account.avg_time_to_invite_days) || 0) > 7;

  // ── 8. Billing balance newly appeared ────────────────────────
  const hasBalanceNow   = (Number(account.outstanding_balance) || 0) > 0;
  const hadBalanceYday  = (Number(yesterday?.outstanding_balance) || 0) > 0;
  flags.flag_billing_balance = hasBalanceNow && !hadBalanceYday;

  // ── Diff: which flags are newly true vs yesterday ─────────────
  const newlyTriggered = {};
  for (const [key, val] of Object.entries(flags)) {
    const wasTrue = Boolean(yesterday?.[key]);
    newlyTriggered[key] = Boolean(val) && !wasTrue;
  }

  return { flags, newlyTriggered };
}

/**
 * Human-readable label for each flag key.
 */
export const FLAG_LABELS = {
  flag_churn_verbatim:        'Churn-signal verbatim',
  flag_promoter_flip:         'Promoter → Detractor flip',
  flag_zero_roi_new:          'New zero-ROI account',
  flag_new_account_zero_apps: 'New account with zero applications',
  flag_paid_feature_lapsed:   'NextMatch lapsed (feature requested, 0 completions in 90d)',
  flag_hire_rate_low_streak:  'Hire rate below 15% (2 consecutive days)',
  flag_time_to_invite_high:   'Time-to-invite over 7 days',
  flag_billing_balance:       'New outstanding billing balance',
};

/**
 * Flags that fire immediately on any day (need same-day action).
 */
export const URGENT_FLAGS = new Set([
  'flag_churn_verbatim',
  'flag_billing_balance',
]);

/**
 * Flags that are checked weekly (Monday) to avoid daily noise.
 * Newly-triggered = true this week's snapshot, false last week's snapshot.
 */
export const WEEKLY_FLAGS = new Set([
  'flag_promoter_flip',
  'flag_zero_roi_new',
  'flag_new_account_zero_apps',
  'flag_paid_feature_lapsed',
  'flag_hire_rate_low_streak',
  'flag_time_to_invite_high',
]);
