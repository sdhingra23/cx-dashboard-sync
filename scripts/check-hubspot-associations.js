#!/usr/bin/env node
// ============================================================
// CHECK HUBSPOT ASSOCIATIONS
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// None of HM Account/HM Company/HM Brand/Location's properties include a
// foreign key like hm_account_id on HM Company or hm_company_id on
// Location, so the relationship between them is presumably HubSpot's
// native object-association mechanism rather than a flat column. This
// picks one real HM Account, finds its associated HM Companies, and one of
// those companies' associated Locations, to confirm the mechanism and the
// association type IDs before building any real pipeline code on top of
// an assumption.
//
// Usage:
//   HUBSPOT_API_KEY=xxx node scripts/check-hubspot-associations.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY in the environment first.'); process.exit(1); }

  const schemas = (await hsRequest(hsKey, '/crm/v3/schemas')).results || [];
  const find = re => schemas.find(s => re.test(`${s.labels?.singular || ''} ${s.name || ''}`.toLowerCase()));
  const accountSchema  = find(/hm account|hm_account/);
  const companySchema  = find(/hm company|hm_compan/);
  const brandSchema    = find(/hm brand|hm_brand/);
  const locationSchema = find(/^location|h_locations/);

  console.log('Resolved object type IDs:');
  console.log(`  HM Account:  ${accountSchema?.objectTypeId}`);
  console.log(`  HM Company:  ${companySchema?.objectTypeId}`);
  console.log(`  HM Brand:    ${brandSchema?.objectTypeId}`);
  console.log(`  Location:    ${locationSchema?.objectTypeId}`);
  console.log('');

  // Grab one real HM Account with a non-trivial name to test against.
  const accounts = await hsRequest(hsKey, `/crm/v3/objects/${accountSchema.objectTypeId}?limit=5&properties=hm_account_id,hm_account_name`);
  const account = accounts.results?.[0];
  console.log(`Testing with HM Account: id=${account.id}, hm_account_name="${account.properties.hm_account_name}"`);
  console.log('');

  // ── Try the v4 associations endpoint: HM Account -> HM Company ────────
  console.log('── HM Account → HM Company associations ─────────────────────');
  try {
    const assoc = await hsRequest(hsKey, `/crm/v4/objects/${accountSchema.objectTypeId}/${account.id}/associations/${companySchema.objectTypeId}`);
    console.log(`  ✓ ${assoc.results?.length || 0} associated HM Company record(s):`, JSON.stringify(assoc.results, null, 2).slice(0, 500));

    if (assoc.results?.length > 0) {
      const companyId = assoc.results[0].toObjectId;
      const company = await hsRequest(hsKey, `/crm/v3/objects/${companySchema.objectTypeId}/${companyId}?properties=hm_company_id,hm_company_name,hm_has_netchex,hm_type,hm_usage`);
      console.log(`  Company details: ${JSON.stringify(company.properties, null, 2)}`);
      console.log('');

      // ── HM Company -> Location ──────────────────────────────────────
      console.log('── HM Company → Location associations ────────────────────────');
      try {
        const locAssoc = await hsRequest(hsKey, `/crm/v4/objects/${companySchema.objectTypeId}/${companyId}/associations/${locationSchema.objectTypeId}`);
        console.log(`  ✓ ${locAssoc.results?.length || 0} associated Location record(s)`);
        if (locAssoc.results?.length > 0) {
          const locId = locAssoc.results[0].toObjectId;
          const loc = await hsRequest(hsKey, `/crm/v3/objects/${locationSchema.objectTypeId}/${locId}?properties=location_id,location_name,hm_active_job_count,hm_applicant_count_30d,applications_new_last30days`);
          console.log(`  Location details: ${JSON.stringify(loc.properties, null, 2)}`);
        }
      } catch (e) {
        console.log(`  ⚠️  ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ${e.message}`);
  }
  console.log('');

  // ── HM Account -> HM Brand (spec says Account doesn't associate to
  // Brand directly — Company does — but worth checking) ─────────────────
  console.log('── HM Company → HM Brand associations ────────────────────────');
  try {
    const companies = await hsRequest(hsKey, `/crm/v3/objects/${companySchema.objectTypeId}?limit=1`);
    const companyId = companies.results?.[0]?.id;
    const brandAssoc = await hsRequest(hsKey, `/crm/v4/objects/${companySchema.objectTypeId}/${companyId}/associations/${brandSchema.objectTypeId}`);
    console.log(`  ✓ ${brandAssoc.results?.length || 0} associated HM Brand record(s) for company ${companyId}`);
  } catch (e) {
    console.log(`  ⚠️  ${e.message}`);
  }
}

async function hsRequest(hsKey, path) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).message || message; } catch { /* keep raw */ }
    throw new Error(`HTTP ${res.status} on ${path}: ${message}`);
  }
  return res.json();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
