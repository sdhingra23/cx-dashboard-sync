// POST /api/gut-score
// Writes a CX manual gut score to the gut_scores table.
//
// Body: { account_name, score, notes?, scored_by? }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { account_name, score, notes, scored_by } = req.body || {};

  if (!account_name || score === undefined || score === null) {
    return res.status(400).json({ error: 'account_name and score are required' });
  }

  const numScore = Number(score);
  if (isNaN(numScore) || numScore < 0 || numScore > 10) {
    return res.status(400).json({ error: 'score must be a number between 0 and 10' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await sb
      .from('gut_scores')
      .insert({
        account_name,
        score:     numScore,
        notes:     notes     || null,
        scored_by: scored_by || null,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, gut_score: data });
  } catch (err) {
    console.error('/api/gut-score error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
