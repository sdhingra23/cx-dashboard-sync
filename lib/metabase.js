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
export async function mbRunQuestion(questionId, token) {
  const res = await fetch(`${BASE_URL}/api/card/${questionId}/query/json`, {
    method:  'POST',
    headers: {
      'Content-Type':       'application/json',
      'X-Metabase-Session': token,
    },
    body: JSON.stringify({ parameters: [] }),
  });

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
 * @param {object} questions  — same shape as METABASE_QUESTIONS in Config.gs
 *                             { questionKey: { id: number, columns: string[] } }
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

  // Merge all question results by normalized account name
  const merged = {};

  for (const { cfg, rows } of results) {
    for (const row of rows) {
      const rawName  = mbExtractAccountName(row);
      const acctName = normalizeName(rawName);
      if (!acctName) continue;

      if (!merged[acctName]) merged[acctName] = { account_name: acctName };

      // Map configured column names onto row values (case-insensitive)
      const rowKeyMap = Object.keys(row).reduce((m, k) => {
        m[k.toLowerCase().replace(/\s+/g, '_')] = k;
        return m;
      }, {});

      for (const col of (cfg.columns || [])) {
        if (col === 'account_name') continue;
        const rowKey = rowKeyMap[col.toLowerCase()];
        if (rowKey !== undefined) merged[acctName][col] = row[rowKey];
      }
    }
  }

  return merged;
}
