// ============================================================
// TRIGGERS
//
// Run setupDailyTrigger() once from the Apps Script editor to
// register the daily sync.  It is idempotent — safe to re-run.
// ============================================================

function setupDailyTrigger() {
  // Remove any existing syncAll triggers first
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncAll')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Daily at 06:00 in the script owner's timezone
  ScriptApp.newTrigger('syncAll')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  Logger.log('Daily syncAll trigger set for 06:00.');
}

// ── Script Properties setup helper ──────────────────────────
// Run this once to validate all required properties are present.

function checkScriptProperties() {
  const required = ['CHARGEBEE_API_KEY', 'METABASE_USER', 'METABASE_PASS'];
  const props    = PropertiesService.getScriptProperties().getProperties();
  const missing  = required.filter(k => !props[k]);

  if (missing.length > 0) {
    Logger.log(`MISSING Script Properties: ${missing.join(', ')}`);
    Logger.log('Go to: Extensions → Apps Script → Project Settings → Script properties');
  } else {
    Logger.log('All required Script Properties are set.');
  }
}
