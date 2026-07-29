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

// "*ALL Employers" segment (subId 4689849911410688) was intended to scope the
// accounts source for account.auto.lastvisit, but Pendo rejected it with
// "segment id not found" — pending confirmation of the correct ID/shape.
// Temporarily fetching unscoped until that's sorted out.

// ── Public entry points ──────────────────────────────────────

/**
 * Fetch all NPS poll responses from Pendo.
 * Returns an array of individual responses for upsert into nps_responses table.
 *
 * @returns {Array<{account_id, account_name, visitor_id, score, verbatim, response_date}>}
 */
export async function fetchNpsResponses(apiKey) {
  // guideEvents source requires an explicit timeSeries range
  const body = {
    response: { mimeType: 'application/json' },
    request: {
      pipeline: [
        {
          source: {
            guideEvents: null,
            timeSeries: {
              period: 'dayRange',
              first:  Date.now(),  // epoch ms — Pendo rejects the string 'now'
              count:  -365,        // last 12 months of NPS responses
            },
          },
        },
        {
          filter: `guideId == "${NPS_GUIDE_ID}" && type == "pollResponse"`,
        },
        {
          select: {
            accountId:     'accountId',
            visitorId:     'visitorId',
            browserTime:   'browserTime',
            pollResponses: 'pollResponses',
          },
        },
      ],
    },
  };

  const rows = await pendoAggregate(apiKey, body);

  const responses = [];
  for (const row of rows) {
    const polls = row.pollResponses || [];
    for (const poll of polls) {
      const score = poll.numericResponse ?? poll.score;
      if (score === undefined || score === null) continue;

      responses.push({
        account_id:       String(row.accountId || ''),
        pendo_visitor_id: String(row.visitorId  || ''),  // matches Supabase column name
        score:            Number(score),
        verbatim:         poll.freeTextResponse || poll.text || null,
        response_date:    row.browserTime
          ? new Date(row.browserTime).toISOString().split('T')[0]
          : null,
      });
    }
  }

  return responses;
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
            lastVisit:      'lastVisit',
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
