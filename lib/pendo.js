// ============================================================
// PENDO CLIENT
//
// Fetches NPS poll responses and account-level activity via
// Pendo's Aggregation API.
//
// NPS guide ID  : MkCSxW_d4h0KgHVwfzZn_ow2Hu8
// ============================================================

const PENDO_BASE   = 'https://app.pendo.io';
const NPS_GUIDE_ID = 'MkCSxW_d4h0KgHVwfzZn_ow2Hu8';

// ── Public entry points ──────────────────────────────────────

/**
 * Fetch all NPS poll responses from Pendo.
 * Returns an array of individual responses for upsert into nps_responses table.
 *
 * NPS guides are actually two separate polls under the hood (quantitative
 * 0-10 rating + qualitative free text). Following Pendo's own aggregation
 * pattern: resolve both poll IDs for the guide, query pollsSeenEver for
 * each, then join on visitorId.
 *
 * @returns {Array<{account_id, account_name, visitor_id, score, verbatim, response_date}>}
 */
export async function fetchNpsResponses(apiKey) {
  const { pollId1, pollId2 } = await fetchGuidePollIds(apiKey, NPS_GUIDE_ID);

  const body = {
    response: { mimeType: 'application/json' },
    request: {
      pipeline: [
        {
          spawn: [
            [
              { source: { pollsSeenEver: { guideId: NPS_GUIDE_ID, pollId: pollId1 } } },
              { identified: 'visitorId' },
              { cat: null },
              { select: { visitorId: 'visitorId', accountId: 'accountId', quantitativeTime: 'time', quantitativeResponse: 'response' } },
            ],
            [
              { source: { pollsSeenEver: { guideId: NPS_GUIDE_ID, pollId: pollId2 } } },
              { identified: 'visitorId' },
              { cat: null },
              { select: { visitorId: 'visitorId', accountId: 'accountId', qualitativeTime: 'time', qualitativeResponse: 'response' } },
            ],
          ],
        },
        { join: { fields: ['visitorId'], width: 2 } },
        {
          select: {
            visitorId:            'visitorId',
            accountId:            'accountId',
            qualitativeResponse:  'qualitativeResponse',
            qualitativeTime:      'qualitativeTime',
            quantitativeResponse: 'quantitativeResponse',
            quantitativeTime:     'quantitativeTime',
          },
        },
      ],
    },
  };

  const rows = await pendoAggregate(apiKey, body);

  const responses = [];
  for (const row of rows) {
    const score = row.quantitativeResponse;
    if (score === undefined || score === null) continue;

    const responseTime = row.quantitativeTime ?? row.qualitativeTime;
    responses.push({
      account_id:       String(row.accountId || ''),
      pendo_visitor_id: String(row.visitorId  || ''),  // matches Supabase column name
      score:            Number(score),
      verbatim:         row.qualitativeResponse || null,
      response_date:    responseTime
        ? new Date(responseTime).toISOString().split('T')[0]
        : null,
    });
  }

  return responses;
}

// ── Visitor roles ────────────────────────────────────────────
//
// NPS is only as useful as the person answering it: a company admin is the
// buyer and the renewal decision-maker, a shift manager is not. Pendo stores
// role on the visitor, not on the poll response, so roles are fetched
// separately and joined to responses on visitorId.
//
// The metadata field differs per Pendo instance and is not discoverable from
// the API's schema, so each candidate is tried until one returns values. Set
// PENDO_ROLE_FIELD to skip probing once the right field is known.

const ROLE_FIELD_CANDIDATES = [
  'metadata.custom.role',
  'metadata.agent.role',
  'metadata.custom.user_role',
  'metadata.agent.user_role',
  'metadata.custom.usertype',
  'metadata.agent.usertype',
  'metadata.custom.user_type',
  'metadata.custom.account_role',
  'metadata.custom.permission',
];

