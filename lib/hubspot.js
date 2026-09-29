// ============================================================
// HUBSPOT CLIENT (Project Unified data)
//
// Reads the HM Account / HM Company / Location custom objects that
// "Project Unified" (a separate HigherMe → HubSpot sync) populates daily.
//
//   HM Account   — source of truth for account identity + ARR. Correctly
//                  rolls up multiple Chargebee subscriptions/customers onto
//                  one real account, which Chargebee's own company-name
//                  matching cannot do (see the duplicate-account
//                  investigation this replaces).
//   HM Company   — integration/engagement flags. An account can have more
//                  than one associated company; a flag counts as "on" if
//                  ANY associated company has it, same "adopted anywhere"
//                  logic already used for the health score's adoption bonus.
//   Location     — applicant funnel + lifecycle status. location_id is the
//                  same numeric ID space Metabase's Q1513 already uses, so
//                  this data merges into the existing `locations` table
//                  rather than needing a parallel one.
//
// Deliberately NOT pulled in: churn_reason/cancellation_date (HM Account)
// and cxm_health_score (Subscriptions) — out of scope for this pass.
//
// Objects are linked via HubSpot's native association mechanism (no flat
// foreign-key properties exist), fetched in batches rather than one
// GET-per-record so this scales to a full book without a request storm.
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';
const PAGE_SIZE = 100;
const ASSOC_BATCH_SIZE = 100;

const ACCOUNT_PROPS = [
  'hm_account_id', 'hm_account_name', 'hm_total_mrr', 'hm_currency_code',
  'hm_chargebee_status', 'hm_subscription_ids', 'hm_ensuing_renewal_date',
  'hm_started_at', 'hm_total_plan_quantity',
];

const COMPANY_PROPS = [
  'hm_company_id', 'hm_company_name', 'hm_type', 'hm_usage',
  'hm_has_onboarding', 'hm_has_netchex', 'hm_has_clearview', 'hm_has_seven_shifts',
  'hm_has_hr_alliance', 'hm_has_checkr', 'hm_has_form_i9', 'hm_has_hr_logics',
  'hm_has_cfa', 'hm_has_paychex', 'hm_has_wizardline', 'hm_has_iconblocks', 'hm_has_adp',
  'hm_templates_edited_count', 'hm_custom_questions_in_use_count',
];

// 30-day funnel window only, for now — 7/90/180-day variants exist on the
// same object (see explore-hubspot-fields.js output) and can be added if a
// future drill-down wants them.
const LOCATION_PROPS = [
  'location_id', 'location_name', 'status', 'paused_at', 'churned_at', 'deleted_at',
  'brand_id', 'brand_name',
  'hm_active_job_count', 'hm_applicant_count_30d', 'hm_completed_application_count',
  'hm_indeed_applicant_count_30d', 'hm_jobs_without_visible_wage_count',
  'hm_multi_status_application_count', 'hm_onboarded_employee_count', 'last_requested_boost',
  'applications_new_last30days', 'applications_contacted_last30days',
  'applications_uncontacted_last30days', 'applications_interviewed_last30days',
  'applications_offered_last30days', 'applications_will_offer_last30days',
  'applications_hired_last30days', 'applications_rejected_last30days',
  'applications_auto_rejected_last30days', 'applications_pending_onboarding_last30days',
  'applications_future_candidate_last30days', 'applications_with_video_last30days',
];

// ── Public entry point ───────────────────────────────────────

/**
 * Fetch and join HM Account, HM Company, and Location data from HubSpot.
 * @param {string} hsKey — HUBSPOT_API_KEY
 * @returns {Promise<{ accounts: object[], locations: object[] }>}
 */
