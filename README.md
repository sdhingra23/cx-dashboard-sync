# CX Dashboard Sync

Google Apps Script that auto-populates the CX Dashboard spreadsheet daily by pulling:
- **Chargebee** — ARR + outstanding balances for all active customers
- **Metabase** — product usage metrics from saved questions

---

## Setup

### 1. Create the Apps Script project

1. Open the target spreadsheet: https://docs.google.com/spreadsheets/d/1VTB-qXUoB-LMR4McuyVArnBJOVEzgafv3yj8ZhWdjNI
2. Go to **Extensions → Apps Script**
3. Delete the default `Code.gs` file
4. Create the following files and paste the contents from `src/`:

| File in repo | Create in Apps Script as |
|---|---|
| `src/Config.gs` | `Config.gs` |
| `src/Normalize.gs` | `Normalize.gs` |
| `src/Chargebee.gs` | `Chargebee.gs` |
| `src/Metabase.gs` | `Metabase.gs` |
| `src/Sync.gs` | `Sync.gs` |
| `src/Triggers.gs` | `Triggers.gs` |

### 2. Set Script Properties (secrets)

In Apps Script: **Project Settings → Script properties → Add property**

| Key | Value |
|---|---|
| `CHARGEBEE_API_KEY` | Your Chargebee read-only API key |
| `METABASE_USER` | Metabase login email |
| `METABASE_PASS` | Metabase login password |

Run `checkScriptProperties()` from the editor to verify all keys are present.

### 3. Add Metabase question IDs

Once you have collected the question IDs from Metabase (visible in the URL: `/question/{id}`), update `METABASE_QUESTIONS` in `Config.gs`:

```js
const METABASE_QUESTIONS = {
  productUsage: {
    id: 123,                   // ← your question ID
    columns: [
      'account_name',
      'active_locations', 'total_locations', 'open_jobs_count',
      'applications_30d', 'tta_apps_count_90d', 'no_tta_apps_90d',
      'nextmatch_calls_90d', 'job_boost_enabled', 'job_boost_last_used_days',
      'connected_calendars', 'total_hired', 'total_interviews',
      'avg_time_to_invite_days', 'avg_time_to_hire_days',
    ],
  },
  configGaps: {
    id: 456,                   // ← your question ID
    columns: [
      'account_name',
      'perc_no_indeed', 'perc_no_active_jobs', 'perc_no_job_boosts',
      'perc_no_perks', 'perc_no_salaries',
    ],
  },
};
```

The column names in `columns` must match what Metabase returns — run the question in Metabase and check the column headers. The sync does a case-insensitive match, so `Account_Name` and `account name` both work.

### 4. Run the first sync manually

In the Apps Script editor, select `syncAll` from the function dropdown and click **Run**. Check the **Execution log** for any errors.

### 5. Set up the daily trigger

Run `setupDailyTrigger()` once from the editor. This registers a daily 6 AM trigger. It is safe to re-run — it removes the old trigger first.

---

## How it works

```
syncAll()
  ├── loadMaster()          reads existing sheet → preserves manual columns
  ├── buildChargebeeData()  fetches all active customers + unpaid invoices
  │     └── rolls up by normalised account name (handles multi-location franchises)
  ├── buildMetabaseData()   runs each saved question, merges by account name
  └── writeMaster()         writes sorted result back to Master sheet
```

### Column types

| Type | Behaviour |
|---|---|
| `key` | Primary key (`Account Name`) — never overwritten |
| `auto` | Overwritten every sync from Chargebee / Metabase |
| `manual` | Written once on new row creation; human edits are **preserved** on subsequent syncs |

Manual columns include: Health Status, Account Manager, Escalation, Meeting dates, Brand Name, AI Summary, health scores, feature flags.

### Franchise rollup

Multiple Chargebee customer records with the same (normalised) company name are summed into one row: ARR and outstanding balance are aggregated, and `CB Customer Count` shows how many records were merged.

Add name variants to `BRAND_ALIASES` in `Normalize.gs` as needed.

---

## File reference

| File | Purpose |
|---|---|
| `Config.gs` | Constants, column schema, Metabase question map |
| `Normalize.gs` | `normalizeName()` + `BRAND_ALIASES` |
| `Chargebee.gs` | Fetch customers + invoices, build rollup |
| `Metabase.gs` | Session auth, run questions, parse responses |
| `Sync.gs` | `syncAll()` orchestrator + sheet read/write |
| `Triggers.gs` | Daily trigger setup + property validation |
