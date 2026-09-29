#!/usr/bin/env node
// ============================================================
// CHECK NAME MISMATCH
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Searches both Chargebee and HubSpot by a name token and prints what each
// system actually has, side by side — a name typed into chat can be wrong
// (a stale ID, a misremembered spelling), so this looks a real search
// result up in both systems rather than trusting an assumed ID that might
// belong to the wrong namespace (e.g. HubSpot's own hm_account_id vs. a
// real Chargebee customer ID — a mistake made earlier in this
// investigation, worth avoiding a second time).
//
// Usage:
//   CHARGEBEE_API_KEY=xxx HUBSPOT_API_KEY=xxx node scripts/check-name-mismatch.js "<search term>"
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const HUBSPOT_BASE = 'https://api.hubapi.com';
const PAGE_SIZE = 100;

async function main() {
  const cbKey = process.env.CHARGEBEE_API_KEY;
  const hsKey = process.env.HUBSPOT_API_KEY;
  const term = (process.argv[2] || '').trim().toLowerCase();
  if (!cbKey || !hsKey) { console.error('Set CHARGEBEE_API_KEY and HUBSPOT_API_KEY.'); process.exit(1); }
  if (!term) { console.error('Usage: node scripts/check-name-mismatch.js "<search term>"'); process.exit(1); }

  console.log(`── Searching Chargebee (active customers) for "${term}" ────────`);
  const customers = await fetchAllActiveCustomers(cbKey);
  const cbMatches = customers.filter(c => {
    const name = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    return (name || '').toLowerCase().includes(term);
  });
  for (const c of cbMatches) {
    const name = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    console.log(`  id=${c.id}  company=${JSON.stringify(c.company)}  name="${name}"  mrr=${c.mrr}  cf_account_manager=${JSON.stringify(c.cf_account_manager)}`);
  }
  if (cbMatches.length === 0) console.log(`  No active Chargebee customer matches "${term}".`);
  console.log('');

  console.log(`── Searching HubSpot HM Account for "${term}" ───────────────────`);
  const schemas = (await request(`${HUBSPOT_BASE}/crm/v3/schemas`, { Authorization: `Bearer ${hsKey}` })).results || [];
  const accountSchema = schemas.find(s => /hm account|hm_account/.test(`${s.labels?.singular || ''} ${s.name || ''}`.toLowerCase()));
  if (!accountSchema) { console.error('Could not find the HM Account schema.'); process.exit(1); }

  const hsMatches = await fetchAllHsObjects(hsKey, accountSchema.objectTypeId, ['hm_account_id', 'hm_account_name', 'hm_chargebee_status', 'hm_total_mrr']);
  const hsFiltered = hsMatches.filter(a => (a.properties.hm_account_name || '').toLowerCase().includes(term));
  for (const a of hsFiltered) {
    const p = a.properties;
    console.log(`  hm_account_id=${p.hm_account_id}  hm_account_name=${JSON.stringify(p.hm_account_name)}  status=${p.hm_chargebee_status}  mrr=${p.hm_total_mrr}`);
  }
  if (hsFiltered.length === 0) console.log(`  No HM Account matches "${term}".`);
  console.log('');

  console.log('── Comparison ─────────────────────────────────────────────────');
  if (cbMatches.length === 0 || hsFiltered.length === 0) {
    console.log('  Cannot compare — at least one side had no match at all.');
    return;
  }
  for (const c of cbMatches) {
    for (const a of hsFiltered) {
      const cbName = (c.company || '').trim();
      const hsName = (a.properties.hm_account_name || '').trim();
      const match = cbName === hsName;
      console.log(`  Chargebee "${cbName}" (id=${c.id}) vs. HubSpot "${hsName}" (hm_account_id=${a.properties.hm_account_id}): ${match ? '✓ EXACT MATCH' : '✗ different text'}`);
    }
  }
}

async function fetchAllActiveCustomers(apiKey) {
  const results = [];
  let offset = null;
  do {
    const params = { 'status[is]': 'active', limit: String(PAGE_SIZE) };
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

async function fetchAllHsObjects(hsKey, objectType, propertyNames) {
  const results = [];
  let after = null;
  do {
    const params = new URLSearchParams({ limit: '100', properties: propertyNames.join(',') });
    if (after) params.set('after', after);
    const res = await request(`${HUBSPOT_BASE}/crm/v3/objects/${objectType}?${params.toString()}`, { Authorization: `Bearer ${hsKey}` });
    results.push(...(res.results || []));
    after = res.paging?.next?.after || null;
  } while (after);
  return results;
}

async function request(url, headers, init = {}) {
  const res = await fetch(url, { ...init, headers });
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
