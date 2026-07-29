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
