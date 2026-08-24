// ============================================================
// HEALTH SCORE COMPUTATION  —  model v2
//
// v1 scored feature adoption and raw activity directly, which produced two
// systematic distortions:
//
//   Seasonality. Hourly hiring in QSR, retail and hospitality is seasonal. An
//   account with no openings in January is not unhealthy, but v1 read the
//   empty pipeline as failure and marked it red every winter.
//
//   Adoption as a proxy for value. v1 treated "doesn't use Job Boost" as
//   unhealthy even for accounts drowning in organic applicants, who have no
//   reason to boost. Unused levers are only a problem when the outcome they
//   would improve is actually weak.
//
// v2 therefore scores RATIOS, never volumes. Every hiring-side factor is a
// rate — how well the account acts on the applicants it does get — so it
// stays comparable between a 400-application July and an 11-application
// January. When an account is genuinely idle those factors return NEUTRAL
// rather than zero, so an off-season account holds its score.
//
// Idle is only forgiven while the account looks alive by other means. Idle
// plus no login for 30+ days is not a quiet season, it is a customer
// drifting away, and it scores as risk. See idleTreatment() below.
//
//   Factor                    no gut   with gut   Seasonality
//   ─────────────────────────────────────────────────────────────────────
//   Candidate responsiveness    18%       15%     rate — neutral when idle
//   Hiring effectiveness        15%       12%     rate — neutral when idle
//   Configuration readiness     15%       12%     config quality, not volume
//   Feature adoption            10%        8%     conditional — see below
//   Sentiment (admin NPS)       15%       12%     neutral without a response
//   Product engagement          15%       12%     seasonality-independent
//   Commercial health           12%       11%     seasonality-independent
//   CX gut score                 —        18%     AM judgement
//
// Weights shift rather than being added on top when a gut score exists, for
// the reason documented in v1: introducing a new weighted factor mechanically
// moves every account's score at once and mass-fires health-drop Slack
// alerts for accounts whose health has not changed.
//
// SCORE_MODEL_VERSION exists for the same reason. It is written to accounts
// and snapshots, and computeFlags() suppresses the score/tier drop flags when
// the previous snapshot was produced by a different model version — otherwise
// the v1→v2 cutover alerts on virtually the entire book in one morning.
// ============================================================

export const SCORE_MODEL_VERSION = 2;

export const HEALTH_WEIGHTS = {
  withoutGut: { responsiveness: 18, effectiveness: 15, readiness: 15, adoption: 10, sentiment: 15, engagement: 15, commercial: 12, gut:  0 },
  withGut:    { responsiveness: 15, effectiveness: 12, readiness: 12, adoption:  8, sentiment: 12, engagement: 12, commercial: 11, gut: 18 },
};

// Applications in the last 30 days below which the hiring-side rates are too
// thin to mean anything. Under this, those factors defer to idleTreatment().
const MIN_VOLUME_FOR_RATES = 5;

// Applications per active location per 30 days at which the pipeline is
// considered healthy enough that unused features stop counting against the
// account — the "doesn't boost but doesn't need to" case.
const HEALTHY_APPS_PER_ACTIVE_LOC = 8;

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

// ── Idle handling ────────────────────────────────────────────

/**
 * What the hiring-side factors should score when an account has too little
 * application volume to rate.
 *
 * A seasonal trough and a churning customer look identical in the hiring
 * data, so the distinction is drawn from engagement instead: an account whose
 * team is still logging in is between hiring pushes and keeps a neutral
 * score; one that has gone quiet everywhere is scored as risk.
 */
function idleTreatment(acc) {
  const loginDays = daysSince(acc.pendo_last_active);
  const stillEngaged = loginDays !== null && loginDays <= 30;

  if (stillEngaged) {
    return { value: 0.5, note: 'Idle this month — neutral, team still active in-product' };
  }
  if (loginDays === null) {
    // No Pendo signal either way. Neutral, but say so rather than implying
    // the account was checked and found healthy.
    return { value: 0.5, note: 'Idle this month — no engagement data to corroborate' };
  }
  return { value: 0.15, note: `Idle this month and no login in ${loginDays} days — scored as risk` };
}

// ── Factors ──────────────────────────────────────────────────