/**
 * Build a visitorId → raw role string map.
 * @returns {{ field: string|null, roles: object, distinct: string[] }}
 */
export async function fetchVisitorRoles(apiKey) {
  const configured = (process.env.PENDO_ROLE_FIELD || '').trim();
  const candidates = configured ? [configured] : ROLE_FIELD_CANDIDATES;

  for (const field of candidates) {
    let rows;
    try {
      rows = await pendoAggregate(apiKey, {
        response: { mimeType: 'application/json' },
        request: {
          pipeline: [
            { source: { visitors: null } },
            { select: { visitorId: 'visitorId', role: field } },
          ],
        },
      });
    } catch (e) {
      console.warn(`Pendo roles: field "${field}" not queryable — ${e.message.slice(0, 120)}`);
      continue;
    }

    const roles = {};
    for (const r of rows) {
      const raw = r.role;
      if (raw === null || raw === undefined || String(raw).trim() === '') continue;
      roles[String(r.visitorId)] = String(raw).trim();
    }

    const found = Object.keys(roles).length;
    if (found === 0) continue;

    const distinct = [...new Set(Object.values(roles))].sort();
    console.log(`Pendo roles: resolved from "${field}" — ${found}/${rows.length} visitors carry a role`);
    console.log(`Pendo roles: distinct values (${distinct.length}): ${distinct.slice(0, 30).join(' | ')}${distinct.length > 30 ? ' | …' : ''}`);
    return { field, roles, distinct };
  }

  console.warn(
    'Pendo roles: no role metadata found — NPS stays blended across all roles. ' +
    `Tried: ${candidates.join(', ')}. Set PENDO_ROLE_FIELD once the correct field is known.`
  );
  // Guessing field names clearly isn't working, so ask Pendo what it actually
  // has. The next run then reports the real field list in its own log instead
  // of needing another round of guesses.
  await logVisitorMetadataSchema(apiKey);
  return { field: null, roles: {}, distinct: [] };
}

/**
 * Dump every visitor metadata field Pendo knows about, so the correct role
 * field can be identified and pinned via PENDO_ROLE_FIELD.
 */
async function logVisitorMetadataSchema(apiKey) {
  try {
    const res = await fetch(`${PENDO_BASE}/api/v1/metadata/schema/visitor`, {
      headers: { 'x-pendo-integration-key': apiKey },
    });
    if (!res.ok) {
      console.warn(`Pendo roles: could not read visitor metadata schema (HTTP ${res.status})`);
      return;
    }
    const schema = await res.json();
    const fields = [];
    for (const [group, defs] of Object.entries(schema || {})) {
      for (const key of Object.keys(defs || {})) fields.push(`metadata.${group}.${key}`);
    }
    if (fields.length === 0) {
      console.warn('Pendo roles: visitor metadata schema came back empty.');
      return;
    }
    console.warn(`Pendo roles: visitor metadata fields available (${fields.length}) — set PENDO_ROLE_FIELD to whichever holds the role:`);
    for (const f of fields.sort()) console.warn(`    ${f}`);
  } catch (e) {
    console.warn(`Pendo roles: metadata schema lookup failed — ${e.message.slice(0, 160)}`);
  }
}

/**
 * Bucket a raw Pendo role string into the three tiers the dashboard reports
 * on. Unrecognised values fall to 'other', which is counted and displayed but
 * never scored — so a new role appearing in Pendo degrades quietly rather
 * than being silently treated as an admin.
 *
 * @returns {'admin'|'employer'|'other'}
 */
export function classifyRole(raw) {
  if (!raw) return 'other';
  const s = String(raw).toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(company )?admin\b|\bowner\b|\bfranchisee\b|\boperator\b|\bsuper ?admin\b/.test(s)) return 'admin';
  if (/\bemployer\b|\bmanager\b|\bhiring\b|\brecruiter\b|\bgm\b|\bsupervisor\b/.test(s))    return 'employer';
  return 'other';
}

