// ============================================================================
// INTENT VALIDATION TEST SUITE — offline, no network, no chain.
//
//   node build/intent-test.mjs
//
// Covers the four cases Phase D specified (valid / NO-side / 60s window /
// malformed), plus the synonym and normalization behaviours that make this a
// normalizer rather than a pass-through.
// ============================================================================
import { normalizeIntent, normalizeWindowSeconds, normalizeDollarAmount } from './intent.mjs';

let pass = 0, fail = 0;
function check(n, name, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`${String(n).padStart(2)}. [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         ${detail}` : ''}`);
}

console.log('=== THE FOUR SPECIFIED CASES ===\n');

// ---- 1. a valid one
const v = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 2 });
check(1, 'VALID: YES / BTC / 300s / $2 is accepted and normalized',
  v.ok === true && v.placeOrderArgs.direction === 'YES'
  && v.placeOrderArgs.window_seconds === 300 && v.placeOrderArgs.targetDollarAmount === 2
  && v.placeOrderArgs.market_id === undefined,
  `placeOrderArgs=${JSON.stringify(v.placeOrderArgs)}\n         market_id absent as expected (the resolver adds it)`);

// ---- 2. NO side -> must refuse with the documented reason
const no = normalizeIntent({ direction: 'NO', asset: 'BTC', window_seconds: 300, targetDollarAmount: 2 });
check(2, 'NO side is REFUSED with the documented reason',
  no.ok === false && no.refused === true && no.reason === 'direction_not_supported'
  && /never filled/i.test(no.detail),
  `reason=${no.reason}`);
check(3, 'the NO refusal cites what the evidence does NOT show, not just that it failed',
  /not.*explained by a thin book/i.test(no.detail) && /200 units/.test(no.detail)
  && /undetermined/i.test(no.detail),
  'cites run 2\'s 200 units of matchable liquidity + "cause undetermined" rather than implying a thin book');
check(4, 'the NO refusal warns against substituting a YES bet',
  /opposite position/i.test(no.suggestion ?? ''),
  `suggestion mentions that substituting YES is the opposite position`);

// ---- 3. 60s window -> must refuse
const w60 = normalizeIntent({ direction: 'YES', asset: 'ETH', window_seconds: 60, targetDollarAmount: 2 });
check(5, '60s window is REFUSED rather than silently substituted',
  w60.ok === false && w60.reason === 'window_not_supported'
  && w60.requestedWindowSeconds === 60 && w60.nearestSupported === 300,
  `reason=${w60.reason} requested=${w60.requestedWindowSeconds} nearestSupported=${w60.nearestSupported}`);
check(6, 'the 60s refusal states the evidence ACCURATELY (snapshot, and 60s has filled before)',
  /snapshot, not a distribution/i.test(w60.detail) && /DID fill/i.test(w60.detail)
  && /UNRELIABLE/i.test(w60.detail),
  'says 0/2 sampled bare at T-47s AND that runs 1-2 did fill on 60s — so "unreliable", not "always empty"');

// ---- 4. malformed / missing fields
const m1 = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 'ten dollars' });
check(7, 'MALFORMED amount ("ten dollars") is refused',
  m1.ok === false && m1.reason === 'invalid_target_dollar_amount', `reason=${m1.reason}`);
const m2 = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300 });
check(8, 'MISSING size is refused rather than defaulted',
  m2.ok === false && m2.reason === 'sizing_required',
  `reason=${m2.reason} — place_order would default to 1.0 unit, but choosing a trade size for the user is not this tool's call`);
const m3 = normalizeIntent({ asset: 'BTC', window_seconds: 300, targetDollarAmount: 2 });
check(9, 'MISSING direction is refused', m3.ok === false && m3.reason === 'direction_required', `reason=${m3.reason}`);
const m4 = normalizeIntent({ direction: 'YES', window_seconds: 300, targetDollarAmount: 2 });
check(10, 'MISSING asset is refused', m4.ok === false && m4.reason === 'asset_required', `reason=${m4.reason}`);

console.log('\n=== NORMALIZATION (what makes this more than a pass-through) ===\n');

const syn = normalizeIntent({ direction: 'up', asset: 'bitcoin', window: '5m', amount: '$2.50' });
check(11, 'synonyms normalize: up->YES, bitcoin->BTC, "5m"->300, "$2.50"->2.5',
  syn.ok === true && syn.normalized.direction === 'YES' && syn.normalized.asset === 'BTC'
  && syn.normalized.windowSeconds === 300 && syn.normalized.targetDollarAmount === 2.5,
  JSON.stringify(syn.interpretation));

const syn2 = normalizeIntent({ side: 'long', symbol: 'ETHEREUM', duration: '300 seconds', stake: '10 USD' });
check(12, 'alternate field names work: side/symbol/duration/stake',
  syn2.ok === true && syn2.normalized.direction === 'YES' && syn2.normalized.asset === 'ETH'
  && syn2.normalized.windowSeconds === 300 && syn2.normalized.targetDollarAmount === 10,
  JSON.stringify(syn2.interpretation));