/** 1. Candidate responsiveness — do they act on the applicants they get? */
function factorResponsiveness(acc, hasVolume) {
  if (!hasVolume) return idleTreatment(acc);

  const value = mean([
    band(acc.employer_response_rate_pct, 20, 70),   // % of chats the employer answers
    band(acc.two_way_pct,                 5, 40),   // % of applications with a real conversation
    band(acc.avg_time_to_contact_days,    7,  1),   // lower is better
    band(acc.avg_time_to_invite_days,    10,  2),   // lower is better
  ]);
  if (value === null) return { value: 0.5, note: 'No responsiveness data' };
  return { value, note: null };
}

/** 2. Hiring effectiveness — conversion rates, never counts. */
function factorEffectiveness(acc, hasVolume) {
  if (!hasVolume) return idleTreatment(acc);

  const applied = Number(acc.total_applied) || 0;
  const hired   = Number(acc.total_hired)   || 0;
  const applyToHirePct = applied > 0 ? (hired / applied) * 100 : null;

  const value = mean([
    band(applyToHirePct,             0.5,  6),   // hourly apply→hire sits low; 6% is strong
    band(acc.hire_rate_with_chat_pct,  1, 10),
    band(acc.avg_time_to_hire_days,   30,  7),   // lower is better
  ]);
  if (value === null) return { value: 0.5, note: 'No conversion data' };
  return { value, note: null };
}

/**
 * 3. Configuration readiness — is what they have posted set up to succeed?
 *
 * Deliberately excludes "share of locations with an active job": a location
 * with no openings is a business decision, not a defect, and scoring it would
 * reintroduce the seasonality problem through the back door.
 */
function factorReadiness(acc) {
  // perc_active_locs_* come from the locations table and are measured only
  // across locations with a job posted, so they stay null in an off-season
  // and drop out of the mean rather than scoring as failure.
  //
  // Deliberately NOT using perc_locs_no_indeed here: it counts locations with
  // no Indeed *applications*, which spikes every quiet month and would
  // reintroduce the seasonality this model exists to remove.
  const value = mean([
    band(acc.perc_jobs_no_salaries,            60,  5),   // lower is better
    band(acc.perc_jobs_no_perks,               70, 10),
    band(acc.perc_active_locs_indeed_off,      50,  0),
    band(acc.perc_active_locs_no_apps,         70, 10),
  ]);
  if (value === null) return { value: 0.5, note: 'No configuration data' };
  return { value, note: null };
}

/**
 * 4. Feature adoption — conditional.
 *
 * The nuance this model exists to fix: an account with ample organic
 * applications has no reason to run Job Boost, and should not be marked down
 * for skipping a lever it does not need. When the pipeline is already
 * healthy, adoption is floored so it can lift a score but barely dent one.
 */
function factorAdoption(acc) {
  const appsPerActiveLoc = (Number(acc.active_locations) || 0) > 0
    ? (Number(acc.applications_30d) || 0) / Number(acc.active_locations)
    : null;
  const pipelineHealthy = appsPerActiveLoc !== null && appsPerActiveLoc >= HEALTHY_APPS_PER_ACTIVE_LOC;

  const raw = mean([
    band(acc.perc_locs_no_job_boosts, 90, 20),  // lower is better
    band(acc.perc_locs_no_tta,        90, 20),
    (Number(acc.nextmatch_calls_90d) || 0) > 0 ? 1 : 0,
    acc.linkedin_enabled   == null ? null : (acc.linkedin_enabled   ? 1 : 0),
    acc.onboarding_enabled == null ? null : (acc.onboarding_enabled ? 1 : 0),
    (Number(acc.total_integrations) || 0) > 0 ? 1 : 0,
  ]);
  if (raw === null) return { value: 0.5, note: 'No adoption data' };

  if (pipelineHealthy && raw < 0.8) {
    return {
      value: 0.8,
      note: `Unused features not penalised — ${appsPerActiveLoc.toFixed(1)} apps per active location is already healthy`,
    };
  }
  return { value: raw, note: null };
}

/**
 * 5. Sentiment — company-admin NPS only.
 *
 * Admins are the buyers and the renewal decision-makers; a hiring manager's
 * frustration with one shift is not the same signal. Employer and other-role
 * responses are still collected and broken out on the account page, they just
 * do not move the score.
 *
 * Falls back to blended NPS when no role data exists at all, so the factor
 * does not silently go neutral for the whole book before roles are wired up.
 */
