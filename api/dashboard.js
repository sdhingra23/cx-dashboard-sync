// GET /api/dashboard
// Returns all accounts from Supabase with latest computed fields.
// No heavy logic — everything is pre-computed by the sync script.

import { createClient } from '@supabase/supabase-js';

const PAGE = 500;

// Supabase PostgREST caps responses at db-max-rows (default 1,000), so a
// full table read has to be paginated. Fetching pages one at a time in a
// while-loop means N sequential network round trips — with the function's
// 10s ceiling (vercel.json), that adds up fast as the accounts table grows
// (e.g. after the Chargebee migration added more rows) or when a second
// paginated query runs after the first. This gets the total row count up
// front, then fires every page request concurrently instead.
//
// postgrest-js query builders aren't reusable (no public .clone(), and
// filter/order methods only exist on the builder .select() returns — not on
// the bare .from() result), so `buildQuery` is a factory called fresh for
// the count and for every page. It must apply .select(cols, opts) itself —
// opts is {count:'exact', head:true} for the count check, undefined for a
// real page fetch — and chain any filters/order after that.
async function fetchAllPaginated(buildQuery) {
  const { count, error: countErr } = await buildQuery({ count: 'exact', head: true });
  if (countErr) throw countErr;

  const totalPages = Math.max(1, Math.ceil((count || 0) / PAGE));
  const pagePromises = [];
  for (let page = 0; page < totalPages; page++) {
    const from = page * PAGE;
    pagePromises.push(buildQuery().range(from, from + PAGE - 1));
  }

  const results = await Promise.all(pagePromises);
  let all = [];
  for (const { data: rows, error } of results) {
    if (error) throw error;
    all = all.concat(rows || []);
  }
  return all;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const data = await fetchAllPaginated(opts => sb.from('accounts').select('*', opts).order('account_name', { ascending: true }));

    // Build the shape the frontend expects:
    //   { accounts: { [account_name]: accountObj }, vpData: {...} }
    // Keyed by account_name (primary key). account_id (Chargebee ID) is a
    // plain field used only for the Chargebee deep-link URL.
    const accounts = {};
    let totalManagedArr = 0;
    let revenueInRed    = 0;
    const amStats = {};

    for (const acc of data) {
      const key = acc.account_name;
      accounts[key] = {
        ...acc,
        // Front-end compat aliases
        ae:          acc.account_manager || 'Unassigned',
        has_balance: (acc.outstanding_balance || 0) > 0,
        // Chargebee deep-link still uses the Chargebee account_id column
        chargebee_url: acc.account_id
          ? `https://higherme.chargebee.com/customers/${acc.account_id}`
          : null,
        // NPS convenience aliases for front-end display
        nps_score:   acc.nps_latest_score,
        nps_band:    acc.nps_latest_band,
        // Pendo engagement
        pendo_last_active_display: acc.pendo_last_active || null,
      };

      const arr      = acc.arr || 0;
      const ae       = acc.account_manager;
      const isRed    = acc.health_status === 'red' || (acc.outstanding_balance || 0) > 0;
      // acc.is_managed is the real column (false for "Unassigned") —
      // Boolean(ae) would always be true since account_manager defaults to
      // the string 'Unassigned' rather than null.
      const isManaged = acc.is_managed === true;

      if (isManaged) {
        totalManagedArr += arr;
        if (isRed) revenueInRed += arr;

        if (!amStats[ae]) amStats[ae] = { redArr: 0, zeroRoiCount: 0 };
        if (isRed) amStats[ae].redArr += arr;
        if (acc.is_zero_roi) amStats[ae].zeroRoiCount += 1;
      }
    }

    // ── Brand rollup (grouped by Chargebee's cf_parent_brand) ─────────
    // Every account tagged to the same brand rolls up into one summary —
    // scale, ARR split, health distribution, and adoption/gap rates across
    // the whole brand, same shape the Brand Dashboard UI already renders.
    const brandGroups = {};
    for (const acc of data) {
      const brandName = acc.parent_brand;
      if (!brandName) continue; // independent accounts aren't part of a brand
      (brandGroups[brandName] ||= []).push(acc);
    }

    const brands = {};
    for (const [brandName, accs] of Object.entries(brandGroups)) {
      const totalArr = accs.reduce((s, a) => s + (a.arr || 0), 0);
      const managedAccs = accs.filter(a => a.is_managed === true);
      const managedArr = managedAccs.reduce((s, a) => s + (a.arr || 0), 0);

      const sumArrWhere = status => accs.filter(a => a.health_status === status).reduce((s, a) => s + (a.arr || 0), 0);

      const createDates = accs.map(a => a.create_date).filter(Boolean).sort();
      const customerSince = createDates.length ? createDates[0].slice(0, 4) : '—'; // year only

      brands[brandName] = {
        name:            brandName,
        logo:            null,
        franchiseeCount: accs.length,
        totalArr,
        managedArr,
        unmanagedArr:    totalArr - managedArr,
        redArr:          sumArrWhere('red'),
        amberArr:        sumArrWhere('amber'),
        greenArr:        sumArrWhere('green'),
        customerSince,
        franchisees: accs.map(a => ({
          id:                        a.account_name,
          account_name:              a.account_name,
          arr:                       a.arr || 0,
          health_status:             a.health_status,
          health_score:              a.health_score,
          perc_locs_no_indeed:       a.perc_locs_no_indeed,
          perc_locs_no_active_jobs:  a.perc_locs_no_active_jobs,
          perc_locs_no_job_boosts:   a.perc_locs_no_job_boosts,
          perc_jobs_no_perks:        a.perc_jobs_no_perks,
          perc_jobs_no_salaries:     a.perc_jobs_no_salaries,
          perc_locs_no_tta:          a.perc_locs_no_tta,
          nextmatch_calls_90d:       a.nextmatch_calls_90d,
          onboarding_enabled:        a.onboarding_enabled,
          linkedin_enabled:          a.linkedin_enabled,
          primary_risk:              null, // no per-account "primary risk" label computed yet
        })),
      };
    }

    return res.status(200).json({
      accounts,
      vpData: {
        totalManagedArr,
        revenueInRed,
        amStats,
      },
      brands,
    });
  } catch (err) {
    console.error('/api/dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
