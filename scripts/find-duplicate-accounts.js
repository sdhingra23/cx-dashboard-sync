#!/usr/bin/env node
// ============================================================
// FIND DUPLICATE ACCOUNTS
//
// One-off diagnostic — NOT part of the sync pipeline.
//
// Tests several things about why the same real-world account can show up as
// multiple separate rows on the dashboard:
//
//  1. ID-shape hypothesis: does a "wrong" duplicate customer record
//     correlate with having a Chargebee auto-generated (random alphanumeric)
//     ID rather than a short numeric one (the signature of a legacy/import
//     ID carried over from a prior billing system)?
//  2. Name-collision scan: groups active, paying customers by a LOOSELY
//     normalized company name (case-folded, quote-style normalized, legal
//     suffixes stripped, whitespace collapsed) to surface near-duplicate
//     company names that our actual dashboard grouping (exact match after
//     a bare .trim()) would NOT catch and would currently show as separate
//     accounts.
//  3. Native hierarchy fields: our production fetch only ever selects a
//     handful of named columns, so if Chargebee's Customer Hierarchy /
//     Business Entity feature is enabled on this site, a parent/child
//     relationship field could already exist on every customer object and
//     we'd never have looked at it. Dumps the full key set of a sample of
//     raw customer objects and flags anything hierarchy-shaped.
//  4. Location-suffix clustering: for multi-location clients billed as one
//     separate Chargebee CUSTOMER per location (not one customer with many
//     subscriptions — that case already rolls up correctly), each location's
//     company name usually shares a common prefix with a trailing qualifier
//     ("White Castle - Downtown", "White Castle #12"). Strips common
//     location-suffix patterns and re-groups to surface prefix-sharing
//     candidates. Heuristic — every group needs a human eyeball, since a
//     company whose real name ends in a number would false-positive here.
//  5. Real-data check (needs Metabase creds too): for every group found in
//     2/4, cross-references each member's name against Metabase Q1513
//     (location drill-down — locations, published jobs, applications) to
//     see whether one member is a real, active customer and the other is
//     an empty shell with no product data behind it at all. If a group is
//     "one has data, one doesn't," the empty one is very likely just a
//     stray Chargebee record, not a real second account — a much more
//     direct signal than ID shape or name pattern-matching.
//
// For every candidate group, reports each member's raw name, Chargebee
// customer ID, ARR, and whether the ID is numeric or Chargebee-generated.
//
// Usage:
//   CHARGEBEE_API_KEY=xxx node scripts/find-duplicate-accounts.js
//
//   # Also runs the Metabase real-data check (step 5):
//   CHARGEBEE_API_KEY=xxx METABASE_BASE_URL=xxx METABASE_USER=xxx METABASE_PASS=xxx \
//     node scripts/find-duplicate-accounts.js
// ============================================================

import { mbGetSession, mbRunQuestion } from '../lib/metabase.js';
import { LOCATION_QUESTION_ID } from '../lib/locations.js';
import { normalizeName } from '../lib/normalize.js';

const CHARGEBEE_SITE = 'higherme';
const PAGE_SIZE = 100;

