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
//   - window:    300s only.  60s depth is UNRELIABLE, not proven absent — runs 1
//                and 2 both FILLED on 60s markets; a narrow probe found no depth
//                at one timing offset. The fence is a reliability choice.
//   - path:      self `placeBinaryOrder` (0x718c2d4d) only. The delegated
//                `placeBinaryOrderFor` path is gated by OnlyApprovedContracts()
//                and is closed.
// ============================================================================
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import {
  createPublicClient, createWalletClient, http, erc20Abi, encodeFunctionData,
  formatUnits, parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redeemGuard } from './redeem-guard.mjs';
import { snapPriceToTick, isOnTick, exactToRaw } from './tick-snap.mjs';
import { checkPreOrder, commitReservation, releaseReservation, recordSpend,
  recordPayout, riskSnapshot, RISK_CONFIG } from './risk.mjs';
// Re-exported below as tools; also needed as a local binding, which `export ... from`
// does not create.
import { list_wallets as walletList, generate_wallet as walletGenerate,
  _privateKeyForSession, CUSTODY_DISCLOSURE } from './wallet.mjs';
import { normalizeIntent as normalizeIntentLocal,
  normalizeMinSecondsToExpiry as normalizeRunwayLocal } from './intent.mjs';
import { recordOrder, recordRedeem, recordWallet, recordBalanceObservation,
  recordWithdrawal, resolveSession } from './trade-log.mjs';
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
// PER-SESSION (this revision). Read-only tools work with no session_id/key
// present (pass session_id: null); only write tools require one, and the key
// used is now the CALLER'S OWN dedicated wallet (wallet.mjs's per-session
// keypair), resolved via _privateKeyForSession — NOT a single shared
// AGENTRAIL_OWNER_KEY signing for everyone. This is the actual fix for the
// custody gap flagged in wallet.mjs's own header: a generated wallet was
// previously an inert deposit address that place_order never signed with.
//
// AGENTRAIL_OWNER_KEY is kept ONLY as an explicit, clearly-labelled legacy
// path for direct script callers that pass no session_id (e.g. existing
// build/ proof scripts run standalone, outside the MCP server). Every path
// reachable through the MCP tools now requires session_id and refuses to
// silently fall back to the shared key — a silent fallback would quietly
// re-open the exact hole this change closes.
//
// One client per session_id, cached for the process lifetime — a real
// deployment moves this cache out of process memory along with everything
// else in Tier 1 #4/#5 (persistence, multi-instance).
const _ctxBySession = new Map();
let _ownerCtx = null; // legacy, non-session path — see note above

function _buildCtx(owner) {
  const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
  const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });
  const wc = owner ? createWalletClient({ account: owner, chain: somniaShannon, transport: http(RPC) }) : null;
  return { pc, ex, owner, wc };
}

/**
 * ctx({ session_id, requireKey })
 *
 * - session_id present: signs with THAT session's own dedicated wallet key.
 *   Throws if requireKey and no wallet exists yet for that session_id (the
 *   caller must call generate_wallet first — there is nothing to fall back to).
 * - session_id absent/null: read-only, chain-only context (pc/ex, no owner/wc).
 *   Throws if requireKey is also true — a write path always needs a session.
 * - LEGACY: if session_id is explicitly the literal string
 *   '__legacy_owner_key__', signs with AGENTRAIL_OWNER_KEY. This exists so the
 *   already-proven standalone scripts in build/ (part3-win-proof.mjs, etc.)
 *   keep working unmodified; the MCP tool layer (mcp-server.mjs) never passes
 *   this value — every MCP-facing write path must go through a real session.
 */
function ctx({ session_id = null, requireKey = false } = {}) {
  if (session_id === '__legacy_owner_key__') {
    if (!_ownerCtx) {
      const KEY = process.env.AGENTRAIL_OWNER_KEY;
      const owner = KEY ? privateKeyToAccount(KEY) : null;
      _ownerCtx = _buildCtx(owner);
    }
    if (requireKey && !_ownerCtx.owner) {
      throw new Error('AGENTRAIL_OWNER_KEY is not set — the legacy owner-key path signs transactions and cannot run without it.');
    }
    return _ownerCtx;
  }

  if (!session_id) {
    if (requireKey) {
      throw new Error('ctx({requireKey:true}) called with no session_id. Every write path must identify which session\'s wallet is signing — there is no shared fallback key. Pass the caller\'s session_id.');
    }
    // read-only, chain-only — cached once, since it carries no key
    if (!_ctxBySession.has('__readonly__')) _ctxBySession.set('__readonly__', _buildCtx(null));
    return _ctxBySession.get('__readonly__');
  }

  const sid = String(session_id).trim();
  if (!_ctxBySession.has(sid)) {
    const pk = _privateKeyForSession(sid);
    const owner = pk ? privateKeyToAccount(pk) : null;
    _ctxBySession.set(sid, _buildCtx(owner));
  }
  const c = _ctxBySession.get(sid);
  if (requireKey && !c.owner) {
    throw new Error(`No dedicated wallet exists yet for session_id="${sid}". Call generate_wallet first — this tool signs with the session's own wallet and there is no shared key to fall back to.`);
  }
  return c;
}

