// ============================================================
// BRAND / ACCOUNT NAME NORMALIZATION
//
// Add dirty variants here → canonical name used as the primary
// key throughout the sync.  Keys must be lowercase + trimmed.
// ============================================================

const BRAND_ALIASES = {
  "dunkin'":       'Dunkin',
  'dunkin':        'Dunkin',
  'dunkin donuts': 'Dunkin',
  "mcdonald's":    'McDonalds',
  'mcdonalds':     'McDonalds',
  // add more as needed
};

function normalizeName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const key     = trimmed.toLowerCase();
  return BRAND_ALIASES[key] || trimmed;
}
