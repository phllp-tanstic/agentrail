// ============================================================================
// SERVER-SIDE RISK GUARDRAILS — single source of truth.
//
// DESIGN RULE, non-negotiable: the LIMITS ARE NOT TOOL PARAMETERS. They come
// from the process environment (or these defaults) and are never accepted as an
// MCP tool input. If a limit were an input, a model could raise it before
// placing an order, which would make the guardrail decorative. This is the
// "enforced in code, never trusted to the model" requirement from
// AgentRail-Build-Spec.md §6.
//
// RESERVE-ON-CHECK (Phase C fix). checkPreOrder() MUTATES STATE: on approval it
// immediately reserves the worst-case spend against the caps and returns a
// `reservationId`. This closes a confirmed check-then-act race — previously the
// check read a committed total that was only updated after the fill resolved
// seconds later, so concurrent callers each read the same stale total, each
// passed the cap individually, and collectively exceeded it.
//
// The caller MUST then resolve the reservation exactly once:
//   commitReservation({reservationId, actualSpentUsd})  -> real spend recorded,
//                                                         the difference released
//   releaseReservation({reservationId, why})            -> reservation dropped
// A reservation that is never resolved permanently eats capacity without ever
// corresponding to a real order, so callers wrap the flow in try/finally.
//
// Storage is in-memory for now, by instruction. Consequence stated plainly:
// restarting the server resets the daily counters AND drops open reservations.
// Persistence is a later concern; the accounting shape here is what it would back.
// ============================================================================

export const RISK_CONFIG = {
  // Max collateral committable to a single market window, in USD (tUSDC).
  maxStakePerWindowUsd: Number(process.env.AGENTRAIL_MAX_STAKE_USD ?? 5),
  // Max realized drawdown per UTC day before all further orders are refused.
  maxDailyLossUsd: Number(process.env.AGENTRAIL_MAX_DAILY_LOSS_USD ?? 10),
  source: {
    maxStakePerWindowUsd: process.env.AGENTRAIL_MAX_STAKE_USD ? 'env AGENTRAIL_MAX_STAKE_USD' : 'default',
    maxDailyLossUsd: process.env.AGENTRAIL_MAX_DAILY_LOSS_USD ? 'env AGENTRAIL_MAX_DAILY_LOSS_USD' : 'default',
  },
};

const utcDay = () => new Date().toISOString().slice(0, 10);

const freshState = () => ({
  day: utcDay(), spendUsd: 0, payoutUsd: 0, perMarket: {},
  reservations: new Map(),   // reservationId -> { marketId, amountUsd, at }
  seq: 0, events: [],
});
let state = freshState();

function rollDayIfNeeded() {
  const d = utcDay();
  if (state.day !== d) {
    // Carry open reservations across a day boundary: they represent in-flight
    // orders that still need resolving. Dropping them would leak capacity in the
    // other direction (a commit arriving with no reservation to match).
    const carried = state.reservations;
    const seq = state.seq;
    state = freshState();
    state.reservations = carried;
    state.seq = seq;
  }
}

// --- derived views over open reservations
const reservedTotal = () => {
  let t = 0;
  for (const r of state.reservations.values()) t += r.amountUsd;
  return t;
};
const reservedForMarket = (marketId) => {
  let t = 0;
  for (const r of state.reservations.values()) if (r.marketId === marketId) t += r.amountUsd;
  return t;
};

// Committed exposure to one market window = real spend + open reservations.
const windowExposure = (marketId) => (state.perMarket[marketId] ?? 0) + reservedForMarket(marketId);

// Drawdown, deliberately CONSERVATIVE — see PHASE-C-LOG.md TASK 3.
// Collateral that is spent but not yet redeemed counts as a loss until a payout
// offsets it, and OPEN RESERVATIONS count too, so concurrent orders cannot
// collectively breach the daily cap either. Over-states loss while positions are
// open, which fails CLOSED (refuses too early rather than too late).
const drawdown = () => Math.max(0, state.spendUsd + reservedTotal() - state.payoutUsd);

