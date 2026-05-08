// ============================================================
// METABASE SYNC
//
// Authenticates against the self-hosted Metabase instance,
// caches the session token in Script Properties (12-hour TTL),
// runs each configured saved question, and returns a merged
// map of { normalizedAccountName → { ...metricColumns } }.
//
// Questions must return one row per account, with an account
// name column (see ACCT_NAME_KEYS below for accepted variants).
// ============================================================

const MB_TOKEN_KEY    = 'MB_SESSION_TOKEN';
const MB_TOKEN_TS_KEY = 'MB_SESSION_TS';
const MB_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Column name variants Metabase questions might use for account name
const ACCT_NAME_KEYS = [
  'account_name', 'Account Name', 'company', 'Company',
  'customer_name', 'Customer Name', 'client_name', 'Client Name',
];

// ── Public entry point ──────────────────────────────────────

function buildMetabaseData() {
  const activeQuestions = Object.entries(METABASE_QUESTIONS)
    .filter(([, cfg]) => cfg && cfg.id);

  if (activeQuestions.length === 0) {
    Logger.log('Metabase: no question IDs configured — skipping.');
    return {};
  }

  const merged = {};

  for (const [qName, cfg] of activeQuestions) {
    Logger.log(`Metabase: running question "${qName}" (id=${cfg.id})`);

    let rows;
    try {
      rows = mbRunQuestion(cfg.id);
    } catch (e) {
      Logger.log(`Metabase question "${qName}" failed: ${e}`);
      continue;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      Logger.log(`Metabase question "${qName}" returned no rows`);
      continue;
    }

    Logger.log(`Metabase question "${qName}": ${rows.length} rows`);

    rows.forEach(row => {
      const rawName  = mbExtractAccountName(row);
      const acctName = normalizeName(rawName);
      if (!acctName) return;

      if (!merged[acctName]) merged[acctName] = { account_name: acctName };

      // Map configured columns onto the master key names (case-insensitive)
      const rowKeyMap = Object.keys(row).reduce((m, k) => {
        m[k.toLowerCase().replace(/\s+/g, '_')] = k;
        return m;
      }, {});

      (cfg.columns || [])
        .filter(col => col !== 'account_name')
        .forEach(col => {
          const rowKey = rowKeyMap[col.toLowerCase()];
          if (rowKey !== undefined) merged[acctName][col] = row[rowKey];
        });
    });

    Utilities.sleep(300);
  }

  return merged;
}

// ── Run a saved question, return array of row objects ───────

function mbRunQuestion(questionId) {
  const token = mbGetSession();

  const res = UrlFetchApp.fetch(
    `${METABASE_BASE_URL}/api/card/${questionId}/query/json`,
    {
      method:             'post',
      headers:            { 'X-Metabase-Session': token },
      contentType:        'application/json',
      payload:            JSON.stringify({}),
      muteHttpExceptions: true,
    }
  );

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    throw new Error(`HTTP ${code}: ${body.slice(0, 300)}`);
  }

  return mbParseResponse(body);
}

// Handles both response shapes Metabase may return
function mbParseResponse(responseText) {
  const parsed = JSON.parse(responseText);

  // Shape A: flat array  [{col: val}, ...]
  if (Array.isArray(parsed)) return parsed;

  // Shape B: {data: {rows: [...], cols: [...]}}
  if (parsed.data && Array.isArray(parsed.data.rows)) {
    const colNames = parsed.data.cols.map(c => c.display_name || c.name);
    return parsed.data.rows.map(row => {
      const obj = {};
      colNames.forEach((name, i) => { obj[name] = row[i]; });
      return obj;
    });
  }

  Logger.log(`Metabase: unrecognised response shape — ${responseText.slice(0, 200)}`);
  return [];
}

// ── Session token management ────────────────────────────────

function mbGetSession() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(MB_TOKEN_KEY);
  const ts    = Number(props.getProperty(MB_TOKEN_TS_KEY) || 0);

  if (token && (Date.now() - ts) < MB_TOKEN_TTL_MS) return token;

  const user = props.getProperty('METABASE_USER');
  const pass = props.getProperty('METABASE_PASS');
  if (!user || !pass) throw new Error('METABASE_USER or METABASE_PASS not set in Script Properties.');

  const res = UrlFetchApp.fetch(`${METABASE_BASE_URL}/api/session`, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({ username: user, password: pass }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Metabase auth failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }

  const newToken = JSON.parse(res.getContentText()).id;
  props.setProperty(MB_TOKEN_KEY, newToken);
  props.setProperty(MB_TOKEN_TS_KEY, String(Date.now()));
  Logger.log('Metabase: new session token obtained');
  return newToken;
}

// Call this to force re-authentication on next run
function mbClearSession() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(MB_TOKEN_KEY);
  props.deleteProperty(MB_TOKEN_TS_KEY);
  Logger.log('Metabase: session cleared');
}

// ── Helpers ─────────────────────────────────────────────────

function mbExtractAccountName(row) {
  for (const key of ACCT_NAME_KEYS) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return String(row[key]);
    }
  }
  return null;
}
