#!/usr/bin/env node
// ============================================================
// CHECK BUSINESS ENTITIES
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Chargebee's Business Entity feature scopes customers/subscriptions per
// entity; API calls without an explicit entity context may only see the
// default entity, while the admin console UI (with full account access)
// shows everything. If this Chargebee account has more than one Business
// Entity, that would explain why customer "White Castle Corporate" (or a
// second "White Castle") is visible in the UI but invisible to every API
// call this investigation has made so far, regardless of status filter —
// and would also be a strong lead on the broader 62% Metabase/HubSpot
// mismatch (not just this one account).
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/check-business-entities.js
// ============================================================

const CHARGEBEE_SITE = 'higherme';

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) { console.error('Set CHARGEBEE_API_KEY.'); process.exit(1); }

  console.log('── GET /business_entities ────────────────────────────────────');
  try {
    const res = await request(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/business_entities`, apiKey);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('  Error:', e.message);
  }
}

async function request(url, apiKey) {
  const headers = {
    Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
    Accept: 'application/json',
  };
  const res = await fetch(url, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
