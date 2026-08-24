// ============================================================
// LOCATION DRILL-DOWN
//
// Metabase question 1513 returns one row per *location* — unlike every
// other configured question, which buildMetabaseData() collapses to one
// row per account. These rows are stored verbatim in the `locations`
// table so the dashboard can drill from an account down to its sites.
//
// buildLocationRows() maps raw Metabase rows onto the Supabase schema in
// sql/locations.sql, coercing Metabase's string-formatted numbers
// ("12,348") and empty-string dates into real numbers and nulls.
// ============================================================

import { normalizeName } from './normalize.js';

export const LOCATION_QUESTION_ID = 1513;

// ── Value coercion ───────────────────────────────────────────

/** "12,348" | 12348 | "" | null → 12348 | 0 */
function toInt(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Same as toInt but preserves "no value" as null rather than 0. */
function toIdOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(String(val).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Empty strings and unparseable dates become null rather than Invalid Date. */
function toTimestampOrNull(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Yes"/"No"/true/1 → boolean */
function toBool(val) {
  if (val === true || val === false) return val;
  if (val === null || val === undefined || val === '') return false;
  const s = String(val).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y';
}

// ── Row mapping ──────────────────────────────────────────────

/**
 * Build a lowercase/underscored lookup so we tolerate Metabase returning
 * display names ("Account ID") instead of raw column names ("account_id").
 */
function keyMap(row) {
  return Object.keys(row).reduce((m, k) => {
    m[k.toLowerCase().replace(/\s+/g, '_')] = k;
    return m;
  }, {});
}

function get(row, map, col) {
  const key = map[col];
  return key === undefined ? null : row[key];
}

/**
 * Map raw Q1513 rows → rows shaped for the `locations` table.
 *
 * Rows without a location_id are dropped (nothing to key on), as are rows
 * whose account isn't in the dashboard's account universe — the sync seeds
 * that universe from the AM assignments CSV, and a location belonging to no
 * known account can never be reached from the UI.
 *
 * @param {object[]} rows         — raw rows from mbRunQuestion(1513)
 * @param {Set<string>} knownNames — normalized account names to keep
 * @param {string} syncedAt        — ISO timestamp stamped on every row
 * @returns {{ rows: object[], skippedNoId: number, skippedUnknownAccount: string[] }}
 */
export function buildLocationRows(rows, knownNames, syncedAt) {
  const out                   = [];
  const seen                  = new Set();
  const skippedUnknownAccount = new Set();
  let   skippedNoId           = 0;

  for (const row of rows) {
    const map        = keyMap(row);
    const locationId = toIdOrNull(get(row, map, 'location_id'));
    if (locationId === null) { skippedNoId++; continue; }

    const accountName = normalizeName(get(row, map, 'account_name'));
    if (!accountName) { skippedNoId++; continue; }
    if (knownNames.size > 0 && !knownNames.has(accountName)) {
      skippedUnknownAccount.add(accountName);
      continue;
    }

    // Metabase can return the same location twice if the underlying query
    // fans out; the upsert would fail on a duplicate primary key in one batch.
    if (seen.has(locationId)) continue;
    seen.add(locationId);

    const indeedApps  = toInt(get(row, map, 'indeed_apps_30d'));
    const signageApps = toInt(get(row, map, 'signage_apps_30d'));

    out.push({
      location_id:                locationId,
      account_id:                 toIdOrNull(get(row, map, 'account_id')),
      account_name:               accountName,
      company_name:               get(row, map, 'company_name')  || null,
      location_name:              get(row, map, 'location_name') || null,

      boosts_30d:                 toInt(get(row, map, 'boosts_30d')),
      last_boost_at:              toTimestampOrNull(get(row, map, 'last_boost_at')),
      has_boosted_30d:            toBool(get(row, map, 'has_boosted_30d')),

      published_jobs:             toInt(get(row, map, 'published_jobs')),
      jobs_no_salary:             toInt(get(row, map, 'jobs_no_salary')),

      signage_apps_30d:           signageApps,
      last_signage_app_at:        toTimestampOrNull(get(row, map, 'last_signage_app_at')),
      indeed_status:              get(row, map, 'indeed_status') || null,
      indeed_apps_30d:            indeedApps,
      last_indeed_app_at:         toTimestampOrNull(get(row, map, 'last_indeed_app_at')),
      total_apps_30d:             indeedApps + signageApps,

      screenings_requested_30d:   toInt(get(row, map, 'screenings_requested_30d')),
      screenings_completed_30d:   toInt(get(row, map, 'screenings_completed_30d')),
      screenings_expired_30d:     toInt(get(row, map, 'screenings_expired_30d')),

      total_chats_30d:            toInt(get(row, map, 'total_chats_30d')),
      chats_employer_replied_30d: toInt(get(row, map, 'chats_employer_replied_30d')),
      two_way_chats_30d:          toInt(get(row, map, 'two_way_chats_30d')),

      last_synced:                syncedAt,
    });
  }

  return {
    rows: out,
    skippedNoId,
    skippedUnknownAccount: [...skippedUnknownAccount],
  };
}

/**
 * Roll location rows up to the per-account configuration signals the health
 * score needs.
 *
 * These exist because the account-level Metabase percentages are all
 * outcome-based: perc_locs_no_indeed counts locations with no Indeed
 * *applications*, so it spikes every off-season even when nothing is
 * misconfigured. Scoring readiness on it reintroduced seasonality through the
 * back door. These aggregates instead measure configuration on the locations
 * that actually have jobs posted, and return null when none do — so an
 * account between hiring pushes is scored as "unknown", not "broken".
 *
 * @param {object[]} rows — output of buildLocationRows()
 * @returns {{ [accountName: string]: object }}
 */
export function buildLocationConfigByAccount(rows) {
  const acc = {};

  for (const l of rows) {
    const a = acc[l.account_name] || (acc[l.account_name] = {
      loc_total: 0, loc_active: 0, loc_active_indeed_off: 0,
      loc_active_no_apps: 0, loc_jobs_no_salary: 0,
    });

    a.loc_total++;
    if (l.published_jobs > 0) {
      a.loc_active++;
      if (String(l.indeed_status || '').trim().toLowerCase() !== 'enabled') a.loc_active_indeed_off++;
      if ((l.total_apps_30d || 0) === 0) a.loc_active_no_apps++;
    }
    if ((l.jobs_no_salary || 0) > 0) a.loc_jobs_no_salary++;
  }

  const out = {};
  for (const [name, a] of Object.entries(acc)) {
    out[name] = {
      loc_total:  a.loc_total,
      loc_active: a.loc_active,
      // Config quality, measured only where jobs are actually posted.
      perc_active_locs_indeed_off: a.loc_active > 0
        ? Math.round((a.loc_active_indeed_off / a.loc_active) * 1000) / 10
        : null,
      // Posted a job and still got nothing — a real problem in any season,
      // unlike "has no job posted", which is a business decision.
      perc_active_locs_no_apps: a.loc_active > 0
        ? Math.round((a.loc_active_no_apps / a.loc_active) * 1000) / 10
        : null,
    };
  }
  return out;
}