/**
 * Resolve the two underlying poll IDs (quantitative rating + qualitative
 * free text) for an NPS guide. Required because pollsSeenEver is queried
 * per-poll, not per-guide.
 */
async function fetchGuidePollIds(apiKey, guideId) {
  const body = {
    response: { mimeType: 'application/json' },
    request: {
      pipeline: [
        { source: { guides: null } },
        { filter: `id==\`${guideId}\`` },
        { select: { pollId1: 'polls[0].id', pollId2: 'polls[1].id' } },
      ],
    },
  };

  const rows = await pendoAggregate(apiKey, body);
  const row = rows[0];
  if (!row || !row.pollId1 || !row.pollId2) {
    throw new Error(`Could not resolve poll IDs for guide ${guideId} — got ${JSON.stringify(row)}`);
  }
  return { pollId1: row.pollId1, pollId2: row.pollId2 };
}

/**
 * Fetch account-level activity from Pendo.
 * Returns { accountId: { last_active, days_active_per_visitor, error_click_rate } }
 *
 * The current and prior 30-day windows are fetched in parallel so the sync
 * can compute a trend (improving / declining / stable).
 *
 * lastVisit is account.auto.lastvisit (epoch ms). Fetched unscoped (no
 * segment filter) pending confirmation of the correct "*ALL Employers"
 * segment ID — see the note above.
 */
export async function fetchAccountActivity(apiKey) {
  // accounts source returns current state — lastVisit, daysActive etc.
  // timeSeries is not supported on the accounts source; drop it.
  // NOTE: the accounts source only accepts a single key ("accounts") —
  // appId/segmentId must NOT be siblings inside `source` (Pendo rejects
  // that with "only a single source is allowed"). Segment scoping (when
  // re-added) is a separate pipeline stage.
  const body = {
    response: { mimeType: 'application/json' },
    request: {
      pipeline: [
        {
          source: {
            accounts: null,
          },
        },
        {
          select: {
            accountId:      'accountId',
            lastVisit:      'metadata.auto.lastvisit',
            daysActive:     'daysActive',
            numErrorClicks: 'numErrorClicks',
          },
        },
      ],
    },
  };

  const rows = await pendoAggregate(apiKey, body);

  const result = {};
  let skippedNoAccountId = 0;
  let nullLastVisit = 0;
  for (const row of rows) {
    if (!row.accountId) { skippedNoAccountId++; continue; }
    if (row.lastVisit == null) nullLastVisit++;

    const id = String(row.accountId);
    result[id] = {
      pendo_last_active:             row.lastVisit
        ? new Date(row.lastVisit).toISOString().split('T')[0]
        : null,
      pendo_days_active_per_visitor: row.daysActive    ?? null,
      pendo_error_click_rate:        row.numErrorClicks ?? null,
    };
  }

  if (skippedNoAccountId > 0) {
    console.warn(`Pendo activity: skipped ${skippedNoAccountId} rows with null/missing accountId`);
  }
  if (nullLastVisit > 0) {
    console.warn(`Pendo activity: ${nullLastVisit} accounts have no lastvisit value (never logged in or untracked)`);
  }

  return result;
}

/**
 * POST to Pendo Aggregation API and return the results array.
 */
async function pendoAggregate(apiKey, body, retries = 3) {
  const url = `${PENDO_BASE}/api/v1/aggregation`;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':            'application/json',
          'x-pendo-integration-key': apiKey,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        await sleep(1000 * Math.pow(2, i + 1));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Pendo aggregation HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = await res.json();
      // Pendo returns { results: [...] } or the array directly
      return Array.isArray(json) ? json : (json.results || []);
    } catch (e) {
      if (i === retries - 1) throw e;
      console.error(`Pendo request error (attempt ${i + 1}):`, e.message);
      await sleep(1000 * Math.pow(2, i + 1));
    }
  }

  return [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