async function main() {
  const apiKey = process.env.CHARGEBEE_API_KEY;
  if (!apiKey) {
    console.error('Set CHARGEBEE_API_KEY in the environment first.');
    process.exit(1);
  }

  console.log('Fetching all active Chargebee customers (this scans the full book, not a sample)...\n');
  const customers = await fetchAllActiveCustomers(apiKey);
  console.log(`Fetched ${customers.length} active customers.\n`);

  // ── Same filter production applies (lib/chargebee.js: skip $0 MRR) ────
  const paying = customers.filter(c => c.mrr && c.mrr > 0);
  console.log(`${paying.length} of those are paying (mrr > 0) — this is the set that actually reaches the dashboard.\n`);

  // ── 1. ID-shape baseline across the whole paying book ──────────────────
  const numericPaying = paying.filter(c => isNumericId(c.id));
  const autoGenPaying = paying.filter(c => !isNumericId(c.id));
  console.log('── ID shape, all paying customers ──────────────────────────');
  console.log(`  Numeric ID (legacy/import-style):     ${numericPaying.length} (${pct(numericPaying.length, paying.length)})`);
  console.log(`  Chargebee auto-generated ID:           ${autoGenPaying.length} (${pct(autoGenPaying.length, paying.length)})`);
  console.log('');

  // ── 2. Near-duplicate name groups ───────────────────────────────────────
  const groups = new Map(); // looseKey -> [customer, ...]
  for (const c of paying) {
    const rawName = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    if (!rawName) continue;
    const key = looseNormalize(rawName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, _rawName: rawName });
  }

  // Only groups where the EXACT (production) name differs across members —
  // those are the ones that currently show up as separate dashboard rows.
  // (A group where every member's raw name is byte-identical after a plain
  // .trim() already collapses into one account in production — not a bug.)
  const dupGroups = [...groups.values()].filter(members => {
    const exactNames = new Set(members.map(m => m._rawName.trim()));
    return exactNames.size > 1;
  });

  console.log(`── Near-duplicate company-name groups ──────────────────────`);
  console.log(`${dupGroups.length} group(s) found — same real company, different exact spelling, so each currently gets its own dashboard row.\n`);

  let mixedFormatGroups = 0;
  let sameFormatGroups  = 0;

  for (const members of dupGroups.sort((a, b) => b.length - a.length)) {
    const idFormats = new Set(members.map(m => isNumericId(m.id) ? 'numeric' : 'auto'));
    const isMixed = idFormats.size > 1;
    if (isMixed) mixedFormatGroups++; else sameFormatGroups++;

    console.log(`  ${isMixed ? '⚠️  MIXED ID FORMAT' : '   same ID format'} — "${members[0]._rawName}" family (${members.length} records)`);
    for (const m of members) {
      const idType = isNumericId(m.id) ? 'numeric' : 'auto-gen';
      const arr = ((m.mrr || 0) / 100 * 12).toFixed(0);
      console.log(`      [${idType.padEnd(8)}] id=${m.id.padEnd(20)} name="${m._rawName}"  ARR=$${arr}`);
    }
    console.log('');
  }

  console.log('── Hypothesis check ─────────────────────────────────────────');
  console.log(`  Near-duplicate groups with mixed ID format (1 numeric + 1+ auto-gen): ${mixedFormatGroups}`);
  console.log(`  Near-duplicate groups with same ID format on all sides:               ${sameFormatGroups}`);
  if (dupGroups.length > 0) {
    console.log(`  → ${pct(mixedFormatGroups, dupGroups.length)} of near-duplicate groups are mixed-format.`);
    console.log(`    Compare against the ${pct(autoGenPaying.length, paying.length)} auto-gen baseline above —`);
    console.log(`    if mixed-format groups are much more common than the baseline rate,`);
    console.log(`    that's real correlation, not coincidence.`);
  }
  console.log('');

  // ── 3. Native hierarchy field check ─────────────────────────────────────
  console.log('── Native Chargebee hierarchy fields ────────────────────────');
  const sampleSize = Math.min(50, paying.length);
  const allKeys = new Set();
  for (const c of paying.slice(0, sampleSize)) {
    for (const k of Object.keys(c)) allKeys.add(k);
  }
  const hierarchyLike = [...allKeys].filter(k => /parent|hierarch|business_entit|child/i.test(k));
  if (hierarchyLike.length > 0) {
    console.log(`  Found field(s) that look hierarchy-related on the raw customer object:`);
    for (const k of hierarchyLike) {
      const withValue = paying.slice(0, sampleSize).filter(c => c[k] != null && c[k] !== '');
      console.log(`    ${k}  (set on ${withValue.length}/${sampleSize} sampled)`);
      if (withValue.length) console.log(`      e.g. ${JSON.stringify(withValue[0][k])}`);
    }
    console.log(`  → If populated, this may be the CORRECT way to group multi-location accounts —`);
    console.log(`    worth checking before relying on the name-based heuristic below.`);
  } else {
    console.log('  None found on the sampled customer objects — all fields present:');
    console.log(`    ${[...allKeys].sort().join(', ')}`);
    console.log('  → No native hierarchy field visible via the API for this site/plan.');
    console.log('    (Doesn\'t rule out Business Entities being used elsewhere in Chargebee —');
    console.log('     just that it\'s not exposed on GET /customers for this account.)');
  }
  console.log('');

  // ── 4. Location-suffix clustering (heuristic) ────────────────────────────
  console.log('── Location-suffix clustering (heuristic — review each group) ──');
  const suffixGroups = new Map(); // strippedKey -> [customer, ...]
  for (const c of paying) {
    const rawName = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    if (!rawName) continue;
    const stripped = looseNormalize(stripLocationSuffix(rawName));
    if (!stripped) continue;
    if (!suffixGroups.has(stripped)) suffixGroups.set(stripped, []);
    suffixGroups.get(stripped).push({ ...c, _rawName: rawName });
  }

  // Only groups where stripping actually changed something (i.e. a real
  // suffix was found) AND there's more than one distinct exact name —
  // otherwise this just re-finds groups already caught above.
  const suffixCandidates = [...suffixGroups.values()].filter(members => {
    const exactNames = new Set(members.map(m => m._rawName.trim()));
    if (exactNames.size < 2) return false;
    return members.some(m => stripLocationSuffix(m._rawName) !== m._rawName.trim());
  });

  console.log(`${suffixCandidates.length} candidate group(s) — same prefix, different location-like suffix.\n`);
  for (const members of suffixCandidates.sort((a, b) => b.length - a.length)) {
    console.log(`  "${members[0]._rawName}" family (${members.length} records) — REVIEW BEFORE TRUSTING:`);
    for (const m of members) {
      const idType = isNumericId(m.id) ? 'numeric' : 'auto-gen';
      const arr = ((m.mrr || 0) / 100 * 12).toFixed(0);
      console.log(`      [${idType.padEnd(8)}] id=${m.id.padEnd(20)} name="${m._rawName}"  ARR=$${arr}`);
    }
    console.log('');
  }

  // ── 5. Real-data check against Metabase Q1513 (location drill-down) ────
  const mbUser = process.env.METABASE_USER;
  const mbPass = process.env.METABASE_PASS;
  const allCandidateGroups = [...dupGroups, ...suffixCandidates];

  console.log('── Real-data check (Metabase Q1513 location drill-down) ─────');
  let locsByName = null;
  if (!mbUser || !mbPass) {
    console.log('  Skipped — set METABASE_BASE_URL/METABASE_USER/METABASE_PASS to run this check.');
    console.log('  (Step 6 below will fall back to ID-shape only, which is less confident.)');
  } else if (allCandidateGroups.length === 0) {
    console.log('  No candidate groups to check (steps 2/4 found nothing).');
  } else {
    console.log('  Authenticating to Metabase...');
    const mbToken = await mbGetSession();
    console.log(`  Fetching Q${LOCATION_QUESTION_ID} location rows (full book — can take a bit)...`);
    const locationRows = await mbRunQuestion(LOCATION_QUESTION_ID, mbToken);
    console.log(`  ${locationRows.length} location rows fetched.\n`);

    // Index by normalized account_name AND company_name — Q1513 exposes both,
    // and we don't know for certain which one a given customer's company name
    // would match, so check either.
    // A Set of keys per row (not a plain loop over both columns) so a row
    // whose account_name and company_name are identical — the common case —
    // gets indexed once per key, not pushed twice into the same bucket and
    // double-counted in the job/app sums below.
    locsByName = new Map();
    for (const row of locationRows) {
      const map = keyMap(row);
      const keys = new Set(
        ['account_name', 'company_name']
          .map(col => normalizeName(get(row, map, col)))
          .filter(Boolean)
          .map(n => n.trim().toLowerCase())
      );
      for (const key of keys) {
        if (!locsByName.has(key)) locsByName.set(key, []);
        locsByName.get(key).push(row);
      }
    }

    for (const members of allCandidateGroups.sort((a, b) => b.length - a.length)) {
      console.log(`  "${members[0]._rawName}" family:`);
      for (const m of members) {
        const status = memberDataStatus(m, locsByName);
        const flag = status.locs === 0
          ? '⚠️  NO LOCATIONS MATCHED (name mismatch, or genuinely no product data)'
          : status.hasData ? '✓ has real product data' : '⚠️  locations exist but zero jobs/apps — looks like a dead shell';
        console.log(`      id=${m.id.padEnd(20)} name="${m._rawName}"  locations=${status.locs}  publishedJobs=${status.publishedJobs}  apps30d=${status.apps30d}  ${flag}`);
      }
      console.log('');
    }
  }
  console.log('');

  // ── 6. ARR impact: what changes if the likely duplicates are excluded? ──
  // For every candidate group, decides which member(s) to treat as the
  // likely stray duplicate, in order of confidence:
  //   1. Real-data split (from step 5): some members have product data,
  //      some don't → exclude the no-data ones. Highest confidence.
  //   2. ID-shape split: mixed numeric/auto-generated IDs → exclude the
  //      auto-generated ones. Medium confidence (correlation, not proof).
  //   3. Neither signal splits the group → exclude everyone but the
  //      highest-ARR member, flagged LOW CONFIDENCE. This is a guess, not
  //      a finding — reviewed manually before trusting.
  // This does NOT change the dashboard or Chargebee — it only recomputes
  // the ARR total so you can compare it against a known-correct number.
  console.log('── ARR impact if likely duplicates are excluded ─────────────');

  const totalArrAll = paying.reduce((s, c) => s + (c.mrr || 0) / 100 * 12, 0);
  const excluded = new Map(); // customer id -> { member, reason, confidence }

  for (const members of allCandidateGroups) {
    if (members.length < 2) continue;

    // 1. Real-data split
    if (locsByName) {
      const statuses = members.map(m => ({ m, ...memberDataStatus(m, locsByName) }));
      const withData = statuses.filter(s => s.hasData);
      const withoutData = statuses.filter(s => !s.hasData);
      if (withData.length > 0 && withoutData.length > 0) {
        for (const s of withoutData) {
          excluded.set(s.m.id, { member: s.m, reason: 'no product data in Metabase', confidence: 'HIGH' });
        }
        continue;
      }
    }

    // 2. ID-shape split
    const numeric = members.filter(m => isNumericId(m.id));
    const autoGen = members.filter(m => !isNumericId(m.id));
    if (numeric.length > 0 && autoGen.length > 0) {
      for (const m of autoGen) {
        excluded.set(m.id, { member: m, reason: 'auto-generated Chargebee ID (numeric sibling exists)', confidence: 'MEDIUM' });
      }
      continue;
    }

    // 3. No signal splits the group — guess by ARR, flagged low confidence
    const sorted = [...members].sort((a, b) => (b.mrr || 0) - (a.mrr || 0));
    for (const m of sorted.slice(1)) {
      excluded.set(m.id, { member: m, reason: 'ambiguous — lower ARR than its sibling', confidence: 'LOW — verify manually' });
    }
  }

  const excludedList = [...excluded.values()];
  const excludedArr = excludedList.reduce((s, x) => s + (x.member.mrr || 0) / 100 * 12, 0);
  const totalArrFiltered = totalArrAll - excludedArr;

  console.log(`  All paying customers:        ${paying.length} accounts, $${totalArrAll.toFixed(0)} ARR`);
  console.log(`  Likely duplicates excluded:  ${excludedList.length} accounts, -$${excludedArr.toFixed(0)} ARR`);
  console.log(`  Remaining:                   ${paying.length - excludedList.length} accounts, $${totalArrFiltered.toFixed(0)} ARR`);
  console.log('');
  if (excludedList.length > 0) {
    console.log('  Excluded records:');
    for (const { member: m, reason, confidence } of excludedList.sort((a, b) => (b.member.mrr || 0) - (a.member.mrr || 0))) {
      const arr = ((m.mrr || 0) / 100 * 12).toFixed(0);
      console.log(`    [${confidence.padEnd(20)}] id=${m.id.padEnd(20)} name="${m._rawName}"  ARR=$${arr}  — ${reason}`);
    }
  }
  console.log('');
  console.log('  Compare "Remaining" ARR above against your known-correct number.');
  console.log('  LOW-confidence exclusions are guesses — verify those specific records');
  console.log('  in Chargebee before treating this as final.');
}

