// ============================================================
// SLACK NOTIFICATIONS
//
// postFlagAlert(flag, account, dashboardUrl)
//   — posts a single flag alert block to the configured webhook
//
// postWeeklyDigest(digestPayload)
//   — posts the Monday morning NPS + risk summary
// ============================================================

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ── Flag alert ───────────────────────────────────────────────

/**
 * Post a single daily flag alert to Slack.
 *
 * @param {string} flagKey    — e.g. 'flag_billing_balance'
 * @param {string} flagLabel  — human-readable label
 * @param {object} account    — account row from Supabase
 * @param {string} metricNote — the specific metric that triggered it
 * @param {string} dashboardBase — base URL of the Vercel deployment
 */
export async function postFlagAlert(flagKey, flagLabel, account, metricNote, dashboardBase) {
  const arr      = formatMoney(account.arr || 0);
  const am       = account.account_manager || 'Unassigned';
  const name     = account.account_name;
  const link     = `${dashboardBase}?account=${encodeURIComponent(account.account_id)}`;
  const emoji    = flagEmoji(flagKey);

  const text = [
    `${emoji} *${flagLabel}*`,
    `Account: *${name}*  |  AM: ${am}  |  ARR: ${arr}`,
    `Metric: ${metricNote}`,
    `<${link}|View account →>`,
  ].join('\n');

  await slackPost({ text });
}

/**
 * Post the Monday weekly digest to Slack.
 *
 * @param {object} digest
 *   .npsThisWeek      { totalResponses, avgScore, detractorCount, verbatims[] }
 *   .npsLastWeek      { detractorCount }
 *   .repeatDetractors Array<{ account_name, account_manager, arr }>
 *   .arrAtRiskEntered Array<{ account_name, account_manager, arr }>
 *   .arrAtRiskExited  Array<{ account_name, account_manager, arr }>
 *   .netArrRiskChange number (positive = more ARR at risk)
 */
export async function postWeeklyDigest(digest) {
  const {
    npsThisWeek,
    npsLastWeek,
    repeatDetractors,
    arrAtRiskEntered,
    arrAtRiskExited,
    netArrRiskChange,
  } = digest;

  const detectorDelta = npsThisWeek.detractorCount - (npsLastWeek?.detractorCount || 0);
  const detractorDir  = detectorDelta > 0 ? `↑ +${detectorDelta}` : detectorDelta < 0 ? `↓ ${detectorDelta}` : '→ unchanged';
  const detractorEmoji = detectorDelta > 0 ? '🔴' : detectorDelta < 0 ? '🟢' : '⚪';

  // Verbatim sample (up to 3, churn-signal keywords bolded)
  const churnKw = ['cancel', 'leaving', 'switching', 'last month', 'no improvement'];
  const verbatimSample = (npsThisWeek.verbatims || [])
    .filter(v => v && v.trim())
    .slice(0, 3)
    .map(v => `> _"${v.slice(0, 150)}${v.length > 150 ? '…' : ''}"_`)
    .join('\n');

  const repeatList = repeatDetractors.length
    ? repeatDetractors.map(a => `• ${a.account_name} (${a.account_manager || '—'}, ${formatMoney(a.arr)})`).join('\n')
    : '• None this week ✅';

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
    `*NPS Summary*`,
    `Responses this week: *${npsThisWeek.totalResponses}*  |  Avg score: *${npsThisWeek.avgScore ?? '—'}*`,
    `Detractors: ${detractorEmoji} *${npsThisWeek.detractorCount}* ${detractorDir} vs last week`,
    verbatimSample ? `\nVerbatim sample:\n${verbatimSample}` : '',
    '',
    `*🔁 Repeat Detractor Watchlist* (0–6 score in 2+ consecutive weekly snapshots)`,
    repeatList,
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
  const link    = `${dashboardBase}?account=${encodeURIComponent(escalation.account_id || '')}`;

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
    flag_promoter_flip:         '📉',
    flag_zero_roi_new:          '⚡',
    flag_paid_feature_lapsed:   '😴',
    flag_time_to_invite_high:   '⏱',
    flag_billing_balance:       '💳',
    flag_health_score_drop:     '📉',
    flag_health_tier_drop:      '🔴',
    flag_renewal_at_risk:       '📅',
    flag_zero_apps_established: '📭',
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
