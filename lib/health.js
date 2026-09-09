// ============================================================
// HEALTH SCORE COMPUTATION  —  model v3
//
// Structure: a 100-point BASE built only from health, plus an additive
// ADOPTION BONUS that can lift a score but never lower one.
//
// That split exists because v1 and v2 both let feature adoption drag the
// score down. An account with ample organic applicants has no reason to run
// Job Boost, and marking it unhealthy for skipping a lever it does not need
// made the number describe usage rather than health. In v3 every base input
// is an outcome, a sentiment, or a commercial fact; using more of the product
// can only ever help.
//
// Boost is the exception that proves the rule, and it is split in two:
//
//   Boost GAP    a location with a job posted that produced zero applications
//                in 30 days and is not boosting. That is a real problem, and
//                it scores inside Pipeline health. Accounts with healthy
//                application flow cannot land here by construction.
//   Boost USAGE  locations that are boosting. Bonus only.
//
//   BASE                          no gut   with gut
//   ─────────────────────────────────────────────────
//   Pipeline health                 30%      25%
//   Hiring effectiveness            20%      16%
//   Sentiment (admin NPS)           20%      16%
//   Product engagement              15%      12%
//   Billing                         15%      13%
//   CX gut score                     —       18%
//
//   BONUS  up to +10, capped so the total never exceeds 100.
//          Boost usage, AI screening, Text-to-Apply, LinkedIn, onboarding,
//          integrations, on-app messaging.
//
// A perfectly healthy account that adopts nothing still reaches 100 on the
// base alone. The bonus lifts the middle of the book; it does not gate the top.
//
// Weights shift rather than being added on top when a gut score exists: a new
// weighted factor otherwise moves every account's score at once and mass-fires
// health-drop Slack alerts for accounts whose health has not changed.
//
// SCORE_MODEL_VERSION is written to accounts and snapshots, and computeFlags()
// suppresses the score/tier drop flags when the previous snapshot came from a
// different version — otherwise a model change alerts on the whole book.
// ============================================================

export const SCORE_MODEL_VERSION = 3;

export const HEALTH_WEIGHTS = {
  withoutGut: { pipeline: 30, effectiveness: 20, sentiment: 20, engagement: 15, billing: 15, gut:  0 },
  withGut:    { pipeline: 25, effectiveness: 16, sentiment: 16, engagement: 12, billing: 13, gut: 18 },
};

/** Maximum points feature adoption can add. Never subtracts. */
export const ADOPTION_BONUS_MAX = 10;

// Applications in the last 30 days below which apply-to-hire is arithmetic
// noise rather than a measurement.
const MIN_VOLUME_FOR_RATES = 5;

// An admin NPS response older than this no longer describes current
// sentiment. Without this cutoff a single response from years ago keeps
// scoring as if it were fresh, forever — which reads to an AM as "no data"
// (there's nothing recent) while the score quietly still uses it.
const STALE_ADMIN_NPS_DAYS = 180;

// ── Scoring primitives ───────────────────────────────────────

/**
 * Map a metric onto 0–1 by linear interpolation between a "bad" and a "good"
 * anchor, clamped at both ends. Works in either direction: pass good < bad
 * for lower-is-better metrics such as time-to-contact.
 * Returns null for absent values so callers can tell "bad" from "unknown".
 */
function band(value, bad, good) {
  if (value === null || value === undefined || value === '') return null;
  const v = Number(value);
  if (!isFinite(v)) return null;
  if (good === bad) return 0.5;
  return Math.max(0, Math.min(1, (v - bad) / (good - bad)));
}

