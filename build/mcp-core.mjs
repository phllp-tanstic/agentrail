// ============================================================================
// AgentRail MCP CORE — the four tools, as plain async functions.
//
// THIN WRAPPERS ONLY. Every code path here is lifted from a script in build/
// that has a live testnet proof behind it in research/PROOF-LOG.md. Where a
// behaviour is NOT proven, the tool REFUSES rather than attempts it.
//
// Provenance, function by function:
//   listMarkets  <- part3-win-proof.mjs:98-120 (pickYesMarket) + :139-143 (gate)
//   placeOrder   <- part3-win-proof.mjs:146-182 (snap -> approve -> sim -> place)
//   getPosition  <- part3-win-proof.mjs:71 (bal6909) + phase-a-lifecycle.mjs:268
//   redeem       <- phase-a-lifecycle.mjs:253-330 (Finalized scan + 5b grant)
//                   + part3-win-proof.mjs:199-244 (guard -> broadcast -> delta)
//
// SCOPE FENCES (deliberate refusals — see build/PHASE-B-LOG.md):
//   - direction: YES only.   NO-side fills are an open, undetermined phenomenon.
//   - window:    300s only.  60s books were empty in every sample.
//   - path:      self `placeBinaryOrder` (0x718c2d4d) only. The delegated
//                `placeBinaryOrderFor` path is gated by OnlyApprovedContracts()
//                and is closed.
// ============================================================================
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import {
  createPublicClient, createWalletClient, http, erc20Abi, encodeFunctionData,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redeemGuard } from './redeem-guard.mjs';
import { snapPriceToTick, isOnTick, exactToRaw } from './tick-snap.mjs';
import { checkPreOrder, commitReservation, releaseReservation, recordSpend,
  recordPayout, riskSnapshot, RISK_CONFIG } from './risk.mjs';
// Re-exported below as tools; also needed as a local binding, which `export ... from`
// does not create.
import { list_wallets as walletList } from './wallet.mjs';
import { normalizeIntent as normalizeIntentLocal } from './intent.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- constants
const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const COLL = A.collateral;
const OUTCOME_TOKEN = '0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9'; // ERC6909, confirmed run 1
const MODULE = '0x3ecC694Cef705358864a646142ac17A90E29e388';        // binaryMarketsModule
const COLL_DEC = 6;                                                 // tUSDC on testnet

// Scope fences, enforced not documented.
export const ALLOWED_DIRECTIONS = ['YES'];
export const ALLOWED_WINDOWS = [300];

// Defence-in-depth ceiling on maxSlippagePct. This parameter stays
// caller-adjustable by design — unlike the risk caps in ./risk.mjs, which are
// env-only because they bound total exposure. Slippage tolerance is a per-order
// execution preference, like a limit price. The ceiling exists so an ABSURD value
// cannot silently disable a protection the caller still believes is active.
// A request above it is CLAMPED, not rejected: refusing would turn a harmless
// overshoot into a failed trade.
//
// The FLOOR is deliberately not clamped. A negative value makes the guard refuse
// unconditionally, which fails CLOSED (refuses orders rather than placing
// unprotected ones) and is how Phase C exercised the refusal branch.
export const SLIPPAGE_PCT_CEILING = 50;

/**
 * Resolve the effective maxSlippagePct, reporting any adjustment.
 *
 * Handles two distinct unsafe inputs:
 *   - above the ceiling      -> clamped down
 *   - NOT A FINITE NUMBER    -> falls back to the default. This one matters more
 *     than it looks: the guard is `slippagePct > maxSlippagePct`, and EVERY
 *     comparison against NaN is false, so a non-numeric value silently removed
 *     the slippage guard entirely and broadcast with no protection.
 */
export function resolveMaxSlippagePct(raw, { defaultPct = 5 } = {}) {
  const requested = Number(raw);
  if (!Number.isFinite(requested)) {
    return { maxSlippagePct: defaultPct, requestedMaxSlippagePct: raw ?? null,
      clamped: false, nonFiniteFallback: true,
      clampNote: `maxSlippagePct=${JSON.stringify(raw)} is not a finite number. Fell back to the default of ${defaultPct}%. This is NOT cosmetic: the guard is a single \`>\` comparison and every comparison against NaN is false, so a non-numeric value would have silently disabled slippage protection entirely rather than erroring.` };
  }
  if (requested > SLIPPAGE_PCT_CEILING) {
    return { maxSlippagePct: SLIPPAGE_PCT_CEILING, requestedMaxSlippagePct: requested,
      clamped: true, nonFiniteFallback: false,
      clampNote: `requested ${requested}% exceeded the server-side ceiling of ${SLIPPAGE_PCT_CEILING}% and was clamped down. The order was NOT refused — it proceeds under the ceiling. This ceiling is defence-in-depth against an absurd value silently disabling slippage protection; it is not a risk cap, and moderate values are honoured as given.` };
  }
  return { maxSlippagePct: requested, requestedMaxSlippagePct: requested,
    clamped: false, nonFiniteFallback: false, clampNote: null };
}

// ------------------------------------------------------------------ helpers
const __dir = path.dirname(fileURLToPath(import.meta.url));
// cwd-independent: an MCP server is launched by its client from an arbitrary cwd,
// so this file is resolved against the module, not the process working dir.
const ERRMAP = JSON.parse(fs.readFileSync(
  path.resolve(__dir, '../research/onchain-proof/error-selectors.json'), 'utf8'));

export const jsonSafe = (o) =>
  JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

// decodeRevert / rawCall lifted verbatim from part3-win-proof.mjs:43-62
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

// ------------------------------------------------------------ lazy chain ctx
// Read-only tools must work with no key present; only write tools require one.
let _ctx = null;
function ctx({ requireKey = false } = {}) {
  if (!_ctx) {
    const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
    const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });
    const KEY = process.env.AGENTRAIL_OWNER_KEY;
    const owner = KEY ? privateKeyToAccount(KEY) : null;
    const wc = owner ? createWalletClient({ account: owner, chain: somniaShannon, transport: http(RPC) }) : null;
    _ctx = { pc, ex, owner, wc };
  }
  if (requireKey && !_ctx.owner) {
    throw new Error('AGENTRAIL_OWNER_KEY is not set — this tool signs transactions and cannot run without it.');
  }
  return _ctx;
}

const bal6909 = (id) => ctx().pc.readContract({
  address: OUTCOME_TOKEN, abi: SDK.erc6909Abi, functionName: 'balanceOf',
  args: [ctx({ requireKey: true }).owner.address, BigInt(id)] });
const balColl = () => ctx().pc.readContract({
  address: COLL, abi: erc20Abi, functionName: 'balanceOf',
  args: [ctx({ requireKey: true }).owner.address] });

// send() lifted from part3-win-proof.mjs:63-70. Throws on a non-success receipt
// by default (redeem relies on that). Pass throwOnRevert:false to get the receipt
// back instead, so a caller can classify the failure and decide about retrying.
async function send(txlog, label, req, { throwOnRevert = true } = {}) {
  const { wc, pc } = ctx({ requireKey: true });
  const hash = await wc.sendTransaction(req);
  const rcpt = await pc.waitForTransactionReceipt({ hash });
  txlog[label] = { hash, status: rcpt.status, block: Number(rcpt.blockNumber),
    gasUsed: String(rcpt.gasUsed), logs: rcpt.logs.length };
  if (rcpt.status !== 'success' && throwOnRevert) throw new Error(`${label} REVERTED: ${hash}`);
  return rcpt;
}

