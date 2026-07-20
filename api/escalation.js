// POST /api/escalation
// Sets accounts.manual_escalation (the value the dashboard reads/displays
// and filters critical-account lists on), and logs the submission to
// escalations as a history/audit trail (also used for Slack alerting).
//
// Body: { account_name, flag_text, escalated_by? }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { account_name, flag_text, escalated_by } = req.body || {};

  if (!account_name || !flag_text) {
    return res.status(400).json({ error: 'account_name and flag_text are required' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error: updateError } = await sb
      .from('accounts')
      .update({ manual_escalation: flag_text })
      .eq('account_name', account_name);

    if (updateError) throw updateError;

    const { data, error } = await sb
      .from('escalations')
      .insert({ account_name, flag_text, escalated_by: escalated_by || null })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, escalation: data });
  } catch (err) {
    console.error('/api/escalation error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