function factorSentiment(acc) {
  const hasAdmin = acc.nps_admin_band != null;
  const band_    = hasAdmin ? acc.nps_admin_band : (acc.nps_role_data_available ? null : acc.nps_latest_band);

  if (band_ == null) {
    return {
      value: 0.5,
      note: hasAdmin ? null : 'No company-admin NPS response on record',
    };
  }

  let value;
  switch (band_) {
    case 'promoter':  value = 1.0;  break;
    case 'passive':   value = 0.5;  break;
    case 'detractor': value = 0.0;  break;
    default:          value = 0.5;  break;
  }

  // A declining trend is a leading indicator; discount rather than rebase.
  if (acc.nps_trend === 'declining') value *= 0.8;
  // An explicit churn signal in a recent verbatim outweighs the band.
  if (acc.flag_churn_verbatim) value = Math.min(value, 0.15);

  return {
    value,
    note: hasAdmin ? null : 'Blended NPS — no role data available yet',
  };
}

/** 6. Product engagement — the corroborating signal for idle accounts. */
function factorEngagement(acc) {
  const loginDays = daysSince(acc.pendo_last_active);
  const value = mean([
    band(acc.pendo_days_active_per_visitor, 0, 20),
    band(loginDays, 60, 3),   // lower is better
  ]);
  if (value === null) return { value: 0.5, note: 'No Pendo engagement data' };
  return { value, note: loginDays !== null && loginDays > 30 ? `No login in ${loginDays} days` : null };
}

/** 7. Commercial health — billing, plus renewal proximity as an amplifier. */
function factorCommercial(acc) {
  const balance = Number(acc.billing_balance_effective ?? acc.outstanding_balance) || 0;
  let value = balance > 0 ? 0 : 1;
  let note  = balance > 0 ? `Outstanding balance $${balance.toLocaleString()}` : null;

  // An unpaid balance in the renewal window is materially worse than one
  // eleven months out.
  const renewalDays = acc.renewal_date
    ? Math.floor((new Date(acc.renewal_date).getTime() - Date.now()) / 86400000)
    : null;
  if (balance > 0 && renewalDays !== null && renewalDays >= 0 && renewalDays <= 60) {
    note = `${note} with renewal in ${renewalDays} days`;
  } else if (balance === 0 && renewalDays !== null && renewalDays >= 0 && renewalDays <= 30) {
    value = 0.85;   // healthy, but the renewal deserves attention
    note  = `Renewal in ${renewalDays} days`;
  }
  return { value, note };
}

// ── Public API ───────────────────────────────────────────────

const FACTOR_LABELS = {
  responsiveness: 'Candidate responsiveness',
  effectiveness:  'Hiring effectiveness',
  readiness:      'Configuration readiness',
  adoption:       'Feature adoption',
  sentiment:      'Sentiment (admin NPS)',
  engagement:     'Product engagement',
  commercial:     'Commercial health',
  gut:            'CX gut score',
};

/**
 * Full score with a per-factor breakdown, so the dashboard can show why an
 * account scores what it does instead of presenting a bare number.
 *
 * @param {object} acc — merged account object
 * @returns {{ score:number, modelVersion:number, factors:Array }}
 */
export function computeHealthBreakdown(acc) {
  const hasGutScore = acc.cx_gut_score !== null && acc.cx_gut_score !== undefined
    && !isNaN(Number(acc.cx_gut_score));
  const W = hasGutScore ? HEALTH_WEIGHTS.withGut : HEALTH_WEIGHTS.withoutGut;

  const hasVolume = (Number(acc.applications_30d) || 0) >= MIN_VOLUME_FOR_RATES;

  const results = {
    responsiveness: factorResponsiveness(acc, hasVolume),
    effectiveness:  factorEffectiveness(acc, hasVolume),
    readiness:      factorReadiness(acc),
    adoption:       factorAdoption(acc),
    sentiment:      factorSentiment(acc),
    engagement:     factorEngagement(acc),
    commercial:     factorCommercial(acc),
  };

  if (hasGutScore) {
    const raw = Math.min(10, Math.max(0, Number(acc.cx_gut_score)));
    results.gut = { value: raw / 10, note: `AM rated ${raw}/10` };
  }

  const factors = [];
  let total = 0;
  for (const [key, res] of Object.entries(results)) {
    const weight = W[key] || 0;
    if (weight === 0) continue;
    const earned = res.value * weight;
    total += earned;
    factors.push({
      key,
      label:  FACTOR_LABELS[key],
      weight,
      earned: Math.round(earned * 10) / 10,
      pct:    Math.round(res.value * 100),
      note:   res.note || null,
    });
  }

  return {
    score:        Math.min(100, Math.max(0, Math.round(total))),
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
