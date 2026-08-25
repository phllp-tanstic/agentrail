// ============================================================================
// AgentRail — PHASE A: full lifecycle, one continuous run, real broadcasts.
//   1. status-gate a live binary market (getMarketOnchain == Trading)
//   2. snap price to a valid integer tick (confirmed tick-math fix)
//   3. place a REAL order via placeBinaryOrder  (SELF path, 0x718c2d4d)
//   4. wait for the window to settle
//   5. discover the settled position via listBinaryMarkets({status:"Finalized"})
//   6. REDEEM for real — broadcast, not just signed
//
// Reads AGENTRAIL_OWNER_KEY from env. NEVER logs it. Logs the derived address
// (public) only. Every tx hash is printed and saved to PHASE-A-RESULT.json.
// ============================================================================
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import {
  createPublicClient, createWalletClient, http, erc20Abi, encodeFunctionData,
  decodeErrorResult, formatUnits, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redeemGuard } from './redeem-guard.mjs';
import { exactToRaw, snapPriceToTick, isOnTick } from './tick-snap.mjs';
import fs from 'node:fs';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const COLL = A.collateral;
const SELF_SELECTOR = '0x718c2d4d';           // placeBinaryOrder — confirmed self path
const T0 = Date.now();
const el = () => `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const L = (...a) => console.log(el(), ...a);
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const KEY = process.env.AGENTRAIL_OWNER_KEY;
if (!KEY) { console.log('FATAL: AGENTRAIL_OWNER_KEY not set'); process.exit(1); }
const owner = privateKeyToAccount(KEY);
const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wc = createWalletClient({ account: owner, chain: somniaShannon, transport: http(RPC) });
const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });

const ERRMAP = JSON.parse(fs.readFileSync('research/onchain-proof/error-selectors.json', 'utf8'));
const R = { owner: owner.address, chain: 'somnia-shannon-testnet', chainId: somniaShannon.id, tx: {}, steps: {} };

function decodeRevert(d) {
  if (!d) return 'NO REVERT DATA';
  if (d === '0x') return 'EMPTY 0x (not dispatched)';
  const s = d.slice(0, 10).toLowerCase();
  const named = ERRMAP[s];
  let out = `${s} = ${named ?? 'UNKNOWN'}`;
  if (named && d.length > 10) {
    const types = named.slice(named.indexOf('(') + 1, -1).split(',').filter(Boolean);
    const words = d.slice(10).match(/.{64}/g) || [];
    out += ` ( ${words.map((w, i) => types[i] === 'address' ? `address=0x${w.slice(24)}` : `${types[i] ?? '?'}=${BigInt('0x' + w)}`).join(', ')} )`;
  }
  return out;
}
async function rawCall({ from, to, data }) {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data }, 'latest'] };
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (!r.error) return { ok: true, result: r.result };
  const m = JSON.stringify(r.error).match(/0x[0-9a-fA-F]{8,}/);
  return { ok: false, data: m ? m[0] : '0x', msg: r.error.message };
}
async function send(label, req) {
  const hash = await wc.sendTransaction(req);
  const rcpt = await pc.waitForTransactionReceipt({ hash });
  L(`   tx ${label}: ${hash}  status=${rcpt.status} block=${rcpt.blockNumber} gas=${rcpt.gasUsed} logs=${rcpt.logs.length}`);
  R.tx[label] = { hash, status: rcpt.status, block: Number(rcpt.blockNumber), gasUsed: String(rcpt.gasUsed), logs: rcpt.logs.length };
  if (rcpt.status !== 'success') throw new Error(`${label} REVERTED on-chain: ${hash}`);
  return rcpt;
}
const bal6909 = (id) => pc.readContract({ address: A.outcomeToken6909 ?? '0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9',
  abi: SDK.erc6909Abi, functionName: 'balanceOf', args: [owner.address, BigInt(id)] });
const balColl = () => pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });

console.log('='.repeat(78));
console.log('AgentRail PHASE A — full lifecycle, real broadcasts, testnet');
console.log('='.repeat(78));
L('owner (public address):', owner.address);
L('collateral:', COLL, '| binaryModule:', A.binaryModule);

// ---------------------------------------------------------------- STEP 0: fund
console.log('\n' + '-'.repeat(78));
L('STEP 0 — collateral funding (prerequisite)');
let cb = await balColl();
L('tUSDC balance:', formatUnits(cb, 6));
if (cb < 100_000000n) {
  const per = await pc.readContract({ address: COLL, abi: parseAbi(['function FAUCET_PER_TX() view returns (uint256)']), functionName: 'FAUCET_PER_TX' });
  L('FAUCET_PER_TX =', formatUnits(per, 6), '-> calling faucet()');
  await send('faucet', { to: COLL, data: encodeFunctionData({ abi: parseAbi(['function faucet(uint256)']), functionName: 'faucet', args: [per] }) });
  cb = await balColl();
  L('tUSDC balance after faucet:', formatUnits(cb, 6));
}
if (cb === 0n) { console.log('FATAL: still zero collateral, cannot trade'); process.exit(1); }
R.steps.step0_funding = { collateralBalance: cb.toString(), decimals: 6 };

// ------------------------------------------------- STEP 1: pick + STATUS GATE
console.log('\n' + '-'.repeat(78));
L('STEP 1 — market selection + ON-CHAIN STATUS GATE');

async function pickMarket(minT = 22, maxT = 70) {
  for (let attempt = 1; attempt <= 40; attempt++) {
    const live = await ex.client.listLiveBinaryMarkets();
    const now = Math.floor(Date.now() / 1000);
    const cands = [];
    for (const m of live) {
      const T = Number(m.expiry) - now;
      if (Number(m.intervalSec) > 900) continue;          // keep the settle wait short
      if (T < minT || T > maxT) continue;
      let ob = null;
      try { ob = await ex.client.getBinaryOrderBook(m.poolAddress); } catch { }
      if (!ob?.yesAsks?.length || !ob?.noAsks?.length) continue;
      cands.push({ m, T, ob, interval: Number(m.intervalSec) });
    }
    cands.sort((a, b) => a.interval - b.interval || b.T - a.T);
    if (cands.length) return cands[0];
    L(`   no candidate in T-${minT}..${maxT}s with two-sided depth (attempt ${attempt}) — waiting 5s`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('no tradable short-window market found');
}
const pick = await pickMarket();
const M = pick.m;
L(`selected: ${M.marketId} ${M.asset} interval=${pick.interval}s pool=${M.poolAddress} T-${pick.T}s`);
L(`  yesAsks[0]=${J(pick.ob.yesAsks[0])} noAsks[0]=${J(pick.ob.noAsks[0])}`);
L(`  operatorId=${M.operatorId} venueId=${M.venueId}`);
L(`  yesTokenId=${M.yesTokenId}`);
L(`  noTokenId=${M.noTokenId}`);

const onchain = await ex.client.getMarketOnchain(M.marketId);
L('getMarketOnchain ->', J({ status: onchain.status, finalized: onchain.finalized, isResolved: onchain.isResolved, winningOutcome: onchain.winningOutcome }));
const gateOpen = onchain.status === 1 || onchain.status === 'Trading';
L(`STATUS GATE (status===1 / "Trading"): ${gateOpen ? 'OPEN — proceed' : 'CLOSED — abort'}`);
if (!gateOpen) { console.log('FATAL: status gate closed'); process.exit(1); }
R.steps.step1_statusGate = { marketId: M.marketId, pool: M.poolAddress, asset: M.asset,
  intervalSec: pick.interval, expiry: String(M.expiry), secsToExpiry: pick.T,
  onchainStatus: onchain.status, gate: 'OPEN', operatorId: M.operatorId, venueId: M.venueId,
  yesTokenId: String(M.yesTokenId), noTokenId: String(M.noTokenId) };

// -------------------------------------------------------- STEP 2: tick snapping
console.log('\n' + '-'.repeat(78));
L('STEP 2 — integer tick snapping (the confirmed tick-math fix)');
const bp = await ex.client.getBinaryBookParams(M.poolAddress);
const tick = BigInt(bp.tickSize), lot = BigInt(bp.lotSize), minQ = BigInt(bp.minQuantity);
const DEC = Number(M.quoteDecimals);
L(`book params: tickSize=${tick} lotSize=${lot} minQuantity=${minQ} decimals=${DEC}`);

// Tick math moved VERBATIM to ./tick-snap.mjs (Phase B) so the MCP layer cannot
// drift from the proven price snapping. Same pattern as ./redeem-guard.mjs.
// Behaviour unchanged — see build/PHASE-B-LOG.md STEP 1.

// Cross the spread so the order actually FILLS: bid a few ticks above best ask.
const rawAskYes = BigInt(pick.ob.yesAsks[0].price);
const rawAskNo = BigInt(pick.ob.noAsks[0].price);
const ONE = 10n ** BigInt(DEC);
const bidYes = snapPriceToTick(formatUnits(rawAskYes + 500n * tick, DEC), tick, DEC);
const bidNo = snapPriceToTick(formatUnits(rawAskNo + 500n * tick, DEC), tick, DEC);
L(`YES: bestAsk=${rawAskYes} -> snapped crossing bid=${bidYes} onTick=${isOnTick(bidYes, tick)} (p=${formatUnits(bidYes, DEC)})`);
L(`NO : bestAsk=${rawAskNo} -> snapped crossing bid=${bidNo} onTick=${isOnTick(bidNo, tick)} (p=${formatUnits(bidNo, DEC)})`);
// negative control: the naive 18-dec path, proving the snapper is doing real work
const naive18 = exactToRaw(Number(formatUnits(bidYes, DEC)).toFixed(18), 18);
L(`negative control @18dec: naive=${naive18} onTick(1e15)=${isOnTick(naive18, 10n ** 15n)}  <- the mainnet bug`);
R.steps.step2_tickSnap = { tickSize: String(tick), lotSize: String(lot), minQuantity: String(minQ), decimals: DEC,
  bestAskYes: String(rawAskYes), snappedBidYes: String(bidYes), onTickYes: isOnTick(bidYes, tick),
  bestAskNo: String(rawAskNo), snappedBidNo: String(bidNo), onTickNo: isOnTick(bidNo, tick),
  naive18DecControl: String(naive18), naive18OnTick: isOnTick(naive18, 10n ** 15n) };

// ------------------------------------------- STEP 3: place REAL order, self path
console.log('\n' + '-'.repeat(78));
L('STEP 3 — place REAL order via placeBinaryOrder (SELF path 0x718c2d4d)');
const QTY = minQ * 1000n;                                     // 1.0 unit at 6 dec
const expireNs = BigInt(M.expiry) * 1_000_000_000n;           // pin to market expiry
const encodeSelf = (kind, priceRaw) => encodeFunctionData({
  abi: SDK.binaryPoolWriteAbi, functionName: 'placeBinaryOrder',
  args: [kind, priceRaw, QTY, expireNs, SDK.ORDER_TYPE.LIMIT, SDK.SELF_MATCHING_OPTION.CANCEL_TAKER,
         SDK.ZERO_ADDRESS, 0n, 0n],
});
const dYes = encodeSelf(SDK.ORDER_KIND.BUY_YES, bidYes);
L(`qty=${QTY} expireNs=${expireNs} (pinned to market expiry)`);
L(`selector=${dYes.slice(0, 10)} (expect ${SELF_SELECTOR}) calldata bytes=${(dYes.length - 2) / 2} (expect 4+9*32=292)`);
if (dYes.slice(0, 10) !== SELF_SELECTOR) L(`   !! selector mismatch vs ground truth ${SELF_SELECTOR}`);

// simulate to discover the required allowance spender, then approve exactly that
let sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
L('pre-approval simulation ->', sim.ok ? 'NO REVERT' : decodeRevert(sim.data));
if (!sim.ok && sim.data?.slice(0, 10).toLowerCase() === '0xfb8f41b2') {
  const spender = '0x' + sim.data.slice(34, 74);
  L(`ERC20InsufficientAllowance names spender=${spender} -> approving`);
  await send('approve', { to: COLL, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }) });
  R.steps.step3_allowance = { spender, approved: 'max' };
  sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
  L('post-approval simulation ->', sim.ok ? 'NO REVERT — clean' : decodeRevert(sim.data));
}
if (!sim.ok) { R.steps.step3_place = { failed: decodeRevert(sim.data) }; fs.writeFileSync('build/PHASE-A-RESULT.json', J(R)); console.log('FATAL: order still reverts in simulation:', decodeRevert(sim.data)); process.exit(1); }

const yesBefore = await bal6909(M.yesTokenId), noBefore = await bal6909(M.noTokenId), collBefore = await balColl();
L(`pre-order: yes6909=${yesBefore} no6909=${noBefore} collateral=${formatUnits(collBefore, 6)}`);
const rcYes = await send('placeBinaryOrder_BUY_YES', { to: M.poolAddress, data: dYes });
// second leg: BUY_NO in the same window, so exactly one side is guaranteed to win
// and the STEP 6 redeem is provably non-zero rather than a zero-payout no-op.
const dNo = encodeSelf(SDK.ORDER_KIND.BUY_NO, bidNo);
let rcNo = null;
try { rcNo = await send('placeBinaryOrder_BUY_NO', { to: M.poolAddress, data: dNo }); }
catch (e) { L('   BUY_NO leg failed (non-fatal, YES leg is the primary proof):', e.message.slice(0, 140)); }

const yesAfter = await bal6909(M.yesTokenId), noAfter = await bal6909(M.noTokenId), collAfter = await balColl();
L(`post-order: yes6909=${yesAfter} (+${yesAfter - yesBefore}) no6909=${noAfter} (+${noAfter - noBefore})`);
L(`collateral: ${formatUnits(collBefore, 6)} -> ${formatUnits(collAfter, 6)} (delta ${formatUnits(collAfter - collBefore, 6)})`);
const filled = yesAfter > yesBefore;
L(`FILL CONFIRMED: ${filled ? 'YES — outcome tokens minted to owner' : 'NO — order rested unfilled'}`);
R.steps.step3_place = {
  selector: dYes.slice(0, 10), calldataBytes: (dYes.length - 2) / 2, qty: String(QTY), expireNs: String(expireNs),
  yesBefore: String(yesBefore), yesAfter: String(yesAfter), yesDelta: String(yesAfter - yesBefore),
  noBefore: String(noBefore), noAfter: String(noAfter), noDelta: String(noAfter - noBefore),
  collateralBefore: String(collBefore), collateralAfter: String(collAfter),
  collateralDelta: String(collAfter - collBefore), fillConfirmed: filled,
};
if (!filled) { fs.writeFileSync('build/PHASE-A-RESULT.json', J(R)); console.log('FATAL: no fill — cannot proceed to settle/redeem'); process.exit(1); }

// -------------------------------------------------------- STEP 4: wait to settle
console.log('\n' + '-'.repeat(78));
L('STEP 4 — wait for the window to settle');
const expirySec = Number(M.expiry);
let waited = 0;
while (Math.floor(Date.now() / 1000) < expirySec) { await new Promise(r => setTimeout(r, 2000)); waited += 2; }
L(`expiry ${expirySec} reached (waited ~${waited}s) — polling for finalization`);
let oc = null, polls = 0;
while (polls++ < 90) {
  oc = await ex.client.getMarketOnchain(M.marketId).catch(() => null);
  if (oc && (oc.finalized === true || oc.isResolved === true || oc.status === 3 || oc.status === 'Finalized')) break;
  if (polls % 5 === 0) L(`   poll ${polls}: status=${oc?.status} finalized=${oc?.finalized} isResolved=${oc?.isResolved}`);
  await new Promise(r => setTimeout(r, 2000));
}
L('settled onchain ->', J({ status: oc?.status, finalized: oc?.finalized, isResolved: oc?.isResolved, winningOutcome: oc?.winningOutcome }));
R.steps.step4_settle = { expiry: expirySec, polls, status: oc?.status, finalized: oc?.finalized,
  isResolved: oc?.isResolved, winningOutcome: oc?.winningOutcome };
if (!(oc?.finalized || oc?.isResolved || oc?.status === 3 || oc?.status === 'Finalized')) {
  fs.writeFileSync('build/PHASE-A-RESULT.json', J(R)); console.log('FATAL: market did not finalize within poll budget'); process.exit(1);
}

// ------------------------ STEP 5: discover via Finalized-status scan (NOT default)
console.log('\n' + '-'.repeat(78));
L('STEP 5 — discover the settled position via listBinaryMarkets({status:"Finalized"})');
const liveNow = await ex.client.listLiveBinaryMarkets();
const inLive = liveNow.some(x => x.marketId === M.marketId);
L(`our market present in listLiveBinaryMarkets()? ${inLive}  <- default discovery`);
let fin = [], found = null;
for (let i = 0; i < 20 && !found; i++) {
  fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 100 });
  found = fin.find(x => x.marketId === M.marketId) ?? null;
  if (!found) { L(`   not yet indexed as Finalized (${fin.length} finalized seen) — retry in 3s`); await new Promise(r => setTimeout(r, 3000)); }
}
L(`Finalized scan: ${fin.length} markets | OUR MARKET FOUND: ${!!found}`);
if (found) L('  ->', J({ marketId: found.marketId, status: found.status, finalized: found.finalized, voided: found.voided,
  winningOutcome: found.winningOutcome, payoutNumerators: found.payoutNumerators, payoutDenominator: found.payoutDenominator }));
const yesBal = await bal6909(M.yesTokenId), noBal = await bal6909(M.noTokenId);
L(`position held: yes=${yesBal} no=${noBal}`);
R.steps.step5_discovery = { inDefaultLiveListing: inLive, finalizedListCount: fin.length,
  ourMarketFoundInFinalized: !!found, winningOutcome: found?.winningOutcome ?? oc?.winningOutcome,
  payoutNumerators: found?.payoutNumerators, payoutDenominator: found?.payoutDenominator,
  yesBalance: String(yesBal), noBalance: String(noBal) };
if (!found) { fs.writeFileSync('build/PHASE-A-RESULT.json', J(R)); console.log('FATAL: market never appeared in the Finalized scan'); process.exit(1); }

// ------------------- STEP 5b: ERC6909 operator grant — the run-1 redeem blocker
// Run 1 failed step 6 with InsufficientPermission() (0xdeda9030) because the
// module can only burn the owner's ERC6909 outcome tokens if it holds operator
// rights over them. Grant them here, BEFORE redeem is attempted.
console.log('\n' + '-'.repeat(78));
L("STEP 5b — grant the module ERC6909 operator rights over the owner's outcome tokens");
const setOperatorAbi = [{
  type: 'function', name: 'setOperator',
  inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
  outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable',
}];
const MODULE = '0x3ecC694Cef705358864a646142ac17A90E29e388';        // binaryMarketsModule
const OUTCOME_TOKEN = '0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9'; // ERC6909, confirmed run 1
L(`token=${OUTCOME_TOKEN} module=${MODULE}`);
if (MODULE.toLowerCase() !== String(A.binaryModule).toLowerCase()) {
  L(`   !! MODULE literal disagrees with SDK binaryModule ${A.binaryModule}`);
}

// READ FIRST — the owner already ran a standalone setOperator(MODULE,true) earlier
// (tx 0x9652abf7…d661, success). If that grant is live for THIS owner address the
// broadcast here is redundant, so check rather than assume. Log which case it was.
let alreadyOperator = null, readErr = null;
try {
  alreadyOperator = await pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
    functionName: 'isOperator', args: [owner.address, MODULE] });
  L(`isOperator(owner=${owner.address}, operator=module) -> ${alreadyOperator}   <- read BEFORE any broadcast`);
} catch (e) {
  readErr = e.shortMessage ?? e.message;
  L(`isOperator read FAILED (${readErr}) — cannot skip on a read, will simulate then broadcast`);
}

// simulate before broadcasting, same rawCall pattern as the ERC20 approve above
const setOpData = encodeFunctionData({ abi: setOperatorAbi, functionName: 'setOperator', args: [MODULE, true] });
L(`setOperator calldata: selector=${setOpData.slice(0, 10)} bytes=${(setOpData.length - 2) / 2} (expect 4+2*32=68)`);
const opSim = await rawCall({ from: owner.address, to: OUTCOME_TOKEN, data: setOpData });
L(`   simulation -> ${opSim.ok ? `NO REVERT (returns ${opSim.result})` : decodeRevert(opSim.data)}`);

let grantCase;
if (alreadyOperator === true) {
  grantCase = 'ALREADY_GRANTED — redundant broadcast SKIPPED';
  L('CASE: ALREADY GRANTED — isOperator already true, skipping the redundant broadcast.');
} else if (!opSim.ok) {
  grantCase = `SIMULATION_REVERTED (${decodeRevert(opSim.data)}) — NOT broadcast`;
  L('CASE: SIMULATION REVERTED — not broadcasting blind. Redeem will likely still fail.');
} else {
  L(`CASE: NOT GRANTED (isOperator=${alreadyOperator}${readErr ? `, read err: ${readErr}` : ''}) — broadcasting setOperator.`);
  await send('setOperator_module', { to: OUTCOME_TOKEN, data: setOpData });
  const nowOp = await pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
    functionName: 'isOperator', args: [owner.address, MODULE] }).catch(() => null);
  L(`isOperator read back AFTER broadcast -> ${nowOp}`);
  grantCase = nowOp === true ? 'BROADCAST — granted, reads back true' : `BROADCAST — reads back ${nowOp}`;
}
R.steps.step5b_erc6909Operator = { token: OUTCOME_TOKEN, module: MODULE,
  isOperatorBefore: alreadyOperator, isOperatorReadError: readErr,
  simulation: opSim.ok ? 'NO REVERT' : decodeRevert(opSim.data), case: grantCase };

// ------------------------------------------------- STEP 6: REAL redeem, broadcast
console.log('\n' + '-'.repeat(78));
L('STEP 6 — REAL redeem, actually broadcast');
const win = Number(found.winningOutcome ?? oc?.winningOutcome ?? -1);
L(`winningOutcome = ${win} (0=YES, 1=NO)`);
const legs = [];
if (yesBal > 0n) legs.push({ idx: 0, amount: yesBal, label: 'YES', winner: win === 0 });
if (noBal > 0n) legs.push({ idx: 1, amount: noBal, label: 'NO', winner: win === 1 });
legs.sort((a, b) => Number(b.winner) - Number(a.winner));   // redeem the winner first
L('redeem legs:', J(legs.map(l => ({ ...l, amount: String(l.amount) }))));

// ==================== HARD CLIENT-SIDE GUARD — DO NOT REMOVE ====================
// Logic lives in ./redeem-guard.mjs (single source of truth, shared with the
// Part 3 proof script so the two can never drift). See PROOF-LOG.md RUN 3 PART 1.
const winOnchain = Number(oc?.winningOutcome ?? -1);
const winIndexed = (found?.winningOutcome === undefined || found?.winningOutcome === null)
  ? null : Number(found.winningOutcome);
const settledOnchain = oc?.finalized === true || oc?.isResolved === true;
L(`GUARD inputs: oc.winningOutcome=${winOnchain} indexer.winningOutcome=${winIndexed} settledOnchain=${settledOnchain}`);
// ================================================================================

const collPreRedeem = await balColl();
L(`collateral before redeem: ${formatUnits(collPreRedeem, 6)}`);
for (const leg of legs) {
  const data = encodeFunctionData({
    abi: SDK.binaryModuleWriteAbi, functionName: 'redeem',
    args: [Number(M.operatorId), M.venueId, M.marketId, leg.idx, leg.amount],
  });
  L(`redeem ${leg.label} (outcomeIdx=${leg.idx}, amount=${leg.amount}, winner=${leg.winner}) selector=${data.slice(0, 10)}`);

  // GUARD FIRST — before the simulation, and unconditionally before any broadcast.
  // A losing redeem simulates clean (it does not revert), so the simulation can
  // never catch this. Only this check can.
  const g = redeemGuard({ leg, oc, indexerWinningOutcome: found?.winningOutcome });
  L(`   GUARD -> ${g.allow ? 'ALLOW' : 'BLOCK'}: ${g.reason}`);
  R.steps[`step6_guard_${leg.label}`] = { outcomeIdx: leg.idx, amount: String(leg.amount),
    allow: g.allow, reason: g.reason, winOnchain, winIndexed, settledOnchain };
  if (!g.allow) {
    L(`   NOT BROADCAST — position left intact (${leg.amount} tokens preserved, not burned)`);
    continue;
  }

  const pre = await rawCall({ from: owner.address, to: A.binaryModule, data });
  L(`   simulation -> ${pre.ok ? 'NO REVERT' : decodeRevert(pre.data)}`);
  if (!pre.ok) { L('   skipping broadcast for this leg (would revert)'); R.steps[`step6_redeem_${leg.label}_sim`] = decodeRevert(pre.data); continue; }
  const before = await balColl();
  await send(`redeem_${leg.label}`, { to: A.binaryModule, data });
  const after = await balColl();
  const tokAfter = await bal6909(leg.idx === 0 ? M.yesTokenId : M.noTokenId);
  L(`   collateral ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} (payout ${formatUnits(after - before, 6)}) | 6909 balance now ${tokAfter}`);
  R.steps[`step6_redeem_${leg.label}`] = { outcomeIdx: leg.idx, amount: String(leg.amount), winner: leg.winner,
    collateralBefore: String(before), collateralAfter: String(after), payout: String(after - before),
    tokenBalanceAfter: String(tokAfter) };
}
const collPost = await balColl();
L(`TOTAL redeem payout: ${formatUnits(collPost - collPreRedeem, 6)} tUSDC`);
R.steps.step6_total = { collateralBefore: String(collPreRedeem), collateralAfter: String(collPost),
  totalPayout: String(collPost - collPreRedeem) };

console.log('\n' + '='.repeat(78));
L('PHASE A COMPLETE — tx hashes:');
for (const [k, v] of Object.entries(R.tx)) console.log(`   ${k.padEnd(28)} ${v.hash}  (${v.status})`);
fs.writeFileSync('build/PHASE-A-RESULT.json', J(R));
L('-> wrote build/PHASE-A-RESULT.json');
process.exit(0);
