#!/usr/bin/env node
// ============================================================
// LIST HM ACCOUNT PROPERTIES (full schema)
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// lib/hubspot.js only ever fetches a curated subset of HM Account
// properties. Before rearchitecting the sync around a "join on the raw
// Chargebee id" model, confirm whether HM Account actually carries a raw
// Chargebee customer id (external, alphanumeric, e.g. HtZEwUtQ2kIAW83zD)
// as its own property, separate from hm_account_id (which — per prior
// investigation — looks like HubSpot's own internal sequence, not
// Chargebee's external id). If Project Unified writes the real Chargebee
// id somewhere on this object, that's the correct join key going forward,
// not name-matching.
//
// Usage:
//   HUBSPOT_API_KEY=xxx node scripts/list-hm-account-properties.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY in the environment first.'); process.exit(1); }

  const schemas = (await request(`${HUBSPOT_BASE}/crm/v3/schemas`, hsKey)).results || [];
  const accountSchema = schemas.find(s => /hm account|hm_account/i.test(`${s.labels?.singular || ''} ${s.name || ''}`.toLowerCase()));
  if (!accountSchema) { console.error('Could not find the HM Account schema.'); process.exit(1); }

  console.log(`HM Account objectTypeId=${accountSchema.objectTypeId} name=${accountSchema.name}\n`);
  console.log('── All properties on HM Account ─────────────────────────────');
  const props = (await request(`${HUBSPOT_BASE}/crm/v3/properties/${accountSchema.objectTypeId}`, hsKey)).results || [];
  for (const p of props.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${p.name}  |  label="${p.label}"  |  type=${p.type}/${p.fieldType}`);
  }

  console.log('\n── Properties that look chargebee/id/external related ───────');
  const suspects = props.filter(p => /chargebee|cb_|external|customer_id|source_id|cb id/i.test(`${p.name} ${p.label}`));
  if (suspects.length === 0) {
    console.log('  None found. hm_account_id appears to be the only account-identifying field.');
  } else {
    for (const p of suspects) console.log(`  ${p.name}  |  label="${p.label}"`);
  }

  // Pull one real record (White Castle) and print every non-empty property, to see actual values.
  console.log('\n── Sample record: search for "white castle" and dump ALL properties ─');
  const allProps = props.map(p => p.name);
  const results = await fetchAllHsObjects(hsKey, accountSchema.objectTypeId, allProps);
  const match = results.find(r => (r.properties.hm_account_name || '').toLowerCase().includes('white castle'));
  if (match) {
    console.log(`  Record id (HubSpot object id): ${match.id}`);
    for (const [k, v] of Object.entries(match.properties)) {
      if (v !== null && v !== '') console.log(`    ${k} = ${JSON.stringify(v)}`);
    }
  } else {
    console.log('  No "white castle" record found.');
  }
}

async function fetchAllHsObjects(hsKey, objectType, propertyNames) {
  const results = [];
  let after = null;
  do {
    const params = new URLSearchParams({ limit: '100', properties: propertyNames.join(',') });
    if (after) params.set('after', after);
    const res = await request(`${HUBSPOT_BASE}/crm/v3/objects/${objectType}?${params.toString()}`, hsKey);
    results.push(...(res.results || []));
    after = res.paging?.next?.after || null;
  } while (after);
  return results;
}

async function request(url, hsKey) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${hsKey}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
