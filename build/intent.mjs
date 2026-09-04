// ============================================================================
// INTENT NORMALIZATION — pure, no chain access, no LLM.
//
// CONTRACT, and the boundary matters: this module does NOT do natural-language
// understanding. The CALLING AGENT reads the user's sentence and extracts the
// fields. This module's job is the step after that — VALIDATE and NORMALIZE
// already-extracted intent into exactly what place_order accepts, and REFUSE
// anything unsupported before it can reach the chain.
//
// Why that split: an MCP tool that called an LLM itself would be doing the
// client's job, would add a second model in the loop with its own failure modes,
// and would make a deterministic validation layer non-deterministic. The value
// here is precisely that it is deterministic and testable offline.
//
// Every refusal uses the same shape as the rest of the surface:
//   { ok:false, refused:true, reason:'<stable_machine_code>', detail:'<prose>' }
// ============================================================================

// The proven scope, duplicated here as data rather than imported from mcp-core, so
// this module stays free of chain imports and testable with no network. mcp-core
// remains the enforcing authority — this is a pre-check that fails the same way.
export const SUPPORTED_DIRECTIONS = ['YES', 'NO'];
export const SUPPORTED_WINDOWS = [300];
export const SUPPORTED_ASSETS = ['BTC', 'ETH'];

// Synonym maps. Normalizing these IS this module's job — the calling agent may
// hand over "up" or "long" from a sentence like "put $10 on BTC going up".
const DIRECTION_SYNONYMS = {
  YES: 'YES', UP: 'YES', LONG: 'YES', HIGHER: 'YES', ABOVE: 'YES', RISE: 'YES',
  BULL: 'YES', BULLISH: 'YES', CALL: 'YES',
  NO: 'NO', DOWN: 'NO', SHORT: 'NO', LOWER: 'NO', BELOW: 'NO', FALL: 'NO',
  BEAR: 'NO', BEARISH: 'NO', PUT: 'NO',
};
const ASSET_SYNONYMS = {
  BTC: 'BTC', BITCOIN: 'BTC', XBT: 'BTC', 'BTC-USD': 'BTC', BTCUSD: 'BTC',
  ETH: 'ETH', ETHER: 'ETH', ETHEREUM: 'ETH', 'ETH-USD': 'ETH', ETHUSD: 'ETH',
};

/** "5m" | "300s" | "5 min" | 300 -> seconds. null if uninterpretable. */
export function normalizeWindowSeconds(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+(?:\.\d+)?)(s|sec|secs|second|seconds)?$/);
  if (m) return Math.round(Number(m[1]));
  m = s.match(/^(\d+(?:\.\d+)?)(m|min|mins|minute|minutes)$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = s.match(/^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours)$/);
  if (m) return Math.round(Number(m[1]) * 3600);
  return null;
}

