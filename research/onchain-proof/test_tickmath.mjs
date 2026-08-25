// test_tickmath.mjs - REQUIRED TASK: unit-test 18-decimal tick math against
// mainnet's REAL on-chain parameters (tickSize read live from a live mainnet pool).
// READ-ONLY. No private key required.
//
// Proves: naive parseUnits(price.toFixed(18), 18) produces OFF-TICK raw prices
// for ordinary probabilities, while snapPriceToTick() always produces a valid
// multiple of the pool's real tickSize. Also proves testnet (6 dec) hides the bug.
import { parseUnits } from 'viem';
import { SomniaMarkets } from '@somnia-chain/markets-sdk';
import { MAINNET_CFG, TESTNET_CFG, MAINNET_POOLS } from './config.mjs';
import { snapPriceToTick, isOnTick, exactToRaw, rawToProbString } from './tickmath.mjs';

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('   FAIL:', msg); } };

// ---------------------------------------------------------------- live params
console.log('=== 1. READ REAL TICK PARAMS FROM LIVE POOLS (no key) ===');
const mex = new SomniaMarkets(MAINNET_CFG);
const mp = await mex.client.getBinaryBookParams(MAINNET_POOLS.ETH);
const MAIN_TICK = BigInt(mp.tickSize);
const MAIN_DEC = 18;
console.log(`mainnet ETH pool ${MAINNET_POOLS.ETH}`);
console.log(`  tickSize=${MAIN_TICK} lotSize=${mp.lotSize} minQuantity=${mp.minQuantity}  (decimals=${MAIN_DEC})`);
console.log(`  => tick as probability = ${rawToProbString(MAIN_TICK, MAIN_DEC)}`);

const tex = new SomniaMarkets(TESTNET_CFG);
const tlive = await tex.client.listLiveBinaryMarkets();
const tm = tlive[0];
const tp = await tex.client.getBinaryBookParams(tm.poolAddress);
const TEST_TICK = BigInt(tp.tickSize);
const TEST_DEC = tm.quoteDecimals;
console.log(`testnet pool ${tm.poolAddress}`);
console.log(`  tickSize=${TEST_TICK} (decimals=${TEST_DEC}) => probability ${rawToProbString(TEST_TICK, TEST_DEC)}`);

// -------------------------------------------------- the headline demonstration
const PROBS = [0.05, 0.1, 0.35, 0.6, 0.62, 0.9, 0.25, 0.5, 0.75, 0.01, 0.99, 0.123, 0.375, 0.7, 0.2, 0.8, 0.15, 0.45];

console.log('\n=== 2. MAINNET 18-DEC: naive parseUnits(p.toFixed(18),18) vs snapPriceToTick ===');
console.log('tick = ' + MAIN_TICK + ' (raw price must be a multiple of this)\n');
const head = 'prob    toFixed(18)             naive raw (18dec)      naive?  snapped raw            snap?';
console.log(head);
console.log('-'.repeat(head.length + 6));
const naiveSurvivors = [], naiveBroken = [];
for (const p of PROBS) {
  const fx = p.toFixed(18);
  const naive = parseUnits(fx, MAIN_DEC);              // THE BROKEN PATH
  const snapped = snapPriceToTick(p, MAIN_TICK, MAIN_DEC); // THE FIX
  const nOk = isOnTick(naive, MAIN_TICK);
  const sOk = isOnTick(snapped, MAIN_TICK);
  (nOk ? naiveSurvivors : naiveBroken).push(p);
  ok(sOk, `snapPriceToTick(${p}) produced OFF-TICK ${snapped}`);
  console.log(
    String(p).padEnd(7) +
    fx.padEnd(23) + ' ' +
    String(naive).padEnd(22) + ' ' +
    (nOk ? 'ON  ' : 'OFF ').padEnd(7) +
    String(snapped).padEnd(22) + ' ' +
    (sOk ? 'ON' : 'OFF'));
}
console.log(`\nnaive survives for : ${JSON.stringify(naiveSurvivors)}`);
console.log(`naive OFF-TICK for : ${JSON.stringify(naiveBroken)}`);
console.log(`=> naive path is broken for ${naiveBroken.length}/${PROBS.length} ordinary probabilities.`);
ok(naiveBroken.length > 0, 'expected the naive path to be broken for some probabilities');