export async function buildHubspotData(hsKey) {
  if (!hsKey) throw new Error('HUBSPOT_API_KEY not set.');

  const schemas = (await hsRequest(hsKey, '/crm/v3/schemas')).results || [];
  const accountSchema  = findSchema(schemas, /hm account|hm_account/);
  const companySchema  = findSchema(schemas, /hm company|hm_compan/);
  const locationSchema = findSchema(schemas, /^location|h_locations/);
  if (!accountSchema || !companySchema || !locationSchema) {
    throw new Error(`HubSpot schema discovery failed — account=${!!accountSchema} company=${!!companySchema} location=${!!locationSchema}`);
  }

  const [rawAccounts, companies, locations] = await Promise.all([
    fetchAllObjects(hsKey, accountSchema.objectTypeId, ACCOUNT_PROPS),
    fetchAllObjects(hsKey, companySchema.objectTypeId, COMPANY_PROPS),
    fetchAllObjects(hsKey, locationSchema.objectTypeId, LOCATION_PROPS),
  ]);

  // "Active" per the spec's own three-value enum (active, non_renewing,
  // cancelled) — only cancelled is excluded, same definition already
  // validated in scripts/compare-hubspot-account-totals.js. Filtered before
  // associations are resolved, not just before returning, so cancelled
  // accounts don't cost an association batch call for nothing — most HM
  // Account records are cancelled (a full historical ledger, not just
  // current customers), so this matters for both correctness and cost.
  const accounts = rawAccounts.filter(a => {
    const status = (a.properties.hm_chargebee_status || '').toLowerCase();
    return status === 'active' || status === 'non_renewing';
  });
  console.log(`HubSpot: fetched ${rawAccounts.length} HM Accounts (${accounts.length} active/non_renewing, ${rawAccounts.length - accounts.length} cancelled/blank excluded), ${companies.length} HM Companies, ${locations.length} Locations`);

  const [acctToCompany, companyToLocation] = await Promise.all([
    fetchBatchAssociations(hsKey, accountSchema.objectTypeId, companySchema.objectTypeId, accounts.map(a => a.id)),
    fetchBatchAssociations(hsKey, companySchema.objectTypeId, locationSchema.objectTypeId, companies.map(c => c.id)),
  ]);

  const fx = await fetchFxRates();

  const companyById = new Map(companies.map(c => [c.id, c]));
  const hmAccounts = accounts.map(a => buildAccountRecord(a, acctToCompany.get(a.id) || [], companyById, fx));

  // Location -> Company -> Account, so each location row can carry the
  // account_name it rolls up to (matching how Metabase-sourced rows key by
  // account_name already).
  const locationToCompany = new Map();
  for (const [companyId, locIds] of companyToLocation.entries()) {
    for (const locId of locIds) locationToCompany.set(locId, companyId);
  }
  const companyToAccount = new Map();
  for (const [accountHsId, compIds] of acctToCompany.entries()) {
    for (const compId of compIds) companyToAccount.set(compId, accountHsId);
  }
  const accountById = new Map(accounts.map(a => [a.id, a]));

  const hmLocations = locations
    .map(l => buildLocationRecord(l, locationToCompany, companyToAccount, accountById))
    .filter(l => l.location_id !== null && l.account_name);

  return { accounts: hmAccounts, locations: hmLocations };
}

// ── Record builders ─────────────────────────────────────────

function buildAccountRecord(a, companyIds, companyById, fx) {
  const p = a.properties;
  const assocCompanies = companyIds.map(id => companyById.get(id)).filter(Boolean);

  const rawMrr   = Number(p.hm_total_mrr) || 0;
  const currency = (p.hm_currency_code || 'USD').toUpperCase();
  const mrrUsd   = (!currency || currency === 'USD') ? rawMrr : (fx?.[currency] ? rawMrr / fx[currency] : rawMrr);

  // null (unknown) when there's no associated company to judge from, rather
  // than false — an account with no HM Company data isn't "verified not
  // using X," it's just data we don't have. Same null-vs-false distinction
  // already used for LinkedIn/NPS/etc. elsewhere in this pipeline.
  const hasAny = key => assocCompanies.length === 0 ? null : assocCompanies.some(c => isYes(c.properties[key]));
  const sumMetric = key => {
    const vals = assocCompanies.map(c => Number(c.properties[key])).filter(n => Number.isFinite(n));
    return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
  };

  return {
    hm_account_id:    p.hm_account_id ? Number(p.hm_account_id) : null,
    account_name:      (p.hm_account_name || '').trim(),
    arr:                Math.round(mrrUsd * 12 * 100) / 100,
    chargebee_status:  p.hm_chargebee_status || null,
    renewal_date:      toDateOrNull(p.hm_ensuing_renewal_date),
    create_date:       toDateOrNull(p.hm_started_at),
    plan_quantity:      p.hm_total_plan_quantity != null ? Number(p.hm_total_plan_quantity) : null,

    has_netchex:       hasAny('hm_has_netchex'),
    has_clearview:     hasAny('hm_has_clearview'),
    has_7shifts:       hasAny('hm_has_seven_shifts'),
    has_hr_alliance:   hasAny('hm_has_hr_alliance'),
    has_checkr:        hasAny('hm_has_checkr'),
    has_form_i9:       hasAny('hm_has_form_i9'),
    has_hr_logics:     hasAny('hm_has_hr_logics'),
    has_cfa:           hasAny('hm_has_cfa'),
    has_paychex:       hasAny('hm_has_paychex'),
    has_wizardline:    hasAny('hm_has_wizardline'),
    has_iconblocks:    hasAny('hm_has_iconblocks'),
    has_adp:           hasAny('hm_has_adp'),
    has_onboarding:    hasAny('hm_has_onboarding'),

    templates_edited_count:        sumMetric('hm_templates_edited_count'),
    custom_questions_in_use_count: sumMetric('hm_custom_questions_in_use_count'),
  };
}

