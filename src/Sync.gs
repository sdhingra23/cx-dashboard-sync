// ============================================================
// SYNC ORCHESTRATOR
//
// syncAll() is the single entry point called by the daily
// trigger (and can be run manually from the Apps Script editor).
//
// Merge strategy:
//   • 'auto' columns  → overwritten every run from CB / MB data
//   • 'manual' columns → written once on row creation; subsequent
//                        runs leave them untouched so human edits
//                        (health status, AM, escalation, etc.) persist
//   • 'key' columns   → never overwritten (account_name)
// ============================================================

function syncAll() {
  Logger.log('=== syncAll START ===');
  const startMs = Date.now();

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss, MASTER_SHEET_NAME);

  // 1. Load current Master — preserves manual columns
  const existing = loadMaster(sheet);
  Logger.log(`Master: ${Object.keys(existing).length} existing accounts`);

  // 2. Pull Chargebee
  let cbRows = [];
  try {
    cbRows = buildChargebeeData();
    Logger.log(`Chargebee: ${cbRows.length} accounts after rollup`);
  } catch (e) {
    Logger.log(`Chargebee sync error: ${e} — continuing without CB data`);
  }

  // 3. Pull Metabase
  let mbMap = {};
  try {
    mbMap = buildMetabaseData();
    Logger.log(`Metabase: ${Object.keys(mbMap).length} accounts`);
  } catch (e) {
    Logger.log(`Metabase sync error: ${e} — continuing without MB data`);
  }

  // 4. Merge into master map
  const merged = {};

  // Seed with existing rows (preserves manual data)
  Object.entries(existing).forEach(([name, row]) => {
    merged[name] = { ...row };
  });

  // Apply Chargebee auto columns
  cbRows.forEach(cb => {
    const name = cb.account_name;
    if (!merged[name]) merged[name] = { account_name: name };

    merged[name].account_id          = cb.account_id;
    merged[name].arr                 = cb.arr;
    merged[name].outstanding_balance = cb.outstanding_balance;
    merged[name].cb_customer_count   = cb.cb_customer_count;
  });

  // Apply Metabase auto columns
  const mbAutoKeys = MASTER_COLUMNS
    .filter(c => c.type === 'auto' && !['account_id', 'arr', 'outstanding_balance', 'cb_customer_count', 'last_synced'].includes(c.key))
    .map(c => c.key);

  Object.entries(mbMap).forEach(([name, mb]) => {
    if (!merged[name]) merged[name] = { account_name: name };
    mbAutoKeys.forEach(k => {
      if (mb[k] !== undefined) merged[name][k] = mb[k];
    });
  });

  // Stamp sync time
  const today = new Date().toISOString().split('T')[0];
  Object.values(merged).forEach(row => { row.last_synced = today; });

  // 5. Write back
  writeMaster(sheet, merged);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  Logger.log(`Master: wrote ${Object.keys(merged).length} rows in ${elapsed}s`);
  Logger.log('=== syncAll END ===');
}

// ── Read Master sheet → map by normalised account name ──────

function loadMaster(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};

  const rawHeaders = data[0].map(h => String(h).trim());
  const labelToKey = MASTER_COLUMNS.reduce((m, c) => { m[c.label] = c.key; return m; }, {});

  const result = {};
  data.slice(1).forEach(row => {
    const obj = {};
    rawHeaders.forEach((h, i) => {
      const key = labelToKey[h];
      if (key) obj[key] = row[i];
    });

    const name = normalizeName(obj.account_name);
    if (name) {
      obj.account_name = name;
      result[name] = obj;
    }
  });

  return result;
}

// ── Write full Master sheet ──────────────────────────────────

function writeMaster(sheet, merged) {
  const headers  = MASTER_COLUMNS.map(c => c.label);
  const sortedRows = Object.values(merged)
    .sort((a, b) => String(a.account_name || '').localeCompare(String(b.account_name || '')))
    .map(row => MASTER_COLUMNS.map(c => {
      const val = row[c.key];
      return val !== undefined && val !== null ? val : '';
    }));

  sheet.clearContents();

  // Header row
  const hRange = sheet.getRange(1, 1, 1, headers.length);
  hRange.setValues([headers]);
  hRange.setFontWeight('bold')
        .setBackground('#1e293b')
        .setFontColor('#ffffff')
        .setFontSize(11);

  // Data rows
  if (sortedRows.length > 0) {
    sheet.getRange(2, 1, sortedRows.length, headers.length).setValues(sortedRows);
  }

  sheet.setFrozenRows(1);
  try { sheet.autoResizeColumns(1, headers.length); } catch (_) {}
}

// ── Utility ──────────────────────────────────────────────────

function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