// Shared by steps 5 and 6 — looks up a candidate member's real product data
// (locations, published jobs, applications) from the Q1513 index.
function memberDataStatus(m, locsByName) {
  const key = m._rawName.trim().toLowerCase();
  const locs = locsByName.get(key) || [];
  const publishedJobs = locs.reduce((s, r) => s + toInt(get(r, keyMap(r), 'published_jobs')), 0);
  const apps30d = locs.reduce((s, r) =>
    s + toInt(get(r, keyMap(r), 'indeed_apps_30d')) + toInt(get(r, keyMap(r), 'signage_apps_30d')), 0);
  return { locs: locs.length, publishedJobs, apps30d, hasData: locs.length > 0 && (publishedJobs > 0 || apps30d > 0) };
}

async function fetchAllActiveCustomers(apiKey) {
  const results = [];
  let offset = null;
  do {
    const params = { 'status[is]': 'active', limit: String(PAGE_SIZE) };
    if (offset) params.offset = offset;
    const url = buildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers`, params);
    const res = await request(url, apiKey);
    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) await sleep(300);
  } while (offset);
  return results;
}

function isNumericId(id) {
  return /^\d+$/.test(String(id));
}

// Same tolerant column lookup lib/locations.js uses internally (not
// exported from there) — Metabase can return a question's columns as
// display names ("Account Name") rather than raw names ("account_name").
function keyMap(row) {
  return Object.keys(row).reduce((m, k) => {
    m[k.toLowerCase().replace(/\s+/g, '_')] = k;
    return m;
  }, {});
}

function get(row, map, col) {
  const key = map[col];
  return key === undefined ? null : row[key];
}

function toInt(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Case-fold, normalize curly quotes to straight, strip common legal
// suffixes and punctuation, collapse whitespace. Deliberately looser than
// production's normalizeName() (which only trims) — this is for surfacing
// candidates for a human to review, not for driving the actual dashboard.
function looseNormalize(name) {
  return String(name)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|ltd|company)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strips a trailing location-like qualifier so multi-location clients billed
// as separate Chargebee customers (one per location, not one customer with
// many subscriptions) can be clustered by their shared prefix. Heuristic,
// not exhaustive — every match needs a human to confirm it's really a
// location suffix and not part of the actual company name.
function stripLocationSuffix(name) {
  return String(name)
    .replace(/\s*[-–—]\s*(store|location|loc|unit|branch|shop)?\s*#?\d+\s*$/i, '')
    .replace(/\s*[-–—]\s*[A-Za-z][A-Za-z .]{0,24}$/, '')   // "- Downtown", "- North Ave"
    .replace(/\s*#\s*\d+\s*$/, '')                          // "#12"
    .replace(/\s*\(\s*[^)]{1,30}\)\s*$/, '')                // "(Chicago)"
    .replace(/\s+\d{2,6}\s*$/, '')                          // trailing bare number
    .trim();
}

function pct(n, total) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
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
