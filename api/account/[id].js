// GET /api/account/[id]
// [id] is the URL-encoded account_name (primary key).
// Returns a single account with NPS history from the snapshots table.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'account_name required' });

  const accountName = decodeURIComponent(id);

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const [{ data: acc, error: e1 }, { data: snaps, error: e2 }, { data: responses, error: e3 }] =
      await Promise.all([
        sb.from('accounts').select('*').eq('account_name', accountName).single(),
        sb.from('snapshots')
            .select('snapshot_date, nps_score, nps_band, health_score, health_status, arr, is_zero_roi, outstanding_balance')
            .eq('account_name', accountName)
            .order('snapshot_date', { ascending: false })
            .limit(90),
        sb.from('nps_responses')
            .select('response_date, score, verbatim')
            .eq('account_name', accountName)
            .order('response_date', { ascending: false })
            .limit(50),
      ]);

    if (e1) throw e1;
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    return res.status(200).json({
      account:    { ...acc, has_balance: (acc.outstanding_balance || 0) > 0 },
      history:    snaps    || [],
      npsHistory: responses || [],
    });
  } catch (err) {
    console.error(`/api/account/${accountName} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
