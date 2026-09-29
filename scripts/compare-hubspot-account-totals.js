#!/usr/bin/env node
// ============================================================
// COMPARE HUBSPOT ACCOUNT TOTALS
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// "Project Unified" (a separate HigherMe sync) pushes a canonical HM
// Account object to HubSpot, keyed by a real database Account ID rather
// than a fuzzy-matched Chargebee company name — each Account can span
// multiple Chargebee Subscriptions, with Chargebee's MRR/status already
// rolled up onto it via computed_account_stats.
//
// This pulls HM Account totals from HubSpot and Chargebee's own paying-
// customer totals in the same run, so the two numbers are directly
// comparable and not skewed by fetching them minutes apart. The goal is to
// see whether HM Account's rollup lines up with (or corrects) what our
// current Chargebee-company-name-matching pipeline produces, before
// migrating sync.js's account identity onto it.
//
// HubSpot's internal property names aren't in the spec (only human labels
// like "Total MRR"), so this discovers the HM Account schema and matches
// properties by label rather than guessing internal names.
//
// Usage:
//   HUBSPOT_API_KEY=xxx CHARGEBEE_API_KEY=xxx node scripts/compare-hubspot-account-totals.js
// ============================================================

const HUBSPOT_BASE = 'https://api.hubapi.com';
const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

// Label substrings we're looking for on the HM Account object — matched
// case-insensitively against each property's label, since we don't know
// the internal (snake_case) names ahead of time.
const WANTED_PROPS = {
  accountId:        ['account id'],
  accountName:      ['account name'],
  totalMrr:         ['total mrr'],
  currencyCode:     ['currency code'],
  chargebeeStatus:  ['chargebee status'],
};

async function main() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  const cbKey = process.env.CHARGEBEE_API_KEY;
  if (!hsKey) { console.error('Set HUBSPOT_API_KEY in the environment first.'); process.exit(1); }
  if (!cbKey) { console.error('Set CHARGEBEE_API_KEY in the environment first.'); process.exit(1); }

  console.log('── Discovering HM Account schema in HubSpot ──────────────────');
  const schema = await findHmAccountSchema(hsKey);
  if (!schema) {
    console.error('Could not find an "HM Account" custom object schema. Listing what IS there:');
    const all = await hsRequest(hsKey, '/crm/v3/schemas');
    for (const s of all.results || []) console.error(`  - ${s.labels?.singular || s.name} (objectTypeId=${s.objectTypeId})`);
    process.exit(1);
  }
  console.log(`  Found "${schema.labels?.singular}" — objectTypeId=${schema.objectTypeId}, name=${schema.name}\n`);

  console.log('── Discovering property internal names ────────────────────────');
  const properties = await hsRequest(hsKey, `/crm/v3/properties/${schema.objectTypeId}`);
  const resolved = {};
  for (const [key, labelSubstrings] of Object.entries(WANTED_PROPS)) {
    const match = (properties.results || []).find(p =>
      labelSubstrings.some(sub => (p.label || '').toLowerCase().includes(sub))
    );
    resolved[key] = match ? match.name : null;
    console.log(`  ${key.padEnd(16)} → ${match ? match.name : '⚠️  NOT FOUND (label containing "' + labelSubstrings[0] + '")'}`);
  }
  console.log('');

  if (!resolved.accountId || !resolved.totalMrr) {
    console.error('Missing required properties (accountId/totalMrr) — cannot continue reliably.');
    process.exit(1);
  }

  console.log('── Fetching all HM Account records ────────────────────────────');
  const propList = Object.values(resolved).filter(Boolean);
  const accounts = await fetchAllHsObjects(hsKey, schema.objectTypeId, propList);
  console.log(`  Fetched ${accounts.length} HM Account records.\n`);

  // ── Filter check: don't assume "not cancelled" is the only thing that
  // matters. Show the actual distribution of status and currency values
  // before deciding what to include, since a blank/unexpected status or a
  // non-USD currency would silently skew the ARR total either way.
  console.log('── hm_chargebee_status distribution (all fetched records) ─────');
  const statusCounts = new Map();
  for (const a of accounts) {
    const status = a.properties[resolved.chargebeeStatus] || '(blank)';
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
  }
  for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${status}`);
  }
  console.log('');

  if (resolved.currencyCode) {
    console.log('── hm_currency_code distribution (all fetched records) ────────');
    const currencyCounts = new Map();
    for (const a of accounts) {
      const cur = a.properties[resolved.currencyCode] || '(blank)';
      currencyCounts.set(cur, (currencyCounts.get(cur) || 0) + 1);
    }
    for (const [cur, count] of [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)}  ${cur}`);
    }
    const nonUsd = accounts.filter(a => {
      const cur = (a.properties[resolved.currencyCode] || '').toUpperCase();
      return cur && cur !== 'USD';
    });
    if (nonUsd.length > 0) {
      const nonUsdMrr = nonUsd.reduce((s, a) => s + (Number(a.properties[resolved.totalMrr]) || 0), 0);
      console.log(`  ⚠️  ${nonUsd.length} account(s) not in USD, summing $${nonUsdMrr.toFixed(0)}/mo raw —`);
      console.log('      these are being added to the total UNCONVERTED below. Treat the');
      console.log('      final ARR comparison as approximate until this is handled properly.');
    }
    console.log('');
  } else {
    console.log('⚠️  Could not resolve a currency property — skipping currency check.\n');
  }

  // "active" per the spec's own three-value enum (active, non_renewing,
  // cancelled) — only "cancelled" is excluded here, matching what the spec
  // says Chargebee Status is "the field to filter on for whether an Account
  // is currently churned." non_renewing accounts are still currently paying
  // (they've just given notice), so they're kept, same as Chargebee's own
  // "active" status include on our side. Blank status is treated as unknown
  // and excluded conservatively rather than assumed active.
  const active = accounts.filter(a => {
    const status = (a.properties[resolved.chargebeeStatus] || '').toLowerCase();
    return status === 'active' || status === 'non_renewing';
  });
  // hm_total_mrr is published in dollars, not cents — Project Unified's own
  // spec divides the internal (cents-stored) value before publishing to
  // HubSpot, unlike Chargebee's raw API below, which is still in cents.
  const totalMrrDollars = active.reduce((s, a) => s + (Number(a.properties[resolved.totalMrr]) || 0), 0);
  const totalArrHubspot = totalMrrDollars * 12;

  console.log('── Fetching Chargebee paying customers (fresh, same run) ──────');
  const customers = await fetchAllActiveCustomers(cbKey);
  const paying = customers.filter(c => c.mrr && c.mrr > 0);
  const totalArrChargebee = paying.reduce((s, c) => s + (c.mrr || 0) / 100 * 12, 0);
  console.log(`  Fetched ${customers.length} active Chargebee customers, ${paying.length} paying.\n`);

  console.log('── Comparison ───────────────────────────────────────────────');
  console.log(`  HubSpot HM Account (active or non_renewing): ${active.length} accounts, $${totalArrHubspot.toFixed(0)} ARR`);
  console.log(`  Chargebee (active, mrr > 0):                 ${paying.length} accounts, $${totalArrChargebee.toFixed(0)} ARR`);
  const diff = totalArrHubspot - totalArrChargebee;
  const diffPct = totalArrChargebee ? (diff / totalArrChargebee) * 100 : 0;
  console.log(`  Difference:                                 $${diff.toFixed(0)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%)`);
  console.log('');
  console.log('  If HubSpot\'s total is meaningfully lower and closer to your known-correct');
  console.log('  number, that supports HM Account already de-duplicating what Chargebee\'s');
  console.log('  raw customer list does not. If the two are close, duplicates may not be');
  console.log('  explaining as much of the gap as hoped, and it\'s worth re-checking the');
  console.log('  known-correct number itself.');
  console.log('');

  // ── Spot-check known duplicate cases directly ───────────────────────
  // Aggregate totals can move for reasons unrelated to duplicates (currency,
  // rollup correctness). This checks whether HM Account actually collapses
  // the specific cases we already confirmed are duplicates via Chargebee +
  // Metabase — a much more direct test than comparing sums.
  // Only cases we have real reason to believe are one account fragmented
  // into multiple Chargebee records — NOT "Tim Hortons," which we already
  // confirmed is a legitimate multi-location franchise network (35+ real,
  // distinct accounts), not a duplicate. Applying a blanket "1 result =
  // good" rule to that would misread a correct result as a problem.
  console.log('── Spot-check: known duplicate cases in HM Account ─────────────');
  const KNOWN_CASES = ['sensational', 'white castle', 'askar'];
  for (const term of KNOWN_CASES) {
    const matches = accounts.filter(a =>
      (a.properties[resolved.accountName] || '').toLowerCase().includes(term)
    );
    console.log(`  "${term}" → ${matches.length} HM Account record(s)`);
    for (const m of matches) {
      const p = m.properties;
      console.log(`      id=${p[resolved.accountId]}  name="${p[resolved.accountName]}"  mrr=$${p[resolved.totalMrr]}  status=${p[resolved.chargebeeStatus]}`);
    }
  }
  console.log('');
  console.log('  1 record per name here means HM Account is genuinely collapsing that');
  console.log('  case. More than 1 means it isn\'t, for that specific case — this does not');
  console.log('  generalize to names like Tim Hortons, where multiple real records is correct.');
}