// Find a market object (which carries tokenIds / operatorId / venueId) by id.
// Checks the live listing first, then the Finalized scan — NOT default discovery,
// because the two sets are disjoint (spec §3 Trap 1).
async function findMarket(marketId) {
  const { ex } = ctx();
  const live = await ex.client.listLiveBinaryMarkets().catch(() => []);
  const hit = live.find((m) => m.marketId === marketId);
  if (hit) return { m: hit, source: 'listLiveBinaryMarkets' };
  const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 100 }).catch(() => []);
  const f = fin.find((m) => m.marketId === marketId);
  if (f) return { m: f, source: 'listBinaryMarkets({status:Finalized})' };
  return { m: null, source: null };
}

// ============================================================================
// TOOL 1 — list_markets
// Status-gated (getMarketOnchain().status === Trading) live 300s windows, with
// real resting YES-side ask depth reported per market. Depth IS cheaply
// checkable (one getBinaryOrderBook per candidate), so it is checked.
// Wraps part3-win-proof.mjs pickYesMarket() + the status gate.
// ============================================================================
export async function list_markets({ window_seconds = 300, require_yes_liquidity = true,
  min_seconds_to_expiry = 25, max_seconds_to_expiry = 290 } = {}) {
  if (!ALLOWED_WINDOWS.includes(Number(window_seconds))) {
    return { ok: false, refused: true,
      reason: `window_seconds=${window_seconds} is out of proven scope. Only ${ALLOWED_WINDOWS.join('/')}s windows are supported: 60s books were empty in every sample taken (PROOF-LOG RUN 3 PART 2). Other window lengths are future work, not a supported path.` };
  }
  const { ex } = ctx();
  const live = await ex.client.listLiveBinaryMarkets();
  const now = Math.floor(Date.now() / 1000);
  const out = [], skipped = { wrongInterval: 0, outsideTimeWindow: 0, noYesDepth: 0, gateClosed: 0 };

  for (const m of live) {
    if (Number(m.intervalSec) !== Number(window_seconds)) { skipped.wrongInterval++; continue; }
    const T = Number(m.expiry) - now;
    if (T < min_seconds_to_expiry || T > max_seconds_to_expiry) { skipped.outsideTimeWindow++; continue; }

    // real resting YES-side ask depth (the side proven to fill)
    let ob = null;
    try { ob = await ex.client.getBinaryOrderBook(m.poolAddress); } catch { /* treat as no depth */ }
    const yesAsks = ob?.yesAsks ?? [];
    const depth = yesAsks.reduce((a, l) => a + BigInt(l.quantity), 0n);
    if (require_yes_liquidity && depth === 0n) { skipped.noYesDepth++; continue; }

    // on-chain status gate — the single most avoidable live failure (spec §3)
    const oc = await ex.client.getMarketOnchain(m.marketId).catch(() => null);
    const gateOpen = oc?.status === 1 || oc?.status === 'Trading';
    if (!gateOpen) { skipped.gateClosed++; continue; }

    const DEC = Number(m.quoteDecimals);
    out.push({
      marketId: m.marketId, asset: m.asset, pool: m.poolAddress,
      intervalSec: Number(m.intervalSec), expiry: Number(m.expiry), secondsToExpiry: T,
      onchainStatus: oc.status, statusGate: 'OPEN',
      yesAskDepthUnits: formatUnits(depth, DEC), yesAskDepthRaw: String(depth),
      bestYesAsk: yesAsks[0] ? String(yesAsks[0].price) : null,
      bestYesAskProb: yesAsks[0] ? formatUnits(BigInt(yesAsks[0].price), DEC) : null,
      quoteDecimals: DEC, yesTokenId: String(m.yesTokenId), noTokenId: String(m.noTokenId),
    });
  }
  out.sort((a, b) => a.secondsToExpiry - b.secondsToExpiry); // soonest settlement first
  return { ok: true, scope: { direction: 'YES only', windowSeconds: Number(window_seconds) },
    liveMarketsSeen: live.length, tradeable: out.length, markets: out, skipped,
    note: 'Depth shown is real resting yesAsks only. The NO arrays returned by getBinaryOrderBook are an arithmetic mirror of the YES book and would double-count liquidity (PROOF-LOG RUN 3 PART 2).' };
}