const bal6909 = (session_id, id) => ctx({ session_id }).pc.readContract({
  address: OUTCOME_TOKEN, abi: SDK.erc6909Abi, functionName: 'balanceOf',
  args: [ctx({ session_id, requireKey: true }).owner.address, BigInt(id)] });
const balColl = (session_id) => ctx({ session_id }).pc.readContract({
  address: COLL, abi: erc20Abi, functionName: 'balanceOf',
  args: [ctx({ session_id, requireKey: true }).owner.address] });

// send() lifted from part3-win-proof.mjs:63-70. Throws on a non-success receipt
// by default (redeem relies on that). Pass throwOnRevert:false to get the receipt
// back instead, so a caller can classify the failure and decide about retrying.
async function send(session_id, txlog, label, req, { throwOnRevert = true } = {}) {
  const { wc, pc } = ctx({ session_id, requireKey: true });
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
      reason: `window_seconds=${window_seconds} is out of proven scope. Only ${ALLOWED_WINDOWS.join('/')}s windows are supported. The reason is RELIABILITY, not proven emptiness: at 60s a narrow probe found no depth at one timing offset (0 of 2 sampled books had any levels at T-47s, while 2 of 2 sampled 300s books had 3 levels per side), but PROOF-LOG runs 1 and 2 BOTH FILLED on 60s markets — run 2 read 200 units at T-26s. So 60s liquidity is not dependable at that window length, NOT confirmed absent. That sample is 12 live markets, 4 probed, one moment in time — a snapshot, not a distribution (PROOF-LOG RUN 3 PART 2). Other window lengths are future work, not a supported path.` };
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
//
// Phase D wraps this in a trade-log adapter (see below place_order_inner): the
// LOGGING is deliberately outside the execution logic rather than sprinkled
// through it, because this function has fourteen distinct terminal return paths
// and a per-return log call would eventually miss one. Wrapping guarantees every
// outcome — including every refusal and a thrown error — produces exactly one entry.
// ============================================================================
async function place_order_inner(input = {}) {
  const {
    market_id, direction = 'YES', cross_ticks = 20, window_seconds = 300,
  } = input;
  const session_id = input.session_id ?? input.sessionId ?? null;
  // Accept both the camelCase names Phase C specified and snake_case matching the
  // existing tool surface, so either spelling works from any caller.
  const targetDollarAmount = input.targetDollarAmount ?? input.target_dollar_amount ?? null;
  const SLIP = resolveMaxSlippagePct(input.maxSlippagePct ?? input.max_slippage_pct ?? 5);
  const maxSlippagePct = SLIP.maxSlippagePct;
  const stakeUnitsIn = input.stake_units ?? input.stakeUnits ?? null;

  // PER-SESSION CUSTODY: this is now a required argument, not just a logging
  // tag. It selects WHICH wallet signs. Refusing here — rather than at ctx()
  // several lines later — gives a clear, specific reason instead of a generic
  // "no key" throw.
  if (!session_id) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id is required. It identifies which dedicated wallet signs this order — there is no shared wallet to fall back to. Call generate_wallet for this session_id first if you have not already.' };
  }

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

  const { ex, owner } = ctx({ session_id, requireKey: true });
  const R = { tool: 'place_order', sessionId: session_id, owner: owner.address, marketId: market_id,
    direction: dir, sizingMode, tx: {}, attempts: [], custody: CUSTODY_DISCLOSURE };

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
    commitReservation({ session_id, reservationId, marketId: market_id, actualSpentUsd });
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
    releaseReservation({ session_id, reservationId, why });
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
      const rk = checkPreOrder({ session_id, marketId: market_id, estimatedSpendUsd: worstCaseSpendUsd });
      AT.riskCheck = rk;
      if (!rk.allow) {
        R.attempts.push(AT);
        return { ok: false, refused: true, ...R, reason: rk.code, detail: rk.reason,
          riskStatus: riskSnapshot(session_id) };
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
        await send(session_id, R.tx, `a${attempt}_approve`, { to: COLL, data: encodeFunctionData({
          abi: erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }) });
      } catch (e) {
        AT.allowanceError = e.shortMessage ?? e.message;
        R.attempts.push(AT);
        release('allowance approval failed — nothing was placed');
        return { ok: false, ...R, reason: 'allowance_failed', detail: AT.allowanceError,
          riskStatus: riskSnapshot(session_id) };
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
        riskStatus: riskSnapshot(session_id) };
    }

    AT.simulation = sim.ok ? 'NO REVERT' : decodeRevert(sim.data);
    if (!sim.ok) {
      R.attempts.push(AT);
      release('order simulation reverted — nothing was broadcast');
      return { ok: false, ...R, reason: 'simulation_reverted',
        detail: `order simulation reverted: ${AT.simulation} — NOT broadcast.`,
        riskStatus: riskSnapshot(session_id) };
    }
    AT.calldata = { selector: dYes.slice(0, 10), bytes: (dYes.length - 2) / 2, path: 'self placeBinaryOrder' };

    // ------------------------------------------------------------- broadcast
    // TASK 1: a reverted broadcast is a NORMAL, state-dependent outcome — not an
    // exception. Return the same structured shape as every other failure path.
    const yesBefore = await bal6909(session_id, M.yesTokenId), collBefore = await balColl(session_id);
    let rcpt = null, sendError = null;
    try {
      rcpt = await send(session_id, R.tx, `a${attempt}_placeBinaryOrder_BUY_YES`,
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
        riskStatus: riskSnapshot(session_id) };
    }

    // ------------------------------------------------- bounded fill resolution
    const tReceipt = Date.now();
    const yesAtReceipt = await bal6909(session_id, M.yesTokenId), collAtReceipt = await balColl(session_id);

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
        const b = await bal6909(session_id, M.yesTokenId).catch(() => null);
        const elapsed = Number(((Date.now() - tReceipt) / 1000).toFixed(1));
        observations.push({ atSeconds: elapsed, erc6909: b === null ? 'READ FAILED' : String(b) });
        if (b !== null && b > yesBefore) {
          yesAfter = b; collAfter = await balColl(session_id);
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
      if (stoppedReason !== 'filled') collAfter = await balColl(session_id);
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
    R.riskStatus = riskSnapshot(session_id);

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
    riskStatus: riskSnapshot(session_id) };

  } finally {
    // BACKSTOP — a reservation must NEVER leak. Every refusal path above now
    // releases EXPLICITLY (so the returned payload and the state agree — see the
    // release() helper), and every real order outcome commits. What remains for
    // this block is only the genuinely unexpected: a thrown error from any await
    // in the flow, or a new early return added later that forgets to resolve.
    // Without it, a leaked reservation would permanently consume capacity that no
    // real order explains — risk-test.mjs assertion 22 demonstrates that failure.
    if (reservationId && !reservationResolved) {
      releaseReservation({ session_id, reservationId,
        why: 'place_order exited without resolving the reservation (thrown error or unexpected exit path) — released by the try/finally backstop' });
      R.reservation = { reservationId, resolution: 'RELEASED_BY_BACKSTOP',
        note: 'The flow exited without a terminal order outcome. The reservation was released so it cannot eat capacity with no real order behind it. NOTE: a payload already returned by that exit path cannot show this — it was constructed before this block ran.' };
    }
  }
}