function buildLocationRecord(l, locationToCompany, companyToAccount, accountById) {
  const p = l.properties;
  const companyId  = locationToCompany.get(l.id);
  const accountHsId = companyId ? companyToAccount.get(companyId) : null;
  const account     = accountHsId ? accountById.get(accountHsId) : null;

  return {
    location_id:  p.location_id ? Number(p.location_id) : null,
    account_name:  account ? (account.properties.hm_account_name || '').trim() : null,
    location_name: p.location_name || null,

    status:      p.status || null,
    paused_at:   toDateOrNull(p.paused_at),
    churned_at:  toDateOrNull(p.churned_at),
    deleted_at:  toDateOrNull(p.deleted_at),
    brand_id:    p.brand_id ? Number(p.brand_id) : null,
    brand_name:  p.brand_name || null,

    active_job_count:               toIntOrNull(p.hm_active_job_count),
    applicant_count_30d:            toIntOrNull(p.hm_applicant_count_30d),
    completed_application_count:    toIntOrNull(p.hm_completed_application_count),
    indeed_applicant_count_30d:     toIntOrNull(p.hm_indeed_applicant_count_30d),
    jobs_without_wage_count:        toIntOrNull(p.hm_jobs_without_visible_wage_count),
    multi_status_application_count: toIntOrNull(p.hm_multi_status_application_count),
    onboarded_employee_count:       toIntOrNull(p.hm_onboarded_employee_count),
    last_requested_boost:           toDateOrNull(p.last_requested_boost),

    funnel_new_30d:                toIntOrNull(p.applications_new_last30days),
    funnel_contacted_30d:          toIntOrNull(p.applications_contacted_last30days),
    funnel_uncontacted_30d:        toIntOrNull(p.applications_uncontacted_last30days),
    funnel_interviewed_30d:        toIntOrNull(p.applications_interviewed_last30days),
    funnel_offered_30d:            toIntOrNull(p.applications_offered_last30days),
    funnel_will_offer_30d:         toIntOrNull(p.applications_will_offer_last30days),
    funnel_hired_30d:              toIntOrNull(p.applications_hired_last30days),
    funnel_rejected_30d:           toIntOrNull(p.applications_rejected_last30days),
    funnel_auto_rejected_30d:      toIntOrNull(p.applications_auto_rejected_last30days),
    funnel_pending_onboarding_30d: toIntOrNull(p.applications_pending_onboarding_last30days),
    funnel_future_candidate_30d:   toIntOrNull(p.applications_future_candidate_last30days),
    funnel_with_video_30d:         toIntOrNull(p.applications_with_video_last30days),
  };
}

// ── HubSpot API helpers ──────────────────────────────────────

function findSchema(schemas, re) {
  return schemas.find(s => re.test(`${s.labels?.singular || ''} ${s.name || ''}`.toLowerCase()));
}

async function fetchAllObjects(hsKey, objectType, propertyNames) {
  const results = [];
  let after = null;
  do {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), properties: propertyNames.join(',') });
    if (after) params.set('after', after);
    const res = await hsRequest(hsKey, `/crm/v3/objects/${objectType}?${params.toString()}`);
    results.push(...(res.results || []));
    after = res.paging?.next?.after || null;
  } while (after);
  return results;
}

/**
 * Batch-resolve associations for every ID in fromIds, chunked to stay under
 * HubSpot's per-request input limit. Returns a Map(fromId -> [toId, ...]).
 */
async function fetchBatchAssociations(hsKey, fromObjectType, toObjectType, fromIds) {
  const map = new Map();
  for (let i = 0; i < fromIds.length; i += ASSOC_BATCH_SIZE) {
    const chunk = fromIds.slice(i, i + ASSOC_BATCH_SIZE);
    if (chunk.length === 0) continue;
    const res = await hsRequest(
      hsKey,
      `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`,
      { method: 'POST', body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }) }
    );
    for (const result of res.results || []) {
      // HubSpot's v4 batch associations endpoint returns toObjectId as a raw
      // JSON number, while every object's own .id from the v3 objects list
      // endpoint is a string — coerce both sides to string so Map lookups
      // against companyById/accountById/locationToCompany (all keyed by the
      // string .id) actually hit instead of silently missing on every call.
      const fromId = result.from?.id != null ? String(result.from.id) : null;
      const toIds  = (result.to || []).map(t => String(t.toObjectId));
      if (fromId) map.set(fromId, toIds);
    }
  }
  return map;
}

async function hsRequest(hsKey, path, init = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).message || message; } catch { /* keep raw */ }
    throw new Error(`HubSpot ${res.status} on ${path}: ${message}`);
  }
  return res.json();
}

// Live USD-based rates from a free, keyless API — see
// compare-hubspot-account-totals.js, same approach. Returns null on any
// failure so callers fall back to unconverted rather than throwing.
async function fetchFxRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) return null;
    const data = await res.json();
    return data.rates || null;
  } catch {
    return null;
  }
}

// ── Value coercion ───────────────────────────────────────────

function isYes(val) {
  if (val === true) return true;
  if (val === null || val === undefined) return false;
  return String(val).trim().toLowerCase() === 'yes';
}

function toIntOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// A HubSpot date property with no value has been observed coming back as
// the literal string "None" rather than actual null (most likely Project
// Unified's own sync — probably Python-based — writing str(None) instead
// of leaving the property blank), which Postgres correctly rejects as
// invalid date syntax rather than silently treating as empty. Screens out
// that and other common "no value" sentinels defensively.
const NULL_SENTINELS = new Set(['none', 'null', 'nat', 'n/a', 'nan', 'undefined']);
function toDateOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  if (NULL_SENTINELS.has(String(val).trim().toLowerCase())) return null;
  return val;
}
