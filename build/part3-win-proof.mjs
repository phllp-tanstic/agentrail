// ============================================================================
// PART 3 — the missing proof: a REAL WINNING PAYOUT.
//
// Strategy (per PROOF-LOG RUN 3 PART 2): YES-only, single-sided. The YES side has
// real matchable resting asks; the NO side is a display mirror with zero literal
// resting orders, so BUY_NO is avoided entirely rather than fixed.
//   - fresh 300s windows only (60s books were empty 2/2 at T-47s)
//   - up to 5 attempts, stop on the first WIN
//   - every attempt runs through the SHARED redeemGuard: BLOCK on losses,
//     ALLOW on the win — a live secondary proof of the Part 1 guard
//   - a win is confirmed by tUSDC balance delta AND ERC6909 burn, not tx status
// ============================================================================
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import {
  createPublicClient, createWalletClient, http, erc20Abi, encodeFunctionData,
  formatUnits, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redeemGuard } from './redeem-guard.mjs';
import { exactToRaw, snapPriceToTick, isOnTick } from './tick-snap.mjs';
import fs from 'node:fs';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const COLL = A.collateral;
const OUTCOME_TOKEN = '0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9';
const MAX_ATTEMPTS = 5;
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
const R = { owner: owner.address, startedAt: new Date().toISOString(), maxAttempts: MAX_ATTEMPTS, attempts: [], tx: {} };

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
  if (rcpt.status !== 'success') throw new Error(`${label} REVERTED: ${hash}`);
  return rcpt;
}
const bal6909 = (id) => pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi, functionName: 'balanceOf', args: [owner.address, BigInt(id)] });
const balColl = () => pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });

// Tick math moved VERBATIM to ./tick-snap.mjs (Phase B) — imported above.

console.log('='.repeat(78));
console.log('PART 3 — REAL WINNING PAYOUT PROOF (YES-only, 300s windows, max 5 attempts)');
console.log('='.repeat(78));
L('owner:', owner.address);

