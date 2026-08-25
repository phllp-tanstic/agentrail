// ============================================================================
// INTEGER TICK SNAPPING — single source of truth.
//
// Extracted VERBATIM from the byte-identical inline copies that existed in
// build/phase-a-lifecycle.mjs:147-162 and build/part3-win-proof.mjs:74-89.
// Function bodies are unchanged character-for-character; only their location
// moved. Same refactor pattern (and same reason) as ./redeem-guard.mjs: three
// copies of price math cannot be kept from drifting, and this is the code that
// the confirmed 18-decimal mainnet InvalidPrice bug turns on.
//
// See research/AgentRail-Build-Spec.md §3 ("Price handling") and
// research/PROOF-LOG.md "PHASE A — RUN 3 / PART 3" for the live proof:
//   bestAsk 614000 -> crossing bid 634000, onTick, filled AT THE ASK (0.614).
// ============================================================================

export function exactToRaw(value, decimals) {              // float-free decimal -> raw
  let s = typeof value === 'number' ? String(value) : String(value).trim();
  let [int = '0', frac = ''] = s.split('.'); if (int === '') int = '0';
  if (frac.length <= decimals) return BigInt(int + frac.padEnd(decimals, '0'));
  const keep = frac.slice(0, decimals); let out = BigInt(int + keep);
  if (frac[decimals] >= '5') out += 1n; return out;
}

export function snapPriceToTick(prob, tickSize, decimals) {
  const t = BigInt(tickSize), ONE = 10n ** BigInt(decimals);
  const raw = exactToRaw(prob, decimals);
  let snapped = ((raw + t / 2n) / t) * t;
  if (snapped < t) snapped = t;
  if (snapped > ONE - t) snapped = ONE - t;
  return snapped;
}

export const isOnTick = (r, t) => BigInt(r) % BigInt(t) === 0n;
