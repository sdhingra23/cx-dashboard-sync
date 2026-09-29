#!/usr/bin/env node
// ============================================================
// CHECK NAME MISMATCH
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Compares a specific Chargebee customer's `company` field against its
// matching HM Account's `hm_account_name`, to confirm (rather than assume)
// that cross-system text matching — not a data change — is why AM
// assignment stopped resolving for an account after the HubSpot migration.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx HUBSPOT_API_KEY=xxx node scripts/check-name-mismatch.js <chargebee_customer_id>
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const cbKey = process.env.CHARGEBEE_API_KEY;
  const hsKey = process.env.HUBSPOT_API_KEY;
  const customerId = process.argv[2];
  if (!cbKey || !hsKey) { console.error('Set CHARGEBEE_API_KEY and HUBSPOT_API_KEY.'); process.exit(1); }
  if (!customerId) { console.error('Usage: node scripts/check-name-mismatch.js <chargebee_customer_id>'); process.exit(1); }

  console.log(`── Chargebee customer ${customerId} ──────────────────────────`);
  const cbRes = await fetch(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers/${customerId}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(cbKey + ':').toString('base64'), Accept: 'application/json' },
  });
  const cbData = await cbRes.json();
  const c = cbData.customer || {};
  console.log(`  company:             ${JSON.stringify(c.company)}`);
  console.log(`  first_name/last_name: ${JSON.stringify(c.first_name)} / ${JSON.stringify(c.last_name)}`);
  console.log(`  cf_account_manager:  ${JSON.stringify(c.cf_account_manager)}`);
  console.log('');

  console.log('── Matching HM Account in HubSpot ────────────────────────────');
  const schemas = (await (await fetch(`${HUBSPOT_BASE}/crm/v3/schemas`, {
    headers: { Authorization: `Bearer ${hsKey}` },
  })).json()).results || [];
  const accountSchema = schemas.find(s => /hm account|hm_account/.test(`${s.labels?.singular || ''} ${s.name || ''}`.toLowerCase()));

  // Search HM Account by a token from the Chargebee company name — we don't
  // have a direct foreign key between the two systems, so this is the same
  // best-effort lookup a human would do.
  const token = (c.company || c.first_name || '').split(/\s+/)[0];
  const nameSearch = await (await fetch(`${HUBSPOT_BASE}/crm/v3/objects/${accountSchema.objectTypeId}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hm_account_name', operator: 'CONTAINS_TOKEN', value: token }] }],
      properties: ['hm_account_id', 'hm_account_name'],
      limit: 10,
    }),
  })).json();

  for (const r of nameSearch.results || []) {
    console.log(`  hm_account_id=${r.properties.hm_account_id}  hm_account_name=${JSON.stringify(r.properties.hm_account_name)}`);
  }
  console.log('');

  console.log('── Comparison ─────────────────────────────────────────────');
  console.log(`  Chargebee company: ${JSON.stringify(c.company)}`);
  for (const r of nameSearch.results || []) {
    const match = (c.company || '').trim() === (r.properties.hm_account_name || '').trim();
    console.log(`  vs. HubSpot "${r.properties.hm_account_name}": ${match ? '✓ EXACT MATCH' : '✗ different text'}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