/** "$10" | "10 usd" | "10.50" | 10 -> 10. null if uninterpretable. */
export function normalizeDollarAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase()
    .replace(/^\$/, '').replace(/(usd|usdc|tusdc|dollars?|bucks?)$/, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// How much time must remain before settlement for a market to be SELECTABLE.
//
// 60s, because the flow this feeds is confirm-before-execute (spec §2): the user
// has to READ the stake/direction/window/payout summary and reply before the
// window closes. A market resolved with 20s left produces a confirmation for a bet
// that is gone by the time anyone answers — place_order then correctly refuses on
// `status_gate_closed`, but the user was shown something that was never available.
export const DEFAULT_MIN_SECONDS_TO_EXPIRY = 60;

/**
 * Validate a runway floor. Returns { value, warning } — never a refusal, because
 * every degenerate input here has an unambiguous safe normalization.
 *
 * THE NON-FINITE CASE IS THE ONE THAT MATTERS. The floor is applied as
 * `secondsToExpiry >= floor`, and EVERY comparison against NaN is false, so a
 * non-numeric floor would silently reject every market and report "no market has
 * adequate runway" — a refusal that looks correct and states a false cause. That is
 * the same class of defect as the `maxSlippagePct` NaN bug fixed in Task 0, reached
 * from a different input, so it is handled the same way: fall back to the default
 * and say so in a warning rather than passing NaN through.
 */
export function normalizeMinSecondsToExpiry(raw,
  { defaultSeconds = DEFAULT_MIN_SECONDS_TO_EXPIRY } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return { value: defaultSeconds, warning: null, wasDefaulted: true };
  }
  const n = normalizeWindowSeconds(raw);          // accepts 90, "90", "90s", "2m"
  if (n === null) {
    return { value: defaultSeconds, wasDefaulted: true,
      warning: `min_seconds_to_expiry=${JSON.stringify(raw)} is not an interpretable duration and was replaced with the default of ${defaultSeconds}s. It was deliberately NOT passed through: the floor is applied as \`secondsToExpiry >= floor\` and every comparison against NaN is false, so a non-numeric floor would have silently rejected EVERY market and refused with "no market has adequate runway" — a refusal stating a cause that was not the real one.` };
  }
  if (n < 0) {
    return { value: 0, wasDefaulted: false,
      warning: `min_seconds_to_expiry=${JSON.stringify(raw)} is negative and was raised to 0, which means NO runway floor. A negative floor is meaningless rather than unsafe — every market clears it — so it is normalized rather than refused. Note this disables the protection: the soonest-settling market becomes selectable again.` };
  }
  return { value: n, warning: null, wasDefaulted: false };
}

const refuse = (reason, detail, extra = {}) =>
  ({ ok: false, refused: true, reason, detail, ...extra });

/**
 * Validate + normalize structured intent into place_order arguments.
 *
 * Returns either a refusal or { ok:true, placeOrderArgs, normalized, warnings }.
 * `placeOrderArgs` is missing `market_id` — the caller (or parse_intent) resolves
 * that from `normalized.asset`, since it needs a live market read.
 */
