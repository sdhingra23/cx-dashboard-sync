// ============================================================
// METABASE CLIENT
//
// Ported from Metabase.gs.
// mbGetSession()   — POST /api/session, returns token string.
// mbRunQuestion()  — POST /api/card/{id}/query/json, returns rows[].
// buildMetabaseData() — runs all configured questions in parallel
//                       via Promise.all and merges by normalized name.
// ============================================================

import { normalizeName } from './normalize.js';

const BASE_URL = process.env.METABASE_BASE_URL;

// Column name variants Metabase questions might use for account name
const ACCT_NAME_CANDIDATES = [
  'account_name', 'account name',
  'company', 'company_name', 'company name',
  'customer_name', 'customer name',
  'client_name',  'client name',
];

// ── Session ──────────────────────────────────────────────────

/**
 * Authenticate to Metabase and return a session token.
 * No caching — each GitHub Actions run authenticates fresh.
 */
export async function mbGetSession() {
  const user = (process.env.METABASE_USER || '').trim();
  const pass = (process.env.METABASE_PASS || '').trim();
  if (!user || !pass) throw new Error('METABASE_USER or METABASE_PASS env var not set.');

  const res = await fetch(`${BASE_URL}/api/session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: user, password: pass }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Metabase auth failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  console.log('Metabase: session token obtained');
  return json.id;
}

// ── Run a saved question ─────────────────────────────────────

/**
 * Execute a saved Metabase question and return an array of row objects.
 * Handles both response shapes:
 *   Shape A: flat array [{col: val}, ...]
 *   Shape B: {data: {rows: [...], cols: [...]}}
 */
export async function mbRunQuestion(questionId, token, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/card/${questionId}/query/json`, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-Metabase-Session': token,
      },
      body:   JSON.stringify({ parameters: [] }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`MB Q${questionId} timed out after ${timeoutMs / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  console.log(`MB Q${questionId} → HTTP ${res.status}, body length=${body.length}`);

  if (!res.ok) throw new Error(`MB Q${questionId} HTTP ${res.status}: ${body.slice(0, 300)}`);

  return mbParseResponse(body);
}

/** Handles both Metabase JSON response shapes */
function mbParseResponse(responseText) {
  const parsed = JSON.parse(responseText);

  // Shape A: flat array
  if (Array.isArray(parsed)) return parsed;

  // Shape B: {data: {rows, cols}}
  if (parsed.data && Array.isArray(parsed.data.rows)) {
    const colNames = parsed.data.cols.map(c => c.display_name || c.name);
    return parsed.data.rows.map(row => {
      const obj = {};
      colNames.forEach((name, i) => { obj[name] = row[i]; });
      return obj;
    });
  }

  console.warn('Metabase: unrecognised response shape —', responseText.slice(0, 200));
  return [];
}

// ── Extract account name from a row ─────────────────────────

function mbExtractAccountName(row) {
  const norm = k => k.toLowerCase().replace(/[\s]+/g, '_');
  const rowKeyMap = Object.keys(row).reduce((m, k) => {
    m[norm(k)] = k;
    return m;
  }, {});

  for (const candidate of ACCT_NAME_CANDIDATES) {
    const originalKey = rowKeyMap[norm(candidate)];
    if (originalKey !== undefined && row[originalKey] !== null && row[originalKey] !== '') {
      return String(row[originalKey]);
    }
  }
  return null;
}

// ── Public entry point ───────────────────────────────────────

/**
 * Run all configured Metabase questions in parallel.
 *
 * Questions that return one row per *company* (multi-row per account) must
 * declare an `aggregate` map on the question config so values are summed or
 * averaged correctly rather than just overwritten by the last row.
 *
 *   aggregate: {
 *     'original_column_name': 'sum' | 'avg' | 'first' | 'last'
 *   }
 *
 * 'last' is the default (original behaviour — last row wins).
 *
 * @param {object} questions  — METABASE_QUESTIONS config object
 * @param {string} token      — session token from mbGetSession()
 * @returns {object}          — { normalizedAccountName: { ...mergedColumns } }
 */
export async function buildMetabaseData(questions, token) {
  const activeEntries = Object.entries(questions).filter(([, cfg]) => cfg && cfg.id);

  if (activeEntries.length === 0) {
    console.log('Metabase: no question IDs configured — skipping.');
    return {};
  }

  // Run all questions in parallel
  const results = await Promise.all(
    activeEntries.map(async ([qName, cfg]) => {
      console.log(`Metabase: running question "${qName}" (id=${cfg.id})`);
      try {
        const rows = await mbRunQuestion(cfg.id, token);
        console.log(`Metabase question "${qName}": ${rows.length} rows`);
        return { qName, cfg, rows };
      } catch (e) {
        console.error(`Metabase question "${qName}" failed:`, e.message);
        return { qName, cfg, rows: [] };
      }
    })
  );

  // ── Pass 1: accumulate values per account ──────────────────
  // acc[acctName][targetKey] = value  (for 'last'/'first'/'sum')
  // acc[acctName]['__avg_' + targetKey] = { sum, n }  (for 'avg')

  const acc = {};

  for (const { cfg, rows } of results) {
    for (const row of rows) {
      const rawName  = mbExtractAccountName(row);
      const acctName = normalizeName(rawName);
      if (!acctName) continue;

      if (!acc[acctName]) acc[acctName] = {};

      const rowKeyMap = Object.keys(row).reduce((m, k) => {
        m[k.toLowerCase().replace(/\s+/g, '_')] = k;
        return m;
      }, {});

      for (const col of (cfg.columns || [])) {
        const colNorm   = col.toLowerCase().replace(/\s+/g, '_');
        if (colNorm === 'account_name') continue;
        const rowKey    = rowKeyMap[colNorm];
        if (rowKey === undefined) continue;

        const targetKey = cfg.columnMap?.[col] ?? col;
        const aggType   = cfg.aggregate?.[col] ?? 'last';
        const rawVal    = row[rowKey];

        if (aggType === 'sum') {
          acc[acctName][targetKey] = (acc[acctName][targetKey] || 0) + (Number(rawVal) || 0);

        } else if (aggType === 'avg') {
          const slot = `__avg_${targetKey}`;
          if (!acc[acctName][slot]) acc[acctName][slot] = { sum: 0, n: 0 };
          const num = Number(rawVal);
          if (!isNaN(num) && rawVal !== null && rawVal !== undefined) {
            acc[acctName][slot].sum += num;
            acc[acctName][slot].n   += 1;
          }

        } else if (aggType === 'first') {
          if (acc[acctName][targetKey] === undefined) {
            acc[acctName][targetKey] = rawVal;
          }

        } else {
          // 'last' — default: last row wins
          acc[acctName][targetKey] = rawVal;
        }
      }
    }
  }

  // ── Pass 2: resolve avg accumulators into final values ─────
  const merged = {};
  for (const [acctName, fields] of Object.entries(acc)) {
    merged[acctName] = { account_name: acctName };
    for (const [key, val] of Object.entries(fields)) {
      if (key.startsWith('__avg_')) {
        const targetKey = key.slice(6); // strip '__avg_'
        merged[acctName][targetKey] = val.n > 0
          ? Math.round((val.sum / val.n) * 100) / 100
          : null;
      } else {
        merged[acctName][key] = val;
      }
    }
  }

  return merged;
}