// ============================================================================
// TOOL 2 — place_order
// Wraps part3-win-proof.mjs:146-182: snap the crossing price to a valid tick via
// the SHARED snapper, auto-approve the per-pool ERC20 allowance on 0xfb8f41b2,
// simulate, broadcast, then confirm the fill by ERC6909 + collateral BALANCE
// DELTA — never by tx status, which is success even on a non-fill.
//
// Phase C adds, in order of evaluation:
//   - two sizing modes: raw `stake_units` (unchanged) OR `targetDollarAmount`
//   - `maxSlippagePct` refusal if the reference price drifts before placement
//   - server-side risk guardrails (./risk.mjs) evaluated BEFORE any broadcast
//   - a reverted broadcast returns {ok:false, reason:'reverted'} instead of
//     throwing, and gets EXACTLY ONE automatic retry
// ============================================================================
export async function place_order(input = {}) {
  const {
    market_id, direction = 'YES', cross_ticks = 20, window_seconds = 300,
  } = input;
  // Accept both the camelCase names Phase C specified and snake_case matching the
  // existing tool surface, so either spelling works from any caller.
  const targetDollarAmount = input.targetDollarAmount ?? input.target_dollar_amount ?? null;
  const SLIP = resolveMaxSlippagePct(input.maxSlippagePct ?? input.max_slippage_pct ?? 5);
  const maxSlippagePct = SLIP.maxSlippagePct;
  const stakeUnitsIn = input.stake_units ?? input.stakeUnits ?? null;

  const dir = String(direction).toUpperCase();
  if (!ALLOWED_DIRECTIONS.includes(dir)) {
    return { ok: false, refused: true, reason: 'direction_out_of_scope',
      detail: `direction=${dir} is out of proven scope. Only YES is supported. A BUY_NO has never filled at any expressible price across two runs (0.58 and 0.999, byte-identical gas), and the cause is undetermined — logged, not root-caused (PROOF-LOG RUN 2 / RUN 3 PART 2).` };
  }
  if (!ALLOWED_WINDOWS.includes(Number(window_seconds))) {
    return { ok: false, refused: true, reason: 'window_out_of_scope',
      detail: `window_seconds=${window_seconds} is out of proven scope. Only ${ALLOWED_WINDOWS.join('/')}s windows are supported (PROOF-LOG RUN 3 PART 2).` };
  }
  if (!market_id) return { ok: false, refused: true, reason: 'market_id_required' };

  // --- sizing mode: exactly one of the two paths
  if (targetDollarAmount !== null && stakeUnitsIn !== null) {
    return { ok: false, refused: true, reason: 'ambiguous_sizing',
      detail: `both targetDollarAmount (${targetDollarAmount}) and stake_units (${stakeUnitsIn}) were given. Specify exactly one — they are alternative ways to size the same order.` };
  }
  const sizingMode = targetDollarAmount !== null ? 'DOLLAR' : 'UNITS';
  const stakeUnits = sizingMode === 'UNITS' ? Number(stakeUnitsIn ?? 1.0) : null;
  if (sizingMode === 'DOLLAR' && !(Number(targetDollarAmount) > 0)) {
    return { ok: false, refused: true, reason: 'invalid_target_dollar_amount',
      detail: `targetDollarAmount=${targetDollarAmount} must be a positive number.` };
  }

  const { ex, owner } = ctx({ requireKey: true });
  const R = { tool: 'place_order', owner: owner.address, marketId: market_id,
    direction: dir, sizingMode, tx: {}, attempts: [] };

  const { m: M, source } = await findMarket(market_id);
  if (!M) return { ok: false, reason: 'market_not_found',
    detail: `market ${market_id} not found in the live listing or the Finalized scan.` };
  R.marketSource = source;
  if (Number(M.intervalSec) !== Number(window_seconds)) {
    return { ok: false, refused: true, reason: 'window_mismatch',
      detail: `market ${market_id} has intervalSec=${M.intervalSec}, not the required ${window_seconds}s.` };
  }
  const DEC = Number(M.quoteDecimals);
  const ONE = 10n ** BigInt(DEC);
  const toUsd = (raw) => Number(formatUnits(raw, DEC));
  R.pool = M.poolAddress; R.asset = M.asset; R.intervalSec = Number(M.intervalSec);

  const bp = await ex.client.getBinaryBookParams(M.poolAddress);
  const tick = BigInt(bp.tickSize);
  const minQ = BigInt(bp.minQuantity);

  // ------------------------------------------------------------------ attempts
  // Exactly one automatic retry, and only for a revert we classify as retryable.
  //
  // RESERVATION LIFECYCLE: the risk check on attempt 1 RESERVES the worst-case
  // spend. Every exit from here on must resolve that reservation exactly once, or
  // it permanently eats capacity with no real order behind it. The try/finally
  // below is the backstop: any path that leaves without committing — a refusal, a
  // thrown error, an interruption mid-flow — releases.
  const MAX_ATTEMPTS = 2;
  let riskApproved = null;
  let reservationId = null;
  let reservationResolved = false;

  const commit = (actualSpentUsd, note) => {
    if (!reservationId || reservationResolved) return;
    commitReservation({ reservationId, marketId: market_id, actualSpentUsd });
    reservationResolved = true;
    R.reservation = { reservationId, resolution: 'COMMITTED',
      actualSpentUsd: Number(Number(actualSpentUsd).toFixed(6)), note };
  };

  // Release EXPLICITLY on any refusal that happens after the reservation was
  // taken, rather than leaving it to the finally-block backstop.
  //
  // This is a reporting correctness issue, not a state one — the backstop does
  // free the capacity either way. But `return { ...R, riskStatus: riskSnapshot() }`
  // evaluates its spread and its snapshot BEFORE finally runs, so a payload built
  // on a still-open reservation reports `reservation: OPEN` and a riskStatus with
  // capacity consumed, while the state it describes has already released it. The
  // caller would see phantom exposure that no order explains. Releasing here, then
  // building the return value, makes the payload and the state agree.
  const release = (why) => {
    if (!reservationId || reservationResolved) return;
    releaseReservation({ reservationId, why });
    reservationResolved = true;
    R.reservation = { reservationId, resolution: 'RELEASED', why,
      note: 'Refused after reserving. The reservation was released, so this order consumes no risk capacity.' };
  };

  try {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const AT = { attempt };

    // --- on-chain status gate, immediately before the write (spec §3)
    const onchain = await ex.client.getMarketOnchain(market_id);
    const gateOpen = onchain.status === 1 || onchain.status === 'Trading';
    AT.statusGate = { status: onchain.status, open: gateOpen };
    if (!gateOpen) {
      R.attempts.push(AT);
      release('status gate closed on a retry attempt — refusing to submit into a closed window');
      return { ok: false, refused: true, ...R, reason: 'status_gate_closed',
        detail: `status gate CLOSED (status=${onchain.status}) — refusing to submit into a window already closed on-chain.` };
    }

    // --- REFERENCE read: the book as it stands when we size the order
    const obRef = await ex.client.getBinaryOrderBook(M.poolAddress).catch(() => null);
    const asksRef = obRef?.yesAsks ?? [];
    if (!asksRef.length) {
      R.attempts.push(AT);
      release('no resting liquidity on a retry attempt — the book emptied between attempts');
      return { ok: false, ...R, reason: 'no_resting_liquidity',
        detail: 'no resting yesAsks on this market — nothing to cross. Pick a market from list_markets with non-zero yesAskDepthUnits.' };
    }
    const referencePrice = BigInt(asksRef[0].price);
    const depth = asksRef.reduce((a, l) => a + BigInt(l.quantity), 0n);

    // --- quantity
    // NOTE ON TICK-SNAPPING QUANTITY, deliberately NOT done: snapPriceToTick()
    // clamps its result into [tickSize, ONE − tickSize] because it snaps a
    // PROBABILITY. Passing a quantity through it would corrupt any size above
    // 1.0 unit — e.g. 2.012 units (2012000 raw at DEC=6) clamps to 999000, a
    // silent 2x under-size. Quantity granularity is `minQuantity`, not
    // `tickSize`, so quantity is rounded to a minQuantity multiple here. The
    // PRICE still goes through the shared tick-snapper, unchanged.
    let QTY, sizing;
    if (sizingMode === 'DOLLAR') {
      const targetRaw = exactToRaw(String(targetDollarAmount), DEC);
      const rawQty = (targetRaw * ONE) / referencePrice;      // qty = $ / price
      QTY = ((rawQty + minQ / 2n) / minQ) * minQ;             // -> minQuantity grid
      if (QTY < minQ) QTY = minQ;
      sizing = { mode: 'DOLLAR', targetDollarAmount: Number(targetDollarAmount),
        referencePrice: String(referencePrice), referencePriceProb: formatUnits(referencePrice, DEC),
        impliedQuantityRaw: String(rawQty), quantityRaw: String(QTY),
        quantityUnits: formatUnits(QTY, DEC), minQuantity: String(minQ),
        roundedToMinQuantityGrid: true,
        note: 'Quantity is derived as targetDollarAmount / referencePrice, then rounded to a minQuantity multiple. Quantity is NOT run through the price tick-snapper — that function clamps into a probability band and would corrupt sizes above 1.0 unit.' };
    } else {
      const unit = minQ * 1000n;                              // proven Phase A unit
      QTY = (BigInt(Math.round(Number(stakeUnits) * 1000)) * unit) / 1000n;
      if (QTY <= 0n) {
        R.attempts.push(AT);
        release('zero quantity on a retry attempt');
        return { ok: false, refused: true, ...R, reason: 'zero_quantity',
          detail: `stake_units=${stakeUnits} resolves to zero quantity.` };
      }
      sizing = { mode: 'UNITS', stakeUnits: Number(stakeUnits), quantityRaw: String(QTY),
        quantityUnits: formatUnits(QTY, DEC), minQuantity: String(minQ),
        note: 'stake_units is OUTCOME-TOKEN QUANTITY, not a cash amount. Use targetDollarAmount to size by cash instead.' };
    }
    AT.sizing = sizing;

    // --- price snap via the SHARED module (build/tick-snap.mjs) — not reimplemented
    const bidYes = snapPriceToTick(formatUnits(referencePrice + BigInt(cross_ticks) * tick, DEC), tick, DEC);
    AT.book = { bestYesAsk: String(referencePrice), bestYesAskProb: formatUnits(referencePrice, DEC),
      yesAskDepthUnits: formatUnits(depth, DEC), tickSize: String(tick) };
    AT.priceSnap = { crossTicks: Number(cross_ticks), snappedBid: String(bidYes),
      snappedBidProb: formatUnits(bidYes, DEC), onTick: isOnTick(bidYes, tick),
      ceilingHit: bidYes === ONE - tick };

    // Worst case: we pay our own limit. Phase B observed exactly this (rested,
    // then taken at our limit), so the risk check uses this, not the ask.
    const worstCaseSpendRaw = (bidYes * QTY) / ONE;
    const worstCaseSpendUsd = toUsd(worstCaseSpendRaw);
    AT.spendEstimate = {
      atReferencePriceUsd: toUsd((referencePrice * QTY) / ONE),
      worstCaseAtOurLimitUsd: worstCaseSpendUsd,
      note: 'worstCaseAtOurLimitUsd assumes we pay our own limit price, which is what Phase B observed when an order rested and was then taken. It is the figure the risk check uses.' };

    // --- RISK GUARDRAILS — server-side, evaluated BEFORE any broadcast.
    // On approval this RESERVES the worst-case spend in the same synchronous step,
    // so a concurrent caller sees this order's exposure immediately rather than a
    // stale total. Only on attempt 1: a retry re-places the same intent and reuses
    // the existing reservation rather than taking a second one.
    if (attempt === 1) {
      const rk = checkPreOrder({ marketId: market_id, estimatedSpendUsd: worstCaseSpendUsd });
      AT.riskCheck = rk;
      if (!rk.allow) {
        R.attempts.push(AT);
        return { ok: false, refused: true, ...R, reason: rk.code, detail: rk.reason,
          riskStatus: riskSnapshot() };
      }
      riskApproved = rk;
      reservationId = rk.reservationId;
      R.reservation = { reservationId, resolution: 'OPEN',
        reservedUsd: rk.reservedNowUsd };
    } else {
      AT.riskCheck = { skipped: `already approved and reserved on attempt 1 (${reservationId}) — a retry is the same intent, not new exposure` };
    }

    // --- per-pool ERC20 allowance: recurs per window (proven runs 1 & 2)
    const expireNs = BigInt(M.expiry) * 1_000_000_000n;
    const mkData = (price) => encodeFunctionData({
      abi: SDK.binaryPoolWriteAbi, functionName: 'placeBinaryOrder',
      args: [SDK.ORDER_KIND.BUY_YES, price, QTY, expireNs, SDK.ORDER_TYPE.LIMIT,
        SDK.SELF_MATCHING_OPTION.CANCEL_TAKER, SDK.ZERO_ADDRESS, 0n, 0n],
    });
    let dYes = mkData(bidYes);
    let sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
    if (!sim.ok && sim.data?.slice(0, 10).toLowerCase() === '0xfb8f41b2') {
      const spender = '0x' + sim.data.slice(34, 74);
      AT.allowance = { needed: true, spender };
      try {
        await send(R.tx, `a${attempt}_approve`, { to: COLL, data: encodeFunctionData({
          abi: erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }) });
      } catch (e) {
        AT.allowanceError = e.shortMessage ?? e.message;
        R.attempts.push(AT);
        release('allowance approval failed — nothing was placed');
        return { ok: false, ...R, reason: 'allowance_failed', detail: AT.allowanceError,
          riskStatus: riskSnapshot() };
      }
      sim = await rawCall({ from: owner.address, to: M.poolAddress, data: dYes });
    } else {
      AT.allowance = { needed: false };
    }

    // --- SLIPPAGE CHECK: re-read the book immediately before broadcasting and
    // compare against the reference we sized against. The gap is real — the
    // allowance tx and the simulation both take seconds, and Phase B saw the
    // best ask move 497000 -> 212000 inside ~30s.
    const obNow = await ex.client.getBinaryOrderBook(M.poolAddress).catch(() => null);
    const asksNow = obNow?.yesAsks ?? [];
    const placementPrice = asksNow.length ? BigInt(asksNow[0].price) : referencePrice;
    const slippagePct = referencePrice === 0n ? 0
      : (Number(placementPrice - referencePrice) / Number(referencePrice)) * 100;
    AT.slippage = {
      referencePrice: String(referencePrice), placementPrice: String(placementPrice),
      slippagePct: Number(slippagePct.toFixed(4)), maxSlippagePct,
      requestedMaxSlippagePct: SLIP.requestedMaxSlippagePct,
      clamped: SLIP.clamped, ...(SLIP.nonFiniteFallback ? { nonFiniteFallback: true } : {}),
      ...(SLIP.clampNote ? { clampNote: SLIP.clampNote } : {}),
      ceiling: SLIPPAGE_PCT_CEILING,
      estimatedSpendAtPlacementPriceUsd: toUsd((placementPrice * QTY) / ONE),
      enforced: sizingMode === 'DOLLAR',
      basis: 'adverse movement of the best ask between the reference read (used for sizing) and the read immediately before broadcast. The deliberate cross_ticks premium is NOT counted as slippage — it is intended, and is reported separately as worstCaseAtOurLimitUsd.' };

    if (sizingMode === 'DOLLAR' && slippagePct > maxSlippagePct) {
      R.attempts.push(AT);
      release(`slippage guard refused the order (${slippagePct.toFixed(4)}% > ${maxSlippagePct}%) — nothing was broadcast`);
      return { ok: false, refused: true, ...R, reason: 'slippage_exceeded',
        detail: `best ask moved ${slippagePct.toFixed(4)}% (${referencePrice} -> ${placementPrice}) between sizing and placement, exceeding maxSlippagePct=${maxSlippagePct}. The quantity sized for $${targetDollarAmount} would now spend about $${toUsd((placementPrice * QTY) / ONE).toFixed(6)}. NOT broadcast.`,
        riskStatus: riskSnapshot() };
    }

    AT.simulation = sim.ok ? 'NO REVERT' : decodeRevert(sim.data);
    if (!sim.ok) {
      R.attempts.push(AT);
      release('order simulation reverted — nothing was broadcast');
      return { ok: false, ...R, reason: 'simulation_reverted',
        detail: `order simulation reverted: ${AT.simulation} — NOT broadcast.`,
        riskStatus: riskSnapshot() };
    }
    AT.calldata = { selector: dYes.slice(0, 10), bytes: (dYes.length - 2) / 2, path: 'self placeBinaryOrder' };

    // ------------------------------------------------------------- broadcast
    // TASK 1: a reverted broadcast is a NORMAL, state-dependent outcome — not an
    // exception. Return the same structured shape as every other failure path.
    const yesBefore = await bal6909(M.yesTokenId), collBefore = await balColl();
    let rcpt = null, sendError = null;
    try {
      rcpt = await send(R.tx, `a${attempt}_placeBinaryOrder_BUY_YES`,
        { to: M.poolAddress, data: dYes }, { throwOnRevert: false });
    } catch (e) {
      sendError = e.shortMessage ?? e.message;
    }

    const reverted = sendError === null && rcpt !== null && rcpt.status !== 'success';
    if (reverted || sendError !== null) {
      // Classify. A revert changed no state, and Phase B proved the cause can be
      // transient (same calldata replayed at its own block returned success), so a
      // revert is retryable. A send-layer error (nonce, RPC, funds) is not.
      const retryable = reverted;
      AT.broadcast = {
        outcome: reverted ? 'REVERTED' : 'SEND_ERROR',
        txHash: rcpt?.transactionHash ?? null,
        receiptStatus: rcpt?.status ?? null,
        gasUsed: rcpt ? String(rcpt.gasUsed) : null,
        sendError, retryable,
      };
      R.attempts.push(AT);

      if (retryable && attempt < MAX_ATTEMPTS) {
        R.retry = { retried: true, afterAttempt: attempt,
          why: 'reverted broadcast classified retryable — re-reading the book and re-sizing at current prices for one more attempt' };
        continue;                                  // EXACTLY ONE retry, reservation stays open
      }
      // Terminal. A reverted transaction moves NO collateral, so the reservation
      // converts to an actual spend of 0 — which releases it in full. Committing 0
      // rather than plain-releasing keeps the ledger honest: the event records that
      // a real order resolved here, not that a reservation was abandoned.
      commit(0, reverted
        ? 'reverted placement — no collateral moved, reservation converted to 0 spend'
        : 'send-layer failure — no transaction landed, reservation converted to 0 spend');
      return { ok: false, ...R,
        reason: reverted ? 'reverted' : 'send_error',
        detail: reverted
          ? `the placement transaction reverted on-chain (tx ${rcpt?.transactionHash}). This is a NORMAL, often state-dependent outcome — Phase B observed a revert after a clean simulation where the identical calldata replayed at its own block succeeded, consistent with resting liquidity being taken by a competing fill in the same block. It is not necessarily a sign of a deeper problem. No collateral was committed by a reverted transaction.${attempt >= MAX_ATTEMPTS ? ` One automatic retry was already used; not retrying again.` : ''}`
          : `the placement could not be submitted: ${sendError}. Classified NOT retryable (a send-layer failure, not an on-chain revert).`,
        retryable,
        riskStatus: riskSnapshot() };
    }

    // ------------------------------------------------- bounded fill resolution
    const tReceipt = Date.now();
    const yesAtReceipt = await bal6909(M.yesTokenId), collAtReceipt = await balColl();

    // A read taken immediately after the receipt is not a durable answer: an order
    // that rests is often taken seconds later by a maker crossing it. So
    // receipt-time "no fill" conflates two DIFFERENT facts — "still resolving" and
    // "did not fill". Poll the same ERC6909 read get_position uses, every 5s for up
    // to 60s. Never reports `false` for an order that could still fill.
    const POLL_EVERY_MS = 5000, POLL_MAX_MS = 60000;
    let yesAfter = yesAtReceipt, collAfter = collAtReceipt;
    let fillStatus, resolution = null, poll = null;

    if (yesAtReceipt > yesBefore) {
      fillStatus = 'FILLED';
      resolution = { latencySecondsObserved: 0, polls: 0, resolvedAt: 'receipt',
        note: 'Already filled at the first post-receipt read — no polling needed.' };
    } else {
      const observations = [];
      let stoppedReason = 'timeout';
      while (Date.now() - tReceipt < POLL_MAX_MS) {
        // An order cannot fill once the window expires — stop rather than poll on.
        if (Math.floor(Date.now() / 1000) >= Number(M.expiry)) { stoppedReason = 'expiry'; break; }
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
        const b = await bal6909(M.yesTokenId).catch(() => null);
        const elapsed = Number(((Date.now() - tReceipt) / 1000).toFixed(1));
        observations.push({ atSeconds: elapsed, erc6909: b === null ? 'READ FAILED' : String(b) });
        if (b !== null && b > yesBefore) {
          yesAfter = b; collAfter = await balColl();
          stoppedReason = 'filled';
          resolution = { latencySecondsObserved: elapsed, polls: observations.length, resolvedAt: 'poll',
            granularity: `±${POLL_EVERY_MS / 1000}s — the fill landed somewhere in the ${POLL_EVERY_MS / 1000}s before this observation, so this is an upper bound`,
            measuredFrom: 'transaction receipt confirmation' };
          break;
        }
      }
      poll = { everyMs: POLL_EVERY_MS, maxMs: POLL_MAX_MS, count: observations.length, stoppedReason, observations };
      fillStatus = stoppedReason === 'filled' ? 'FILLED'
        : stoppedReason === 'expiry' ? 'NOT_FILLED'   // terminal: window closed
          : 'PENDING';                               // unresolved — NOT "did not fill"
      if (stoppedReason !== 'filled') collAfter = await balColl();
    }

    // filled: true | false | null. null === PENDING (unresolved). Callers must not
    // read null as a non-fill; fillStatus is the signal that keeps them distinct.
    const filled = fillStatus === 'FILLED' ? true : fillStatus === 'NOT_FILLED' ? false : null;
    const spentRaw = collBefore - collAfter;
    const spentUsd = toUsd(spentRaw);

    AT.broadcast = { outcome: 'SUCCESS', txHash: rcpt.transactionHash,
      receiptStatus: rcpt.status, gasUsed: String(rcpt.gasUsed) };
    R.attempts.push(AT);

    // Fold the attempt's derived fields up to the top level for callers that do
    // not walk `attempts` (shape-compatible with Phase B).
    R.sizing = AT.sizing; R.book = AT.book; R.priceSnap = AT.priceSnap;
    R.slippage = AT.slippage; R.allowance = AT.allowance;
    R.simulation = AT.simulation; R.calldata = AT.calldata;
    R.riskCheck = riskApproved;

    R.fill = {
      fillStatus, filled,
      filledAtReceipt: yesAtReceipt > yesBefore,
      resolution, poll,
      erc6909Before: String(yesBefore), erc6909AtReceipt: String(yesAtReceipt),
      erc6909After: String(yesAfter),
      erc6909Delta: String(yesAfter - yesBefore),
      filledUnits: formatUnits(yesAfter - yesBefore, DEC),
      collateralBefore: formatUnits(collBefore, COLL_DEC),
      collateralAfter: formatUnits(collAfter, COLL_DEC),
      collateralSpent: formatUnits(spentRaw, COLL_DEC),
      confirmedBy: 'ERC6909 balance delta + collateral delta (NOT tx status — both a non-fill and a losing redeem also return status=success)',
      statusMeaning: {
        FILLED: 'confirmed by ERC6909 balance increase',
        PENDING: 'order accepted and resting, unresolved at the poll deadline — it may still fill before expiry',
        NOT_FILLED: 'terminal — the window expired with the order still unfilled',
      }[fillStatus],
    };

    // --- dollar-sizing variance, reported rather than assumed
    if (sizingMode === 'DOLLAR') {
      const target = Number(targetDollarAmount);
      R.dollarSizing = {
        requestedUsd: target,
        actualCollateralSpentUsd: spentUsd,
        varianceUsd: Number((spentUsd - target).toFixed(6)),
        variancePct: target > 0 ? Number((((spentUsd - target) / target) * 100).toFixed(4)) : null,
        note: 'Variance is expected and is not an error. Quantity is rounded to the minQuantity grid, the fill price is set by the book (a fill can execute at the maker\'s price, better than our limit), and a PENDING or NOT_FILLED order locks collateral at our limit rather than spending it. Compare requestedUsd against actualCollateralSpentUsd rather than assuming the target was hit.',
      };
    }

    R.yesTokenId = String(M.yesTokenId); R.expiry = Number(M.expiry);

    // --- risk accounting: resolve the reservation into the REAL spend, releasing
    // the difference between the reserved worst case and what actually moved.
    // Note spentUsd is the collateral delta, so a PENDING/NOT_FILLED order that
    // merely LOCKED collateral at our limit is still counted — that capital is
    // genuinely committed until the order fills or expires.
    commit(spentUsd, `fillStatus=${fillStatus}; reserved worst case ${riskApproved?.reservedNowUsd ?? '?'} USD, actual collateral delta ${spentUsd} USD`);
    R.riskStatus = riskSnapshot();

    if (fillStatus === 'PENDING') {
      R.pending = `UNRESOLVED, NOT a non-fill. The order is accepted and resting and may still fill before expiry (${Number(M.expiry)}). Do not treat this as "did not fill". Recheck with get_position({market_id:"${market_id}"}) — its ERC6909 balance is the authoritative holding. If it never fills, the locked collateral is refunded automatically at expiry (PROOF-LOG RUN 3 PART 4).`;
    } else if (fillStatus === 'NOT_FILLED') {
      R.restingOrder = 'Window expired with the order unfilled. Its collateral was locked at the order\'s own limit price and is refunded automatically — no cancel needed (PROOF-LOG RUN 3 PART 4).';
    }
    return { ok: true, ...R };
  }

  // Unreachable in practice: the loop either returns or continues, and the final
  // attempt's failure path returns. Kept so no code path falls off the end.
  release('attempt loop exhausted without a terminal result');
  return { ok: false, ...R, reason: 'exhausted_attempts',
    detail: `all ${MAX_ATTEMPTS} attempts finished without a terminal result.`,
    riskStatus: riskSnapshot() };

  } finally {
    // BACKSTOP — a reservation must NEVER leak. Every refusal path above now
    // releases EXPLICITLY (so the returned payload and the state agree — see the
    // release() helper), and every real order outcome commits. What remains for
    // this block is only the genuinely unexpected: a thrown error from any await
    // in the flow, or a new early return added later that forgets to resolve.
    // Without it, a leaked reservation would permanently consume capacity that no
    // real order explains — risk-test.mjs assertion 22 demonstrates that failure.
    if (reservationId && !reservationResolved) {
      releaseReservation({ reservationId,
        why: 'place_order exited without resolving the reservation (thrown error or unexpected exit path) — released by the try/finally backstop' });
      R.reservation = { reservationId, resolution: 'RELEASED_BY_BACKSTOP',
        note: 'The flow exited without a terminal order outcome. The reservation was released so it cannot eat capacity with no real order behind it. NOTE: a payload already returned by that exit path cannot show this — it was constructed before this block ran.' };
    }
  }
}

