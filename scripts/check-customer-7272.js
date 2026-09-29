#!/usr/bin/env node
// ============================================================
// CHECK CUSTOMER 7272 TRACE
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// check-name-mismatch.js confirmed GET /customers/7272 returns a plain
// HTTP 404 resource_not_found from the current Chargebee API key. But the
// user directly recalls browsing to https://higherme.chargebee.com/customers/7272
// early in this investigation and seeing it as a real, distinct "White
// Castle" record. This script checks two possible explanations before
// assuming the user misremembered:
//
//   1. The customer was deleted (not merged) — GET /customers/7272 with
//      include_deleted=true would still 404 if truly gone, but Chargebee's
//      List Customers endpoint with include_deleted[is]=true + id filter
//      can sometimes surface soft-deleted records the single-GET can't.
//   2. The customer was merged into another one (e.g. HtZEwUtQ2kIAW83zD) —
//      Chargebee's Events API logs customer_deleted / customer_changed
//      events; scanning recent history for any event whose content
//      mentions id "7272" would show what actually happened and when.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/check-customer-7272.js [customer_id]
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const TARGET_ID = process.argv[2] || '7272';

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) { console.error('Set CHARGEBEE_API_KEY in the environment first.'); process.exit(1); }

  console.log(`── Step 1: GET /customers/${TARGET_ID} (plain) ──────────────────`);
  await tryGet(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers/${TARGET_ID}`, apiKey);

  console.log(`\n── Step 2: GET /customers/${TARGET_ID}?include_deleted=true ─────`);
  await tryGet(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers/${TARGET_ID}?include_deleted=true`, apiKey);

  console.log(`\n── Step 3: List customers filtered by id[is]=${TARGET_ID}, include_deleted=true ─`);
  await tryGet(
    `https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers?id[is]=${encodeURIComponent(TARGET_ID)}&include_deleted[is]=true`,
    apiKey
  );

  console.log(`\n── Step 4: Scan Events API for any event mentioning id "${TARGET_ID}" ─`);
  console.log('   (scanning customer_deleted / customer_changed / customer_merged events, newest first)');
  await scanEvents(apiKey, TARGET_ID);
}

async function tryGet(url, apiKey) {
  try {
    const res = await cbRequest(url, apiKey);
    console.log('  Result:', JSON.stringify(res, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('  Error:', e.message);
  }
}

async function scanEvents(apiKey, targetId) {
  const eventTypes = ['customer_deleted', 'customer_changed', 'customer_merged', 'customer_created'];
  let offset = null;
  let scanned = 0;
  let found = [];
  const MAX_PAGES = 50; // 50 * 100 = up to 5000 most recent matching-type events

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      'event_type[in]': `[${eventTypes.join(',')}]`,
      'sort_by[desc]': 'occurred_at',
      limit: '100',
    };
    if (offset) params.offset = offset;
    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    let res;
    try {
      res = await cbRequest(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/events?${qs}`, apiKey);
    } catch (e) {
      console.log(`  Error fetching events page ${page}:`, e.message);
      break;
    }
    const list = res.list || [];
    scanned += list.length;
    for (const item of list) {
      const ev = item.event;
      const raw = JSON.stringify(ev.content || {});
      if (raw.includes(`"${targetId}"`) || raw.includes(`"id":"${targetId}"`)) {
        found.push(ev);
      }
    }
    offset = res.next_offset || null;
    if (page % 5 === 0) console.log(`  ...scanned ${scanned} events so far (page ${page}), ${found.length} matches`);
    if (!offset) break;
    await sleep(150);
  }

  console.log(`\n  Total events scanned: ${scanned}`);
  console.log(`  Matches for "${targetId}": ${found.length}`);
  for (const ev of found.slice(0, 20)) {
    const when = new Date(ev.occurred_at * 1000).toISOString();
    console.log(`\n  [${ev.event_type}] id=${ev.id} occurred_at=${when} source=${ev.source} user=${ev.user || ''}`);
    console.log('  content:', JSON.stringify(ev.content).slice(0, 1500));
  }
  if (found.length === 0) {
    console.log('\n  No matching events found within the scanned window. Either the record predates');
    console.log('  this scan window, or it never existed as a distinct Chargebee customer object');
    console.log('  under this exact ID (e.g. it could have been a URL the user saw before a rename/merge');
    console.log('  that is now outside retention, or a misremembered ID).');
  }
}

async function cbRequest(url, apiKey) {
  const headers = {
    Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
    Accept: 'application/json',
  };
  const res = await fetch(url, { method: 'GET', headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
