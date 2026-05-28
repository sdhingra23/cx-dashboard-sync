// ============================================================
// HEALTH SCORE COMPUTATION
//
// New 5-factor weighted formula (replaces GAS formula + meeting cadence):
//
//   Applicant pipeline health  25%
//   Feature adoption           25%
//   NPS trend                  20%
//   Billing health             15%
//   Pendo engagement           15%
// ============================================================

/**
 * Compute the health score (0–100) for one account.
 * @param {object} acc — merged account object with all fields
 * @returns {number}   — integer 0–100
 */
export function computeHealthScore(acc) {
  // ── 1. Applicant pipeline health (25%) ────────────────────
  // Zero-ROI accounts score 0 automatically.
  // Otherwise: inverse of % locations with no Indeed apps.
  let pipelineScore = 0;
  if (!acc.is_zero_roi) {
    const noIndeedPct = Number(acc.perc_locs_no_indeed) || 0;
    const healthPct   = Math.max(0, 100 - noIndeedPct);
    pipelineScore     = (healthPct / 100) * 25;
  }

  // ── 2. Feature adoption (25%) ─────────────────────────────
  // Feature is "adopted" when enabled AND actively used.
  const features = [
    Boolean(acc.feature_onboarding),
    Boolean(acc.feature_nextmatch) && (Number(acc.nextmatch_calls_90d) || 0) > 0,
    !acc.no_tta_apps_90d && (Number(acc.tta_apps_count_90d) || 0) > 0,
    Boolean(acc.job_boost_enabled) && (Number(acc.job_boost_last_used_days) || 999) < 60,
    Boolean(acc.linkedin_enabled),
  ];
  const adoptedCount  = features.filter(Boolean).length;
  const adoptionScore = (adoptedCount / features.length) * 25;

  // ── 3. NPS trend (20%) ────────────────────────────────────
  // Base: promoter=100, passive=50, detractor=0, no data=50 (neutral).
  // 20% penalty applied if score declined vs prior period.
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
  // Any outstanding balance → 0; no balance → full 15.
  const billingScore = (Number(acc.outstanding_balance) || 0) > 0 ? 0 : 15;

  // ── 5. Pendo engagement (15%) ─────────────────────────────
  // Based on days_active_per_visitor vs prior period.
  // No Pendo data → neutral (7.5 out of 15).
  let engagementScore = 7.5;
  const current = Number(acc.pendo_days_active_per_visitor);
  if (!isNaN(current) && current !== null) {
    // Normalize: cap at 20 days/month as "excellent"
    let normalized = Math.min(current / 20, 1);
    // Declining trend penalty: if current < 90% of prior, apply 20% penalty
    const prior = Number(acc.pendo_days_active_per_visitor_prior);
    if (!isNaN(prior) && prior > 0 && current < prior * 0.9) {
      normalized = normalized * 0.80;
    }
    engagementScore = normalized * 15;
  }

  const total = pipelineScore + adoptionScore + npsScore + billingScore + engagementScore;
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
