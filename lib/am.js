// ============================================================
// AM ASSIGNMENTS LOADER
//
// Reads data/am-assignments.csv and returns a map of
// normalizedName → { account_manager, arr, is_managed }
//
// Managed   = account_manager is set and not "Unassigned"
// Unmanaged = account_manager is blank or "Unassigned"
//
// Both types appear on the dashboard.
// Only managed accounts receive Slack flag alerts.
// ============================================================

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeName } from './normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load and parse data/am-assignments.csv.
 * Returns a map keyed by normalized account name.
 *
 * @returns {{ [normalizedName: string]: { account_manager: string|null, arr: number|null, is_managed: boolean } }}
 */
export function loadAmAssignments() {
  const csvPath = resolve(__dirname, '../data/am-assignments.csv');

  let text;
  try {
    text = readFileSync(csvPath, 'utf8');
  } catch {
    console.warn('am-assignments.csv not found — skipping AM override step.');
    return {};
  }

  // Normalise line endings, strip comment lines and blank lines
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'));

  if (lines.length < 2) {
    console.warn('am-assignments.csv has no data rows — skipping AM override step.');
    return {};
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const nameIdx = headers.indexOf('account_name');
  const amIdx   = headers.indexOf('account_manager');
  const arrIdx  = headers.indexOf('arr');

  if (nameIdx === -1 || amIdx === -1) {
    throw new Error('am-assignments.csv must have account_name and account_manager columns.');
  }

  const map = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const rawName = cols[nameIdx]?.trim();
    if (!rawName) continue;

    const normalizedName   = normalizeName(rawName);
    const rawAm            = cols[amIdx]?.trim() || '';
    const isManaged        = Boolean(rawAm) && rawAm.toLowerCase() !== 'unassigned';
    const account_manager  = rawAm || 'Unassigned';
    const rawArr           = arrIdx !== -1 ? (cols[arrIdx]?.trim() || '') : '';
    const cleanArr         = rawArr.replace(/[$,\s]/g, ''); // strip $, commas, spaces
    const arr              = cleanArr ? parseFloat(cleanArr) : null;

    map[normalizedName] = { account_manager, arr, is_managed: isManaged };
  }

  console.log(`AM assignments loaded: ${Object.keys(map).length} accounts (${
    Object.values(map).filter(v => v.is_managed).length
  } managed, ${
    Object.values(map).filter(v => !v.is_managed).length
  } unmanaged)`);

  return map;
}

// ── CSV parser — handles quoted fields with embedded commas ──

function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}