// ============================================================================
// TOOL 3 — get_position
// ERC6909 balance for both outcome token ids + the market's on-chain status.
// ============================================================================
export async function get_position({ market_id }) {
  if (!market_id) return { ok: false, refused: true, reason: 'market_id is required.' };
  const { ex, owner } = ctx({ requireKey: true });
  const { m: M, source } = await findMarket(market_id);
  if (!M) return { ok: false, error: `market ${market_id} not found in the live listing or the Finalized scan.` };
  const DEC = Number(M.quoteDecimals);

  const oc = await ex.client.getMarketOnchain(market_id).catch(() => null);
  const yes = await bal6909(M.yesTokenId), no = await bal6909(M.noTokenId);

  // status label: 1/Trading is the write gate; finalized/isResolved is the redeem gate
  const settled = oc?.finalized === true || oc?.isResolved === true;
  const trading = oc?.status === 1 || oc?.status === 'Trading';
  const label = trading ? 'Trading' : settled ? 'Finalized' : `status=${oc?.status ?? 'unknown'}`;

  return { ok: true, tool: 'get_position', owner: owner.address,
    marketId: market_id, asset: M.asset, pool: M.poolAddress,
    intervalSec: Number(M.intervalSec), expiry: Number(M.expiry), marketSource: source,
    status: { label, onchainStatus: oc?.status ?? null, tradingGateOpen: trading,
      settled, finalized: oc?.finalized ?? null, isResolved: oc?.isResolved ?? null,
      winningOutcome: settled ? (oc?.winningOutcome ?? null) : null,
      winningOutcomeNote: settled ? null
        : 'withheld: getMarketOnchain returns winningOutcome=0 as a PRE-SETTLEMENT DEFAULT, which reads as "YES won". Only meaningful once finalized (PROOF-LOG RUN 2).' },
    position: {
      yesTokenId: String(M.yesTokenId), yesBalanceRaw: String(yes), yesBalanceUnits: formatUnits(yes, DEC),
      noTokenId: String(M.noTokenId), noBalanceRaw: String(no), noBalanceUnits: formatUnits(no, DEC),
      hasPosition: yes > 0n || no > 0n },
    collateralBalance: formatUnits(await balColl(), COLL_DEC) };
}