const dn = normalizeIntent({ direction: 'short', asset: 'ETH', window_seconds: 300, amount: 1 });
check(13, 'a NO synonym ("short") is resolved THEN refused, not misread as unrecognized',
  dn.ok === false && dn.reason === 'direction_not_supported' && dn.requestedDirection === 'NO',
  `"short" -> NO -> refused (reason=${dn.reason}), not direction_unrecognized`);

const amb = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 2, stake_units: 1 });
check(14, 'both sizing modes at once is refused rather than one being picked',
  amb.ok === false && amb.reason === 'ambiguous_sizing', `reason=${amb.reason}`);

const noWin = normalizeIntent({ direction: 'YES', asset: 'BTC', targetDollarAmount: 2 });
check(15, 'omitted window defaults to 300 WITH a warning, not silently',
  noWin.ok === true && noWin.normalized.windowSeconds === 300 && noWin.warnings.length === 1,
  `warning: ${noWin.warnings[0]}`);

const badAsset = normalizeIntent({ direction: 'YES', asset: 'DOGE', window_seconds: 300, targetDollarAmount: 2 });
check(16, 'an out-of-scope asset is refused as unsupported, not as a parse failure',
  badAsset.ok === false && badAsset.reason === 'asset_not_supported'
  && /not a parsing failure/i.test(badAsset.detail), `reason=${badAsset.reason}`);

const badWin = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 'next tuesday', targetDollarAmount: 2 });
check(17, 'an uninterpretable window is window_unrecognized, distinct from window_not_supported',
  badWin.ok === false && badWin.reason === 'window_unrecognized',
  `"next tuesday" -> ${badWin.reason} (a DIFFERENT code from a well-formed but unsupported 60s)`);

const units = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, stake_units: 1.5 });
check(18, 'UNITS sizing mode passes through as stake_units, not converted to cash',
  units.ok === true && units.placeOrderArgs.stake_units === 1.5
  && units.placeOrderArgs.targetDollarAmount === undefined,
  `placeOrderArgs=${JSON.stringify(units.placeOrderArgs)}`);

const negUnits = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, stake_units: -1 });
check(19, 'a negative stake_units is refused',
  negUnits.ok === false && negUnits.reason === 'invalid_stake_units', `reason=${negUnits.reason}`);

const zero = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 0 });
check(20, 'a zero dollar amount is refused',
  zero.ok === false && zero.reason === 'invalid_target_dollar_amount', `reason=${zero.reason}`);

const slipWarn = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 2, maxSlippagePct: 500 });
check(21, 'an over-ceiling maxSlippagePct is passed through WITH a warning that it will be clamped',
  slipWarn.ok === true && slipWarn.placeOrderArgs.maxSlippagePct === 500
  && slipWarn.warnings.some((w) => /clamped to 50/.test(w)),
  `warning: ${slipWarn.warnings.find((w) => /clamped/.test(w))}`);

const echo = normalizeIntent({ direction: 'YES', asset: 'BTC', window_seconds: 300, targetDollarAmount: 2,
  raw_text: 'put $2 on bitcoin going up in the next 5 minutes' });
check(22, 'raw_text is echoed for audit and explicitly marked as NOT parsed',
  echo.ok === true && echo.rawTextEcho === 'put $2 on bitcoin going up in the next 5 minutes'
  && /did NOT parse it/i.test(echo.rawTextNote),
  'the tool states the calling agent did the NL extraction');

console.log('\n=== UNIT: the two normalizers ===\n');
const winCases = [[300, 300], ['300', 300], ['300s', 300], ['5m', 300], ['5 minutes', 300],
  ['1h', 3600], ['60s', 60], ['1m', 60], ['next tuesday', null], ['', null], [null, null]];
let wOk = true;
for (const [inp, want] of winCases) {
  const got = normalizeWindowSeconds(inp);
  if (got !== want) { wOk = false; console.log(`      window MISMATCH ${JSON.stringify(inp)} -> ${got}, wanted ${want}`); }
}
check(23, 'normalizeWindowSeconds handles s/m/h forms and rejects prose', wOk,
  `${winCases.length} cases: 300 | "300" | "300s" | "5m" | "5 minutes" | "1h" | "60s" | "1m" | prose | "" | null`);

const amtCases = [[10, 10], ['10', 10], ['$10', 10], ['10 usd', 10], ['10.50', 10.5],
  ['$1,000', 1000], ['ten', null], ['', null], [null, null], ['abc', null]];
let aOk = true;
for (const [inp, want] of amtCases) {
  const got = normalizeDollarAmount(inp);
  if (got !== want) { aOk = false; console.log(`      amount MISMATCH ${JSON.stringify(inp)} -> ${got}, wanted ${want}`); }
}
check(24, 'normalizeDollarAmount handles $ / commas / unit suffixes and rejects words', aOk,
  `${amtCases.length} cases incl. "$1,000" -> 1000 and "ten" -> null`);

console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