/**
 * place_order + the trade-log entry, which is the exported tool.
 *
 * A THROWN error is logged and then RE-THROWN unchanged, so the MCP layer's
 * existing error handling is untouched: an attempted order that blew up is part of
 * an honest record, but swallowing the throw would change the tool's contract.
 *
 * The log write never fails the order — see design note 2 in trade-log.mjs. If the
 * append fails, `tradeLog.error` says so in the response rather than the order
 * being reported as failed.
 */
export async function place_order(input = {}) {
  const session_id = input.session_id ?? input.sessionId ?? null;
  let res;
  try {
    res = await place_order_inner(input);
  } catch (e) {
    const msg = e.shortMessage ?? e.message;
    recordOrder({ session_id, input, res: null, thrown: msg });
    throw e;
  }
  const logged = recordOrder({ session_id, input, res });
  return { ...res, tradeLog: logged.ok
    ? { recorded: true, seq: logged.seq, sessionId: logged.sessionId,
        note: 'This outcome is in the append-only trade log. Read it with get_trade_log.' }
    : { recorded: false, error: logged.error, note: logged.note } };
}

// ============================================================================
// TOOL 3 — get_position
// ERC6909 balance for both outcome token ids + the market's on-chain status.
// ============================================================================
export async function get_position({ market_id, session_id = null, sessionId = null } = {}) {
  const sid = session_id ?? sessionId ?? null;
  if (!market_id) return { ok: false, refused: true, reason: 'market_id is required.' };
  if (!sid) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id is required. A position is a balance held by one session\'s own dedicated wallet — there is no shared wallet whose position this could otherwise mean.' };
  }
  const { ex, owner } = ctx({ session_id: sid, requireKey: true });
  const { m: M, source } = await findMarket(market_id);
  if (!M) return { ok: false, error: `market ${market_id} not found in the live listing or the Finalized scan.` };
  const DEC = Number(M.quoteDecimals);

  const oc = await ex.client.getMarketOnchain(market_id).catch(() => null);
  const yes = await bal6909(sid, M.yesTokenId), no = await bal6909(sid, M.noTokenId);

  // status label: 1/Trading is the write gate; finalized/isResolved is the redeem gate
  const settled = oc?.finalized === true || oc?.isResolved === true;
  const trading = oc?.status === 1 || oc?.status === 'Trading';
  const label = trading ? 'Trading' : settled ? 'Finalized' : `status=${oc?.status ?? 'unknown'}`;

  return { ok: true, tool: 'get_position', sessionId: sid, owner: owner.address,
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
    collateralBalance: formatUnits(await balColl(sid), COLL_DEC) };
}