// ============================================================================
// TOOL 4 — redeem
// Discovery is listBinaryMarkets({status:"Finalized"}) — NOT default discovery,
// which is a DISJOINT set and silently reports nothing owed (spec §3 Trap 1).
// Every leg passes the shared redeemGuard BEFORE any broadcast. A BLOCK refuses
// and reports; it never falls through to a broadcast.
// ============================================================================
export async function redeem({ market_id = null, dry_run = false } = {}) {
  const { ex, owner } = ctx({ requireKey: true });
  const R = { tool: 'redeem', owner: owner.address, dryRun: !!dry_run, tx: {},
    discovery: {}, legs: [], blocked: [], redeemed: [] };

  // --- STEP 5: Finalized-status scan. NOT loadMarkets()/default discovery.
  const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 100 }).catch(() => []);
  R.discovery = { method: 'listBinaryMarkets({status:"Finalized"})', finalizedSeen: fin.length,
    note: 'Default discovery (listLiveBinaryMarkets/loadMarkets) is a DISJOINT set and would report nothing owed while winnings sit unclaimed (spec §3 Trap 1).' };
  let candidates = market_id ? fin.filter((m) => m.marketId === market_id) : fin;
  if (market_id && !candidates.length) {
    return { ok: false, ...R, reason: `market ${market_id} does not appear in the Finalized scan (${fin.length} finalized seen) — nothing to redeem there yet.` };
  }

  // --- which finalized markets do we actually hold tokens in?
  for (const m of candidates) {
    const DEC = Number(m.quoteDecimals);
    const yes = await bal6909(m.yesTokenId).catch(() => 0n);
    const no = await bal6909(m.noTokenId).catch(() => 0n);
    if (yes === 0n && no === 0n) continue;
    if (yes > 0n) R.legs.push({ marketId: m.marketId, m, idx: 0, label: 'YES', amount: yes, units: formatUnits(yes, DEC) });
    if (no > 0n) R.legs.push({ marketId: m.marketId, m, idx: 1, label: 'NO', amount: no, units: formatUnits(no, DEC) });
  }
  R.positionsFound = R.legs.length;
  if (!R.legs.length) {
    return { ok: true, ...R, legs: [], reason: `no held positions in any of the ${fin.length} finalized markets scanned — nothing owed.` };
  }

  // --- STEP 5b: ERC6909 operator grant. READ FIRST, never assume. Token-wide,
  // so it does not recur per market (unlike the per-pool ERC20 allowance).
  let isOp = null, opErr = null;
  try {
    isOp = await ctx().pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
      functionName: 'isOperator', args: [owner.address, MODULE] });
  } catch (e) { opErr = e.shortMessage ?? e.message; }
  R.erc6909Operator = { token: OUTCOME_TOKEN, module: MODULE, isOperatorBefore: isOp, readError: opErr };

  if (isOp !== true) {
    const setOperatorAbi = [{ type: 'function', name: 'setOperator',
      inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
      outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' }];
    const setOpData = encodeFunctionData({ abi: setOperatorAbi, functionName: 'setOperator', args: [MODULE, true] });
    const opSim = await rawCall({ from: owner.address, to: OUTCOME_TOKEN, data: setOpData });
    R.erc6909Operator.simulation = opSim.ok ? 'NO REVERT' : decodeRevert(opSim.data);
    if (!opSim.ok) {
      R.erc6909Operator.case = 'SIMULATION_REVERTED — NOT broadcast';
      return { ok: false, ...R, legs: jsonSafe(R.legs.map(stripM)),
        reason: `ERC6909 setOperator simulation reverted (${R.erc6909Operator.simulation}); redeem would fail with InsufficientPermission(). Not broadcasting blind.` };
    }
    if (dry_run) {
      R.erc6909Operator.case = 'NOT GRANTED — would broadcast setOperator (dry_run, skipped)';
    } else {
      await send(R.tx, 'setOperator_module', { to: OUTCOME_TOKEN, data: setOpData });
      const nowOp = await ctx().pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
        functionName: 'isOperator', args: [owner.address, MODULE] }).catch(() => null);
      R.erc6909Operator.case = nowOp === true ? 'BROADCAST — granted, reads back true' : `BROADCAST — reads back ${nowOp}`;
      R.erc6909Operator.isOperatorAfter = nowOp;
    }
  } else {
    R.erc6909Operator.case = 'ALREADY GRANTED — redundant broadcast SKIPPED (token-wide, does not recur per market)';
  }

  // --- STEP 6: guard EVERY leg before any broadcast.
  for (const leg of R.legs) {
    const m = leg.m;
    const oc = await ex.client.getMarketOnchain(leg.marketId).catch(() => null);
    const g = redeemGuard({ leg, oc, indexerWinningOutcome: m.winningOutcome });
    const entry = { marketId: leg.marketId, asset: m.asset, outcomeIdx: leg.idx, label: leg.label,
      amount: String(leg.amount), units: leg.units,
      guard: { allow: g.allow, reason: g.reason, winOnchain: g.winOnchain,
        winIndexed: g.winIndexed, settledOnchain: g.settledOnchain } };

    if (!g.allow) {
      // Refuse and report. Same behaviour as the proven script: NOT broadcast,
      // position left intact rather than burned for zero.
      const still = await bal6909(leg.idx === 0 ? m.yesTokenId : m.noTokenId).catch(() => null);
      entry.broadcast = false;
      entry.outcome = `BLOCKED — NOT BROADCAST. Position left intact (${still ?? leg.amount} tokens preserved, not burned).`;
      entry.tokensPreserved = String(still ?? leg.amount);
      R.blocked.push(entry);
      continue;
    }

    if (dry_run) {
      entry.broadcast = false; entry.outcome = 'ALLOW — would broadcast (dry_run, skipped)';
      R.redeemed.push(entry); continue;
    }

    const data = encodeFunctionData({ abi: SDK.binaryModuleWriteAbi, functionName: 'redeem',
      args: [Number(m.operatorId), m.venueId, leg.marketId, leg.idx, leg.amount] });
    const pre = await rawCall({ from: owner.address, to: A.binaryModule, data });
    entry.simulation = pre.ok ? 'NO REVERT' : decodeRevert(pre.data);
    if (!pre.ok) { entry.broadcast = false; entry.outcome = `simulation reverted — NOT broadcast`; R.blocked.push(entry); continue; }

    const collPre = await balColl(), tokPre = await bal6909(leg.idx === 0 ? m.yesTokenId : m.noTokenId);
    await send(R.tx, `redeem_${leg.label}_${leg.marketId.slice(-6)}`, { to: A.binaryModule, data });
    const collPost = await balColl(), tokPost = await bal6909(leg.idx === 0 ? m.yesTokenId : m.noTokenId);
    const payout = collPost - collPre;

    entry.broadcast = true;
    entry.payout = { collateralBefore: formatUnits(collPre, COLL_DEC), collateralAfter: formatUnits(collPost, COLL_DEC),
      payoutUnits: formatUnits(payout, COLL_DEC), payoutRaw: String(payout), nonZero: payout > 0n,
      erc6909Before: String(tokPre), erc6909After: String(tokPost),
      confirmedBy: 'tUSDC balance delta + ERC6909 burn (NOT tx status — a losing redeem also returns status=success)' };
    entry.outcome = payout > 0n ? 'REDEEMED — non-zero payout confirmed by balance delta' : 'BROADCAST BUT ZERO PAYOUT';
    // Feed the payout into risk accounting so it reduces the day's drawdown.
    if (payout > 0n) recordPayout({ marketId: leg.marketId, payoutUsd: Number(formatUnits(payout, COLL_DEC)) });
    R.redeemed.push(entry);
  }

  R.legs = jsonSafe(R.legs.map(stripM));
  R.riskStatus = riskSnapshot();
  return { ok: true, ...R,
    summary: { positionsFound: R.positionsFound, redeemedCount: R.redeemed.length, blockedCount: R.blocked.length,
      totalPayoutUnits: R.redeemed.reduce((a, e) => a + Number(e.payout?.payoutUnits ?? 0), 0).toFixed(6) } };
}
const stripM = ({ m, ...rest }) => ({ ...rest, amount: String(rest.amount) });