export function normalizeIntent(input = {}) {
  const warnings = [];

  // ---------------------------------------------------------------- direction
  const dirRaw = input.direction ?? input.side ?? input.outcome ?? null;
  if (dirRaw === null || String(dirRaw).trim() === '') {
    return refuse('direction_required',
      'No direction was supplied. Expected YES (or a synonym such as up/long/higher). The calling agent is responsible for extracting this from the user\'s instruction.',
      { supportedDirections: SUPPORTED_DIRECTIONS });
  }
  const dirKey = String(dirRaw).trim().toUpperCase();
  const dir = DIRECTION_SYNONYMS[dirKey] ?? null;
  if (dir === null) {
    return refuse('direction_unrecognized',
      `direction="${dirRaw}" could not be interpreted. Recognized: ${Object.keys(DIRECTION_SYNONYMS).join(', ')}.`,
      { supportedDirections: SUPPORTED_DIRECTIONS });
  }
  if (!SUPPORTED_DIRECTIONS.includes(dir)) {
    // Unreachable while SUPPORTED_DIRECTIONS is ['YES','NO'] — kept as a real
    // guard, not dead code, in case SUPPORTED_DIRECTIONS is ever narrowed again
    // (e.g. NO support disabled pending re-verification after a protocol change).
    return refuse('direction_not_supported',
      `direction resolved to ${dir} (from "${dirRaw}"), which is out of proven scope.`,
      { requestedDirection: dir, supportedDirections: SUPPORTED_DIRECTIONS });
  }
  if (dir === 'NO') {
    // NO is supported, but carry its real, still-open caveats forward rather
    // than let them silently disappear now that the blanket refusal is gone.
    // Evidence: research/NO-side-fill-paths.md. Concretely — a BUY_NO fills via
    // mint-a-pair against a resting BUY_YES; the exact crossing boundary is
    // INFERRED from 6 decoded real fills, not read from verified pool source
    // (§7 item 1, still open); DIRECT_NO (crossing a resting SELL_NO) has never
    // been observed on this venue (0 of 200 sampled fills, §11d item 3) — if the
    // book has no BUY_YES depth, a NO order may simply not fill, which is a
    // different, more benign outcome than a wrong price, but worth knowing.
    warnings.push('direction=NO fills via mint-a-pair against a resting BUY_YES order — the exact crossing boundary is inferred from real on-chain fills, not read from verified contract source (research/NO-side-fill-paths.md §7 item 1). A direct NO-vs-NO cross (DIRECT_NO) has never been observed on this venue; if there is no BUY_YES depth to cross, expect PENDING or NOT_FILLED, not a revert.');
  }

  // -------------------------------------------------------------------- asset
  const assetRaw = input.asset ?? input.symbol ?? input.market ?? null;
  if (assetRaw === null || String(assetRaw).trim() === '') {
    return refuse('asset_required',
      `No asset was supplied. Supported: ${SUPPORTED_ASSETS.join(', ')}.`,
      { supportedAssets: SUPPORTED_ASSETS });
  }
  const asset = ASSET_SYNONYMS[String(assetRaw).trim().toUpperCase()] ?? null;
  if (asset === null) {
    return refuse('asset_not_supported',
      `asset="${assetRaw}" is not supported. Only ${SUPPORTED_ASSETS.join(' and ')} event contracts are in scope. Note this is a limit of what the venue lists in the proven scope, not a parsing failure.`,
      { supportedAssets: SUPPORTED_ASSETS });
  }

  // ------------------------------------------------------------------- window
  const winRaw = input.window_seconds ?? input.windowSeconds ?? input.window ?? input.duration ?? null;
  let windowSeconds;
  if (winRaw === null || winRaw === '') {
    windowSeconds = 300;
    warnings.push('No window was supplied; defaulted to the only supported length, 300s.');
  } else {
    windowSeconds = normalizeWindowSeconds(winRaw);
    if (windowSeconds === null) {
      return refuse('window_unrecognized',
        `window="${winRaw}" could not be interpreted as a duration. Accepted forms: 300, "300s", "5m", "5 minutes".`,
        { supportedWindowSeconds: SUPPORTED_WINDOWS });
    }
  }
  if (!SUPPORTED_WINDOWS.includes(windowSeconds)) {
    // Stated accurately: the 60s evidence is a SNAPSHOT, and 60s markets HAVE
    // filled before. The fence is a reliability choice, not a proof of emptiness.
    const sixty = windowSeconds === 60
      ? ' Specifically for 60s: liquidity there is UNRELIABLE, NOT confirmed empty, and the fence is a deliberate reliability choice rather than a claim that no depth exists. The evidence is a snapshot, not a distribution — a separate narrow probe found no depth at ONE specific timing offset (0 of 2 sampled 60s books had any levels at T-47s, while 2 of 2 sampled 300s books had 3 levels per side), against which PROOF-LOG runs 1 and 2 BOTH DID fill on 60s markets, run 2 reading 200 units at T-26s. Sampling caps: 12 live markets, 4 probed, one moment in time. So the accurate statement is that 60s depth is not DEPENDABLE, not that it is absent (PROOF-LOG RUN 3 PART 2).'
      : '';
    return refuse('window_not_supported',
      `window resolved to ${windowSeconds}s (from ${JSON.stringify(winRaw)}), which is outside the proven scope of ${SUPPORTED_WINDOWS.join('/')}s and is refused rather than attempted.${sixty}`,
      { requestedWindowSeconds: windowSeconds, supportedWindowSeconds: SUPPORTED_WINDOWS,
        nearestSupported: 300,
        suggestion: 'Re-issue with window_seconds: 300. Do not silently substitute it — a different settlement window is a materially different bet, so the user should be told the requested one is unavailable.' });
  }

  // ------------------------------------------------------------------- sizing
  const dollarRaw = input.targetDollarAmount ?? input.target_dollar_amount
    ?? input.amount ?? input.stake ?? input.stake_usd ?? null;
  const unitsRaw = input.stake_units ?? input.stakeUnits ?? null;

  if (dollarRaw !== null && unitsRaw !== null) {
    return refuse('ambiguous_sizing',
      `both a dollar amount (${JSON.stringify(dollarRaw)}) and stake_units (${JSON.stringify(unitsRaw)}) were supplied. These are alternative ways to size the same order — specify exactly one. Refusing rather than picking, because guessing wrong changes the size of a real trade.`);
  }
  if (dollarRaw === null && unitsRaw === null) {
    return refuse('sizing_required',
      'No size was supplied. Provide either targetDollarAmount (cash to spend, e.g. 10 or "$10") or stake_units (raw outcome-token quantity). Nothing is defaulted here on purpose: place_order defaults to 1.0 unit, but silently choosing a trade size on a user\'s behalf is not this tool\'s call to make.');
  }

  let sizing;
  if (dollarRaw !== null) {
    const usd = normalizeDollarAmount(dollarRaw);
    if (usd === null) {
      return refuse('invalid_target_dollar_amount',
        `targetDollarAmount=${JSON.stringify(dollarRaw)} could not be interpreted as a dollar amount. Accepted forms: 10, "10", "$10", "10 USD", "10.50".`);
    }
    if (!(usd > 0)) {
      return refuse('invalid_target_dollar_amount',
        `targetDollarAmount=${JSON.stringify(dollarRaw)} resolved to ${usd}, which is not a positive amount.`);
    }
    sizing = { mode: 'DOLLAR', targetDollarAmount: usd };
  } else {
    const units = typeof unitsRaw === 'number' ? unitsRaw : Number(String(unitsRaw).trim());
    if (!Number.isFinite(units) || !(units > 0)) {
      return refuse('invalid_stake_units',
        `stake_units=${JSON.stringify(unitsRaw)} is not a positive number. Note stake_units is an OUTCOME-TOKEN QUANTITY, not a cash amount — use targetDollarAmount to size by cash.`);
    }
    sizing = { mode: 'UNITS', stake_units: units };
  }

  // ------------------------------------------------- optional passthroughs
  const passthrough = {};
  if (input.maxSlippagePct !== undefined || input.max_slippage_pct !== undefined) {
    const sp = Number(input.maxSlippagePct ?? input.max_slippage_pct);
    if (!Number.isFinite(sp)) {
      warnings.push(`maxSlippagePct=${JSON.stringify(input.maxSlippagePct ?? input.max_slippage_pct)} is not a finite number and was dropped; place_order will apply its default of 5%.`);
    } else {
      passthrough.maxSlippagePct = sp;
      if (sp > 50) warnings.push(`maxSlippagePct=${sp} exceeds the server-side ceiling of 50% and will be clamped to 50 by place_order.`);
    }
  }
  if (input.cross_ticks !== undefined || input.crossTicks !== undefined) {
    const ct = Number(input.cross_ticks ?? input.crossTicks);
    if (Number.isInteger(ct) && ct >= 0) passthrough.cross_ticks = ct;
    else warnings.push(`cross_ticks=${JSON.stringify(input.cross_ticks ?? input.crossTicks)} is not a non-negative integer and was dropped; place_order will use its proven default of 20.`);
  }

  return {
    ok: true,
    normalized: { direction: dir, asset, windowSeconds, ...sizing },
    placeOrderArgs: {                      // market_id is added by the resolver
      direction: dir, window_seconds: windowSeconds,
      ...(sizing.mode === 'DOLLAR'
        ? { targetDollarAmount: sizing.targetDollarAmount }
        : { stake_units: sizing.stake_units }),
      ...passthrough,
    },
    interpretation: {
      direction: `${dirRaw} -> ${dir}`,
      asset: `${assetRaw} -> ${asset}`,
      window: `${JSON.stringify(winRaw)} -> ${windowSeconds}s`,
      sizing: sizing.mode === 'DOLLAR'
        ? `${JSON.stringify(dollarRaw)} -> $${sizing.targetDollarAmount} of cash`
        : `${JSON.stringify(unitsRaw)} -> ${sizing.stake_units} outcome-token units`,
    },
    warnings,
    ...(input.raw_text ? { rawTextEcho: String(input.raw_text),
      rawTextNote: 'Echoed for audit only. This tool did NOT parse it — the calling agent extracted the structured fields, and only those fields were validated.' } : {}),
  };
}
