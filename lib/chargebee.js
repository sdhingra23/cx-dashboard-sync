// ============================================================
// CHARGEBEE CLIENT
//
// Ported from Chargebee.gs.
// Fetches all active customers + unpaid invoices (last 180d),
// rolls them up by normalized account name.
//
// ARR = (customer.mrr / 100) * 12   (mrr stored in cents)
// ============================================================

import { normalizeName } from './normalize.js';

const CHARGEBEE_SITE = 'higherme';
const LOOKBACK_DAYS  = 180;

// ── Public entry point ───────────────────────────────────────

/**
 * Fetch and roll up all Chargebee data.
 * @param {string} apiKey — CHARGEBEE_API_KEY
 * @returns {Array<{account_name, account_id, email, arr, outstanding_balance, cb_customer_count, create_date, renewal_date}>}
 */
export async function buildChargebeeData(apiKey) {
  if (!apiKey) throw new Error('CHARGEBEE_API_KEY not set.');

  // Fetch customers, unpaid balances, and subscriptions in parallel
  const [customers, balanceMap, subscriptions] = await Promise.all([
    cbFetchAllCustomers(apiKey),
    cbFetchUnpaidBalances(apiKey),
    cbFetchAllSubscriptions(apiKey),
  ]);

  console.log(`Chargebee: ${customers.length} customers, ${subscriptions.length} subscriptions fetched`);
  console.log(`Chargebee: unpaid balances for ${Object.keys(balanceMap).length} customers`);

  // Build renewal map: customer_id → soonest current_term_end (ISO date string)
  // Multiple subscriptions per customer (base + add-ons) → take earliest end date
  const subEndMap = {};
  for (const sub of subscriptions) {
    if (!sub.customer_id || !sub.current_term_end) continue;
    const endDate = new Date(sub.current_term_end * 1000).toISOString().split('T')[0];
    if (!subEndMap[sub.customer_id] || endDate < subEndMap[sub.customer_id]) {
      subEndMap[sub.customer_id] = endDate;
    }
  }

  // Roll up by normalized account name
  const rollup = {};

  for (const c of customers) {
    if (!c.mrr || c.mrr === 0) continue; // skip non-paying customers

    const rawName = c.company || [c.first_name, c.last_name].filter(Boolean).join(' ');
    const name    = normalizeName(rawName);
    if (!name) continue;

    const arr     = (c.mrr / 100) * 12;
    const balance = balanceMap[c.id] || 0;

    if (!rollup[name]) {
      // First customer for this account sets identity + dates
      rollup[name] = {
        account_name:        name,
        account_id:          c.id,
        email:               c.email || '',
        arr:                 0,
        outstanding_balance: 0,
        cb_customer_count:   0,
        create_date:         c.created_at
          ? new Date(c.created_at * 1000).toISOString().split('T')[0]
          : null,
        renewal_date:        subEndMap[c.id] || null,
      };
    } else {
      // Subsequent customers for same account: take earliest create_date, latest renewal_date
      const thisCreate  = c.created_at
        ? new Date(c.created_at * 1000).toISOString().split('T')[0]
        : null;
      const thisRenewal = subEndMap[c.id] || null;
      if (thisCreate && (!rollup[name].create_date || thisCreate < rollup[name].create_date)) {
        rollup[name].create_date = thisCreate;
      }
      if (thisRenewal && (!rollup[name].renewal_date || thisRenewal > rollup[name].renewal_date)) {
        rollup[name].renewal_date = thisRenewal; // latest renewal across all customers
      }
    }

    rollup[name].arr                += arr;
    rollup[name].outstanding_balance += balance;
    rollup[name].cb_customer_count   += 1;
  }

  return Object.values(rollup);
}

// ── Fetch all active subscriptions (paginated) ───────────────

async function cbFetchAllSubscriptions(apiKey) {
  const results = [];
  let offset    = null;

  do {
    const params = { 'status[is]': 'active', limit: '100' };
    if (offset) params.offset = offset;

    const url = cbBuildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/subscriptions`, params);
    const res  = await cbRequest(url, apiKey);

    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.subscription) results.push(item.subscription); });
    offset = res.next_offset || null;
    if (offset) await sleep(400);
  } while (offset);

  return results;
}

// ── Fetch all active customers (paginated) ───────────────────

async function cbFetchAllCustomers(apiKey) {
  const results = [];
  let offset    = null;

  do {
    const params = { 'status[is]': 'active', limit: '100' };
    if (offset) params.offset = offset;

    const url = cbBuildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/customers`, params);
    const res  = await cbRequest(url, apiKey);

    if (!res || !res.list) break;
    res.list.forEach(item => { if (item.customer) results.push(item.customer); });
    offset = res.next_offset || null;
    if (offset) await sleep(400);
  } while (offset);

  return results;
}

// ── Fetch all unpaid invoices (paginated, last 180d) ─────────
// Returns { customer_id: totalOutstandingDollars }

async function cbFetchUnpaidBalances(apiKey) {
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const map    = {};
  let offset   = null;

  do {
    const params = {
      'status[in][0]':     'payment_due',
      'status[in][1]':     'not_paid',
      'updated_at[after]': String(cutoff),
      limit:               '100',
    };
    if (offset) params.offset = offset;

    const url = cbBuildUrl(`https://${CHARGEBEE_SITE}.chargebee.com/api/v2/invoices`, params);
    const res  = await cbRequest(url, apiKey);

    if (!res || !res.list) break;
    res.list.forEach(item => {
      const inv = item.invoice;
      if (!inv) return;
      const owing  = (inv.amount_due || 0) / 100;
      map[inv.customer_id] = (map[inv.customer_id] || 0) + owing;
    });
    offset = res.next_offset || null;
    if (offset) await sleep(400);
  } while (offset);

  return map;
}

// ── HTTP helpers ─────────────────────────────────────────────

function cbBuildUrl(base, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

async function cbRequest(url, apiKey, retries = 3) {
  const headers = {
    Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
    Accept:        'application/json',
  };

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { method: 'GET', headers });

      if (res.ok)             return res.json();
      if (res.status === 429) { await sleep(1000 * Math.pow(2, i + 1)); continue; }
      if (res.status === 404) return null;

      const body = await res.text();
      console.error(`Chargebee ${res.status}: ${body.slice(0, 200)}`);
      return null;
    } catch (e) {
      console.error(`Chargebee request error (attempt ${i + 1}):`, e.message);
      await sleep(1000 * Math.pow(2, i + 1));
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