// ============================================================================
// TOOL 5 — generate_wallet  (re-exported from ./wallet.mjs, no chain access)
// TOOL 6 — get_wallet_balance
//
// Purpose-only dedicated wallets, per spec §2's custody model. See the header of
// build/wallet.mjs for the custody and storage disclosures — this is a CUSTODIAL
// model over the generated wallet and is deliberately NOT described otherwise.
// ============================================================================
export { generate_wallet, list_wallets, STORE_PATH } from './wallet.mjs';

const SOMI_DEC = 18;   // native gas token

/**
 * tUSDC + native SOMI balance for a generated (or any) address, so a caller can
 * confirm a deposit landed BEFORE trying to trade. Read-only: needs no key.
 *
 * Accepts either a `session_id` (resolved through the wallet store) or a raw
 * `address`. An address that is not in the store is still reported — these are
 * public reads — but flagged `known: false` so a caller cannot mistake an
 * arbitrary address for one AgentRail can sign for.
 */
export async function get_wallet_balance({ session_id = null, address = null } = {}) {
  if (!session_id && !address) {
    return { ok: false, refused: true, reason: 'session_id_or_address_required',
      detail: 'Pass either session_id (resolved through the wallet store) or a raw address.' };
  }

  let resolved = address, known = false, record = null;
  if (session_id) {
    const hit = walletList().wallets.find((w) => w.sessionId === String(session_id).trim());
    if (!hit) {
      return { ok: false, refused: true, reason: 'session_not_found',
        detail: `no wallet is stored for session_id="${session_id}". Call generate_wallet first.` };
    }
    if (address && address.toLowerCase() !== hit.address.toLowerCase()) {
      return { ok: false, refused: true, reason: 'session_address_mismatch',
        detail: `session_id="${session_id}" maps to ${hit.address}, which is not the address ${address} that was also supplied. Refusing rather than guessing which one was meant.` };
    }
    resolved = hit.address; known = true; record = hit;
  } else {
    const hit = walletList().wallets.find(
      (w) => w.address.toLowerCase() === String(address).trim().toLowerCase());
    if (hit) { known = true; record = hit; }
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(String(resolved))) {
    return { ok: false, refused: true, reason: 'invalid_address',
      detail: `"${resolved}" is not a 20-byte hex address.` };
  }

  const { pc } = ctx();                                  // read-only, no key needed
  const [somiRaw, usdcRaw] = await Promise.all([
    pc.getBalance({ address: resolved }),
    pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [resolved] }),
  ]);

  const tusdc = Number(formatUnits(usdcRaw, COLL_DEC));
  const somi = Number(formatUnits(somiRaw, SOMI_DEC));

  // Both are required to trade, for different reasons, so report them separately
  // rather than as one "funded" boolean.
  const canPayGas = somiRaw > 0n;
  const hasCollateral = usdcRaw > 0n;

  return { ok: true,
    address: resolved, known,
    ...(record ? { sessionId: record.sessionId, createdAt: record.createdAt, label: record.label } : {}),
    ...(known ? {} : { unknownNote: 'This address is NOT in the wallet store. Balances are public reads so they are still reported, but AgentRail holds no key for it and cannot sign on its behalf.' }),
    balances: {
      tUSDC: { formatted: formatUnits(usdcRaw, COLL_DEC), raw: String(usdcRaw), decimals: COLL_DEC,
        token: COLL, purpose: 'collateral — this is what orders spend' },
      SOMI: { formatted: formatUnits(somiRaw, SOMI_DEC), raw: String(somiRaw), decimals: SOMI_DEC,
        purpose: 'native gas — needed to broadcast, separate from collateral' },
    },
    readiness: {
      hasCollateral, canPayGas,
      readyToTrade: hasCollateral && canPayGas,
      blockedBy: hasCollateral && canPayGas ? null
        : [...(hasCollateral ? [] : ['no tUSDC collateral']), ...(canPayGas ? [] : ['no SOMI for gas'])],
      note: 'tUSDC and SOMI are BOTH required and are not interchangeable: tUSDC is the collateral an order spends, SOMI pays gas to broadcast it. A wallet with collateral but no SOMI cannot place an order at all.',
    },
    confirmedBy: 'direct on-chain reads (eth_getBalance + ERC20 balanceOf) at call time — not an indexer, so a deposit shows as soon as it is mined',
  };
}