// ============================================================================
// TOOL 4 — redeem
// Discovery is listBinaryMarkets({status:"Finalized"}) — NOT default discovery,
// which is a DISJOINT set and silently reports nothing owed (spec §3 Trap 1).
// Every leg passes the shared redeemGuard BEFORE any broadcast. A BLOCK refuses
// and reports; it never falls through to a broadcast.
//
// Phase D: wrapped in a trade-log adapter, ONE ENTRY PER LEG. A guard BLOCK is
// logged exactly as prominently as a payout — that asymmetry is the whole trust
// story, since a refused redemption is what PRESERVED value here.
// ============================================================================
async function redeem_inner({ market_id = null, dry_run = false, session_id = null } = {}) {
  if (!session_id) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id is required. Redemption burns outcome tokens held by one session\'s own dedicated wallet and pays collateral into that same wallet — there is no shared wallet this could otherwise apply to.' };
  }
  const { ex, owner } = ctx({ session_id, requireKey: true });
  const R = { tool: 'redeem', sessionId: session_id, owner: owner.address, dryRun: !!dry_run, tx: {},
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
    const yes = await bal6909(session_id, m.yesTokenId).catch(() => 0n);
    const no = await bal6909(session_id, m.noTokenId).catch(() => 0n);
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
    isOp = await ctx({ session_id }).pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
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
      await send(session_id, R.tx, 'setOperator_module', { to: OUTCOME_TOKEN, data: setOpData });
      const nowOp = await ctx({ session_id }).pc.readContract({ address: OUTCOME_TOKEN, abi: SDK.erc6909Abi,
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
      const still = await bal6909(session_id, leg.idx === 0 ? m.yesTokenId : m.noTokenId).catch(() => null);
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

    const collPre = await balColl(session_id), tokPre = await bal6909(session_id, leg.idx === 0 ? m.yesTokenId : m.noTokenId);
    await send(session_id, R.tx, `redeem_${leg.label}_${leg.marketId.slice(-6)}`, { to: A.binaryModule, data });
    const collPost = await balColl(session_id), tokPost = await bal6909(session_id, leg.idx === 0 ? m.yesTokenId : m.noTokenId);
    const payout = collPost - collPre;

    entry.broadcast = true;
    entry.payout = { collateralBefore: formatUnits(collPre, COLL_DEC), collateralAfter: formatUnits(collPost, COLL_DEC),
      payoutUnits: formatUnits(payout, COLL_DEC), payoutRaw: String(payout), nonZero: payout > 0n,
      erc6909Before: String(tokPre), erc6909After: String(tokPost),
      confirmedBy: 'tUSDC balance delta + ERC6909 burn (NOT tx status — a losing redeem also returns status=success)' };
    entry.outcome = payout > 0n ? 'REDEEMED — non-zero payout confirmed by balance delta' : 'BROADCAST BUT ZERO PAYOUT';
    // Feed the payout into risk accounting so it reduces the day's drawdown.
    if (payout > 0n) recordPayout({ session_id, marketId: leg.marketId, payoutUsd: Number(formatUnits(payout, COLL_DEC)) });
    R.redeemed.push(entry);
  }

  R.legs = jsonSafe(R.legs.map(stripM));
  R.riskStatus = riskSnapshot(session_id);
  return { ok: true, ...R,
    summary: { positionsFound: R.positionsFound, redeemedCount: R.redeemed.length, blockedCount: R.blocked.length,
      totalPayoutUnits: R.redeemed.reduce((a, e) => a + Number(e.payout?.payoutUnits ?? 0), 0).toFixed(6) } };
}
const stripM = ({ m, ...rest }) => ({ ...rest, amount: String(rest.amount) });

/** redeem + one trade-log entry per leg. Thrown errors are logged and re-thrown. */
export async function redeem({ market_id = null, dry_run = false, session_id = null,
  sessionId = null } = {}) {
  const sid = session_id ?? sessionId ?? null;
  let res;
  try {
    res = await redeem_inner({ market_id, dry_run, session_id: sid });
  } catch (e) {
    const msg = e.shortMessage ?? e.message;
    recordRedeem({ session_id: sid, res: null, dry_run, thrown: msg });
    throw e;
  }
  const logged = recordRedeem({ session_id: sid, res, dry_run });
  const failedWrites = logged.filter((l) => !l.ok);
  return { ...res, tradeLog: failedWrites.length
    ? { recorded: false, entriesWritten: logged.length - failedWrites.length,
        error: failedWrites[0].error, note: failedWrites[0].note }
    : { recorded: true, entries: logged.length, seqs: logged.map((l) => l.seq),
        note: `${logged.length} entry/entries appended — one per leg, so a guard BLOCK appears separately from any payout. Read them with get_trade_log.` } };
}

// ============================================================================
// TOOL 10 — withdraw
//
// WHY THIS EXISTS: Production Roadmap Tier 0 #2 — "AgentRail generates a
// wallet and takes deposits into it. There is currently no mechanism for a
// user to get funds back out except by trading them away." This is that
// mechanism. It is the first tool that puts the per-session ctx() rewiring
// (see that function's header) to use for something other than trading.
//
// SCOPE, deliberate: sends the full requested asset out of the CALLER'S OWN
// dedicated wallet to an address the caller supplies, in either tUSDC
// (ERC20 transfer) or SOMI (native transfer). No implicit/default
// destination is ever used — to_address is always required and validated.
// This does NOT interact with risk.mjs or any open position: a dedicated
// wallet's balance is not itself "reserved" by anything until an order is
// actually placed, so withdrawing collateral needs no reservation logic of
// its own. If a caller withdraws funds they meant to trade with next, the
// next place_order attempt simply fails on insufficient balance — a
// sequencing problem for the caller, not a state this tool must guard.
//
// GAS ACCOUNTING: tUSDC and SOMI are not interchangeable (same fact
// get_wallet_balance already reports) — a tUSDC withdrawal still needs SOMI
// in the wallet to pay for its own transaction, and is refused up front if
// there isn't enough, rather than broadcasting and failing at the send
// layer. amount:"max" on SOMI reserves estimated gas for the withdrawal
// transaction itself so the wallet is not left unable to broadcast; amount:
// "max" on tUSDC withdraws the entire ERC20 balance, since tUSDC itself
// carries no gas cost to hold at zero.
// ============================================================================
async function withdraw_inner({ session_id = null, to_address = null, asset = null, amount = null } = {}) {
  if (!session_id) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id is required — it identifies which dedicated wallet the funds leave from. There is no shared or default wallet.' };
  }
  const ASSET = String(asset ?? '').toUpperCase();
  if (!['TUSDC', 'SOMI'].includes(ASSET)) {
    return { ok: false, refused: true, reason: 'asset_required',
      detail: `asset must be "tUSDC" or "SOMI" (case-insensitive), got ${JSON.stringify(asset)}. They are separate balances with separate transfer mechanics (ERC20 vs native) and must be withdrawn separately.` };
  }
  if (!to_address || !/^0x[0-9a-fA-F]{40}$/.test(String(to_address))) {
    return { ok: false, refused: true, reason: 'invalid_to_address',
      detail: 'to_address must be a 20-byte hex address (0x + 40 hex chars). Required on every call — there is deliberately no default or previously-used destination to fall back to.' };
  }

  const { pc, owner } = ctx({ session_id, requireKey: true });
  const R = { tool: 'withdraw', sessionId: session_id, fromAddress: owner.address,
    toAddress: to_address, asset: ASSET === 'TUSDC' ? 'tUSDC' : 'SOMI', tx: {},
    custody: CUSTODY_DISCLOSURE };

  const gasPrice = await pc.getGasPrice();

  // ---------------------------------------------------------------- SOMI
  if (ASSET === 'SOMI') {
    const balBefore = await pc.getBalance({ address: owner.address });
    const gasEstimate = await pc.estimateGas(
      { account: owner.address, to: to_address, value: 1n }).catch(() => 21000n);
    const gasCost = gasEstimate * gasPrice;

    let sendRaw;
    if (amount === 'max' || amount === null || amount === undefined) {
      sendRaw = balBefore - gasCost;
      if (sendRaw <= 0n) {
        return { ok: false, ...R, reason: 'insufficient_balance_for_gas',
          detail: `SOMI balance ${formatUnits(balBefore, 18)} is not enough to cover the estimated gas cost (${formatUnits(gasCost, 18)} SOMI) of the withdrawal transaction itself. Nothing to withdraw after reserving gas.` };
      }
    } else {
      sendRaw = parseUnits(String(amount), 18);
      if (sendRaw <= 0n) {
        return { ok: false, ...R, reason: 'zero_amount', detail: `amount=${amount} resolves to zero.` };
      }
      if (sendRaw + gasCost > balBefore) {
        return { ok: false, ...R, reason: 'insufficient_balance',
          detail: `Requested ${amount} SOMI + estimated gas ${formatUnits(gasCost, 18)} SOMI exceeds balance ${formatUnits(balBefore, 18)} SOMI. Pass amount:"max" to withdraw everything minus gas.` };
      }
    }

    await send(session_id, R.tx, 'withdraw_SOMI', { to: to_address, value: sendRaw });
    const balAfter = await pc.getBalance({ address: owner.address });
    const t = R.tx.withdraw_SOMI;
    return { ok: true, ...R,
      amountSent: formatUnits(sendRaw, 18),
      balanceBefore: formatUnits(balBefore, 18), balanceAfter: formatUnits(balAfter, 18),
      confirmedBy: 'transaction receipt status + native balance delta',
      tx: { hash: t.hash, status: t.status, block: t.block, gasUsed: t.gasUsed } };
  }

  // ---------------------------------------------------------------- tUSDC
  // ERC20 transfer needs SOMI for gas — checked up front, not discovered by a
  // failed broadcast, same discipline get_wallet_balance already uses.
  const somiBal = await pc.getBalance({ address: owner.address });
  // Conservative estimate for a plain ERC20 transfer on this chain; refined by
  // an actual simulation would be better but transfer() on a standard ERC20
  // has no branch-dependent gas cost worth simulating for a refusal check.
  const gasEstimate = 65000n;
  const gasCost = gasEstimate * gasPrice;
  if (somiBal < gasCost) {
    return { ok: false, ...R, reason: 'insufficient_gas',
      detail: `This wallet holds ${formatUnits(somiBal, 18)} SOMI, below the estimated ${formatUnits(gasCost, 18)} SOMI needed to broadcast the withdrawal transaction. tUSDC cannot pay for its own transfer's gas — fund this wallet with SOMI first.` };
  }

  const collBefore = await pc.readContract(
    { address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  let sendRaw;
  if (amount === 'max' || amount === null || amount === undefined) {
    sendRaw = collBefore;
  } else {
    sendRaw = parseUnits(String(amount), COLL_DEC);
  }
  if (sendRaw <= 0n) {
    return { ok: false, ...R, reason: 'zero_amount',
      detail: amount === 'max' ? 'tUSDC balance is zero — nothing to withdraw.' : `amount=${amount} resolves to zero.` };
  }
  if (sendRaw > collBefore) {
    return { ok: false, ...R, reason: 'insufficient_balance',
      detail: `Requested ${formatUnits(sendRaw, COLL_DEC)} tUSDC exceeds balance ${formatUnits(collBefore, COLL_DEC)} tUSDC. Pass amount:"max" to withdraw the full balance.` };
  }

  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to_address, sendRaw] });
  await send(session_id, R.tx, 'withdraw_tUSDC', { to: COLL, data });
  const collAfter = await pc.readContract(
    { address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  const t = R.tx.withdraw_tUSDC;
  return { ok: true, ...R,
    amountSent: formatUnits(sendRaw, COLL_DEC),
    balanceBefore: formatUnits(collBefore, COLL_DEC), balanceAfter: formatUnits(collAfter, COLL_DEC),
    confirmedBy: 'transaction receipt status + ERC20 balance delta',
    tx: { hash: t.hash, status: t.status, block: t.block, gasUsed: t.gasUsed } };
}

/** withdraw + one trade-log entry. A thrown error is logged and re-thrown unchanged. */
export async function withdraw(input = {}) {
  const session_id = input.session_id ?? input.sessionId ?? null;
  const to_address = input.to_address ?? input.toAddress ?? null;
  let res;
  try {
    res = await withdraw_inner({ session_id, to_address, asset: input.asset, amount: input.amount ?? 'max' });
  } catch (e) {
    const msg = e.shortMessage ?? e.message;
    recordWithdrawal({ session_id, input, res: null, thrown: msg });
    throw e;
  }
  const logged = recordWithdrawal({ session_id, input, res });
  return { ...res, tradeLog: logged.ok
    ? { recorded: true, seq: logged.seq, sessionId: logged.sessionId,
        note: 'This outcome is in the append-only trade log. Read it with get_trade_log.' }
    : { recorded: false, error: logged.error, note: logged.note } };
}

// ============================================================================
// TOOL 5 — generate_wallet  (re-exported from ./wallet.mjs, no chain access)
// TOOL 6 — get_wallet_balance
//
// Purpose-only dedicated wallets, per spec §2's custody model. See the header of
// build/wallet.mjs for the custody and storage disclosures — this is a CUSTODIAL
// model over the generated wallet and is deliberately NOT described otherwise.
// ============================================================================
export { list_wallets, STORE_PATH } from './wallet.mjs';

// ============================================================================
// TOOL 9 — get_trade_log  (re-exported from ./trade-log.mjs, no chain access)
// The append-only record every write tool above feeds. See that module's header
// for why refusals are first-class entries.
// ============================================================================
export { get_trade_log, TRADE_LOG_DIR, DEFAULT_SESSION_ID } from './trade-log.mjs';

/** generate_wallet + a trade-log entry. Creation AND the idempotent no-op are logged. */
export function generate_wallet({ session_id, label = null, force_new = false } = {}) {
  const res = walletGenerate({ session_id, label, force_new });
  // Key the log entry to the SAME session id the wallet is stored under, so a
  // wallet and the orders placed for that session land in one history.
  const logged = recordWallet({ session_id, res, forceNew: force_new });
  return { ...res, tradeLog: logged.ok
    ? { recorded: true, seq: logged.seq, sessionId: logged.sessionId }
    : { recorded: false, error: logged.error, note: logged.note } };
}

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

  // --- DEPOSIT LOGGING, by observation. AgentRail has no deposit tool by design
  // (in production the user deposits from their own wallet), so the only honest way
  // to get deposits into the trade log is to notice a balance change here. An entry
  // is written only when something actually moved; the first read is a baseline.
  const obs = recordBalanceObservation({
    session_id: session_id ?? record?.sessionId ?? null,
    address: resolved, tUSDC: tusdc, SOMI: somi,
    readyToTrade: hasCollateral && canPayGas, known });

  return { ok: true,
    address: resolved, known,
    tradeLog: obs.skipped
      ? { recorded: false, unchanged: true, note: obs.reason }
      : obs.ok ? { recorded: true, seq: obs.seq, sessionId: obs.sessionId,
          note: 'A balance CHANGE was recorded in the trade log, marked actor:"OBSERVED" — AgentRail noticed it on-chain and did not perform it.' }
        : { recorded: false, error: obs.error, note: obs.note },
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
export { normalizeMinSecondsToExpiry, DEFAULT_MIN_SECONDS_TO_EXPIRY } from './intent.mjs';

// list_markets' own upper bound on runway for a 300s window. Used only to tell a
// caller when a floor they asked for is unsatisfiable BY CONSTRUCTION rather than
// by current market conditions — a different problem with a different remedy.
const LIST_MARKETS_MAX_SECONDS_TO_EXPIRY = 290;

export async function parse_intent(input = {}) {
  const norm = normalizeIntentLocal(input);
  if (!norm.ok) return { tool: 'parse_intent', ...norm };

  // --- runway floor: how much time must remain for a market to be SELECTABLE.
  // See intent.mjs for why the default is 60s and why a non-finite value must not
  // be passed through to the comparison.
  const RUN = normalizeRunwayLocal(input.min_seconds_to_expiry ?? input.minSecondsToExpiry);
  const minSec = RUN.value;

  const R = { ok: true, tool: 'parse_intent', ...norm,
    warnings: [...(norm.warnings ?? []), ...(RUN.warning ? [RUN.warning] : [])],
    placedAnything: false,
    contract: 'This tool VALIDATES and NORMALIZES intent. It does not place an order. Pass `placeOrderArgs` to place_order after the user confirms.' };

  if (input.resolve_market === false) {
    return { ...R, marketResolution: { attempted: false,
      note: 'resolve_market:false — market_id was NOT resolved. placeOrderArgs is incomplete: add a market_id from list_markets before calling place_order.' } };
  }

  // --- resolve asset -> a live, gated, liquid market of the right window
  //
  // Deliberately asks list_markets for a WIDER set than we intend to select from:
  // its own floor is lowered to min(ourFloor, 25) so markets that fail OUR floor
  // are still returned and can be REPORTED as skipped rather than silently
  // vanishing. Filtering at the list_markets layer would have hidden exactly the
  // timing information this floor exists to make visible.
  const lm = await list_markets({ window_seconds: norm.normalized.windowSeconds,
    min_seconds_to_expiry: Math.min(minSec, 25) });
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

  // --- apply the runway floor to SELECTION, not to visibility
  const runwayOf = (c) => ({ marketId: c.marketId, secondsToExpiry: c.secondsToExpiry });
  const qualified = candidates.filter((c) => c.secondsToExpiry >= minSec);
  const tooSoon = candidates.filter((c) => c.secondsToExpiry < minSec);

  if (!qualified.length) {
    // A DISTINCT condition from no_tradeable_market, kept separate for the same
    // reason window_unrecognized and window_not_supported are: the remedies differ.
    // Here markets for this asset DO exist and ARE open — they all just settle too
    // soon to put a confirmation in front of a human. A caller told
    // "no tradeable market" would wrongly report the venue as having nothing.
    const impossible = minSec > LIST_MARKETS_MAX_SECONDS_TO_EXPIRY;
    return { ok: false, refused: true, tool: 'parse_intent',
      reason: 'no_market_with_adequate_runway',
      detail: `intent is valid and ${candidates.length} tradeable ${norm.normalized.asset} market(s) are open right now, but every one of them settles in less than the required min_seconds_to_expiry=${minSec}s (soonest ${Math.min(...candidates.map((c) => c.secondsToExpiry))}s, longest ${Math.max(...candidates.map((c) => c.secondsToExpiry))}s). Refusing rather than resolving to one of them, because a confirm-before-execute flow needs enough runway for the user to READ the confirmation and reply — otherwise they approve a bet whose window has already closed, and place_order then refuses on status_gate_closed. This is NOT "no market available" (they exist) and NOT an invalid request.${impossible ? ` NOTE: min_seconds_to_expiry=${minSec}s is unsatisfiable BY CONSTRUCTION, not by current conditions — list_markets caps runway at ${LIST_MARKETS_MAX_SECONDS_TO_EXPIRY}s, so no ${norm.normalized.windowSeconds}s window can ever clear this floor.` : ''}`,
      normalized: norm.normalized,
      warnings: R.warnings,
      marketResolution: { attempted: true, resolved: false,
        minSecondsToExpiry: minSec,
        candidatesConsidered: candidates.length, candidatesClearingFloor: 0,
        skippedForInadequateRunway: tooSoon.map(runwayOf),
        ...(impossible ? { floorUnsatisfiableByConstruction: true,
          maxPossibleSecondsToExpiry: LIST_MARKETS_MAX_SECONDS_TO_EXPIRY } : {}) },
      suggestion: impossible
        ? `Lower min_seconds_to_expiry below ${LIST_MARKETS_MAX_SECONDS_TO_EXPIRY} — no ${norm.normalized.windowSeconds}s window is ever listed with more runway than that.`
        : `Either wait for the next window to open (a fresh 300s market appears regularly) or, if this caller has no human confirmation step, re-issue with a lower min_seconds_to_expiry. Do not silently accept a shorter window on the user's behalf — the timing is the thing being refused.` };
  }

  // Soonest settlement AMONG THOSE WITH ADEQUATE RUNWAY. Still soonest-first, which
  // is what a momentum trader wants; the floor only removes the ones too close to
  // expiry to confirm. `min_seconds_to_expiry: 0` restores the old behaviour exactly.
  const M = qualified[0];
  R.placeOrderArgs = { market_id: M.marketId, ...R.placeOrderArgs };
  R.marketResolution = { attempted: true, resolved: true,
    marketId: M.marketId, asset: M.asset, pool: M.pool,
    secondsToExpiry: M.secondsToExpiry, statusGate: M.statusGate,
    bestYesAskProb: M.bestYesAskProb, yesAskDepthUnits: M.yesAskDepthUnits,
    otherCandidates: candidates.filter((c) => c.marketId !== M.marketId).map((c) => ({
      ...runwayOf(c), belowRunwayFloor: c.secondsToExpiry < minSec })),
    runway: {
      minSecondsToExpiry: minSec,
      selectedSecondsToExpiry: M.secondsToExpiry,
      candidatesConsidered: candidates.length,
      candidatesClearingFloor: qualified.length,
      skippedForInadequateRunway: tooSoon.map(runwayOf),
      ...(RUN.wasDefaulted ? { floorWasDefaulted: true } : {}),
      note: 'A FLOOR on selection, not a replacement for surfacing real timing — every candidate is still listed in otherCandidates with its own secondsToExpiry, including the ones skipped for being too close to expiry. Selection remains soonest-settlement-first among those that clear the floor. Pass min_seconds_to_expiry: 0 to disable it (appropriate only for a caller with no human confirmation step).' },
    selectedBy: `soonest settlement among tradeable ${norm.normalized.asset} markets that clear min_seconds_to_expiry=${minSec}s (list_markets ordering, then the runway floor)` };

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
    runwayNote: `This market settles in ${M.secondsToExpiry}s. The order must be placed BEFORE then — if the user takes longer than that to confirm, place_order will correctly refuse on status_gate_closed and nothing will be bet. A minimum of ${minSec}s of runway was required for this market to be selectable at all.`,
    economics,
    riskLimits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd,
      maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd,
      note: 'Enforced server-side before any broadcast and NOT adjustable by a caller. An order above these is refused by place_order, not trimmed.' },
    showThisToTheUserBeforeCalling: 'place_order',
  };
  return R;
}