/** Mean of the non-null sub-scores; null when nothing is known. */
function mean(parts) {
  const known = parts.filter(p => p !== null && p !== undefined);
  if (known.length === 0) return null;
  return known.reduce((s, v) => s + v, 0) / known.length;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// ── Base factors ─────────────────────────────────────────────

/**
 * 1. Pipeline health — are the jobs they post attracting applicants, and is
 *    anything fixable standing in the way?
 *
 * The perc_active_locs_* inputs come from the locations table and are measured
 * only across locations with a job posted, so they go null rather than zero
 * when an account has nothing open.
 */
function factorPipeline(acc) {
  const value = mean([
    band(acc.perc_active_locs_no_apps,    70, 10),   // posted a job, got nothing
    band(acc.perc_locs_no_indeed,         70,  5),   // account-level Indeed reach (Q1436)
    band(acc.perc_active_locs_boost_gap,  40,  0),   // starving jobs left unboosted
    band(acc.perc_jobs_no_salaries,       60,  5),   // fixable causes of low volume
    band(acc.perc_jobs_no_perks,          70, 10),
  ]);
  if (value === null) return { value: 0.5, note: 'No pipeline data' };

  const gap = Number(acc.locs_boost_gap) || 0;
  return {
    value,
    note: gap > 0 ? `${gap} location${gap === 1 ? '' : 's'} with a posted job, zero applications and no boost` : null,
  };
}

/**
 * 2. Hiring effectiveness — conversion and speed, never counts.
 *
 * Neutral below MIN_VOLUME_FOR_RATES applications: apply-to-hire on three
 * applications is not a measurement. Engagement corroborates whether a quiet
 * month is a lull or a customer drifting away.
 */
function factorEffectiveness(acc) {
  const apps = Number(acc.applications_30d) || 0;
  if (apps < MIN_VOLUME_FOR_RATES) {
    const loginDays = daysSince(acc.pendo_last_active);
    if (loginDays !== null && loginDays > 30) {
      return { value: 0.15, note: `Too few applications to rate, and no login in ${loginDays} days` };
    }
    return { value: 0.5, note: 'Too few applications this month to rate' };
  }

  const applied = Number(acc.total_applied) || 0;
  const hired   = Number(acc.total_hired)   || 0;
  const applyToHirePct = applied > 0 ? (hired / applied) * 100 : null;

  const value = mean([
    band(applyToHirePct,             0.5, 6),   // hourly apply→hire sits low; 6% is strong
    band(acc.avg_time_to_contact_days, 7, 1),   // lower is better
  ]);
  if (value === null) return { value: 0.5, note: 'No conversion data' };
  return { value, note: null };
}

/**
 * 3. Sentiment — company-admin NPS only.
 *
 * Admins are the buyers and the renewal decision-makers; a shift manager's
 * frustration is real feedback but not the same signal. Employer and
 * other-role responses are collected and broken out on the account page, they
 * just do not move the score.
 *
 * Falls back to blended NPS when no role data exists at all, so the factor
 * does not silently go neutral across the whole book before roles are wired.
 *
 * An admin response older than STALE_ADMIN_NPS_DAYS is treated the same as
 * no response at all — otherwise a single response from months/years ago
 * keeps scoring as current sentiment forever, while the account page shows
 * "no recent response," giving the AM two contradictory signals.
 */
function factorSentiment(acc) {
  const adminAgeDays = daysSince(acc.nps_admin_response_date);
  const adminIsStale = adminAgeDays !== null && adminAgeDays > STALE_ADMIN_NPS_DAYS;
  const hasAdmin = acc.nps_admin_band != null && !adminIsStale;
  const useBand  = hasAdmin ? acc.nps_admin_band : (acc.nps_role_data_available ? null : acc.nps_latest_band);

  if (useBand == null) {
    return {
      value: 0.5,
      note: adminIsStale
        ? `No recent company-admin NPS response (last was ${adminAgeDays} days ago)`
        : 'No company-admin NPS response on record',
    };
  }

  let value;
  switch (useBand) {
    case 'promoter':  value = 1.0; break;
    case 'passive':   value = 0.5; break;
    case 'detractor': value = 0.0; break;
    default:          value = 0.5; break;
  }

  if (acc.nps_trend === 'declining') value *= 0.8;
  if (acc.flag_churn_verbatim)       value = Math.min(value, 0.15);

  return { value, note: hasAdmin ? null : 'Blended NPS — no role data available yet' };
}

/** 4. Product engagement — are they still showing up? */
function factorEngagement(acc) {
  const loginDays = daysSince(acc.pendo_last_active);
  const value = mean([
    band(acc.pendo_days_active_per_visitor, 0, 20),
    band(loginDays, 60, 3),   // lower is better
  ]);
  if (value === null) return { value: 0.5, note: 'No Pendo engagement data' };
  return { value, note: loginDays !== null && loginDays > 30 ? `No login in ${loginDays} days` : null };
}

/**
 * 5. Billing — unchanged: an effective outstanding balance zeroes the factor.
 *
 * billing_balance_effective is pre-computed in sync.js and is 0 unless the
 * balance both exceeds 10% of ARR and has persisted 7+ days, so ACH-in-transit
 * amounts never register. Renewal proximity is deliberately not folded in here
 * — flag_renewal_at_risk already surfaces that separately.
 */
function factorBilling(acc) {
  const balance = Number(acc.billing_balance_effective ?? acc.outstanding_balance) || 0;
  return {
    value: balance > 0 ? 0 : 1,
    note:  balance > 0 ? `Outstanding balance $${balance.toLocaleString()}` : null,
  };
}

// ── Adoption bonus ───────────────────────────────────────────

/**
 * Additive only, capped at ADOPTION_BONUS_MAX and further capped so the total
 * never exceeds 100. Each signal is skipped when unknown rather than counted
 * as a miss, so a missing data source cannot cost an account points.
 */
function adoptionBonus(acc) {
  const signals = [
    { label: 'Job Boost',       on: acc.perc_locs_no_job_boosts == null ? null : Number(acc.perc_locs_no_job_boosts) < 100 },
    { label: 'AI screening',    on: (Number(acc.nextmatch_calls_90d) || 0) > 0 },
    { label: 'Text-to-Apply',   on: acc.perc_locs_no_tta == null ? null : Number(acc.perc_locs_no_tta) < 100 },
    { label: 'LinkedIn',        on: acc.linkedin_enabled   == null ? null : Boolean(acc.linkedin_enabled) },
    { label: 'Onboarding',      on: acc.onboarding_enabled == null ? null : Boolean(acc.onboarding_enabled) },
    { label: 'Integrations',    on: (Number(acc.total_integrations) || 0) > 0 },
    { label: 'On-app messaging',on: acc.two_way_pct == null ? null : Number(acc.two_way_pct) > 0 },
  ];

  const known   = signals.filter(s => s.on !== null);
  const adopted = known.filter(s => s.on);
  if (known.length === 0) return { points: 0, note: 'No adoption data', adopted: [] };

  const points = Math.round((adopted.length / known.length) * ADOPTION_BONUS_MAX * 10) / 10;
  return {
    points,
    adopted: adopted.map(s => s.label),
    note: adopted.length === 0
      ? 'No features in use — no penalty, no bonus'
      : `${adopted.length} of ${known.length} in use: ${adopted.map(s => s.label).join(', ')}`,
  };
}

// ── Public API ───────────────────────────────────────────────

const FACTOR_LABELS = {
  pipeline:      'Pipeline health',
  effectiveness: 'Hiring effectiveness',
  sentiment:     'Sentiment (admin NPS)',
  engagement:    'Product engagement',
  billing:       'Billing',
  gut:           'CX gut score',
};

/**
 * Full score with a per-factor breakdown, so the dashboard can show why an
 * account scores what it does instead of presenting a bare number.
 *
 * @param {object} acc — merged account object
 * @returns {{ score:number, baseScore:number, bonus:number, modelVersion:number, factors:Array }}
 */
export function computeHealthBreakdown(acc) {
  const hasGutScore = acc.cx_gut_score !== null && acc.cx_gut_score !== undefined
    && !isNaN(Number(acc.cx_gut_score));
  const W = hasGutScore ? HEALTH_WEIGHTS.withGut : HEALTH_WEIGHTS.withoutGut;

  const results = {
    pipeline:      factorPipeline(acc),
    effectiveness: factorEffectiveness(acc),
    sentiment:     factorSentiment(acc),
    engagement:    factorEngagement(acc),
    billing:       factorBilling(acc),
  };

  if (hasGutScore) {
    const raw = Math.min(10, Math.max(0, Number(acc.cx_gut_score)));
    results.gut = { value: raw / 10, note: `AM rated ${raw}/10` };
  }

  const factors = [];
  let base = 0;
  for (const [key, res] of Object.entries(results)) {
    const weight = W[key] || 0;
    if (weight === 0) continue;
    const earned = res.value * weight;
    base += earned;
    factors.push({
      key,
      label:  FACTOR_LABELS[key],
      weight,
      earned: Math.round(earned * 10) / 10,
      pct:    Math.round(res.value * 100),
      note:   res.note || null,
    });
  }

  const baseScore = Math.min(100, Math.max(0, Math.round(base)));
  const bonus     = adoptionBonus(acc);

  // Capped at 100: the bonus lifts the middle of the book, it cannot push a
  // strong account past the ceiling or make adoption a prerequisite for it.
  const awarded = Math.min(bonus.points, 100 - baseScore);

  factors.push({
    key:    'bonus',
    label:  'Feature adoption bonus',
    weight: ADOPTION_BONUS_MAX,
    earned: Math.round(awarded * 10) / 10,
    pct:    Math.round((bonus.points / ADOPTION_BONUS_MAX) * 100),
    note:   bonus.note,
    isBonus: true,
  });

  return {
    score:        Math.min(100, Math.max(0, Math.round(baseScore + awarded))),
    baseScore,
    bonus:        Math.round(awarded * 10) / 10,
    modelVersion: SCORE_MODEL_VERSION,
    factors,
  };
}

/**
 * Compute the health score (0–100) for one account.
 * @param {object} acc — merged account object with all fields
 * @returns {number}   — integer 0–100
 */
export function computeHealthScore(acc) {
  return computeHealthBreakdown(acc).score;
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
 * Hire rate as applications → hires.
 *
 * Was hires ÷ interviews, which exceeded 100% for the many accounts that hire
 * straight from the application without running an interview on the platform.
 * Applications are the one denominator every account has.
 *
 * @returns {number|null} 0–1, or null when there are no applications
 */
export function computeHireRate(acc) {
  const hired   = Number(acc.total_hired)   || 0;
  const applied = Number(acc.total_applied) || 0;
  if (applied === 0) return null;
  return hired / applied;
}

/**
 * Interview-to-hire rate — the old hire_rate definition, kept as a separate
 * funnel metric for accounts that do interview on the platform.
 * @returns {number|null} 0–1, or null when no interviews were run
 */
export function computeInterviewToHireRate(acc) {
  const hired      = Number(acc.total_hired)      || 0;
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
