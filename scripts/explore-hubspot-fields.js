#!/usr/bin/env node
// ============================================================
// EXPLORE HUBSPOT FIELDS
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Inventories everything reachable with the current HubSpot token: every
// custom object schema (HM Account, HM Brands, whatever else exists) and
// its properties, the standard objects the token has scope for (Companies,
// Contacts, Deals), Owners, and Meetings specifically — since that's not
// covered by the scopes configured so far, this is expected to fail and
// should say exactly what scope would need to be added rather than fail
// silently.
//
// For each object, custom properties (hubspotDefined: false) are called
// out separately from HubSpot's own defaults — the custom ones are almost
// always the actually-useful business data for a CS dashboard; the
// defaults are mostly plumbing (hs_object_id, hs_created_by_user_id, etc.)
//
// Usage:
//   HUBSPOT_API_KEY=xxx node scripts/explore-hubspot-fields.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY in the environment first.'); process.exit(1); }

  console.log('══ Custom object schemas ═══════════════════════════════════════\n');
  const schemas = await hsRequest(hsKey, '/crm/v3/schemas');
  for (const s of schemas.results || []) {
    console.log(`── ${s.labels?.singular || s.name} (objectTypeId=${s.objectTypeId}, name=${s.name}) ──`);
    try {
      const props = await hsRequest(hsKey, `/crm/v3/properties/${s.objectTypeId}`);
      // The whole object is custom-built, so hubspotDefined doesn't mean
      // "not worth showing" the way it does on standard objects (Contacts/
      // Companies) — it apparently marks properties defined at schema-
      // creation time vs. added later via the UI, not built-in-vs-custom.
      // List everything here instead of filtering.
      reportProps(props.results, { isCustomObject: true });
    } catch (e) {
      console.log(`  ⚠️  Could not list properties: ${e.message}`);
    }
    console.log('');
  }

  console.log('══ Standard objects ════════════════════════════════════════════\n');
  for (const objType of ['companies', 'contacts', 'deals']) {
    console.log(`── ${objType} ──`);
    try {
      const props = await hsRequest(hsKey, `/crm/v3/properties/${objType}`);
      reportProps(props.results);
    } catch (e) {
      console.log(`  ⚠️  Not accessible: ${e.message}`);
    }
    console.log('');
  }

  console.log('══ Owners ══════════════════════════════════════════════════════\n');
  try {
    const owners = await hsRequest(hsKey, '/crm/v3/owners?limit=5');
    console.log(`  Accessible. Fields per owner: id, email, firstName, lastName, userId, teams, archived.`);
    console.log(`  Sample: ${(owners.results || []).slice(0, 3).map(o => o.email).join(', ')}`);
  } catch (e) {
    console.log(`  ⚠️  Not accessible: ${e.message}`);
  }
  console.log('');

  console.log('══ Meetings ════════════════════════════════════════════════════\n');
  console.log('Property definitions:');
  try {
    const props = await hsRequest(hsKey, '/crm/v3/properties/meetings');
    reportProps(props.results);
  } catch (e) {
    console.log(`  ⚠️  Not accessible: ${e.message}`);
  }
  console.log('Actual meeting records:');
  try {
    const meetings = await hsRequest(hsKey, '/crm/v3/objects/meetings?limit=1');
    console.log(`  ✓ Accessible — token can read meeting records.`);
    console.log(`  Sample record: ${JSON.stringify(meetings.results?.[0] || {}, null, 2).slice(0, 500)}`);
  } catch (e) {
    console.log(`  ⚠️  Not accessible: ${e.message}`);
    console.log('  Likely needs an additional scope (crm.objects.meetings.read or similar)');
    console.log('  not present on the current token — add it and re-run to check what\'s there.');
  }
  console.log('');
}

function reportProps(list, { isCustomObject = false } = {}) {
  if (!list || list.length === 0) { console.log('  (no properties)'); return; }

  if (isCustomObject) {
    // The whole object is a custom build — hubspotDefined isn't a useful
    // signal here (see caller comment). hs_-prefixed properties are still
    // internal plumbing regardless (hs_object_id, hs_created_by_user_id,
    // hs_all_owner_ids, ...), so those are the only ones filtered out.
    const business = list.filter(p => !p.name.startsWith('hs_'));
    const plumbing = list.length - business.length;
    console.log(`  ${list.length} total properties (${plumbing} internal hs_* fields omitted below)`);
    for (const p of business.sort((a, b) => (a.groupName || '').localeCompare(b.groupName || ''))) {
      console.log(`    ${p.name.padEnd(38)} "${p.label}"  [${p.type}/${p.fieldType}]${p.groupName ? ' — group: ' + p.groupName : ''}`);
    }
    return;
  }

  const custom = list.filter(p => p.hubspotDefined === false);
  const standard = list.filter(p => p.hubspotDefined !== false);
  console.log(`  ${list.length} total properties (${custom.length} custom, ${standard.length} standard/default — defaults omitted below)`);
  if (custom.length > 0) {
    for (const p of custom.sort((a, b) => (a.groupName || '').localeCompare(b.groupName || ''))) {
      console.log(`    ${p.name.padEnd(38)} "${p.label}"  [${p.type}/${p.fieldType}]${p.groupName ? ' — group: ' + p.groupName : ''}`);
    }
  } else {
    console.log('  (no custom properties on this object)');
  }
}

async function hsRequest(hsKey, path) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 200);
    try { message = JSON.parse(body).message || message; } catch { /* keep raw */ }
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return res.json();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
