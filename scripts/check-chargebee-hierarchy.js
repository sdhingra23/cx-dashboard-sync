#!/usr/bin/env node
// ============================================================
// CHECK CHARGEBEE HIERARCHY
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Chargebee has a native Account Hierarchy feature (parent/child customer
// relationships, GET /customers/{id}/hierarchy) that's completely separate
// from customer object properties — which is why the earlier native-
// hierarchy-field check (find-duplicate-accounts.js, which only scanned
// cf_* custom fields) never surfaced it.
//
// If this is actually in use, it could be the real bridge between
// fragmented Chargebee customer records and the canonical account HubSpot's
// HM Account already represents — a parent customer's company name might
// be exactly what matches HM Account's hm_account_name, explaining both
// the low Chargebee-enrichment match rate and (independently) the
// duplicate-account pattern from a few days ago.
//
// There's no bulk "list all hierarchies" endpoint — this has to be checked
// per customer, so it samples rather than scanning the whole book by
// default (full scan is possible via --sample all, but slow: one request
// per customer, rate-limited).
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/check-chargebee-hierarchy.js
//   CHARGEBEE_API_KEY=xxx node scripts/check-chargebee-hierarchy.js --sample 500
//   CHARGEBEE_API_KEY=xxx node scripts/check-chargebee-hierarchy.js --sample all
// ============================================================

const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) { console.error('Set CHARGEBEE_API_KEY in the environment first.'); process.exit(1); }

  const sampleArgIdx = process.argv.indexOf('--sample');
  const sampleArg = sampleArgIdx !== -1 ? process.argv[sampleArgIdx + 1] : '300';
  const sampleSize = sampleArg === 'all' ? Infinity : (Number(sampleArg) || 300);

  console.log('Fetching active Chargebee customers...');
  const allCustomers = await fetchAllActiveCustomers(apiKey);
  const paying = allCustomers.filter(c => c.mrr && c.mrr > 0);
  console.log(`${allCustomers.length} active customers, ${paying.length} paying.\n`);

  const sample = paying.slice(0, Math.min(sampleSize, paying.length));
  console.log(`Checking account hierarchy for ${sample.length} of ${paying.length} paying customers (this is one API call per customer, rate-limited)...\n`);

  let withParent = 0, withChildren = 0, standalone = 0, errored = 0;
  const parentExamples = [];
  const childExamples = [];

  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    try {
      const res = await cbRequest(hierarchyUrl(c.id), apiKey);
      const nodes = res?.hierarchies || [];
      const self = nodes.find(n => n.customer_id === c.id) || nodes[0] || {};
      const hasParent = !!self.parent_id;
      const hasChildren = !!(self.children_ids && self.children_ids.length > 0);

      if (hasParent) {
        withParent++;
        if (parentExamples.length < 10) {
          const parentNode = nodes.find(n => n.customer_id === self.parent_id);
          parentExamples.push({ id: c.id, name: c.company, parent_id: self.parent_id, parent_in_response: !!parentNode });
        }
      }
      if (hasChildren) {
        withChildren++;
        if (childExamples.length < 10) {
          childExamples.push({ id: c.id, name: c.company, children_count: self.children_ids.length });
        }
      }
      if (!hasParent && !hasChildren) standalone++;
    } catch (e) {
      errored++;
    }
    if (i > 0 && i % 20 === 0) {
      console.log(`  ...${i}/${sample.length} checked (parent:${withParent} children:${withChildren} standalone:${standalone} errored:${errored})`);
    }
    await sleep(150); // stay well under Chargebee's rate limit across a few hundred sequential calls
  }

  console.log('\n── Results ─────────────────────────────────────────────────');
  console.log(`  Sampled:                ${sample.length}`);
  console.log(`  Has a parent (is a child of another customer): ${withParent}`);
  console.log(`  Has children (is a parent of other customers): ${withChildren}`);
  console.log(`  Standalone (no hierarchy relationship at all):  ${standalone}`);
  console.log(`  Errored / not found:                            ${errored}`);
  console.log('');

  if (parentExamples.length > 0) {
    console.log('── Customers with a parent (examples) ────────────────────────');
    for (const ex of parentExamples) {
      console.log(`  id=${ex.id}  name="${ex.name}"  parent_id=${ex.parent_id}  (parent in same response: ${ex.parent_in_response})`);
    }
    console.log('');
  }
  if (childExamples.length > 0) {
    console.log('── Customers with children (examples) ────────────────────────');
    for (const ex of childExamples) {
      console.log(`  id=${ex.id}  name="${ex.name}"  children_count=${ex.children_count}`);
    }
    console.log('');
  }

  if (withParent === 0 && withChildren === 0) {
    console.log('No hierarchy relationships found in this sample — Account Hierarchy');
    console.log('does not appear to be in active use for this Chargebee site, at least');
    console.log('not among the sampled customers. Worth re-running with a larger --sample');
    console.log('before ruling it out entirely, but this is not looking like the bridge.');
  } else {
    console.log('Hierarchy relationships exist. Worth checking whether a parent customer\'s');
    console.log('company name is what actually matches HubSpot\'s hm_account_name — that');
    console.log('would mean sync.js should resolve each Chargebee customer to its hierarchy');
    console.log('root before matching, not match the raw customer record directly.');
  }
}

function hierarchyUrl(customerId) {
  return buildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers/${customerId}/hierarchy`, {
    hierarchy_operation_type: 'complete_hierarchy',
  });
}

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
  if (res.status === 404) return null; // not part of any hierarchy
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chargebee ${res.status}: ${body.slice(0, 200)}`);
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
