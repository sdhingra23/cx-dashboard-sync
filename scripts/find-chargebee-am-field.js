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
// `cf_*` key it sees, and prints a frequency breakdown of the values on each
// — a plain "first 5 samples" list can coincidentally show the same value
// 5 times and hide that other real values exist further in.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/find-chargebee-am-field.js
//   CHARGEBEE_API_KEY=xxx node scripts/find-chargebee-am-field.js --pages 10
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
  const maxPages = pagesArg !== -1 ? Number(process.argv[pagesArg + 1]) || 1 : 10;

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

    // Frequency breakdown rather than the first few raw samples — a handful
    // of samples can all coincidentally be the same value (e.g. a default
    // placeholder like "Unassigned") and hide that other real values exist.
    const counts = new Map();
    for (const i of withValue) {
      const v = String(i[key]);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    console.log(`  ${key}  (set on ${withValue.length}/${items.length}, ${distinct.length} distinct value${distinct.length === 1 ? '' : 's'})`);
    for (const [value, count] of distinct.slice(0, 10)) {
      console.log(`      ${count.toString().padStart(4)}  ${JSON.stringify(value)}`);
    }
    if (distinct.length > 10) console.log(`      ... and ${distinct.length - 10} more distinct value(s)`);
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