// ── HubSpot helpers ─────────────────────────────────────────

async function findHmAccountSchema(hsKey) {
  const res = await hsRequest(hsKey, '/crm/v3/schemas');
  const schemas = res.results || [];

  const labelOf = s => `${s.labels?.singular || ''} ${s.labels?.plural || ''} ${s.name || ''}`.toLowerCase();

  // Prefer a schema whose label contains both "hm" and "account" as
  // separate tokens — tolerates "HM Account", "HM Accounts", "hm_account".
  const strict = schemas.find(s => {
    const label = labelOf(s);
    return /\bhm\b/.test(label) && /\baccount/.test(label);
  });
  if (strict) return strict;

  // Fall back to anything with "account" in the label, in case the object
  // wasn't actually named with an "HM" prefix.
  return schemas.find(s => /\baccount/.test(labelOf(s)));
}

async function fetchAllHsObjects(hsKey, objectType, propertyNames) {
  const results = [];
  let after = null;
  do {
    const params = new URLSearchParams({ limit: '100', properties: propertyNames.join(',') });
    if (after) params.set('after', after);
    const res = await hsRequest(hsKey, `/crm/v3/objects/${objectType}?${params.toString()}`);
    results.push(...(res.results || []));
    after = res.paging?.next?.after || null;
  } while (after);
  return results;
}

async function hsRequest(hsKey, path) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${hsKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Chargebee helpers (same as find-duplicate-accounts.js) ───

async function fetchAllActiveCustomers(apiKey) {
  const results = [];
  let offset = null;
  do {
    const params = { 'status[is]': 'active', limit: String(PAGE_SIZE) };
    if (offset) params.offset = offset;
    const url = buildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers`, params);
    const res = await cbRequest(url, apiKey);
    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) await sleep(300);
  } while (offset);
  return results;
}

function buildUrl(base, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

async function cbRequest(url, apiKey) {
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