export function riskSnapshot() {
  rollDayIfNeeded();
  return {
    day: state.day,
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd,
      maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd, source: RISK_CONFIG.source },
    limitsAreToolParameters: false,
    spendUsd: Number(state.spendUsd.toFixed(6)),
    payoutUsd: Number(state.payoutUsd.toFixed(6)),
    reservedUsd: Number(reservedTotal().toFixed(6)),
    openReservations: state.reservations.size,
    drawdownUsd: Number(drawdown().toFixed(6)),
    remainingDailyLossBudgetUsd: Number(Math.max(0, RISK_CONFIG.maxDailyLossUsd - drawdown()).toFixed(6)),
    perMarketCommittedUsd: Object.fromEntries(
      Object.entries(state.perMarket).map(([k, v]) => [k, Number(v.toFixed(6))])),
    perMarketExposureUsd: Object.fromEntries(
      [...new Set([...Object.keys(state.perMarket),
        ...[...state.reservations.values()].map((r) => r.marketId)])]
        .map((k) => [k, Number(windowExposure(k).toFixed(6))])),
    storage: 'in-memory — resets on server restart, which also drops open reservations (by instruction; persistence is a later concern)',
    drawdownDefinition: 'spend + open reservations − payout, floored at 0. Unredeemed positions and in-flight reservations both count as loss until resolved (conservative, fails closed).',
  };
}

/**
 * Evaluate BEFORE any order is broadcast, and RESERVE on approval.
 *
 * !! THIS MUTATES STATE. On `allow: true` it returns a `reservationId` and the
 * amount is immediately held against both caps. The caller MUST resolve it via
 * commitReservation() or releaseReservation() — see the module header.
 *
 * estimatedSpendUsd must be the WORST-CASE spend (quantity × our limit price),
 * not the expected spend, so the check fails closed on an adverse fill.
 */
