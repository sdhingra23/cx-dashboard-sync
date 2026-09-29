#!/usr/bin/env node
// ============================================================
// CHECK SPOOKY / JATON DUPLICATE ACCOUNT
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// "Dunkin Donuts Spooky Donuts LLC" (hm_account_id 11672) and "Dunkin
// Jaton Mgmt Co LLC" (hm_account_id 8727) show identical ARR ($16,074)
// and identical create_date (2021-12-12) on the dashboard — very unlikely
// to be a coincidence. User suspects HigherMe has multiple Company
// records under one real business, and Project Unified is faithfully
// mirroring that split into two separate HM Accounts. This dumps each
// account's associated HM Companies, Locations, and Subscription
// customer_id to confirm (or rule out) that hypothesis before any manual
// merge happens in HubSpot.
//
// Usage:
//   HUBSPOT_API_KEY=xxx node scripts/check-spooky-jaton.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY.'); process.exit(1); }

  const schemas = (await request(`${HUBSPOT_BASE}/crm/v3/schemas`, hsKey)).results || [];
  const accountSchema = schemas.find(s => /hm account|hm_account/i.test(`${s.labels?.singular || ''} ${s.name || ''}`));
  const companySchema = schemas.find(s => /hm company|hm_compan/i.test(`${s.labels?.singular || ''} ${s.name || ''}`));
  const locationSchema = schemas.find(s => /^location|h_locations/i.test(`${s.labels?.singular || ''} ${s.name || ''}`));
  const subSchema = schemas.find(s => /subscription/i.test(`${s.labels?.singular || ''} ${s.name || ''}`));

  const accountProps = ['hm_account_id', 'hm_account_name', 'hm_total_mrr', 'hm_started_at', 'hm_subscription_ids', 'hm_chargebee_status'];
  const accounts = await fetchAll(hsKey, accountSchema.objectTypeId, accountProps);
  const targets = accounts.filter(a => /spooky|jaton/i.test(a.properties.hm_account_name || ''));

  for (const acc of targets) {
    console.log(`\n=== ${acc.properties.hm_account_name} (hs id ${acc.id}, hm_account_id ${acc.properties.hm_account_id}) ===`);
    console.log(`  mrr=${acc.properties.hm_total_mrr}  started_at=${acc.properties.hm_started_at}  status=${acc.properties.hm_chargebee_status}  subscription_ids=${acc.properties.hm_subscription_ids}`);

    const companyIds = await fetchAssociations(hsKey, accountSchema.objectTypeId, companySchema.objectTypeId, acc.id);
    console.log(`  Associated HM Companies: ${companyIds.length} — ${companyIds.join(', ')}`);

    let totalLocations = 0;
    for (const compId of companyIds) {
      const locIds = await fetchAssociations(hsKey, companySchema.objectTypeId, locationSchema.objectTypeId, compId);
      totalLocations += locIds.length;
      console.log(`    Company ${compId}: ${locIds.length} location(s)`);
    }
    console.log(`  Total locations across all associated companies: ${totalLocations}`);

    // Resolve subscription_ids -> raw Chargebee customer_id via the Subscription object
    const subIds = (acc.properties.hm_subscription_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const subId of subIds) {
      const subs = await fetchAll(hsKey, subSchema.objectTypeId, ['subscription_id', 'customer_id', 'chargebee_customer_brand']);
      const match = subs.find(s => s.properties.subscription_id === subId);
      if (match) {
        console.log(`  Subscription ${subId} -> chargebee customer_id=${match.properties.customer_id}  brand=${match.properties.chargebee_customer_brand}`);
      } else {
        console.log(`  Subscription ${subId} -> not found in Subscription object`);
      }
    }
  }
}

async function fetchAssociations(hsKey, fromType, toType, fromId) {
  const res = await request(`${HUBSPOT_BASE}/crm/v4/associations/${fromType}/${toType}/batch/read`, hsKey, {
    method: 'POST',
    body: JSON.stringify({ inputs: [{ id: fromId }] }),
  });
  const result = (res.results || [])[0];
  return (result?.to || []).map(t => String(t.toObjectId));
}

async function fetchAll(hsKey, objectType, propertyNames) {
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

async function request(url, hsKey, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
