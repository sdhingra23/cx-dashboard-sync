#!/usr/bin/env node
// ============================================================
// LIST SUBSCRIPTION OBJECT PROPERTIES
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// The Project Unified PRD says Subscriptions sync into HubSpot via a
// direct native Chargebee connection (separate from Project Unified
// itself), and HM Account associates to those Subscription records via
// hm_subscription_ids. If that native Subscription object carries the raw
// Chargebee customer id directly, that's a cleaner, more exact join
// between Chargebee and HubSpot than fuzzy name-matching — worth checking
// before committing to any particular join strategy.
//
// Usage:
//   HUBSPOT_API_KEY=xxx node scripts/list-subscription-object.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY.'); process.exit(1); }

  const schemas = (await request(`${HUBSPOT_BASE}/crm/v3/schemas`, hsKey)).results || [];
  console.log('── All custom object schemas ─────────────────────────────────');
  for (const s of schemas) {
    console.log(`  objectTypeId=${s.objectTypeId}  name=${s.name}  singular="${s.labels?.singular}"  plural="${s.labels?.plural}"`);
  }

  const subSchema = schemas.find(s => /subscription/i.test(`${s.labels?.singular || ''} ${s.name || ''}`));
  if (!subSchema) {
    console.log('\nNo custom object schema matching "subscription" found — it may be a native object (deals/line items) instead of a custom one.');
    return;
  }

  console.log(`\n── Properties on ${subSchema.name} (objectTypeId=${subSchema.objectTypeId}) ─────`);
  const props = (await request(`${HUBSPOT_BASE}/crm/v3/properties/${subSchema.objectTypeId}`, hsKey)).results || [];
  for (const p of props.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${p.name}  |  label="${p.label}"  |  type=${p.type}/${p.fieldType}`);
  }

  console.log('\n── Sample record: search for "AzZcmGTWbJ1FxV7Z" (White Castle sub id) ─');
  const allProps = props.map(p => p.name);
  const results = await fetchAllHsObjects(hsKey, subSchema.objectTypeId, allProps);
  const match = results.find(r => JSON.stringify(r.properties).includes('AzZcmGTWbJ1FxV7Z'));
  if (match) {
    console.log(`  Record id: ${match.id}`);
    for (const [k, v] of Object.entries(match.properties)) {
      if (v !== null && v !== '') console.log(`    ${k} = ${JSON.stringify(v)}`);
    }
  } else {
    console.log('  Not found by that subscription id string. Total subscription records:', results.length);
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
