#!/usr/bin/env node
// ============================================================
// FIND CHARGEBEE AM CUSTOM FIELD
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Chargebee always returns every configured custom field on a
// customer/subscription object (as a `cf_*` key, null if unset for that
// record), so there's no need to guess field names one at a time. This
// pulls a sample of real customers + subscriptions, collects every distinct
// `cf_*` key it sees, and prints a few sample values for each — so you can
// eyeball which one holds the AM assignment (e.g. cf_account_manager,
// cf_am_owner, cf_cs_owner, ...).
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/find-chargebee-am-field.js
//   CHARGEBEE_API_KEY=xxx node scripts/find-chargebee-am-field.js --pages 5
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) {
    console.error('Set CHARGEBEE_API_KEY in the environment first.');
    process.exit(1);
  }

  const pagesArg = process.argv.indexOf('--pages');
  const maxPages = pagesArg !== -1 ? Number(process.argv[pagesArg + 1]) || 1 : 2;

  console.log(`Scanning ${maxPages} page(s) of customers and subscriptions (${PAGE_SIZE}/page)...\n`);

  const customers     = await fetchPages('customers',     'customer',     apiKey, maxPages);
  const subscriptions = await fetchPages('subscriptions', 'subscription', apiKey, maxPages);

  console.log(`Fetched ${customers.length} customers, ${subscriptions.length} subscriptions.\n`);

  reportCustomFields('CUSTOMER', customers);
  reportCustomFields('SUBSCRIPTION', subscriptions);

  console.log('Look for a field whose sample values look like AM/CSM names, then set:');
  console.log('  export CHARGEBEE_AM_FIELD=cf_whatever_it_is\n');
}

async function fetchPages(resource, itemKey, apiKey, maxPages) {
  const results = [];
  let offset = null;
  let page = 0;

  do {
    const params = { 'status[is]': 'active', limit: String(PAGE_SIZE) };
    if (offset) params.offset = offset;

    const url = buildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/${resource}`, params);
    const res = await request(url, apiKey);
    if (!res || !res.list) break;

    res.list.forEach(item => { if (item[itemKey]) results.push(item[itemKey]); });
    offset = res.next_offset || null;
    page++;
    if (offset && page < maxPages) await sleep(400);
  } while (offset && page < maxPages);

  return results;
}

function reportCustomFields(label, items) {
  console.log(`── ${label} custom fields ──────────────────────────`);
  if (items.length === 0) {
    console.log('  (no records fetched)\n');
    return;
  }

  const fieldKeys = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (key.startsWith('cf_')) fieldKeys.add(key);
    }
  }

  if (fieldKeys.size === 0) {
    console.log('  No cf_* keys found on any fetched record.\n');
    return;
  }

  for (const key of [...fieldKeys].sort()) {
    const withValue = items.filter(i => i[key] !== null && i[key] !== undefined && i[key] !== '');
    const samples = withValue.slice(0, 5).map(i => JSON.stringify(i[key]));
    console.log(`  ${key}  (set on ${withValue.length}/${items.length})`);
    if (samples.length) console.log(`      e.g. ${samples.join(', ')}`);
  }
  console.log('');
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
