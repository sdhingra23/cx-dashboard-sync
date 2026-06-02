// ============================================================
// SUPABASE HELPERS
//
// All Supabase reads/writes live here.
// Uses the service-role key — never exposed to the browser.
// ============================================================

import { createClient } from '@supabase/supabase-js';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set.');
  return createClient(url, key);
}

// ── Accounts ─────────────────────────────────────────────────

/**
 * Upsert an array of account objects (keyed by account_name).
 * Any existing row with the same account_name is updated.
 */
export async function upsertAccounts(accounts) {
  if (!accounts.length) return;
  const sb = client();
  const { error } = await sb
    .from('accounts')
    .upsert(accounts, { onConflict: 'account_name' });
  if (error) throw new Error(`upsertAccounts: ${error.message}`);
  console.log(`Supabase: upserted ${accounts.length} accounts`);
}

/**
 * Fetch all accounts — returns array of account rows.
 */
export async function getAllAccounts() {
  const sb = client();
  const { data, error } = await sb.from('accounts').select('*');
  if (error) throw new Error(`getAllAccounts: ${error.message}`);
  return data;
}

/**
 * Fetch a single account by account_name with NPS history from snapshots.
 */
export async function getAccountWithHistory(accountName) {
  const sb = client();
  const [{ data: acc, error: e1 }, { data: snaps, error: e2 }] = await Promise.all([
    sb.from('accounts').select('*').eq('account_name', accountName).single(),
    sb.from('snapshots')
        .select('snapshot_date, nps_score, nps_band, health_score, arr, is_zero_roi, outstanding_balance')
        .eq('account_name', accountName)
        .order('snapshot_date', { ascending: false })
        .limit(90),
  ]);
  if (e1) throw new Error(`getAccountWithHistory: ${e1.message}`);
  return { account: acc, history: snaps || [] };
}

// ── Snapshots ─────────────────────────────────────────────────

/**
 * Save daily snapshot rows. Uses upsert so re-runs on the same day
 * overwrite rather than duplicate (unique constraint: account_id, snapshot_date).
 */
export async function saveSnapshots(snapshots) {
  if (!snapshots.length) return;
  const sb = client();
  const { error } = await sb
    .from('snapshots')
    .upsert(snapshots, { onConflict: 'account_name,snapshot_date' });
  if (error) throw new Error(`saveSnapshots: ${error.message}`);
  console.log(`Supabase: saved ${snapshots.length} snapshots`);
}

/**
 * Fetch yesterday's snapshot for all accounts.
 * Returns a map: { account_id: snapshotRow }
 */
export async function getYesterdaySnapshots() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  const sb = client();
  const { data, error } = await sb
    .from('snapshots')
    .select('*')
    .eq('snapshot_date', dateStr);
  if (error) throw new Error(`getYesterdaySnapshots: ${error.message}`);

  const map = {};
  for (const row of (data || [])) map[row.account_name] = row;
  return map;
}

/**
 * Fetch all snapshots for a given date range.
 * Returns array of snapshot rows.
 */
export async function getSnapshotRange(fromDate, toDate) {
  const sb = client();
  const { data, error } = await sb
    .from('snapshots')
    .select('*')
    .gte('snapshot_date', fromDate)
    .lte('snapshot_date', toDate);
  if (error) throw new Error(`getSnapshotRange: ${error.message}`);
  return data || [];
}

// ── NPS Responses ─────────────────────────────────────────────

/**
 * Upsert NPS responses from Pendo.
 * Conflicts on (pendo_visitor_id, response_date) are ignored (do nothing).
 */
export async function upsertNpsResponses(responses) {
  if (!responses.length) return;
  const sb = client();
  const rows = responses.map(r => ({
    account_name:     r.account_name || null,
    response_date:    r.response_date,
    score:            r.score,
    verbatim:         r.verbatim || null,
    pendo_visitor_id: r.pendo_visitor_id || null,
  }));
  const { error } = await sb
    .from('nps_responses')
    .upsert(rows, { onConflict: 'pendo_visitor_id,response_date', ignoreDuplicates: true });
  if (error) throw new Error(`upsertNpsResponses: ${error.message}`);
  console.log(`Supabase: upserted ${responses.length} NPS responses`);
}

/**
 * Fetch NPS responses within a date range.
 */
export async function getNpsResponseRange(fromDate, toDate) {
  const sb = client();
  const { data, error } = await sb
    .from('nps_responses')
    .select('*')
    .gte('response_date', fromDate)
    .lte('response_date', toDate);
  if (error) throw new Error(`getNpsResponseRange: ${error.message}`);
  return data || [];
}

// ── Escalations ───────────────────────────────────────────────

export async function insertEscalation(row) {
  const sb = client();
  const { data, error } = await sb.from('escalations').insert(row).select().single();
  if (error) throw new Error(`insertEscalation: ${error.message}`);
  return data;
}

// ── Gut Scores ────────────────────────────────────────────────

export async function insertGutScore(row) {
  const sb = client();
  const { data, error } = await sb.from('gut_scores').insert(row).select().single();
  if (error) throw new Error(`insertGutScore: ${error.message}`);
  return data;
}
