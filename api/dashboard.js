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

    const { data, error } = await sb
      .from('accounts')
      .select('*')
      .order('account_name', { ascending: true });

    if (error) throw error;

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
      const isManaged = Boolean(ae);

      if (isManaged) {
        totalManagedArr += arr;
        if (isRed) revenueInRed += arr;

        if (!amStats[ae]) amStats[ae] = { redArr: 0, zeroRoiCount: 0 };
        if (isRed) amStats[ae].redArr += arr;
        if (acc.is_zero_roi) amStats[ae].zeroRoiCount += 1;
      }
    }

    return res.status(200).json({
      accounts,
      vpData: {
        totalManagedArr,
        revenueInRed,
        amStats,
        history: [], // trend chart data — populated once snapshots accumulate
      },
      brands: {},   // brand rollup — can be populated from snapshots if needed
    });
  } catch (err) {
    console.error('/api/dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
