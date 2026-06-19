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

// Supabase PostgREST caps responses at db-max-rows (default 1,000).
// This helper pages through in 500-row increments so callers always
// get the complete result set regardless of the project's row cap.
async function paginateAll(table, select, extraQuery) {
  const PAGE = 500;
  const sb = client();
  let all = [];
  let page = 0;
  while (true) {
    const from = page * PAGE;
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (extraQuery) q = extraQuery(q);
    const { data, error } = await q;
    if (error) throw new Error(`paginateAll(${table}): ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    page++;
  }
  return all;
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
  return paginateAll('accounts', '*');
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
    .eq('snapshot_date', dateStr)
    .limit(10000);
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
    .lte('snapshot_date', toDate)
    .limit(100000);
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

// ── Stale account cleanup ─────────────────────────────────────

/**
 * Delete accounts (and their snapshots) that are no longer in the CSV.
 * Only runs if currentNames has a reasonable count — guards against
 * accidental wipe if the CSV fails to load.
 */
export async function deleteStaleAccounts(currentNames) {
  if (currentNames.length < 10) {
    console.warn(`deleteStaleAccounts: only ${currentNames.length} accounts in CSV — skipping deletion as a safety guard.`);
    return;
  }
  const sb = client();
  const existingRows = await paginateAll('accounts', 'account_name');
  const existing = existingRows;

  const currentSet = new Set(currentNames);
  const toDelete   = (existing || []).map(r => r.account_name).filter(n => !currentSet.has(n));

  if (toDelete.length === 0) {
    console.log('deleteStaleAccounts: nothing to prune.');
    return;
  }

  // Delete snapshots first (FK constraint)
  const { error: snapErr } = await sb.from('snapshots').delete().in('account_name', toDelete);
  if (snapErr) throw new Error(`deleteStaleAccounts snapshots: ${snapErr.message}`);

  const { error: accErr } = await sb.from('accounts').delete().in('account_name', toDelete);
  if (accErr) throw new Error(`deleteStaleAccounts accounts: ${accErr.message}`);

  console.log(`deleteStaleAccounts: removed ${toDelete.length} stale accounts — ${toDelete.join(', ')}`);
}

// ── Escalations ───────────────────────────────────────────────

export async function insertEscalation(row) {
  const sb = client();
  const { data, error } = await sb.from('escalations').insert(row).select().single();
  if (error) throw new Error(`insertEscalation: ${error.message}`);
  return data;
}

/**
 * Fetch escalation notes created in the last 24 hours.
 * Used by the daily sync to post Slack alerts for newly added escalations.
 */
export async function getRecentEscalations() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sb = client();
  const { data, error } = await sb
    .from('escalations')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getRecentEscalations: ${error.message}`);
  return data || [];
}

// ── Gut Scores ────────────────────────────────────────────────

export async function insertGutScore(row) {
  const sb = client();
  const { data, error } = await sb.from('gut_scores').insert(row).select().single();
  if (error) throw new Error(`insertGutScore: ${error.message}`);
  return data;
}
