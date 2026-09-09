// GET /api/dashboard
// Returns all accounts from Supabase with latest computed fields.
// No heavy logic — everything is pre-computed by the sync script.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Supabase PostgREST caps responses at db-max-rows (default 1,000).
    // Paginate in 500-row pages to guarantee we retrieve all accounts.
    const PAGE = 500;
    let data = [];
    let page = 0;
    while (true) {
      const from = page * PAGE;
      const { data: rows, error } = await sb
        .from('accounts')
        .select('*')
        .order('account_name', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!rows || rows.length === 0) break;
      data = data.concat(rows);
      if (rows.length < PAGE) break;
      page++;
    }

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

    // ── Portfolio health trajectory (last 8 weeks) ────────────────────
    // One point per week: ARR summed by health tier across each account's
    // snapshot on that date. Sampled weekly (today, 7d ago, 14d ago, ...)
    // rather than scanning every daily snapshot in the range — cheaper, and
    // "Last 8 Weeks" only needs 8 points. A day sync happened to fail on one
    // of these exact sampled dates would show that week as all-zero rather
    // than falling back to the nearest available day; acceptable for a
    // trend chart, but worth knowing if a specific week looks suspiciously empty.
    const WEEKS_OF_HISTORY = 8;
    const weeklyDates = [];
    for (let i = WEEKS_OF_HISTORY - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i * 7);
      weeklyDates.push(d.toISOString().split('T')[0]);
    }

    let historySnaps = [];
    {
      let hPage = 0;
      while (true) {
        const from = hPage * PAGE;
        const { data: rows, error } = await sb
          .from('snapshots')
          .select('snapshot_date, arr, health_status')
          .in('snapshot_date', weeklyDates)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!rows || rows.length === 0) break;
        historySnaps = historySnaps.concat(rows);
        if (rows.length < PAGE) break;
        hPage++;
      }
    }

    const historyByDate = {};
    for (const s of historySnaps) {
      const bucket = historyByDate[s.snapshot_date] ||= { greenArr: 0, amberArr: 0, redArr: 0 };
      const arr = s.arr || 0;
      if (s.health_status === 'red') bucket.redArr += arr;
      else if (s.health_status === 'amber') bucket.amberArr += arr;
      else if (s.health_status === 'green') bucket.greenArr += arr;
    }

    const history = weeklyDates.map(dateStr => ({
      date: new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      ...(historyByDate[dateStr] || { greenArr: 0, amberArr: 0, redArr: 0 }),
    }));

    return res.status(200).json({
      accounts,
      vpData: {
        totalManagedArr,
        revenueInRed,
        amStats,
        history,
      },
      brands,
    });
  } catch (err) {
    console.error('/api/dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
