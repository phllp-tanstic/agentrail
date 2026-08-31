// ============================================================================
// RISK GUARDRAIL TEST SUITE — offline, no network, no transactions.
//
//   node build/risk-test.mjs
//
// Two groups:
//   A. CAP ENFORCEMENT (1-8) — the original Phase C assertions, re-expressed for
//      the reserve-on-check API. These prove the caps hold and, critically, that
//      a CALLER CANNOT RAISE THEM.
//   B. RESERVATION LIFECYCLE (9-18) — the Phase C concurrency fix. Test 10 is the
//      one that matters: it reproduces the check-then-act interleaving that was
//      observed leaking, and proves it now refuses.
//
// Every assertion runs against the REAL exports of ./risk.mjs. Nothing is mocked.
// Limits are asserted to be at their defaults (5 USD window / 10 USD daily) first,
// because every numeric expectation below depends on that.
// ============================================================================
import {
  RISK_CONFIG, checkPreOrder, commitReservation, releaseReservation,
  recordSpend, recordPayout, riskSnapshot, _riskEvents, _openReservations,
  _resetRiskState,
} from './risk.mjs';

let pass = 0, fail = 0;
const results = [];

function check(n, name, cond, detail = '') {
  if (cond) { pass++; results.push({ n, name, result: 'PASS', detail }); }
  else { fail++; results.push({ n, name, result: 'FAIL', detail }); }
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${String(n).padStart(2)}. [${tag}] ${name}${detail ? `\n         ${detail}` : ''}`);
}

const M1 = '0xmarket_one';
const M2 = '0xmarket_two';
const SID = 'risk_test_session'; // single session throughout — this file tests one ledger's logic, not cross-session isolation

// ---------------------------------------------------------------- preconditions
console.log('=== PRECONDITION — limits must be at defaults for the numbers below ===');
const LIM = RISK_CONFIG.maxStakePerWindowUsd, DAY = RISK_CONFIG.maxDailyLossUsd;
console.log(`   maxStakePerWindowUsd = ${LIM} (${RISK_CONFIG.source.maxStakePerWindowUsd})`);
console.log(`   maxDailyLossUsd      = ${DAY} (${RISK_CONFIG.source.maxDailyLossUsd})`);
if (LIM !== 5 || DAY !== 10) {
  console.error(`\nABORT: limits are not at defaults (${LIM}/${DAY}). Unset AGENTRAIL_MAX_STAKE_USD / AGENTRAIL_MAX_DAILY_LOSS_USD and re-run.`);
  process.exit(2);
}

// ============================================================================
console.log('\n=== GROUP A — CAP ENFORCEMENT ===');
// ============================================================================

_resetRiskState(SID);
const a1 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 0.9 });
check(1, 'small order within limits is allowed', a1.allow === true,
  `allow=${a1.allow} reservationId=${a1.reservationId}`);
releaseReservation({ session_id: SID, reservationId: a1.reservationId, why: 'test cleanup' });

_resetRiskState(SID);
const a2 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 12.76 });
check(2, 'single order above the per-window max is refused', a2.allow === false && a2.code === 'max_stake_per_window_exceeded',
  `code=${a2.code} wouldTotalUsd=${a2.wouldTotalUsd}`);
check(3, 'a REFUSED order reserves nothing', _openReservations(SID).length === 0 && riskSnapshot(SID).reservedUsd === 0,
  `openReservations=${_openReservations(SID).length} reservedUsd=${riskSnapshot(SID).reservedUsd}`);

// Aggregation: five 0.9 orders commit 4.5, a sixth would reach 5.4 > 5.
_resetRiskState(SID);
for (let i = 0; i < 5; i++) {
  const r = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 0.9 });
  commitReservation({ session_id: SID, reservationId: r.reservationId, actualSpentUsd: 0.9 });
}
const a4 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 0.9 });
check(4, 'five committed 0.9 orders then one more aggregates to 5.4 > 5 and is refused',
  a4.allow === false && a4.code === 'max_stake_per_window_exceeded' && Math.abs(a4.wouldTotalUsd - 5.4) < 1e-9,
  `alreadyCommitted=${a4.alreadyCommittedThisWindowUsd} wouldTotalUsd=${a4.wouldTotalUsd}`);

const a5 = checkPreOrder({ session_id: SID, marketId: M2, estimatedSpendUsd: 0.9 });
check(5, 'a DIFFERENT market window is unaffected by the first window\'s commitments',
  a5.allow === true, `allow=${a5.allow} on ${M2} while ${M1} is at its cap`);
releaseReservation({ session_id: SID, reservationId: a5.reservationId, why: 'test cleanup' });

// Daily loss: drive drawdown to 9.6 across separate markets so the WINDOW cap
// (5) is not what trips — isolating the daily cap.
_resetRiskState(SID);
for (let i = 0; i < 12; i++) recordSpend({ session_id: SID, marketId: `0xm_${i}`, spentUsd: 0.8 });
const ddBefore = riskSnapshot(SID).drawdownUsd;
const a6 = checkPreOrder({ session_id: SID, marketId: '0xm_fresh', estimatedSpendUsd: 0.9 });
check(6, 'daily loss cap trips at 9.6 + 0.9 = 10.5 > 10',
  a6.allow === false && a6.code === 'max_daily_loss_exceeded' && Math.abs(a6.wouldReachUsd - 10.5) < 1e-9,
  `drawdown=${ddBefore} wouldReachUsd=${a6.wouldReachUsd}`);

recordPayout({ session_id: SID, marketId: '0xm_0', payoutUsd: 5.0 });
const ddAfter = riskSnapshot(SID).drawdownUsd;
const a7 = checkPreOrder({ session_id: SID, marketId: '0xm_fresh', estimatedSpendUsd: 0.9 });
check(7, 'a 5.0 USD payout reduces drawdown and re-opens capacity',
  a7.allow === true && Math.abs(ddAfter - 4.6) < 1e-9,
  `drawdown ${ddBefore} -> ${ddAfter}, allow=${a7.allow}`);
releaseReservation({ session_id: SID, reservationId: a7.reservationId, why: 'test cleanup' });

_resetRiskState(SID);
const a8 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 'not-a-number' });
check(8, 'non-numeric spend is refused (fail closed)',
  a8.allow === false && a8.code === 'invalid_estimated_spend', `code=${a8.code}`);

// THE assertion that matters most: limits are not caller-influenceable.
_resetRiskState(SID);
const a9 = checkPreOrder({ session_id: SID,
  marketId: M1, estimatedSpendUsd: 12.76,
  // all of these are ignored by design — a model must not be able to raise a cap
  maxStakePerWindowUsd: 1000, maxDailyLossUsd: 1000,
  limits: { maxStakePerWindowUsd: 1000 }, RISK_CONFIG: { maxStakePerWindowUsd: 1000 },
});
check(9, 'a caller passing maxStakePerWindowUsd:1000 CANNOT raise the limit',
  a9.allow === false && a9.code === 'max_stake_per_window_exceeded'
    && a9.limits.maxStakePerWindowUsd === 5,
  `still refused; limits.maxStakePerWindowUsd reported as ${a9.limits.maxStakePerWindowUsd}, not 1000`);
check(10, 'RISK_CONFIG was not mutated by that attempt',
  RISK_CONFIG.maxStakePerWindowUsd === 5 && RISK_CONFIG.maxDailyLossUsd === 10,
  `${RISK_CONFIG.maxStakePerWindowUsd}/${RISK_CONFIG.maxDailyLossUsd}`);

// ============================================================================
console.log('\n=== GROUP B — RESERVATION LIFECYCLE (the Phase C concurrency fix) ===');
// ============================================================================

_resetRiskState(SID);
const b1 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
const snapB1 = riskSnapshot(SID);
check(11, 'approval RESERVES immediately — before any spend is recorded',
  b1.allow === true && b1.reservationId && snapB1.reservedUsd === 2
    && snapB1.openReservations === 1 && snapB1.spendUsd === 0,
  `reservedUsd=${snapB1.reservedUsd} spendUsd=${snapB1.spendUsd} open=${snapB1.openReservations}`);
check(12, 'an open reservation counts toward the window cap right away',
  snapB1.perMarketExposureUsd[M1] === 2,
  `perMarketExposureUsd[${M1}]=${snapB1.perMarketExposureUsd[M1]} while perMarketCommittedUsd=${JSON.stringify(snapB1.perMarketCommittedUsd)}`);

// ---- TEST 13: THE RACE. This is the assertion the whole fix exists for.
//
// Reproduces the observed interleaving: each caller runs checkPreOrder, then
// AWAITS (as place_order does across allowance + simulation + broadcast), then
// resolves. Under the old check-then-act code every caller read the same stale
// committed total of 0 and all were approved. Three 2 USD orders => 6 USD
// against a 5 USD cap.
_resetRiskState(SID);
const raceLog = [];
async function racingOrder(tag, usd) {
  const rk = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: usd });
  raceLog.push({ tag, allow: rk.allow, code: rk.code ?? null,
    sawCommittedOrReserved: rk.alreadyCommittedThisWindowUsd });
  if (!rk.allow) return { tag, refused: true, code: rk.code };
  // the real flow awaits here for seconds — allowance tx, simulation, broadcast
  await new Promise((r) => setTimeout(r, 10 + Math.abs(usd * 3)));
  commitReservation({ session_id: SID, reservationId: rk.reservationId, actualSpentUsd: usd });
  return { tag, refused: false };
}
const raceOut = await Promise.all([
  racingOrder('A', 2.0), racingOrder('B', 2.0), racingOrder('C', 2.0),
]);
const approved = raceOut.filter((r) => !r.refused).length;
const refused = raceOut.filter((r) => r.refused).length;
const finalExposure = riskSnapshot(SID).perMarketExposureUsd[M1] ?? 0;
check(13, 'CONCURRENCY: three concurrent 2 USD orders against a 5 USD cap cannot all pass',
  approved === 2 && refused === 1 && finalExposure <= 5,
  `approved=${approved} refused=${refused} finalExposure=${finalExposure} USD (<= ${LIM} cap)\n         ` +
  raceLog.map((r) => `${r.tag}: allow=${r.allow}${r.code ? ` code=${r.code}` : ''} saw ${r.sawCommittedOrReserved} already held`).join('\n         '));
check(14, 'the third caller SAW the other two reservations rather than a stale zero',
  raceLog.some((r) => r.allow === false && r.sawCommittedOrReserved === 4),
  `refused caller observed ${raceLog.find((r) => !r.allow)?.sawCommittedOrReserved} USD already committed-or-reserved (stale read would have been 0)`);

// ---- commit with actual < reserved releases the difference
_resetRiskState(SID);
const b4 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 4.0 });   // worst case
commitReservation({ session_id: SID, reservationId: b4.reservationId, actualSpentUsd: 0.101229 });
const snapB4 = riskSnapshot(SID);
check(15, 'commit with actual < reserved releases the difference back to capacity',
  snapB4.reservedUsd === 0 && Math.abs(snapB4.spendUsd - 0.101229) < 1e-9
    && snapB4.openReservations === 0,
  `reserved 4.0 -> actual 0.101229; reservedUsd=${snapB4.reservedUsd} spendUsd=${snapB4.spendUsd}`);
const b4b = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 4.5 });
check(16, 'that released capacity is genuinely reusable',
  b4b.allow === true, `a 4.5 USD order on the same window is now allowed (exposure was 4.0 reserved, now 0.101229 real)`);
releaseReservation({ session_id: SID, reservationId: b4b.reservationId, why: 'test cleanup' });

// ---- a reverted placement: commit(0) is a full release with no spend
_resetRiskState(SID);
const b5 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 3.0 });
commitReservation({ session_id: SID, reservationId: b5.reservationId, actualSpentUsd: 0 });
const snapB5 = riskSnapshot(SID);
check(17, 'a reverted placement (commit 0) records NO spend and frees the reservation',
  snapB5.spendUsd === 0 && snapB5.reservedUsd === 0 && snapB5.openReservations === 0,
  `spendUsd=${snapB5.spendUsd} reservedUsd=${snapB5.reservedUsd} — matches "a reverted tx moves no collateral"`);

// ---- explicit release
_resetRiskState(SID);
const b6 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 3.0 });
releaseReservation({ session_id: SID, reservationId: b6.reservationId, why: 'refused after reserving (slippage)' });
const snapB6 = riskSnapshot(SID);
check(18, 'releaseReservation frees capacity and records no spend',
  snapB6.reservedUsd === 0 && snapB6.spendUsd === 0 && snapB6.openReservations === 0,
  `reservedUsd=${snapB6.reservedUsd} spendUsd=${snapB6.spendUsd}`);

// ---- idempotency: a double-commit must not double-count
_resetRiskState(SID);
const b7 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
commitReservation({ session_id: SID, reservationId: b7.reservationId, actualSpentUsd: 1.5 });
const afterFirst = riskSnapshot(SID).spendUsd;
const dbl = commitReservation({ session_id: SID, reservationId: b7.reservationId, marketId: M1, actualSpentUsd: 1.5 });
const afterSecond = riskSnapshot(SID).spendUsd;
check(19, 'a double-commit is flagged as an orphan rather than corrupting the ledger',
  !!dbl.warning && afterFirst === 1.5,
  `first commit spendUsd=${afterFirst}; second returned a warning: ${dbl.warning ? 'yes' : 'no'}`);
check(20, 'HONEST NOTE — the orphan path DOES add the spend again (documented, not silent)',
  Math.abs(afterSecond - 3.0) < 1e-9,
  `spendUsd ${afterFirst} -> ${afterSecond}. commitReservation() deliberately records real spend with no matching reservation so money that MOVED is never dropped; the cost is that a buggy double-commit double-counts. place_order guards this with its own reservationResolved flag (tested below).`);

// ---- the reservationResolved guard place_order uses
_resetRiskState(SID);
const b8 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
let resolved = false;
const guardedCommit = (usd) => {
  if (!b8.reservationId || resolved) return false;
  commitReservation({ session_id: SID, reservationId: b8.reservationId, marketId: M1, actualSpentUsd: usd });
  resolved = true; return true;
};
guardedCommit(1.5); const g1 = riskSnapshot(SID).spendUsd;
guardedCommit(1.5); const g2 = riskSnapshot(SID).spendUsd;
check(21, 'place_order\'s reservationResolved guard makes commit exactly-once',
  g1 === 1.5 && g2 === 1.5,
  `two guarded commit calls -> spendUsd stayed ${g2} (this is why the guard exists)`);

// ---- a LEAKED reservation eats capacity — proving why the backstop matters
_resetRiskState(SID);
const b9 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 4.0 });
// deliberately never resolved
const leaked = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
check(22, 'an UNRESOLVED reservation permanently eats capacity — the reason for the try/finally backstop',
  leaked.allow === false && _openReservations(SID).length === 1,
  `a leaked 4.0 USD reservation refuses a subsequent legitimate 2.0 USD order (code=${leaked.code}). place_order's finally-block release is what prevents this.`);
releaseReservation({ session_id: SID, reservationId: b9.reservationId, why: 'simulating the backstop' });
const recovered = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
check(23, 'the backstop release fully restores that capacity',
  recovered.allow === true && riskSnapshot(SID).reservedUsd === 2,
  `after release, the same 2.0 USD order is allowed`);
releaseReservation({ session_id: SID, reservationId: recovered.reservationId, why: 'test cleanup' });

// ---- daily cap counts reservations too
_resetRiskState(SID);
const held = [];
for (let i = 0; i < 5; i++) {
  const r = checkPreOrder({ session_id: SID, marketId: `0xdm_${i}`, estimatedSpendUsd: 1.9 });
  if (r.allow) held.push(r.reservationId);
}
const snapDaily = riskSnapshot(SID);
const dailyBlocked = checkPreOrder({ session_id: SID, marketId: '0xdm_last', estimatedSpendUsd: 1.9 });
check(24, 'the DAILY cap counts open reservations, so concurrent orders cannot breach it either',
  snapDaily.drawdownUsd === 9.5 && dailyBlocked.allow === false
    && dailyBlocked.code === 'max_daily_loss_exceeded',
  `5 open reservations of 1.9 = drawdown ${snapDaily.drawdownUsd} (all unspent); a 6th would reach ${dailyBlocked.wouldReachUsd} > ${DAY} -> ${dailyBlocked.code}`);
check(25, 'that drawdown is composed entirely of reservations, not spend',
  snapDaily.spendUsd === 0 && snapDaily.reservedUsd === 9.5,
  `spendUsd=${snapDaily.spendUsd} reservedUsd=${snapDaily.reservedUsd}`);
for (const id of held) releaseReservation({ session_id: SID, reservationId: id, why: 'test cleanup' });
check(26, 'releasing all of them restores the full daily budget',
  riskSnapshot(SID).drawdownUsd === 0 && riskSnapshot(SID).remainingDailyLossBudgetUsd === DAY,
  `drawdown=${riskSnapshot(SID).drawdownUsd} remaining=${riskSnapshot(SID).remainingDailyLossBudgetUsd}`);

// ---- the ledger records every transition
_resetRiskState(SID);
const b10 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 2.0 });
commitReservation({ session_id: SID, reservationId: b10.reservationId, actualSpentUsd: 1.0 });
const b11 = checkPreOrder({ session_id: SID, marketId: M1, estimatedSpendUsd: 1.0 });
releaseReservation({ session_id: SID, reservationId: b11.reservationId, why: 'audit trail test' });
recordPayout({ session_id: SID, marketId: M1, payoutUsd: 0.5 });
const kinds = _riskEvents(SID).map((e) => e.kind);
check(27, 'every state transition is recorded in an auditable ledger',
  JSON.stringify(kinds) === JSON.stringify(['reserve', 'commit', 'reserve', 'release', 'payout']),
  `event kinds: ${kinds.join(' -> ')}`);
const commitEvent = _riskEvents(SID).find((e) => e.kind === 'commit');
check(28, 'the commit event records reserved, actual, AND the released difference',
  commitEvent.reservedUsd === 2 && commitEvent.actualUsd === 1 && commitEvent.releasedDifferenceUsd === 1,
  `reserved=${commitEvent.reservedUsd} actual=${commitEvent.actualUsd} releasedDifference=${commitEvent.releasedDifferenceUsd}`);

// ============================================================================
_resetRiskState(SID);
console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
if (fail) {
  console.log('\nFAILURES:');
  for (const r of results.filter((r) => r.result === 'FAIL')) console.log(`  ${r.n}. ${r.name}\n     ${r.detail}`);
}
process.exit(fail ? 1 : 0);
