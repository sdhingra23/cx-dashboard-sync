// GET /api/locations?account=<account_name>
//   → { mode:'account', locations:[ …one row per location… ] }
//
// GET /api/locations?am=<account_manager>
//   → { mode:'am', totals, rollup:[…one row per account…], problems:[…capped…] }
//
// Populated daily from Metabase question 1513 by scripts/sync.js.
//
// The AM view aggregates server-side on purpose: a book of 20 accounts at a
// few hundred locations each is tens of thousands of rows, and the dashboard
// only ever draws per-account rollups plus a shortlist of problem locations.
// The single-account view returns full rows — its table needs them, and one
// account's location count is bounded.

import { createClient } from '@supabase/supabase-js';

const PAGE          = 1000;  // Supabase db-max-rows default
const PROBLEM_LIMIT = 200;

// Columns the AM rollup and problem list actually read — keeps the DB→function
// transfer small even though the function still scans every location.
const AM_COLUMNS = [
  'location_id', 'account_name', 'company_name', 'location_name',
  'published_jobs', 'total_apps_30d', 'indeed_status', 'has_boosted_30d',
  'jobs_no_salary', 'total_chats_30d', 'chats_employer_replied_30d',
  'active_job_count', 'applicant_count_30d',
].join(',');

// Fires every page request concurrently instead of awaiting one page at a
// time — a sequential while-loop adds up fast against the function's 10s
// ceiling (vercel.json) once an AM's book spans many accounts' worth of
// locations (e.g. after the Chargebee-enrichment fix correctly attributed
// far more accounts to real AMs instead of "Unassigned"). Same count-first,
// parallel-range approach as api/dashboard.js's fetchAllPaginated.
async function paginate(sb, columns, applyFilter) {
  const { count, error: countErr } = await applyFilter(sb.from('locations').select(columns, { count: 'exact', head: true }));
  if (countErr) throw countErr;

  const totalPages = Math.max(1, Math.ceil((count || 0) / PAGE));
  const pagePromises = [];
  for (let page = 0; page < totalPages; page++) {
    const from = page * PAGE;
    pagePromises.push(
      applyFilter(sb.from('locations').select(columns))
        .order('location_id', { ascending: true })
        .range(from, from + PAGE - 1)
    );
  }

  const results = await Promise.all(pagePromises);
  let all = [];
  for (const { data, error } of results) {
    if (error) throw error;
    all = all.concat(data || []);
  }
  return all;
}

// Metabase Q1513 doesn't cover every account's locations (a name-mismatch
// "hanging" gap); those arrive as HubSpot-only rows with published_jobs/
// total_apps_30d hardcoded to 0 — not "confirmed zero," just "Metabase has
// nothing here." Fall back to HubSpot's own active_job_count/
// applicant_count_30d so a location with real HubSpot activity isn't
// flagged dormant/no-apps. has_boosted_30d/indeed_status have no HubSpot
// equivalent, so a HubSpot-only row (company_name == null) can't be judged
// on those — treated as unknown rather than a false positive.
const hasMbData   = l => l.company_name != null;
const isDormant   = l => (l.published_jobs || 0) === 0 && (l.active_job_count    || 0) === 0;
const isNoApps    = l => (l.total_apps_30d || 0) === 0 && (l.applicant_count_30d || 0) === 0;
const isNoBoost   = l => hasMbData(l) && !l.has_boosted_30d;
const isIndeedOff = l => hasMbData(l) && String(l.indeed_status || '').trim().toLowerCase() !== 'enabled';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const account = req.query.account ? decodeURIComponent(req.query.account) : null;
  const am      = req.query.am      ? decodeURIComponent(req.query.am)      : null;

  if (!account && !am) {
    return res.status(400).json({ error: 'account or am query parameter required' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Single account: full rows ────────────────────────────
    if (account) {
      const locations = await paginate(sb, '*', q => q.eq('account_name', account));
      return res.status(200).json({ mode: 'account', locations });
    }

    // ── AM book: resolve their accounts, then aggregate ──────
    const { data: accts, error: acctErr } = await sb
      .from('accounts')
      .select('account_name, arr')
      .eq('account_manager', am);
    if (acctErr) throw acctErr;

    const names = (accts || []).map(a => a.account_name);
    if (names.length === 0) {
      return res.status(200).json({ mode: 'am', totals: emptyTotals(), rollup: [], problems: [], problemsTruncated: 0 });
    }

    const arrByAccount = Object.fromEntries((accts || []).map(a => [a.account_name, a.arr || 0]));

    // account_name travels in the query string — chunk it so a large book
    // doesn't overflow the URL.
    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < names.length; i += CHUNK) chunks.push(names.slice(i, i + CHUNK));
    const chunkResults = await Promise.all(
      chunks.map(chunk => paginate(sb, AM_COLUMNS, q => q.in('account_name', chunk)))
    );
    const rows = chunkResults.flat();

    const totals   = emptyTotals();
    const byAccount = {};
    const problems  = [];

    for (const l of rows) {
      const dormant = isDormant(l), noApps = isNoApps(l);

      totals.total++;
      if (dormant)        totals.dormant++;
      if (noApps)         totals.noApps++;
      if (isNoBoost(l))   totals.noBoost++;
      if (isIndeedOff(l)) totals.indeedOff++;
      totals.apps += l.total_apps_30d || 0;

      const key = l.account_name;
      if (!byAccount[key]) {
        byAccount[key] = { account_name: key, total: 0, dormant: 0, noApps: 0, noBoost: 0, apps: 0, arr: arrByAccount[key] || 0 };
      }
      const a = byAccount[key];
      a.total++;
      if (dormant)      a.dormant++;
      if (noApps)       a.noApps++;
      if (isNoBoost(l)) a.noBoost++;
      a.apps += l.total_apps_30d || 0;

      // Mix buckets for the portfolio doughnut. Counted explicitly rather than
      // derived from dormant/noApps: a location can have applications from a
      // job that has since been unpublished, so the two aren't nested.
      if (dormant)      totals.mixDormant++;
      else if (noApps)  totals.mixIdle++;
      else              totals.mixActive++;

      if (dormant || noApps) problems.push(l);
    }

    totals.accounts = Object.keys(byAccount).length;

    // Highest-ARR accounts first so the AM works the list in revenue order.
    problems.sort((x, y) =>
      ((arrByAccount[y.account_name] || 0) - (arrByAccount[x.account_name] || 0)) ||
      ((x.total_apps_30d || 0) - (y.total_apps_30d || 0))
    );

    return res.status(200).json({
      mode:     'am',
      totals,
      rollup:   Object.values(byAccount),
      problems: problems.slice(0, PROBLEM_LIMIT),
      problemsTruncated: Math.max(0, problems.length - PROBLEM_LIMIT),
    });
  } catch (err) {
    console.error('/api/locations error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function emptyTotals() {
  return { total: 0, dormant: 0, noApps: 0, noBoost: 0, indeedOff: 0, apps: 0, accounts: 0, mixActive: 0, mixIdle: 0, mixDormant: 0 };
}