// ============================================================================
// TOOL 7 — parse_intent
//
// Validate + normalize ALREADY-EXTRACTED structured intent into place_order args,
// and refuse anything unsupported before it can reach the chain.
//
// THIS DOES NOT CALL AN LLM and does not do natural-language understanding — the
// calling agent extracts the fields from the user's sentence, and this validates
// them. That boundary is the point: it keeps the validation layer deterministic
// and offline-testable. Pure logic lives in ./intent.mjs; this adds the one thing
// that needs the chain (resolving asset -> a live market_id) plus the
// confirm-before-execute summary spec §2 calls for.
//
// IT PLACES NOTHING. It returns `placeOrderArgs` for the caller to pass to
// place_order after the user confirms.
// ============================================================================
export { normalizeIntent, SUPPORTED_ASSETS } from './intent.mjs';

export async function parse_intent(input = {}) {
  const norm = normalizeIntentLocal(input);
  if (!norm.ok) return { tool: 'parse_intent', ...norm };

  const R = { ok: true, tool: 'parse_intent', ...norm,
    placedAnything: false,
    contract: 'This tool VALIDATES and NORMALIZES intent. It does not place an order. Pass `placeOrderArgs` to place_order after the user confirms.' };

  if (input.resolve_market === false) {
    return { ...R, marketResolution: { attempted: false,
      note: 'resolve_market:false — market_id was NOT resolved. placeOrderArgs is incomplete: add a market_id from list_markets before calling place_order.' } };
  }

  // --- resolve asset -> a live, gated, liquid market of the right window
  const lm = await list_markets({ window_seconds: norm.normalized.windowSeconds });
  if (!lm.ok) {
    return { ...R, marketResolution: { attempted: true, resolved: false,
      note: `list_markets refused: ${lm.reason}` } };
  }
  const candidates = lm.markets.filter(
    (m) => String(m.asset).toUpperCase().includes(norm.normalized.asset));

  if (!candidates.length) {
    return { ok: false, refused: true, tool: 'parse_intent',
      reason: 'no_tradeable_market',
      detail: `intent is valid, but no tradeable ${norm.normalized.asset} market is available on a ${norm.normalized.windowSeconds}s window right now. list_markets saw ${lm.liveMarketsSeen} live markets and found ${lm.tradeable} tradeable across all assets. This is a transient market-availability condition, not an invalid request — the same intent may succeed shortly.`,
      normalized: norm.normalized,
      marketResolution: { attempted: true, resolved: false,
        assetsAvailable: [...new Set(lm.markets.map((m) => m.asset))],
        listMarketsSkipped: lm.skipped },
      suggestion: 'Retry in the next window, or re-issue for an asset in assetsAvailable.' };
  }

  // Soonest settlement first, matching list_markets' own ordering.
  const M = candidates[0];
  R.placeOrderArgs = { market_id: M.marketId, ...R.placeOrderArgs };
  R.marketResolution = { attempted: true, resolved: true,
    marketId: M.marketId, asset: M.asset, pool: M.pool,
    secondsToExpiry: M.secondsToExpiry, statusGate: M.statusGate,
    bestYesAskProb: M.bestYesAskProb, yesAskDepthUnits: M.yesAskDepthUnits,
    otherCandidates: candidates.slice(1).map((c) => ({ marketId: c.marketId, secondsToExpiry: c.secondsToExpiry })),
    selectedBy: 'soonest settlement among tradeable markets for this asset (list_markets ordering)' };

  // --- confirm-before-execute summary (spec §2: show stake/direction/window/payout)
  const ask = M.bestYesAskProb === null ? null : Number(M.bestYesAskProb);
  let economics = null;

  if (ask !== null && ask > 0) {
    // A binary outcome token pays 1.00 collateral per unit if it wins, 0 if not.
    // So units = cash / price, and max payout = units x 1.00.
    const cash = norm.normalized.mode === 'DOLLAR' ? norm.normalized.targetDollarAmount : null;
    const units = cash !== null ? cash / ask : norm.normalized.stake_units;
    const costAtAsk = units * ask;
    const maxPayout = units * 1.0;
    economics = {
      basis: `best resting YES ask = ${ask} (implied probability ${(ask * 100).toFixed(2)}%)`,
      estimatedUnits: Number(units.toFixed(6)),
      estimatedCostAtAskUsd: Number(costAtAsk.toFixed(6)),
      maxPayoutIfYesWinsUsd: Number(maxPayout.toFixed(6)),
      estimatedProfitIfYesWinsUsd: Number((maxPayout - costAtAsk).toFixed(6)),
      lossIfYesLosesUsd: Number(costAtAsk.toFixed(6)),
      payoutMultiple: Number((1 / ask).toFixed(4)),
      caveats: [
        'ESTIMATE ONLY, at the current best ask. place_order bids cross_ticks (default 20) ABOVE the ask to cross the spread, so the real cost is higher than estimatedCostAtAskUsd — worst case is quantity x our own limit price, which place_order reports as spendEstimate.worstCaseAtOurLimitUsd.',
        'Quantity is rounded to the minQuantity grid, so units will shift slightly.',
        'The book moves. This venue was observed moving 83% between two reads seconds apart, so treat these numbers as indicative of the current book, not a quote.',
        'A binary outcome token pays exactly 1.00 collateral per unit if it wins and 0 if it loses — maxPayoutIfYesWinsUsd already accounts for that and is not leveraged.',
      ],
    };
  }

  R.confirmation = {
    summary: norm.normalized.mode === 'DOLLAR'
      ? `Buy $${norm.normalized.targetDollarAmount} of ${norm.normalized.asset} ${norm.normalized.direction} on a ${norm.normalized.windowSeconds}s window settling in ${M.secondsToExpiry}s.`
      : `Buy ${norm.normalized.stake_units} units of ${norm.normalized.asset} ${norm.normalized.direction} on a ${norm.normalized.windowSeconds}s window settling in ${M.secondsToExpiry}s.`,
    direction: norm.normalized.direction, asset: norm.normalized.asset,
    windowSeconds: norm.normalized.windowSeconds, settlesInSeconds: M.secondsToExpiry,
    economics,
    riskLimits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd,
      maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd,
      note: 'Enforced server-side before any broadcast and NOT adjustable by a caller. An order above these is refused by place_order, not trimmed.' },
    showThisToTheUserBeforeCalling: 'place_order',
  };
  return R;
}
