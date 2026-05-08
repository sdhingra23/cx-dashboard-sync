// ============================================================
// CONFIG
//
// Secrets belong in Script Properties, NOT here.
// Apps Script editor → Project Settings → Script properties
// Required keys:
//   CHARGEBEE_API_KEY   — Chargebee API key (read-only key is fine)
//   METABASE_USER       — Metabase login email
//   METABASE_PASS       — Metabase login password
// ============================================================

const CHARGEBEE_SITE    = 'higherme';
const SPREADSHEET_ID    = '1VTB-qXUoB-LMR4McuyVArnBJOVEzgafv3yj8ZhWdjNI';
const MASTER_SHEET_NAME = 'Master';
const METABASE_BASE_URL = 'https://analytics.higherme.dev';

// ============================================================
// METABASE QUESTIONS
//
// Fill in question IDs once collected. Each entry needs:
//   id      — the numeric ID in the Metabase URL (/question/{id})
//   columns — exact column names the question returns, one of which
//             must be the account identifier (mapped via ACCT_NAME_ALIASES)
//
// The column names here must match the `key` values in MASTER_COLUMNS
// below (case-insensitive match is attempted automatically).
// ============================================================
const METABASE_QUESTIONS = {
  // productUsage: {
  //   id: 0,
  //   columns: [
  //     'account_name',
  //     'active_locations', 'total_locations', 'open_jobs_count',
  //     'applications_30d', 'tta_apps_count_90d', 'no_tta_apps_90d',
  //     'nextmatch_calls_90d', 'job_boost_enabled', 'job_boost_last_used_days',
  //     'connected_calendars', 'total_hired', 'total_interviews',
  //     'avg_time_to_invite_days', 'avg_time_to_hire_days',
  //   ],
  // },
  // configGaps: {
  //   id: 0,
  //   columns: [
  //     'account_name',
  //     'perc_no_indeed', 'perc_no_active_jobs', 'perc_no_job_boosts',
  //     'perc_no_perks', 'perc_no_salaries',
  //   ],
  // },
};

// ============================================================
// MASTER SHEET COLUMNS
//
// type: 'key'    — primary key, never overwritten
//       'auto'   — overwritten every sync run
//       'manual' — written only when the row is brand-new;
//                  human edits are preserved on subsequent syncs
// ============================================================
const MASTER_COLUMNS = [
  { key: 'account_name',             label: 'Account Name',                    type: 'key'    },
  { key: 'account_id',               label: 'Account ID',                      type: 'auto'   },
  { key: 'arr',                      label: 'ARR',                             type: 'auto'   },
  { key: 'outstanding_balance',      label: 'Outstanding Balance',             type: 'auto'   },
  { key: 'cb_customer_count',        label: 'CB Customer Count',               type: 'auto'   },
  // ── manual / human-maintained ────────────────────────────
  { key: 'health_status',            label: 'Health Status',                   type: 'manual' },
  { key: 'account_manager',          label: 'Account Manager',                 type: 'manual' },
  { key: 'manual_escalation',        label: 'Manual Escalation',               type: 'manual' },
  { key: 'last_meeting_date',        label: 'Last Meeting Date',               type: 'manual' },
  { key: 'meeting_cadence_days',     label: 'Meeting Cadence (Days)',          type: 'manual' },
  { key: 'brand_name',               label: 'Brand Name',                      type: 'manual' },
  { key: 'ai_summary',               label: 'AI Summary',                      type: 'manual' },
  { key: 'recommended_action',       label: 'Recommended Action',              type: 'manual' },
  { key: 'cx_gut_score',             label: 'CX gut score',                    type: 'manual' },
  { key: 'calculated_health_score',  label: 'Calculated health score',         type: 'manual' },
  { key: 'total_health_score',       label: 'Total health score',              type: 'manual' },
  { key: 'feature_onboarding',       label: 'Feature: Onboarding',             type: 'manual' },
  { key: 'feature_nextmatch',        label: 'Feature: NextMatch',              type: 'manual' },
  { key: 'linkedin_enabled',         label: 'LinkedIn integration enabled',    type: 'manual' },
  // ── from Metabase ────────────────────────────────────────
  { key: 'perc_no_indeed',           label: '% locations with no indeed apps', type: 'auto'   },
  { key: 'perc_no_active_jobs',      label: '% locations with no active jobs', type: 'auto'   },
  { key: 'perc_no_job_boosts',       label: '% locations with no job boosts',  type: 'auto'   },
  { key: 'perc_no_perks',            label: '% jobs with no perks',            type: 'auto'   },
  { key: 'perc_no_salaries',         label: '% jobs with no salaries',         type: 'auto'   },
  { key: 'no_tta_apps_90d',          label: 'No TTA apps (90d)',               type: 'auto'   },
  { key: 'tta_apps_count_90d',       label: 'TTA Apps Count (90d)',            type: 'auto'   },
  { key: 'connected_calendars',      label: 'No connected calendars',          type: 'auto'   },
  { key: 'total_hired',              label: 'Total hired',                     type: 'auto'   },
  { key: 'total_interviews',         label: 'Total interviews',                type: 'auto'   },
  { key: 'avg_time_to_invite_days',  label: 'Avg Time to Invite (Days)',       type: 'auto'   },
  { key: 'avg_time_to_hire_days',    label: 'Avg Time to Hire (Days)',         type: 'auto'   },
  { key: 'active_locations',         label: 'Active Locations',                type: 'auto'   },
  { key: 'total_locations',          label: 'Total Locations',                 type: 'auto'   },
  { key: 'open_jobs_count',          label: 'Open Jobs Count',                 type: 'auto'   },
  { key: 'applications_30d',         label: 'Applications (30d)',              type: 'auto'   },
  { key: 'nextmatch_calls_90d',      label: 'NextMatch Calls (90d)',           type: 'auto'   },
  { key: 'job_boost_enabled',        label: 'Job Boost Enabled',               type: 'auto'   },
  { key: 'job_boost_last_used_days', label: 'Job Boost Last Used (Days)',      type: 'auto'   },
  // ── metadata ─────────────────────────────────────────────
  { key: 'last_synced',              label: 'Last Synced',                     type: 'auto'   },
];
