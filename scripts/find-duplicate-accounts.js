#!/usr/bin/env node
// ============================================================
// FIND DUPLICATE ACCOUNTS
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Tests two things about why the same real-world account can show up as
// multiple separate rows on the dashboard:
//
//  1. ID-shape hypothesis: does a "wrong" duplicate customer record
//     correlate with having a Chargebee auto-generated (random alphanumeric)
//     ID rather than a short numeric one (the signature of a legacy/import
//     ID carried over from a prior billing system)?
//  2. Name-collision scan: groups active, paying customers by a LOOSELY
//     normalized company name (case-folded, quote-style normalized, legal
//     suffixes stripped, whitespace collapsed) to surface near-duplicate
//     company names that our actual dashboard grouping (exact match after
//     a bare .trim()) would NOT catch and would currently show as separate
//     accounts.
//
// For every such near-duplicate group, reports each member's raw name,
// Chargebee customer ID, ARR, and whether the ID is numeric or
// Chargebee-generated — so the ID-shape hypothesis can be checked against
// real numbers instead of two examples.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/find-duplicate-accounts.js
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) {
    console.error('Set CHARGEBEE_API_KEY in the environment first.');
    process.exit(1);
  }

  console.log('Fetching all active Chargebee customers (this scans the full book, not a sample)...\n');
  const customers = await fetchAllActiveCustomers(apiKey);
  console.log(`Fetched ${customers.length} active customers.\n`);

  // ── Same filter production applies (lib/chargebee.js: skip $0 MRR) ────
  const paying = customers.filter(c => c.mrr && c.mrr > 0);
  console.log(`${paying.length} of those are paying (mrr > 0) — this is the set that actually reaches the dashboard.\n`);

  // ── 1. ID-shape baseline across the whole paying book ──────────────────
  const numericPaying = paying.filter(c => isNumericId(c.id));
  const autoGenPaying = paying.filter(c => !isNumericId(c.id));
  console.log('── ID shape, all paying customers ──────────────────────────');
  console.log(`  Numeric ID (legacy/import-style):     ${numericPaying.length} (${pct(numericPaying.length, paying.length)})`);
  console.log(`  Chargebee auto-generated ID:           ${autoGenPaying.length} (${pct(autoGenPaying.length, paying.length)})`);
  console.log('');

  // ── 2. Near-duplicate name groups ───────────────────────────────────────
  const groups = new Map(); // looseKey -> [customer, ...]
  for (const c of paying) {
    const rawName = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    if (!rawName) continue;
    const key = looseNormalize(rawName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, _rawName: rawName });
  }

  // Only groups where the EXACT (production) name differs across members —
  // those are the ones that currently show up as separate dashboard rows.
  // (A group where every member's raw name is byte-identical after a plain
  // .trim() already collapses into one account in production — not a bug.)
  const dupGroups = [...groups.values()].filter(members => {
    const exactNames = new Set(members.map(m => m._rawName.trim()));
    return exactNames.size > 1;
  });

  console.log(`── Near-duplicate company-name groups ──────────────────────`);
  console.log(`${dupGroups.length} group(s) found — same real company, different exact spelling, so each currently gets its own dashboard row.\n`);

  let mixedFormatGroups = 0;
  let sameFormatGroups  = 0;

  for (const members of dupGroups.sort((a, b) => b.length - a.length)) {
    const idFormats = new Set(members.map(m => isNumericId(m.id) ? 'numeric' : 'auto'));
    const isMixed = idFormats.size > 1;
    if (isMixed) mixedFormatGroups++; else sameFormatGroups++;

    console.log(`  ${isMixed ? '⚠️  MIXED ID FORMAT' : '   same ID format'} — "${members[0]._rawName}" family (${members.length} records)`);
    for (const m of members) {
      const idType = isNumericId(m.id) ? 'numeric' : 'auto-gen';
      const arr = ((m.mrr || 0) / 100 * 12).toFixed(0);
      console.log(`      [${idType.padEnd(8)}] id=${m.id.padEnd(20)} name="${m._rawName}"  ARR=$${arr}`);
    }
    console.log('');
  }

  console.log('── Hypothesis check ─────────────────────────────────────────');
  console.log(`  Near-duplicate groups with mixed ID format (1 numeric + 1+ auto-gen): ${mixedFormatGroups}`);
  console.log(`  Near-duplicate groups with same ID format on all sides:               ${sameFormatGroups}`);
  if (dupGroups.length > 0) {
    console.log(`  → ${pct(mixedFormatGroups, dupGroups.length)} of near-duplicate groups are mixed-format.`);
    console.log(`    Compare against the ${pct(autoGenPaying.length, paying.length)} auto-gen baseline above —`);
    console.log(`    if mixed-format groups are much more common than the baseline rate,`);
    console.log(`    that's real correlation, not coincidence.`);
  }
  console.log('');
}

async function fetchAllActiveCustomers(apiKey) {
  const results = [];
  let offset = null;
  do {
    const params = { 'status[is]': 'active', limit: String(PAGE_SIZE) };
    if (offset) params.offset = offset;
    const url = buildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers`, params);
    const res = await request(url, apiKey);
    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) await sleep(300);
  } while (offset);
  return results;
}

function isNumericId(id) {
  return /^\d+$/.test(String(id));
}

// Case-fold, normalize curly quotes to straight, strip common legal
// suffixes and punctuation, collapse whitespace. Deliberately looser than
// production's normalizeName() (which only trims) — this is for surfacing
// candidates for a human to review, not for driving the actual dashboard.
function looseNormalize(name) {
  return String(name)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|ltd|company)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pct(n, total) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function buildUrl(base, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

async function request(url, apiKey) {
  const headers = {
    Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
    Accept: 'application/json',
  };
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Chargebee ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
