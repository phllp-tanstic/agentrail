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
export const SUPPORTED_DIRECTIONS = ['YES'];
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
    // The NO-side refusal. Cite the real evidence, including what it does NOT show.
    return refuse('direction_not_supported',
      `direction resolved to NO (from "${dirRaw}"), which is out of proven scope and is refused rather than attempted. Evidence: a BUY_NO has never filled at any expressible price across two runs (0.58 and 0.999, byte-identical gas — no match-loop iterations either time). This is NOT explained by a thin book: run 2's order book demonstrably held 200 units of matchable liquidity behind the NO quote (noAsk 750000 mirrors a real resting yesBid at 0.250, 200x the 1.0 unit attempted). The leading hypothesis — that the YES-bid/NO-ask equivalence exists only in the display layer and not in the matching engine — is coherent but was NOT verified and was not acted on. So the cause is genuinely undetermined: logged, not root-caused (PROOF-LOG RUN 2 / RUN 3 PART 2). Attempting a NO order would spend gas on an order that has never filled.`,
      { requestedDirection: dir, supportedDirections: SUPPORTED_DIRECTIONS,
        suggestion: 'Only YES-direction bets are supported. If the user wants downside exposure, that is not expressible through this tool today — say so rather than substituting a YES bet, which is the opposite position.' });
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
      ? ' Specifically for 60s: the evidence is a snapshot, not a distribution — 0 of 2 sampled 60s books had any depth at T-47s, while 2 of 2 sampled 300s books had 3 levels per side. Runs 1 and 2 DID fill on 60s markets, so the accurate statement is that 60s depth is UNRELIABLE, not that it is always absent. The fence is a deliberate reliability choice (PROOF-LOG RUN 3 PART 2).'
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
