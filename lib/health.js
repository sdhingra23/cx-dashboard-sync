// ============================================================
// HEALTH SCORE COMPUTATION
//
// 5-factor weighted formula, plus CX gut score as an optional 6th factor
// that only applies once an AM has actually entered one. Without a gut
// score, weights fall back to the original 5-factor formula unchanged —
// this matters because scoring every un-scored account against a phantom
// 20%-weighted factor (even at "neutral" credit) mechanically shifts
// every account's score the moment the factor is introduced, which
// mass-triggers health_score_drop / health_tier_drop Slack alerts for
// accounts whose underlying health hasn't changed at all.
//
//   With a gut score entered:
//     Applicant pipeline health  20%   Q1436 — % locs with no Indeed apps
//     Platform activity          20%   Q1472/Q1432/Q1468/Q1329 — 4 activity signals
//     NPS trend                  16%   Pendo NPS responses
//     Billing health              12%   Chargebee unpaid invoices
//     Pendo engagement            12%   Pendo account activity
//     CX gut score                20%   Manual 0–10 AM assessment (accounts.cx_gut_score)
//
//   Without a gut score (original formula, unchanged):
//     Applicant pipeline health  25%
//     Platform activity          25%
//     NPS trend                  20%
//     Billing health             15%
//     Pendo engagement           15%
// ============================================================

/**
 * Compute the health score (0–100) for one account.
 * @param {object} acc — merged account object with all fields
 * @returns {number}   — integer 0–100
 */
export function computeHealthScore(acc) {
  const hasGutScore = acc.cx_gut_score !== null && acc.cx_gut_score !== undefined
    && !isNaN(Number(acc.cx_gut_score));

  // Weights depend on whether a gut score exists — see file header for why.
  const W = hasGutScore
    ? { pipeline: 20, activity: 20, nps: 16, billing: 12, engagement: 12, gut: 20 }
    : { pipeline: 25, activity: 25, nps: 20, billing: 15, engagement: 15, gut: 0 };

  // ── 1. Applicant pipeline health ──────────────────────────
  // Zero-ROI accounts score 0 automatically.
  // Otherwise: inverse of % locations with no Indeed apps (Q1436).
  let pipelineScore = 0;
  if (!acc.is_zero_roi) {
    const noIndeedPct = Number(acc.perc_locs_no_indeed) || 0;
    const healthPct   = Math.max(0, 100 - noIndeedPct);
    pipelineScore     = (healthPct / 100) * W.pipeline;
  }

  // ── 2. Platform activity ──────────────────────────────────
  // 4 connected signals, evenly split across the activity weight.
  // All sourced from live Metabase questions (no unavailable feature flags).
  const activitySignals = [
    // Applications received in last 30 days (Q1472)
    (Number(acc.applications_30d) || 0) > 0,
    // Two-way messaging in use: > 10% of applications have a chat (Q1432)
    (Number(acc.two_way_pct) || 0) > 10,
    // AI screening used in last 90 days (Q1468 — Completed > 0)
    (Number(acc.nextmatch_calls_90d) || 0) > 0,
    // Account has TTA applications (not in zero-apps filtered list, Q1329)
    !acc.no_tta_apps_loc_count,
  ];
  const activeCount    = activitySignals.filter(Boolean).length;
  const activityScore  = (activeCount / activitySignals.length) * W.activity;

  // ── 3. NPS trend ───────────────────────────────────────────
  // Base: promoter=100, passive=50, detractor=0, no data=50 (neutral).
  // 20% penalty applied if trend is declining vs prior response.
  let npsBase;
  switch (acc.nps_latest_band) {
    case 'promoter':  npsBase = 100; break;
    case 'passive':   npsBase = 50;  break;
    case 'detractor': npsBase = 0;   break;
    default:          npsBase = 50;  break; // no NPS data → neutral
  }
  if (acc.nps_trend === 'declining') npsBase = npsBase * 0.80;
  const npsScore = (npsBase / 100) * W.nps;

  // ── 4. Billing health ──────────────────────────────────────
  // Uses billing_balance_effective (pre-computed in sync.js): 0 unless
  // balance > 10% of ARR AND has been present for 7+ days.
  // Falls back to outstanding_balance if called outside the sync pipeline.
  const billingScore = (Number(acc.billing_balance_effective ?? acc.outstanding_balance) || 0) > 0 ? 0 : W.billing;

  // ── 5. Pendo engagement ────────────────────────────────────
  // Based on days_active_per_visitor. No Pendo data → neutral (half weight).
  // Cap at 20 days/month as "excellent".
  let engagementScore = W.engagement / 2;
  const daysActive = Number(acc.pendo_days_active_per_visitor);
  if (!isNaN(daysActive) && daysActive > 0) {
    engagementScore = Math.min(daysActive / 20, 1) * W.engagement;
  }

  // ── 6. CX gut score ────────────────────────────────────────
  // Manual 0–10 AM assessment (accounts.cx_gut_score). Only applied once an
  // AM has actually entered one — see file header for why "no score" can't
  // just mean neutral credit here.
  let gutScore = 0;
  if (hasGutScore) {
    const rawGut = Number(acc.cx_gut_score);
    gutScore = (Math.min(10, Math.max(0, rawGut)) / 10) * W.gut;
  }

  const total = pipelineScore + activityScore + npsScore + billingScore + engagementScore + gutScore;
  return Math.min(100, Math.max(0, Math.round(total)));
}

/**
 * Derive health status label from numeric score.
 * @param {number} score
 * @returns {'red'|'amber'|'green'}
 */
export function healthStatus(score) {
  if (score < 40) return 'red';
  if (score < 70) return 'amber';
  return 'green';
}

/**
 * Compute hire rate (0–1) from account fields.
 * Returns null when no interview data is available.
 */
export function computeHireRate(acc) {
  const hired     = Number(acc.total_hired)      || 0;
  const interviews = Number(acc.total_interviews) || 0;
  if (interviews === 0) return null;
  return hired / interviews;
}

/**
 * Derive NPS band from a numeric score.
 * @param {number} score — 0–10
 * @returns {'promoter'|'passive'|'detractor'|null}
 */
export function npsBand(score) {
  if (score === null || score === undefined) return null;
  if (score >= 9)  return 'promoter';
  if (score >= 7)  return 'passive';
  return 'detractor';
}

/**
 * Compute NPS velocity trend.
 * @param {number|null} current
 * @param {number|null} prior
 * @returns {'improving'|'declining'|'stable'|'none'}
 */
export function npsTrend(current, prior) {
  if (current === null || prior === null) return 'none';
  const delta = current - prior;
  if (delta >= 3)  return 'improving';
  if (delta <= -3) return 'declining';
  return 'stable';
}