// ------------------------------------------------ exhaustive sweep of all ticks
console.log('\n=== 3. EXHAUSTIVE SWEEP: every valid 0.001 tick, 0.001 .. 0.999 (999 values) ===');
let nBad = 0, sBad = 0; const survivors = [];
for (let i = 1; i <= 999; i++) {
  const p = i / 1000;                                   // an EXACT on-tick probability
  const naive = parseUnits(p.toFixed(18), MAIN_DEC);
  const snapped = snapPriceToTick(p, MAIN_TICK, MAIN_DEC);
  if (!isOnTick(naive, MAIN_TICK)) nBad++; else survivors.push(p);
  if (!isOnTick(snapped, MAIN_TICK)) sBad++;
  // snapped must also be the CORRECT tick, not merely any tick
  const want = BigInt(i) * MAIN_TICK;
  if (snapped !== want) { sBad++; console.log(`   FAIL: snap(${p}) = ${snapped}, want ${want}`); }
}
console.log(`naive  parseUnits(p.toFixed(18),18) : ${nBad}/999 OFF-TICK  (${(nBad/999*100).toFixed(1)}%)`);
console.log(`snapPriceToTick()                   : ${sBad}/999 OFF-TICK  (0% expected)`);
console.log(`naive survivors (${survivors.length}): ${JSON.stringify(survivors.slice(0, 40))}${survivors.length>40?' ...':''}`);
ok(sBad === 0, 'snapPriceToTick must be on-tick for all 999 ticks');
ok(nBad > 500, 'expected naive path to fail for a majority of ticks');

// ------------------------------------------------------- testnet hides the bug
console.log('\n=== 4. TESTNET 6-DEC: same naive call, bug is INVISIBLE ===');
let tBad = 0;
for (let i = 1; i <= 999; i++) {
  const p = i / 1000;
  const naive = parseUnits(p.toFixed(18), TEST_DEC);  // 6 decimals truncates the float garbage
  if (!isOnTick(naive, TEST_TICK)) tBad++;
}
console.log(`naive parseUnits(p.toFixed(18), ${TEST_DEC}) vs tick ${TEST_TICK}: ${tBad}/999 OFF-TICK`);
console.log(tBad === 0
  ? '=> CONFIRMED: testnet (6 dec) reports 0 failures. Testnet CANNOT expose this bug.'
  : `=> testnet also fails (${tBad}) - unexpected.`);
ok(tBad === 0, 'expected testnet 6-dec to hide the bug entirely');

// ------------------------------------------------- non-tick inputs get snapped
console.log('\n=== 5. snapping genuinely off-tick inputs (round half-up to nearest tick) ===');
for (const p of ['0.6234', '0.05049', '0.05051', '0.0005', '0.99999', '0.3335']) {
  const s = snapPriceToTick(p, MAIN_TICK, MAIN_DEC);
  console.log(`  ${String(p).padEnd(9)} -> ${String(s).padEnd(22)} = ${rawToProbString(s, MAIN_DEC).padEnd(7)} onTick=${isOnTick(s, MAIN_TICK)}`);
  ok(isOnTick(s, MAIN_TICK), `snap(${p}) off-tick`);
}

// ------------------------------------------------------------- exactToRaw unit
console.log('\n=== 6. exactToRaw sanity (float-free) ===');
const cases = [['0.05',18,50000000000000000n],['0.35',18,350000000000000000n],['0.999',18,999000000000000000n],
                ['0.05',6,50000n],['1',18,1000000000000000000n],['0.0000005',6,1n]];
for (const [v,d,want] of cases) {
  const got = exactToRaw(v,d);
  ok(got===want, `exactToRaw(${v},${d}) = ${got}, want ${want}`);
  console.log(`  exactToRaw(${String(v).padEnd(10)},${String(d).padEnd(2)}) = ${String(got).padEnd(22)} ${got===want?'ok':'FAIL'}`);
}
// and prove the number path is safe too
ok(exactToRaw(0.05,18)===50000000000000000n, 'exactToRaw(number 0.05,18)');
console.log(`  exactToRaw(0.05 as NUMBER,18) = ${exactToRaw(0.05,18)} (vs naive ${parseUnits((0.05).toFixed(18),18)})`);

console.log('\n' + '='.repeat(70));
console.log(fails === 0 ? 'ALL TICK-MATH ASSERTIONS PASSED' : `${fails} ASSERTION(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
