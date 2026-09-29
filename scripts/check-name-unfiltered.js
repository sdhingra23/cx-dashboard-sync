#!/usr/bin/env node
// ============================================================
// CHECK NAME UNFILTERED
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// check-name-mismatch.js (and every other diagnostic so far) only ever
// fetched Chargebee customers with status[is]=active. If "White Castle"
// (plain, the Chargebee-UI-only id 7272) is a cancelled/paused/non-active
// duplicate that got superseded by "White Castle Corporate", it would be
// invisible to every prior check — not because it doesn't exist, but
// because the fetch itself filtered it out before we ever looked. This
// searches Chargebee with NO status filter at all.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/check-name-unfiltered.js "<search term>"
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  const term = (process.argv[2] || '').trim().toLowerCase();
  if (!apiKey) { console.error('Set CHARGEBEE_API_KEY.'); process.exit(1); }
  if (!term) { console.error('Usage: node scripts/check-name-unfiltered.js "<search term>"'); process.exit(1); }

  console.log(`── Fetching ALL Chargebee customers (no status filter) ──────`);
  const customers = await fetchAllCustomers(apiKey);
  console.log(`  Total customers fetched: ${customers.length}\n`);

  const matches = customers.filter(c => {
    const name = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    return (name || '').toLowerCase().includes(term);
  });

  console.log(`── Matches for "${term}" (any status) ────────────────────────`);
  for (const c of matches) {
    const name = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    console.log(`  id=${c.id}  company=${JSON.stringify(c.company)}  status=${c.status}  mrr=${c.mrr}  created_at=${c.created_at ? new Date(c.created_at * 1000).toISOString() : null}  cf_account_manager=${JSON.stringify(c.cf_account_manager)}`);
  }
  if (matches.length === 0) console.log(`  No matches at all, any status.`);
}

async function fetchAllCustomers(apiKey) {
  const results = [];
  let offset = null;
  do {
    const params = { limit: String(PAGE_SIZE) };
    if (offset) params.offset = offset;
    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const res = await request(
      `https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers?${qs}`,
      { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'), Accept: 'application/json' }
    );
    (res.list || []).forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) await sleep(300);
  } while (offset);
  return results;
}

async function request(url, headers) {
  const res = await fetch(url, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
