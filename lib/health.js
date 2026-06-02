// ============================================================
// HEALTH SCORE COMPUTATION
//
// 5-factor weighted formula (all factors use connected data sources only):
//
//   Applicant pipeline health  25%   Q1436 — % locs with no Indeed apps
//   Platform activity          25%   Q1472/Q1432/Q1468/Q1329 — 4 activity signals
//   NPS trend                  20%   Pendo NPS responses
//   Billing health             15%   Chargebee unpaid invoices
//   Pendo engagement           15%   Pendo account activity
// ============================================================

/**
 * Compute the health score (0–100) for one account.
 * @param {object} acc — merged account object with all fields
 * @returns {number}   — integer 0–100
 */
export function computeHealthScore(acc) {
  // ── 1. Applicant pipeline health (25%) ────────────────────
  // Zero-ROI accounts score 0 automatically.
  // Otherwise: inverse of % locations with no Indeed apps (Q1436).
  let pipelineScore = 0;
  if (!acc.is_zero_roi) {
    const noIndeedPct = Number(acc.perc_locs_no_indeed) || 0;
    const healthPct   = Math.max(0, 100 - noIndeedPct);
    pipelineScore     = (healthPct / 100) * 25;
  }

  // ── 2. Platform activity (25%) ────────────────────────────
  // 4 connected signals — each worth 6.25 pts.
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
  const activityScore  = (activeCount / activitySignals.length) * 25;

  // ── 3. NPS trend (20%) ────────────────────────────────────
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
  const npsScore = (npsBase / 100) * 20;

  // ── 4. Billing health (15%) ───────────────────────────────
  // Any outstanding balance → 0; no balance → full 15 (Chargebee).
  const billingScore = (Number(acc.outstanding_balance) || 0) > 0 ? 0 : 15;

  // ── 5. Pendo engagement (15%) ─────────────────────────────
  // Based on days_active_per_visitor. No Pendo data → neutral (7.5 / 15).
  // Cap at 20 days/month as "excellent".
  let engagementScore = 7.5;
  const daysActive = Number(acc.pendo_days_active_per_visitor);
  if (!isNaN(daysActive) && daysActive > 0) {
    engagementScore = Math.min(daysActive / 20, 1) * 15;
  }

  const total = pipelineScore + activityScore + npsScore + billingScore + engagementScore;
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
