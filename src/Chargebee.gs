// ============================================================
// CHARGEBEE SYNC
//
// Pulls all active customers + all unpaid invoices (last 180d),
// then rolls them up by normalized account name so multi-location
// brands (e.g. a franchise with 50 Chargebee customer records)
// appear as a single row in the Master sheet.
//
// ARR  = (customer.mrr / 100) * 12   (mrr is stored in cents)
// ============================================================

function buildChargebeeData() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CHARGEBEE_API_KEY');
  if (!apiKey) throw new Error('CHARGEBEE_API_KEY not set in Script Properties.');

  const customers = cbFetchAllCustomers(apiKey);
  Logger.log(`Chargebee: ${customers.length} customers fetched`);

  const balanceMap = cbFetchUnpaidBalances(apiKey);
  Logger.log(`Chargebee: unpaid balances for ${Object.keys(balanceMap).length} customers`);

  // Roll up by normalized name
  const rollup = {};

  customers.forEach(c => {
    const rawName = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    const name    = normalizeName(rawName);
    if (!name) return;

    const arr     = ((c.mrr || 0) / 100) * 12;
    const balance = balanceMap[c.id] || 0;

    if (!rollup[name]) {
      rollup[name] = {
        account_name:        name,
        account_id:          c.id,   // first CB ID encountered for this name
        arr:                 0,
        outstanding_balance: 0,
        cb_customer_count:   0,
      };
    }

    rollup[name].arr                += arr;
    rollup[name].outstanding_balance += balance;
    rollup[name].cb_customer_count   += 1;
  });

  return Object.values(rollup);
}

// ── Fetch all active customers (paginated) ──────────────────

function cbFetchAllCustomers(apiKey) {
  const results = [];
  let offset    = null;

  do {
    const params = { 'status[is]': 'active', 'limit': '100' };
    if (offset) params['offset'] = offset;

    const url = cbBuildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers`, params);
    const res  = cbRequest(url, apiKey);

    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) Utilities.sleep(400);
  } while (offset);

  return results;
}

// ── Fetch ALL unpaid invoices in one paginated sweep ────────
// Returns { customer_id: totalOutstandingDollars }

function cbFetchUnpaidBalances(apiKey) {
  const cutoff = Math.floor(Date.now() / 1000) - 180 * 86400;
  const map    = {};
  let offset   = null;

  do {
    const params = {
      'status[in]':        'payment_due,not_paid',
      'updated_at[after]': String(cutoff),
      'limit':             '100',
    };
    if (offset) params['offset'] = offset;

    const url = cbBuildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/invoices`, params);
    const res  = cbRequest(url, apiKey);

    if (!res || !res.list) break;
    res.list.forEach(item => {
      const inv = item.invoice;
      if (!inv) return;
      const cid   = inv.customer_id;
      const owing = (inv.amount_due || 0) / 100;
      map[cid]    = (map[cid] || 0) + owing;
    });
    offset = res.next_offset || null;
    if (offset) Utilities.sleep(400);
  } while (offset);

  return map;
}

// ── Shared HTTP helpers ─────────────────────────────────────

function cbBuildUrl(base, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

function cbRequest(url, apiKey, retries = 3) {
  const options = {
    method:             'get',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':'),
      Accept:        'application/json',
    },
    muteHttpExceptions: true,
  };

  for (let i = 0; i < retries; i++) {
    try {
      const res  = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();

      if (code === 200) return JSON.parse(res.getContentText());
      if (code === 429) { Utilities.sleep(1000 * Math.pow(2, i + 1)); continue; }
      if (code === 404) return null;

      Logger.log(`Chargebee ${code}: ${res.getContentText().slice(0, 200)}`);
      return null;
    } catch (e) {
      Logger.log(`Chargebee request error (attempt ${i + 1}): ${e}`);
      Utilities.sleep(1000 * Math.pow(2, i + 1));
    }
  }
  return null;
}
