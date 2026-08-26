// ============================================================================
// TRADE LOG TEST SUITE — offline, no network, no chain.
//
//   node build/trade-log-test.mjs
//
// Uses a throwaway log directory so it can never touch a real user's history, and
// drives the adapters with SYNTHETIC tool responses. That is the point of testing
// it this way: the outcomes that are hard to produce on demand against a live
// venue — a redeem guard BLOCK, a PENDING fill, a reverted broadcast, a zero
// payout — are exactly the ones an audit log must get right, so they are pinned
// here deterministically rather than left to whatever the market happened to do.
// ============================================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Must be set BEFORE importing the module: TRADE_LOG_DIR is resolved at load.
const TMP = path.join(os.tmpdir(), `agentrail-tradelog-test-${process.pid}`);
process.env.AGENTRAIL_TRADE_LOG_DIR = TMP;

const TL = await import('./trade-log.mjs');
const { recordOrder, recordRedeem, recordWallet, recordBalanceObservation,
  get_trade_log, resolveSession, logEvent, _resetTradeLogForTests, TRADE_LOG_DIR } = TL;

let pass = 0, fail = 0;
function check(n, name, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`${String(n).padStart(2)}. [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         ${detail}` : ''}`);
}
const S = 'suite';
const reset = () => { _resetTradeLogForTests(); };
const entries = (opts = {}) => get_trade_log({ session_id: S, limit: 500, ...opts }).entries;
const only = (opts = {}) => { const e = entries(opts); return e[e.length - 1]; };

console.log(`log dir: ${TRADE_LOG_DIR}\n`);
console.log('=== SESSION IDS BECOME FILENAMES, so they are sanitised ===\n');

check(1, 'a path-traversal session id cannot escape the log directory',
  (() => {
    const r = resolveSession('../../etc/passwd');
    // The property that matters is that no PATH SEPARATOR survives — a dot is only
    // "parent" as a whole segment. ".." is collapsed as well so the result needs no
    // such argument. Assertion 2 proves the resolved path empirically.
    return !/[/\\]/.test(r.fileSafe) && !r.fileSafe.includes('..')
      && r.sanitised === true && r.sessionId === '../../etc/passwd';
  })(),
  `"../../etc/passwd" -> file "${resolveSession('../../etc/passwd').fileSafe}", no separator survives, original preserved in sessionId`);

check(2, 'a traversal id actually writes INSIDE the log dir, not above it',
  (() => {
    reset();
    const r = logEvent({ session_id: '../../pwned', kind: 'WALLET', event: 'X',
      outcome: 'CREATED', summary: 'traversal probe' });
    return r.ok && path.resolve(r.file).startsWith(path.resolve(TRADE_LOG_DIR))
      && !fs.existsSync(path.resolve(TRADE_LOG_DIR, '../../pwned.jsonl'));
  })(), 'the resolved file path stays under TRADE_LOG_DIR');

check(3, 'sanitisation is NOT injective, and the collision is disclosed per entry',
  (() => {
    reset();
    logEvent({ session_id: 'a/b', kind: 'WALLET', event: 'X', outcome: 'CREATED', summary: 'one' });
    logEvent({ session_id: 'a_b', kind: 'WALLET', event: 'X', outcome: 'CREATED', summary: 'two' });
    const e = get_trade_log({ session_id: 'a_b', limit: 10 }).entries;
    return e.length === 2 && e[0].sessionId === 'a/b' && e[1].sessionId === 'a_b';
  })(),
  '"a/b" and "a_b" share one file, but each entry records which id actually wrote it');

check(4, 'a degenerate session id resolves to a readable name, never an empty filename',
  resolveSession('').fileSafe === TL.DEFAULT_SESSION_ID
  && resolveSession(null).fileSafe === TL.DEFAULT_SESSION_ID
  && resolveSession('...').fileSafe === 'unnamed'
  && resolveSession('///').fileSafe === 'unnamed'
  && resolveSession('  ').fileSafe === TL.DEFAULT_SESSION_ID,
  `"" / null / whitespace -> "${TL.DEFAULT_SESSION_ID}"; "..." and "///" -> "unnamed" rather than "_" or ""`);

console.log('\n=== ORDERS: all outcomes, kept distinct ===\n');
reset();

recordOrder({ session_id: S, input: { market_id: '0xaaa1', targetDollarAmount: 0.5 },
  res: { ok: true, asset: 'ETH', direction: 'YES', intervalSec: 300, marketId: '0xaaa1',
    fill: { fillStatus: 'FILLED', filled: true, filledUnits: '0.776', collateralSpent: '0.493536',
      resolution: { latencySecondsObserved: 0 } },
    dollarSizing: { requestedUsd: 0.5, actualCollateralSpentUsd: 0.493536, variancePct: -1.29 },
    slippage: { slippagePct: -1.24, maxSlippagePct: 5, clamped: false, requestedMaxSlippagePct: 5 },
    reservation: { resolution: 'COMMITTED' },
    tx: { a1_placeBinaryOrder_BUY_YES: { hash: '0xdead', status: 'success' } },
    expiry: 1, yesTokenId: '9' } });
const filled = only();
check(5, 'a FILLED order logs units, spend, variance and how the fill was CONFIRMED',
  filled.outcome === 'FILLED' && filled.fill.filled === true
  && /0\.776 units/.test(filled.summary) && /0\.493536 tUSDC/.test(filled.summary)
  && /variance -1\.29%/.test(filled.summary)
  && /NOT transaction status/i.test(filled.fill.confirmedBy),
  filled.summary);

recordOrder({ session_id: S, input: { market_id: '0xaaa2', targetDollarAmount: 1 },
  res: { ok: true, asset: 'BTC', direction: 'YES', intervalSec: 300, marketId: '0xaaa2',
    fill: { fillStatus: 'PENDING', filled: null, filledUnits: '0.0', collateralSpent: '1.000000',
      resolution: null },
    reservation: { resolution: 'COMMITTED' }, tx: { a1: { hash: '0x1' } } } });
const pending = only();
check(6, 'a PENDING order is NEVER logged as a non-fill — filled stays null and the text says so',
  pending.outcome === 'PENDING' && pending.fill.filled === null
  && /NOT a non-fill/i.test(pending.summary) && /may still fill/i.test(pending.summary)
  && /Recheck with get_position/i.test(pending.summary),
  'this is the exact misreading place_order\'s three-state contract exists to prevent');

recordOrder({ session_id: S, input: { market_id: '0xaaa3', stake_units: 1 },
  res: { ok: true, asset: 'ETH', direction: 'YES', intervalSec: 300, marketId: '0xaaa3',
    fill: { fillStatus: 'NOT_FILLED', filled: false, filledUnits: '0.0', collateralSpent: '0.0' },
    tx: {} } });
check(7, 'a NOT_FILLED order is terminal and says the locked collateral is auto-refunded',
  only().outcome === 'NOT_FILLED' && /expired with the order UNFILLED/i.test(only().summary)
  && /refunded automatically/i.test(only().summary), only().summary);

recordOrder({ session_id: S, input: { market_id: '0xaaa4', targetDollarAmount: 2 },
  res: { ok: false, refused: true, reason: 'slippage_exceeded',
    detail: 'best ask moved 9.1% between sizing and placement. NOT broadcast.',
    asset: 'ETH', marketId: '0xaaa4', intervalSec: 300,
    slippage: { slippagePct: 9.1, maxSlippagePct: 5, clamped: false },
    reservation: { resolution: 'RELEASED' }, tx: {} } });
const rf = only();
check(8, 'a REFUSAL is a first-class entry with the machine reason AND the prose why',
  rf.outcome === 'REFUSED' && rf.ok === false && rf.reason === 'slippage_exceeded'
  && /best ask moved 9\.1%/.test(rf.why) && rf.broadcastAttempted === false
  && /NOTHING was broadcast/i.test(rf.summary) && rf.riskReservation === 'RELEASED',
  rf.summary);

recordOrder({ session_id: S, input: { market_id: '0xaaa5', targetDollarAmount: 2 },
  res: { ok: false, reason: 'reverted', detail: 'the placement transaction reverted on-chain.',
    asset: 'ETH', marketId: '0xaaa5', intervalSec: 300,
    reservation: { resolution: 'COMMITTED' },
    tx: { a1_placeBinaryOrder_BUY_YES: { hash: '0xbad', status: 'reverted' } } } });
const rv = only();
check(9, 'a REVERTED broadcast is distinguished from a refusal — a tx DID go out',
  rv.outcome === 'REVERTED' && rv.broadcastAttempted === true
  && /moved no collateral/i.test(rv.summary) && !!rv.tx.a1_placeBinaryOrder_BUY_YES,
  'a refusal broadcast nothing; a revert broadcast something that moved no money. Different facts.');

recordOrder({ session_id: S, input: { market_id: '0xaaa6', targetDollarAmount: 2 },
  res: null, thrown: 'AGENTRAIL_OWNER_KEY is not set' });
const th = only();
check(10, 'a THROWN error is logged, and is explicit that the outcome is UNKNOWN',
  th.outcome === 'ERROR' && th.ok === false && th.unresolved === true
  && /UNKNOWN from this entry alone/i.test(th.summary) && /check get_position/i.test(th.summary),
  'it does not claim nothing happened — it says it cannot tell, and names how to find out');

console.log('\n=== REDEMPTIONS: one entry per leg, BLOCK as loud as a payout ===\n');
reset();

recordRedeem({ session_id: S, dry_run: false, res: { ok: true,
  discovery: { method: 'listBinaryMarkets({status:"Finalized"})', finalizedSeen: 50 },
  blocked: [{ marketId: '0xbbb1', asset: 'ETH', label: 'YES', outcomeIdx: 0, units: '1.000000',
    tokensPreserved: '1000000', outcome: 'BLOCKED — NOT BROADCAST.',
    guard: { allow: false, reason: 'on-chain winningOutcome is NO; this YES leg lost', winOnchain: 1 } }],
  redeemed: [{ marketId: '0xbbb2', asset: 'BTC', label: 'YES', outcomeIdx: 0, units: '1.000000',
    broadcast: true, guard: { allow: true, reason: 'YES won' },
    payout: { payoutUnits: '1.000000', nonZero: true,
      confirmedBy: 'tUSDC balance delta + ERC6909 burn (NOT tx status)' } }] } });
const legs = entries({ kind: 'REDEEM' });
const blocked = legs.find((e) => e.outcome === 'BLOCKED');
const paid = legs.find((e) => e.outcome === 'REDEEMED');
check(11, 'a BLOCK and a payout in the SAME call become two separate entries',
  legs.length === 2 && !!blocked && !!paid && blocked.seq !== paid.seq,
  'they must not merge into one "redeem happened" line — the refusal is the point');
check(12, 'the BLOCK entry says the position was PRESERVED and why that mattered',
  blocked.ok === false && /left INTACT, not burned/i.test(blocked.summary)
  && /does NOT revert/i.test(blocked.summary) && /pays zero/i.test(blocked.summary)
  && blocked.why === 'on-chain winningOutcome is NO; this YES leg lost'
  && blocked.broadcast === false,
  blocked.summary);
check(13, 'the payout entry records the payout AND how it was confirmed',
  paid.ok === true && /1\.000000 tUSDC/.test(paid.summary)
  && /NOT transaction status/i.test(paid.summary) && paid.payout.nonZero === true,
  paid.summary);

reset();
recordRedeem({ session_id: S, dry_run: false, res: { ok: true, discovery: {},
  blocked: [], redeemed: [{ marketId: '0xbbb3', label: 'YES', units: '1.0', broadcast: true,
    payout: { payoutUnits: '0.000000', nonZero: false, confirmedBy: 'tUSDC delta' } }] } });
check(14, 'a ZERO_PAYOUT is flagged as the guard failing, not as a normal success',
  only().outcome === 'ZERO_PAYOUT'
  && /the exact outcome the redeem guard exists to prevent/i.test(only().summary)
  && /worth investigating/i.test(only().summary),
  only().summary);

reset();
recordRedeem({ session_id: S, dry_run: true, res: { ok: true, discovery: {}, blocked: [],
  redeemed: [{ marketId: '0xbbb4', label: 'YES', units: '1.0', broadcast: false,
    outcome: 'ALLOW — would broadcast (dry_run, skipped)' }] } });
check(15, 'a dry run is logged but flagged, so it can never read as a real broadcast',
  only().outcome === 'WOULD_REDEEM' && only().dryRun === true
  && /nothing broadcast/i.test(only().summary) && only().broadcast === false,
  only().summary);

reset();
recordRedeem({ session_id: S, res: { ok: true, blocked: [], redeemed: [],
  discovery: { method: 'listBinaryMarkets({status:"Finalized"})', finalizedSeen: 50 } } });
check(16, '"nothing owed" is logged as its own outcome, distinct from a refusal',
  only().outcome === 'NOTHING_OWED' && only().ok === true
  && /different from a refusal/i.test(only().summary), only().summary);

console.log('\n=== WALLETS AND DEPOSITS: actions vs observations ===\n');
reset();

recordWallet({ session_id: S, res: { ok: true, created: true, address: '0xW1', createdAt: 'now' } });
check(17, 'wallet creation records the CUSTODIAL model and that no key was returned',
  only().outcome === 'CREATED' && /CUSTODIAL/i.test(only().summary)
  && only().privateKeyReturned === false && only().signingWiredUp === false
  && /AGENTRAIL_OWNER_KEY/.test(only().signingNote),
  'also records that place_order does not yet sign with it, so the history cannot imply otherwise');

recordWallet({ session_id: S, res: { ok: true, created: false, address: '0xW1', createdAt: 'now' } });
check(18, 'the idempotent no-op is also logged — "nothing changed" is a fact worth having',
  only().outcome === 'UNCHANGED' && /No new keypair was generated/i.test(only().summary)
  && /strand those funds/i.test(only().summary), only().summary);

recordBalanceObservation({ session_id: S, address: '0xW1', tUSDC: 0, SOMI: 0, readyToTrade: false, known: true });
check(19, 'the first balance read is a BASELINE that explains why no delta is shown',
  only().outcome === 'BASELINE' && only().actor === 'OBSERVED'
  && /no earlier reading/i.test(only().summary), only().summary);

recordBalanceObservation({ session_id: S, address: '0xW1', tUSDC: 2, SOMI: 0.05, readyToTrade: true, known: true });
const dep = only();
check(20, 'a DEPOSIT is logged as OBSERVED, explicitly NOT performed by AgentRail',
  dep.outcome === 'DEPOSIT' && dep.actor === 'OBSERVED'
  && dep.performedByAgentRail === false
  && /did NOT perform this transfer/i.test(dep.summary)
  && dep.delta.tUSDC === 2 && dep.delta.SOMI === 0.05
  && /0 -> 2/.test(dep.summary),
  dep.summary);

const unchanged = recordBalanceObservation({ session_id: S, address: '0xW1', tUSDC: 2, SOMI: 0.05, readyToTrade: true, known: true });
check(21, 'an UNCHANGED balance writes nothing rather than padding the log with noise',
  unchanged.skipped === true && entries().filter((e) => e.event === 'DEPOSIT_OBSERVED').length === 1,
  unchanged.reason);

recordBalanceObservation({ session_id: S, address: '0xW1', tUSDC: 1.5, SOMI: 0.05, readyToTrade: true, known: true });
check(22, 'a DECREASE is logged too, pointing at the ORDER entries rather than implying a transfer out',
  only().outcome === 'DECREASE' && only().delta.tUSDC === -0.5
  && /read this alongside the ORDER entries/i.test(only().summary),
  'logging only increases would leave gaps in a record that claims to be complete');

console.log('\n=== THE READ SIDE ===\n');
reset();
for (let i = 0; i < 5; i++) {
  logEvent({ session_id: S, kind: 'ORDER', event: 'PLACE_ORDER',
    outcome: i % 2 ? 'REFUSED' : 'FILLED', ok: i % 2 === 0, summary: `synthetic ${i}` });
}
const full = get_trade_log({ session_id: S, limit: 500 });
check(23, 'counts are computed over the WHOLE file even when the entry list is filtered',
  (() => {
    const r = get_trade_log({ session_id: S, refusals_only: true, limit: 500 });
    return r.entries.length === 2 && r.entries.every((e) => e.ok === false)
      && r.total === 5 && r.summary.byOutcome.FILLED === 3;
  })(),
  'a caller asking only for refusals still needs the denominator');
check(24, 'a truncated view reports what it left out instead of looking complete',
  (() => {
    const r = get_trade_log({ session_id: S, limit: 2 });
    return r.returned === 2 && r.elided === 3 && /TRUNCATED/i.test(r.elidedNote)
      && r.entries[1].summary === 'synthetic 4';
  })(), 'limit:2 -> the 2 MOST RECENT, elided:3, plus an explicit TRUNCATED note');
check(25, 'a session with no log says so, and does not imply unlogged activity',
  (() => {
    const r = get_trade_log({ session_id: 'never-used', limit: 10 });
    return r.ok === true && r.exists === false && r.total === 0
      && /NOT that actions happened and went unlogged/i.test(r.note);
  })(), 'absence of a file means nothing was recorded under that id, which is a different claim');
check(26, 'entries are chronological, oldest first',
  full.entries.map((e) => e.seq).every((s, i, a) => i === 0 || s > a[i - 1])
  && full.entries[0].summary === 'synthetic 0', '');

check(27, 'a MALFORMED line is counted and reported, never silently dropped',
  (() => {
    fs.appendFileSync(path.join(TRADE_LOG_DIR, `${S}.jsonl`), 'this is not json\n');
    const r = get_trade_log({ session_id: S, limit: 500 });
    return r.integrity.malformedLines === 1 && /reported rather than hidden/i.test(r.integrity.malformedNote)
      && r.total === 5;
  })(), 'a silently dropped line is exactly what an audit log must not do');

check(28, 'nothing in the module rewrites or deletes an existing entry',
  (() => {
    const file = path.join(TRADE_LOG_DIR, `${S}.jsonl`);
    const before = fs.readFileSync(file, 'utf8');
    logEvent({ session_id: S, kind: 'ORDER', event: 'PLACE_ORDER', outcome: 'FILLED', summary: 'appended' });
    const after = fs.readFileSync(file, 'utf8');
    return after.startsWith(before) && after.length > before.length;
  })(),
  'the new file content starts with the exact previous content — append-only, verified byte-wise');

check(29, 'a log write failure does NOT throw, so it can never fail the action it records',
  (() => {
    const saved = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error('simulated disk failure'); };
    let threw = false, r = null;
    try { r = logEvent({ session_id: S, kind: 'ORDER', event: 'PLACE_ORDER', outcome: 'FILLED', summary: 'x' }); }
    catch { threw = true; }
    fs.appendFileSync = saved;
    return !threw && r?.ok === false && /trade log append failed/i.test(r.error)
      && /The ACTION still happened/i.test(r.note);
  })(),
  'by the time an order is logged the tx has already broadcast — throwing would report a failure for a real fill');

check(30, 'a failed write is REPORTED by the order adapter, not silently swallowed',
  (() => {
    const saved = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error('simulated disk failure'); };
    const r = recordOrder({ session_id: S, input: { market_id: '0xz' },
      res: { ok: true, asset: 'ETH', direction: 'YES', fill: { fillStatus: 'FILLED', filled: true,
        filledUnits: '1', collateralSpent: '1' }, tx: {} } });
    fs.appendFileSync = saved;
    return r.ok === false && typeof r.error === 'string';
  })(), 'place_order surfaces this as tradeLog.error in its response');

console.log('\n=== KEY MATERIAL ===\n');
check(31, 'no adapter reads or writes a private key field',
  (() => {
    reset();
    // Feed a key-shaped string through every field an adapter reads, then assert
    // the log holds no privateKey FIELD and no adapter READS one. The weak check
    // here would be a substring search for "privateKey" — which is misleading,
    // because the wallet adapter legitimately writes the field NAME
    // `privateKeyReturned: false`, an assertion that no key was returned rather
    // than key material. So the check is on the shape: a `"privateKey":` field,
    // and any read of one.
    const KEY = `0x${'ab'.repeat(32)}`;
    recordWallet({ session_id: S, res: { ok: true, created: true, address: KEY } });
    recordOrder({ session_id: S, input: { market_id: KEY, targetDollarAmount: 1 },
      res: { ok: true, asset: 'ETH', direction: 'YES', marketId: KEY,
        fill: { fillStatus: 'FILLED', filled: true, filledUnits: '1', collateralSpent: '1' }, tx: {} } });
    const raw = fs.readFileSync(path.join(TRADE_LOG_DIR, `${S}.jsonl`), 'utf8');
    const src = [TL.recordWallet, TL.recordOrder, TL.recordRedeem,
      TL.recordBalanceObservation, TL.logEvent].map((f) => f.toString()).join('\n');
    const readsAKey = /\.privateKey\b/.test(src) || /_privateKeyForSession/.test(src)
      || /\[['"]privateKey['"]\]/.test(src);
    const writesAKeyField = /"privateKey"\s*:/.test(raw);
    return !readsAKey && !writesAKeyField
      && /"privateKeyReturned":false/.test(raw.replace(/\s/g, ''));
  })(),
  'no adapter dereferences a privateKey field or calls _privateKeyForSession, and no entry carries a "privateKey": field. The one occurrence of the substring is the assertion `privateKeyReturned: false`. The live suite additionally proves the ACTUAL stored key appears nowhere in a real log file.');

// clean up the throwaway dir
try { fs.rmSync(TRADE_LOG_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
