// ============================================================
// BRAND / ACCOUNT NAME NORMALIZATION
//
// Ported from Normalize.gs.
// Add dirty variants here → canonical name used as the primary
// key throughout the sync. Keys must be lowercase + trimmed.
// ============================================================

export const BRAND_ALIASES = {
  "dunkin'":       'Dunkin',
  'dunkin':        'Dunkin',
  'dunkin donuts': 'Dunkin',
  "mcdonald's":    'McDonalds',
  'mcdonalds':     'McDonalds',
  // add more as needed
};

/**
 * Returns the canonical name for a raw account/brand name string.
 * Trims whitespace, lowercases for alias lookup, falls back to trimmed raw.
 * @param {string|null} raw
 * @returns {string|null}
 */
export function normalizeName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const key     = trimmed.toLowerCase();
  return BRAND_ALIASES[key] || trimmed;
}