export function checkPreOrder({ marketId, estimatedSpendUsd }) {
  rollDayIfNeeded();
  const spend = Number(estimatedSpendUsd);
  const base = { checkedAt: new Date().toISOString(), estimatedSpendUsd: Number(spend.toFixed(6)),
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd, maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd },
    reservationId: null };

  if (!Number.isFinite(spend) || spend < 0) {
    return { ...base, allow: false, code: 'invalid_estimated_spend',
      reason: `estimatedSpendUsd=${estimatedSpendUsd} is not a usable number — refusing (fail closed).` };
  }

  // 1. max stake per window. Counts real spend AND open reservations for this
  //    market, so concurrent callers see each other's in-flight exposure.
  const already = windowExposure(marketId);
  const windowTotal = already + spend;
  if (windowTotal > RISK_CONFIG.maxStakePerWindowUsd) {
    return { ...base, allow: false, code: 'max_stake_per_window_exceeded',
      alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
      ofWhichReservedUsd: Number(reservedForMarket(marketId).toFixed(6)),
      wouldTotalUsd: Number(windowTotal.toFixed(6)),
      reason: `stake would commit ${windowTotal.toFixed(6)} USD to window ${marketId} (${already.toFixed(6)} already committed or reserved + ${spend.toFixed(6)} requested), exceeding the server-side max of ${RISK_CONFIG.maxStakePerWindowUsd} USD. This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  // 2. max daily loss. Also counts open reservations, for the same reason.
  const dd = drawdown();
  if (dd + spend > RISK_CONFIG.maxDailyLossUsd) {
    return { ...base, allow: false, code: 'max_daily_loss_exceeded',
      drawdownUsd: Number(dd.toFixed(6)),
      ofWhichReservedUsd: Number(reservedTotal().toFixed(6)),
      wouldReachUsd: Number((dd + spend).toFixed(6)),
      reason: `current daily drawdown ${dd.toFixed(6)} USD (including in-flight reservations) + this order's ${spend.toFixed(6)} USD would reach ${(dd + spend).toFixed(6)} USD, exceeding the server-side daily loss cap of ${RISK_CONFIG.maxDailyLossUsd} USD (day ${state.day}, UTC). This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  // ---- APPROVED: reserve immediately, in the same synchronous step as the
  // check. No await between deciding and holding, so nothing can interleave.
  const reservationId = `rsv_${state.day}_${++state.seq}`;
  state.reservations.set(reservationId, { marketId, amountUsd: spend, at: new Date().toISOString() });
  state.events.push({ at: new Date().toISOString(), kind: 'reserve', marketId, usd: spend, reservationId });

  return { ...base, allow: true, reservationId,
    drawdownUsd: Number(dd.toFixed(6)),
    alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
    reservedNowUsd: Number(spend.toFixed(6)),
    reason: `within limits (window ${windowTotal.toFixed(6)}/${RISK_CONFIG.maxStakePerWindowUsd} USD, daily drawdown ${(dd + spend).toFixed(6)}/${RISK_CONFIG.maxDailyLossUsd} USD) — ${spend.toFixed(6)} USD reserved as ${reservationId}` };
}

/**
 * Resolve a reservation into the real spend. Releases the difference between the
 * reserved worst case and what was actually spent. actualSpentUsd may be 0 (a
 * reverted placement moves no collateral), which is a full release.
 */
export function commitReservation({ reservationId, marketId = null, actualSpentUsd }) {
  rollDayIfNeeded();
  const rsv = state.reservations.get(reservationId);
  const actual = Number(actualSpentUsd);
  const safeActual = Number.isFinite(actual) && actual > 0 ? actual : 0;

  if (!rsv) {
    // Idempotent: a double-commit, or a commit after the reservation was already
    // released, must not corrupt the ledger. Record the real spend anyway so
    // money that actually moved is never silently dropped.
    if (safeActual > 0 && marketId) {
      state.spendUsd += safeActual;
      state.perMarket[marketId] = (state.perMarket[marketId] ?? 0) + safeActual;
    }
    state.events.push({ at: new Date().toISOString(), kind: 'commit_orphan',
      marketId, usd: safeActual, reservationId });
    return { ...riskSnapshot(), warning: `reservation ${reservationId} was not open (already resolved or never created); recorded ${safeActual} USD of real spend without a matching reservation.` };
  }

  state.reservations.delete(reservationId);
  if (safeActual > 0) {
    state.spendUsd += safeActual;
    state.perMarket[rsv.marketId] = (state.perMarket[rsv.marketId] ?? 0) + safeActual;
  }
  state.events.push({ at: new Date().toISOString(), kind: 'commit', marketId: rsv.marketId,
    reservedUsd: rsv.amountUsd, actualUsd: safeActual,
    releasedDifferenceUsd: Number((rsv.amountUsd - safeActual).toFixed(6)), reservationId });
  return riskSnapshot();
}

/** Drop a reservation without recording any spend (refusal, throw, no-op exit). */
export function releaseReservation({ reservationId, why = 'unspecified' }) {
  rollDayIfNeeded();
  const rsv = state.reservations.get(reservationId);
  if (!rsv) return riskSnapshot();
  state.reservations.delete(reservationId);
  state.events.push({ at: new Date().toISOString(), kind: 'release',
    marketId: rsv.marketId, usd: rsv.amountUsd, reservationId, why });
  return riskSnapshot();
}

/**
 * Record collateral spent with no prior reservation. Retained for setting up test
 * scenarios and for any caller outside the reserve/commit flow.
 */
export function recordSpend({ marketId, spentUsd }) {
  rollDayIfNeeded();
  const v = Number(spentUsd);
  if (!Number.isFinite(v) || v <= 0) return riskSnapshot();
  state.spendUsd += v;
  state.perMarket[marketId] = (state.perMarket[marketId] ?? 0) + v;
  state.events.push({ at: new Date().toISOString(), kind: 'spend', marketId, usd: v });
  return riskSnapshot();
}

/** Record a redemption payout, which reduces the day's drawdown. */
export function recordPayout({ marketId, payoutUsd }) {
  rollDayIfNeeded();
  const v = Number(payoutUsd);
  if (!Number.isFinite(v) || v <= 0) return riskSnapshot();
  state.payoutUsd += v;
  state.events.push({ at: new Date().toISOString(), kind: 'payout', marketId, usd: v });
  return riskSnapshot();
}

/** Test-only: full ledger, including open reservations. Not an MCP tool. */
export function _riskEvents() { return [...state.events]; }
export function _openReservations() {
  return [...state.reservations.entries()].map(([id, r]) => ({ reservationId: id, ...r }));
}

/** Test-only: clear in-memory accounting. Not exposed as an MCP tool. */
export function _resetRiskState() {
  state = freshState();
  return riskSnapshot();
}