// pick a fresh 300s market with REAL resting yesAsks depth, that we have not used
const used = new Set();
async function pickYesMarket() {
  for (let att = 1; att <= 60; att++) {
    const live = await ex.client.listLiveBinaryMarkets();
    const now = Math.floor(Date.now() / 1000);
    const cands = [];
    for (const m of live) {
      if (used.has(m.marketId)) continue;
      const interval = Number(m.intervalSec), T = Number(m.expiry) - now;
      if (interval !== 300) continue;                 // 300s only — 60s books were empty
      if (T < 25 || T > 290) continue;                // room to place, not too long a wait
      let ob = null;
      try { ob = await ex.client.getBinaryOrderBook(m.poolAddress); } catch { }
      const depth = (ob?.yesAsks ?? []).reduce((a, l) => a + BigInt(l.quantity), 0n);
      if (depth === 0n) continue;                     // need REAL resting yesAsks
      cands.push({ m, T, ob, interval, depth });
    }
    cands.sort((a, b) => a.T - b.T);                  // soonest settlement first
    if (cands.length) return cands[0];
    if (att % 4 === 0) L(`   waiting for a fresh 300s market with yesAsks depth (probe ${att})`);
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

let winFound = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !winFound; attempt++) {
  console.log('\n' + '='.repeat(78));
  L(`ATTEMPT ${attempt} of ${MAX_ATTEMPTS}`);
  console.log('='.repeat(78));
  const AR = { attempt };

  const pick = await pickYesMarket();
  if (!pick) { L('no eligible 300s market found — aborting'); AR.result = 'NO_MARKET'; R.attempts.push(AR); break; }
  const M = pick.m; used.add(M.marketId);
  const DEC = Number(M.quoteDecimals);
  L(`market ${M.marketId} ${M.asset} interval=${pick.interval}s T-${pick.T}s pool=${M.poolAddress}`);
  L(`yesAsks depth=${formatUnits(pick.depth, DEC)} units | best yesAsk=${pick.ob.yesAsks[0].price}`);
  Object.assign(AR, { marketId: M.marketId, asset: M.asset, pool: M.poolAddress,
    secsToExpiry: pick.T, yesAskDepth: String(pick.depth), bestYesAsk: String(pick.ob.yesAsks[0].price) });

  // status gate
  const onchain = await ex.client.getMarketOnchain(M.marketId);
  const gateOpen = onchain.status === 1 || onchain.status === 'Trading';
  L(`status gate: status=${onchain.status} -> ${gateOpen ? 'OPEN' : 'CLOSED'}`);
  AR.statusGate = { status: onchain.status, open: gateOpen };
  if (!gateOpen) { AR.result = 'GATE_CLOSED'; R.attempts.push(AR); continue; }

  // tick snap — cross the real resting ask (YES side only)
  const bp = await ex.client.getBinaryBookParams(M.poolAddress);
  const tick = BigInt(bp.tickSize);
  const rawAskYes = BigInt(pick.ob.yesAsks[0].price);
  const bidYes = snapPriceToTick(formatUnits(rawAskYes + 20n * tick, DEC), tick, DEC);
  L(`YES bestAsk=${rawAskYes} -> crossing bid=${bidYes} onTick=${isOnTick(bidYes, tick)} (p=${formatUnits(bidYes, DEC)})`);
  AR.snappedBid = String(bidYes); AR.onTick = isOnTick(bidYes, tick);

  const QTY = BigInt(bp.minQuantity) * 1000n;                 // 1.0 unit
  const expireNs = BigInt(M.expiry) * 1_000_000_000n;
  const dYes = encodeFunctionData({
    abi: SDK.binaryPoolWriteAbi, functionName: 'placeBinaryOrder',
    args: [SDK.ORDER_KIND.BUY_YES, bidYes, QTY, expireNs, SDK.ORDER_TYPE.LIMIT,
           SDK.SELF_MATCHING_OPTION.CANCEL_TAKER, SDK.ZERO_ADDRESS, 0n, 0n],
  });

  // per-pool ERC20 allowance (recurs per window — confirmed run 1 & 2)
  let sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
  if (!sim.ok && sim.data?.slice(0, 10).toLowerCase() === '0xfb8f41b2') {
    const spender = '0x' + sim.data.slice(34, 74);
    L(`approving pool ${spender} (per-pool allowance)`);
    await send(`a${attempt}_approve`, { to: COLL, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }) });
    sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
  }
  L(`order simulation -> ${sim.ok ? 'NO REVERT' : decodeRevert(sim.data)}`);
  if (!sim.ok) { AR.result = 'SIM_REVERT'; AR.simRevert = decodeRevert(sim.data); R.attempts.push(AR); continue; }

  const yesBefore = await bal6909(M.yesTokenId), collBefore = await balColl();
  L(`pre-order: yes6909=${yesBefore} collateral=${formatUnits(collBefore, 6)}`);
  await send(`a${attempt}_placeBinaryOrder_BUY_YES`, { to: M.poolAddress, data: dYes });
  const yesAfter = await bal6909(M.yesTokenId), collAfterOrder = await balColl();
  const filled = yesAfter > yesBefore;
  L(`post-order: yes6909=${yesAfter} (+${yesAfter - yesBefore}) collateral=${formatUnits(collAfterOrder, 6)} (${formatUnits(collAfterOrder - collBefore, 6)})`);
  L(`FILL: ${filled ? 'YES' : 'NO — rested unfilled'}`);
  Object.assign(AR, { yesBefore: String(yesBefore), yesAfter: String(yesAfter),
    yesDelta: String(yesAfter - yesBefore), filled,
    collateralSpent: String(collAfterOrder - collBefore) });
  if (!filled) { AR.result = 'NO_FILL'; R.attempts.push(AR); continue; }

  // wait for settlement
  const expirySec = Number(M.expiry);
  L(`waiting for expiry ${expirySec} (~${expirySec - Math.floor(Date.now() / 1000)}s)`);
  while (Math.floor(Date.now() / 1000) < expirySec) await new Promise(r => setTimeout(r, 2000));
  let oc = null, polls = 0;
  while (polls++ < 90) {
    oc = await ex.client.getMarketOnchain(M.marketId).catch(() => null);
    if (oc && (oc.finalized === true || oc.isResolved === true)) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  L(`settled -> ${J({ status: oc?.status, finalized: oc?.finalized, isResolved: oc?.isResolved, winningOutcome: oc?.winningOutcome })}`);
  Object.assign(AR, { settledStatus: oc?.status, finalized: oc?.finalized, winningOutcome: oc?.winningOutcome });
  if (!(oc?.finalized || oc?.isResolved)) { AR.result = 'NO_FINALIZE'; R.attempts.push(AR); continue; }

  // indexer cross-check for the guard's condition 3
  let indexed = null;
  for (let i = 0; i < 10 && indexed === null; i++) {
    const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 100 }).catch(() => []);
    indexed = fin.find(x => x.marketId === M.marketId) ?? null;
    if (!indexed) await new Promise(r => setTimeout(r, 3000));
  }
  L(`indexer Finalized entry: ${indexed ? `found, winningOutcome=${indexed.winningOutcome}` : 'NOT FOUND (guard will treat as null)'}`);
  AR.indexerWinningOutcome = indexed?.winningOutcome ?? null;

  // ---- THE GUARD, live. YES = outcomeIdx 0.
  const heldYes = await bal6909(M.yesTokenId);
  const leg = { idx: 0, amount: heldYes, label: 'YES' };
  const g = redeemGuard({ leg, oc, indexerWinningOutcome: indexed?.winningOutcome });
  L(`GUARD -> ${g.allow ? 'ALLOW' : 'BLOCK'}: ${g.reason}`);
  AR.guard = { allow: g.allow, reason: g.reason, winOnchain: g.winOnchain, winIndexed: g.winIndexed, settledOnchain: g.settledOnchain };

  if (!g.allow) {
    L(`   NOT BROADCAST — position intact (${heldYes} tokens preserved, not burned)`);
    const stillHeld = await bal6909(M.yesTokenId);
    L(`   verified still held after block: ${stillHeld}`);
    AR.result = 'LOSS_BLOCKED_BY_GUARD'; AR.tokensPreserved = String(stillHeld);
    R.attempts.push(AR);
    L(`ATTEMPT ${attempt}: LOSS (winningOutcome=${oc?.winningOutcome}, held YES=0) — guard blocked the burn. Next window.`);
    continue;
  }

  // ---- WIN: redeem for real
  L('*** WIN — held YES is the winning outcome. Redeeming for real. ***');
  const data = encodeFunctionData({ abi: SDK.binaryModuleWriteAbi, functionName: 'redeem',
    args: [Number(M.operatorId), M.venueId, M.marketId, 0, heldYes] });
  const pre = await rawCall({ from: owner.address, to: A.binaryModule, data });
  L(`redeem simulation -> ${pre.ok ? 'NO REVERT' : decodeRevert(pre.data)}`);
  if (!pre.ok) { AR.result = 'REDEEM_SIM_REVERT'; AR.redeemRevert = decodeRevert(pre.data); R.attempts.push(AR); break; }

  const collPre = await balColl(), tokPre = await bal6909(M.yesTokenId);
  L(`PRE-REDEEM  tUSDC=${formatUnits(collPre, 6)}  ERC6909(yes)=${tokPre}`);
  await send(`a${attempt}_redeem_YES_WINNER`, { to: A.binaryModule, data });
  const collPost = await balColl(), tokPost = await bal6909(M.yesTokenId);
  const payout = collPost - collPre;
  L(`POST-REDEEM tUSDC=${formatUnits(collPost, 6)}  ERC6909(yes)=${tokPost}`);
  L(`*** PAYOUT = ${formatUnits(payout, 6)} tUSDC  (nonZero=${payout > 0n}) ***`);
  L(`*** ERC6909 burn: ${tokPre} -> ${tokPost} ***`);
  Object.assign(AR, { result: payout > 0n ? 'WIN_PAYOUT_CONFIRMED' : 'WIN_BUT_ZERO_PAYOUT',
    redeemed: String(heldYes), collateralPreRedeem: String(collPre), collateralPostRedeem: String(collPost),
    payout: String(payout), payoutNonZero: payout > 0n,
    erc6909Pre: String(tokPre), erc6909Post: String(tokPost) });
  R.attempts.push(AR);
  if (payout > 0n) winFound = AR;
  break;
}

console.log('\n' + '='.repeat(78));
L('PART 3 SUMMARY');
for (const a of R.attempts) L(`   attempt ${a.attempt}: ${a.result}` +
  (a.winningOutcome !== undefined ? ` (winningOutcome=${a.winningOutcome}${a.payout ? `, payout=${formatUnits(BigInt(a.payout), 6)}` : ''})` : ''));
R.verdict = winFound ? 'PASS — non-zero winning payout confirmed by balance delta' : 'FAIL — no win within attempt budget';
L(R.verdict);
for (const [k, v] of Object.entries(R.tx)) console.log(`   ${k.padEnd(34)} ${v.hash} (${v.status})`);
fs.writeFileSync('build/PART3-RESULT.json', J(R));
L('-> wrote build/PART3-RESULT.json');
process.exit(winFound ? 0 : 1);
