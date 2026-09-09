// ============================================================
// SLACK NOTIFICATIONS
//
// postAccountFlagAlert(account, flagEntries, dashboardUrl)
//   — posts one message per account covering every newly-triggered flag
//
// postWeeklyDigest(digestPayload)
//   — posts the Monday morning NPS + risk summary
// ============================================================

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ── Flag alert ───────────────────────────────────────────────

/**
 * Post ONE Slack message covering every newly-triggered flag for a single
 * account, instead of one message per flag. An account that trips several
 * flags the same day (e.g. health score drop + renewal at risk + login
 * stale) used to page the channel once per flag — this collapses that into
 * a single alert listing all of them.
 *
 * @param {object} account       — account row from Supabase
 * @param {Array}  flagEntries   — [{ flagKey, label, metric }], newly-triggered flags for this account
 * @param {string} dashboardBase — base URL of the Vercel deployment
 */
export async function postAccountFlagAlert(account, flagEntries, dashboardBase) {
  if (!flagEntries.length) return;

  const arr    = formatMoney(account.arr || 0);
  const am     = account.account_manager || 'Unassigned';
  const name   = account.account_name;
  const link   = `${dashboardBase}?account=${encodeURIComponent(name)}`;
  const headerEmoji = flagEntries.length > 1 ? '🚨' : flagEmoji(flagEntries[0].flagKey);

  // Plain-text fallback (shown in notifications / clients that don't render blocks)
  const text = `${headerEmoji} ${name} — ${flagEntries.length} flag${flagEntries.length > 1 ? 's' : ''} triggered`;

  // One line per flag: emoji + label + what triggered it.
  const flagList = flagEntries
    .map(({ flagKey, label, metric }) => `${flagEmoji(flagKey)} *${label}*\n${metric}`)
    .join('\n\n');

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerEmoji} *${name}*\nAM: ${am}   ·   ARR: ${arr}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open Account →', emoji: false },
        url: link,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: flagList },
    },
  ];

  await slackPost({ text, blocks });
}

/**
 * Post the Monday weekly digest to Slack.
 *
 * @param {object} digest
 *   .arrAtRiskEntered Array<{ account_name, account_manager, arr }>
 *   .arrAtRiskExited  Array<{ account_name, account_manager, arr }>
 *   .netArrRiskChange number (positive = more ARR at risk)
 */
export async function postWeeklyDigest(digest) {
  const {
    arrAtRiskEntered,
    arrAtRiskExited,
    netArrRiskChange,
  } = digest;

  const enteredList = arrAtRiskEntered.length
    ? arrAtRiskEntered.map(a => `• ${a.account_name} — ${formatMoney(a.arr)}`).join('\n')
    : '• None entered';

  const exitedList = arrAtRiskExited.length
    ? arrAtRiskExited.map(a => `• ${a.account_name} — ${formatMoney(a.arr)}`).join('\n')
    : '• None exited';

  const netDir    = netArrRiskChange >= 0 ? `↑ +${formatMoney(netArrRiskChange)}` : `↓ ${formatMoney(Math.abs(netArrRiskChange))}`;
  const netEmoji  = netArrRiskChange > 0 ? '🔴' : netArrRiskChange < 0 ? '🟢' : '⚪';

  const lines = [
    `📊 *Weekly CX Digest — ${todayLabel()}*`,
    '',
    `*📉 ARR At-Risk Movement*`,
    `Entered at-risk:\n${enteredList}`,
    `Exited at-risk:\n${exitedList}`,
    `Net ARR risk change: ${netEmoji} ${netDir}`,
  ].filter(l => l !== undefined).join('\n');

  await slackPost({ text: lines });
}

// ── Escalation alert ─────────────────────────────────────────

/**
 * Post a Slack alert for a newly added manual escalation note.
 *
 * @param {object} escalation  — row from the escalations table
 * @param {string} dashboardBase
 */
export async function postEscalationAlert(escalation, dashboardBase) {
  const name    = escalation.account_name || 'Unknown account';
  const addedBy = escalation.created_by   || 'Unknown';
  const note    = (escalation.note || escalation.description || '').slice(0, 300);
  const link    = dashboardBase;

  const text = [
    `🚨 *Escalation note added* — ${name}`,
    `Added by: ${addedBy}`,
    note ? `Note: _"${note}"_` : '',
    `<${link}|View account →>`,
  ].filter(Boolean).join('\n');

  await slackPost({ text });
}

// ── Internal helpers ─────────────────────────────────────────

async function slackPost(payload) {
  if (process.env.DISABLE_SLACK === 'true') {
    console.log('DISABLE_SLACK=true — skipping Slack post.');
    return;
  }

  if (!WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not set — skipping Slack post.');
    console.log('Slack payload:', JSON.stringify(payload, null, 2));
    return;
  }

  const res = await fetch(WEBHOOK_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Slack webhook failed (${res.status}):`, body.slice(0, 200));
  }
}

function flagEmoji(flagKey) {
  const map = {
    flag_churn_verbatim:        '🆘',
    flag_zero_roi_new:          '⚡',
    flag_paid_feature_lapsed:   '😴',
    flag_billing_balance:       '💳',
    flag_health_score_drop:     '📉',
    flag_health_tier_drop:      '🔴',
    flag_renewal_at_risk:       '📅',
    flag_zero_apps_established: '📭',
    flag_login_stale_14:        '💤',
    flag_login_stale_30:        '💤',
    flag_login_stale_90:        '☠️',
  };
  return map[flagKey] || '🚨';
}

function formatMoney(amount) {
  if (!amount) return '$0';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000)     return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
