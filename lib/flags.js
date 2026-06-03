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
// Active flags:
//  1. Churn-signal verbatim     — NPS response in last 24h with churn keywords (URGENT)
//  2. Promoter → detractor flip — NPS band dropped
//  3. New zero-ROI account      — crossed 70% no-apps/no-jobs threshold for the first time
//  4. NextMatch lapsed          — feature requested but 0 completions in 90d
//  5. Time-to-invite crossed    — avg TTI newly crossed 7-day threshold
//  6. Billing balance           — newly appeared (stored in DB / dashboard only, no Slack)
//  7. Health score drop         — dropped ≥ 10 points day-over-day (URGENT)
//  8. Renewal at risk           — renewal within 30d AND health score < 60 (URGENT)
//  9. Zero apps — established   — account >90d old with 0 applications in last 30d
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
  const wasPromoter = yesterday?.nps_band === 'promoter';
  const isDetractor = account.nps_latest_band === 'detractor';
  flags.flag_promoter_flip = wasPromoter && isDetractor;

  // ── 3. New zero-ROI account ─────────────────────────────────
  flags.flag_zero_roi_new =
    Boolean(account.is_zero_roi) && !Boolean(yesterday?.is_zero_roi);

  // ── 4. NextMatch lapsed ─────────────────────────────────────
  // Fires when the account has requested AI screening (Q1468 Requested > 0)
  // but has zero completed calls in the last 90 days.
  const nmLapsed =
    (Number(account.nextmatch_requested) || 0) > 0 &&
    (Number(account.nextmatch_calls_90d) || 0) === 0;
  flags.flag_paid_feature_lapsed = nmLapsed;

  // ── 5. Time-to-invite newly crossed 7 days ──────────────────
  // Only fires on the day the threshold is first crossed — not a persistent state.
  // Resets if TTI drops back below 7d and crosses again.
  const ttiHighToday = (Number(account.avg_time_to_invite_days) || 0) > 7;
  const ttiHighYday  = (Number(yesterday?.avg_time_to_invite_days) || 0) > 7;
  flags.flag_time_to_invite_high = ttiHighToday && !ttiHighYday;

  // ── 6. Billing balance newly appeared ────────────────────────
  // Stored in DB and shown on dashboard — not posted to Slack (not in URGENT_FLAGS).
  const hasBalanceNow  = (Number(account.outstanding_balance) || 0) > 0;
  const hadBalanceYday = (Number(yesterday?.outstanding_balance) || 0) > 0;
  flags.flag_billing_balance = hasBalanceNow && !hadBalanceYday;

  // ── 7. Health score dropped ≥ 10 points day-over-day ─────────
  const todayScore     = Number(account.health_score);
  const yesterdayScore = Number(yesterday?.health_score);
  flags.flag_health_score_drop =
    yesterday !== null &&
    !isNaN(todayScore) &&
    !isNaN(yesterdayScore) &&
    yesterdayScore - todayScore >= 10;

  // ── 8. Renewal at risk ────────────────────────────────────────
  // Renewal is within 30 days AND health score is below 60.
  const renewalDate   = account.renewal_date ? new Date(account.renewal_date) : null;
  const daysToRenewal = renewalDate
    ? Math.floor((renewalDate.getTime() - Date.now()) / 86400000)
    : null;
  flags.flag_renewal_at_risk =
    daysToRenewal !== null &&
    daysToRenewal >= 0 &&
    daysToRenewal <= 30 &&
    (Number(account.health_score) || 0) < 60;

  // ── 9. Established account with zero applications ─────────────
  // Account is >90 days old but received 0 applications in the last 30 days.
  const accountAgeDays = account.create_date
    ? Math.floor((Date.now() - new Date(account.create_date).getTime()) / 86400000)
    : null;
  flags.flag_zero_apps_established =
    accountAgeDays !== null &&
    accountAgeDays >= 90 &&
    (Number(account.applications_30d) || 0) === 0;

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
  flag_paid_feature_lapsed:   'NextMatch lapsed (feature requested, 0 completions in 90d)',
  flag_time_to_invite_high:   'Time-to-invite crossed 7-day threshold',
  flag_billing_balance:       'New outstanding billing balance',
  flag_health_score_drop:     'Health score dropped ≥ 10 points',
  flag_renewal_at_risk:       'Renewal at risk (due within 30d, health score < 60)',
  flag_zero_apps_established: 'Established account with zero applications (last 30d)',
};

/**
 * Flags that fire immediately on any day via Slack (need same-day action).
 */
export const URGENT_FLAGS = new Set([
  'flag_churn_verbatim',
  'flag_health_score_drop',
  'flag_renewal_at_risk',
]);

/**
 * Flags batched into the Monday weekly digest.
 */
export const WEEKLY_FLAGS = new Set([
  'flag_promoter_flip',
  'flag_zero_roi_new',
  'flag_paid_feature_lapsed',
  'flag_time_to_invite_high',
  'flag_zero_apps_established',
]);
