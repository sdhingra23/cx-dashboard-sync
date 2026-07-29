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
//  1.  Churn-signal verbatim     — NPS response in last 24h with churn keywords (URGENT)
//  2.  Promoter → detractor flip — NPS band dropped
//  3.  New zero-ROI account      — crossed 70% no-apps/no-jobs threshold for the first time
//  4.  NextMatch lapsed          — feature requested but 0 completions in 90d
//  5.  Time-to-invite crossed    — avg TTI newly crossed 7-day threshold
//  6.  Billing balance           — newly appeared (stored in DB / dashboard only, no Slack)
//  7.  Health score drop         — dropped ≥ 10 points day-over-day (URGENT)
//  8.  Renewal at risk           — renewal within 30d AND health score < 60 (URGENT)
//  9.  Zero apps — established   — account >90d old with 0 applications in last 30d
//  10. Health tier drop          — status downgraded (green→amber, amber→red, green→red) (URGENT)
//  11-13. No-login staleness     — no Pendo login in 14/30/90 days (URGENT)
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

  // ── 5. Billing balance — exceeds 10% of ARR for 7+ days ──────
  // billing_balance_effective is pre-computed in sync.js: it is 0 unless the
  // balance both exceeds the ARR threshold AND has been present for 7+ days.
  // Using it here means small ACH-in-transit amounts never set this flag.
  const effectiveBalance = Number(account.billing_balance_effective ?? account.outstanding_balance) || 0;
  flags.flag_billing_balance = effectiveBalance > 0;

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

  // ── 10. Health tier dropped ───────────────────────────────────
  // Fires when health status is downgraded to a lower tier:
  //   green → amber | green → red | amber → red
  // Resets when the account recovers, so a future drop fires again.
  const TIER = { green: 2, amber: 1, red: 0 };
  const todayTier     = TIER[account.health_status] ?? null;
  const yesterdayTier = TIER[yesterday?.health_status] ?? null;
  flags.flag_health_tier_drop =
    todayTier !== null &&
    yesterdayTier !== null &&
    todayTier < yesterdayTier;

  // ── 11-13. No-login staleness (14/30/90 days since Pendo login) ─
  // Based on account.auto.lastvisit (pendo_last_active), fetched via the
  // "*ALL Employers" segment in lib/pendo.js. No lastvisit data → never flagged.
  const daysSinceLogin = account.pendo_last_active
    ? Math.floor((Date.now() - new Date(account.pendo_last_active).getTime()) / 86400000)
    : null;
  flags.flag_login_stale_14 = daysSinceLogin !== null && daysSinceLogin >= 14;
  flags.flag_login_stale_30 = daysSinceLogin !== null && daysSinceLogin >= 30;
  flags.flag_login_stale_90 = daysSinceLogin !== null && daysSinceLogin >= 90;

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
  flag_billing_balance:       'New outstanding billing balance',
  flag_health_score_drop:     'Health score dropped ≥ 10 points',
  flag_renewal_at_risk:       'Renewal at risk (due within 30d, health score < 60)',
  flag_zero_apps_established: 'Established account with zero applications (last 30d)',
  flag_health_tier_drop:      'Health tier downgraded',
  flag_login_stale_14:        'No login in 14+ days',
  flag_login_stale_30:        'No login in 30+ days',
  flag_login_stale_90:        'No login in 90+ days',
};

/**
 * Flags that fire immediately on any day via Slack (need same-day action).
 */
export const URGENT_FLAGS = new Set([
  'flag_churn_verbatim',
  'flag_health_score_drop',
  'flag_health_tier_drop',
  'flag_renewal_at_risk',
  'flag_login_stale_14',
  'flag_login_stale_30',
  'flag_login_stale_90',
]);

/**
 * Flags batched into the Monday weekly digest.
 * NPS-derived flags (e.g. flag_promoter_flip) are intentionally excluded —
 * NPS was removed from the weekly digest's Slack output.
 */
export const WEEKLY_FLAGS = new Set([
  'flag_zero_roi_new',
  'flag_paid_feature_lapsed',
  'flag_zero_apps_established',
]);
