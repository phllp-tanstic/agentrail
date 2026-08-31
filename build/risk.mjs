// ============================================================================
// SERVER-SIDE RISK GUARDRAILS — single source of truth, PER SESSION.
//
// DESIGN RULE, non-negotiable: the LIMITS ARE NOT TOOL PARAMETERS. They come
// from the process environment (or these defaults) and are never accepted as an
// MCP tool input. If a limit were an input, a model could raise it before
// placing an order, which would make the guardrail decorative. This is the
// "enforced in code, never trusted to the model" requirement from
// AgentRail-Build-Spec.md §6.
//
// PER-SESSION LEDGER (this revision). Every exported function now takes a
// required `session_id` and reads/writes that session's own state, keyed in
// `ledgers`. This is NOT a limits-as-parameters violation — session_id
// identifies WHOSE budget is being checked, it does not change what the
// budget IS. RISK_CONFIG (the actual dollar limits) stays global: every
// session is bound by the same env-configured caps, applied to that
// session's own spend, not to a shared pool. Before this change, ALL
// sessions shared one global spend/payout/reservation total — one user's
// losses could exhaust the daily loss budget for every other user on the
// same running process. That was never a viable multi-user design; it was
// only safe because the earlier build had, in effect, exactly one user
// (AGENTRAIL_OWNER_KEY signed every trade regardless of session_id).
//
// RESERVE-ON-CHECK (Phase C fix, unchanged). checkPreOrder() MUTATES STATE: on
// approval it immediately reserves the worst-case spend against that session's
// caps and returns a `reservationId`. This closes a confirmed check-then-act
// race — previously the check read a committed total that was only updated
// after the fill resolved seconds later, so concurrent callers each read the
// same stale total, each passed the cap individually, and collectively
// exceeded it. That race is per-session now, same as everything else here.
//
// The caller MUST then resolve the reservation exactly once:
//   commitReservation({session_id, reservationId, actualSpentUsd}) -> real spend
//                                                         recorded, difference released
//   releaseReservation({session_id, reservationId, why})           -> reservation dropped
// A reservation that is never resolved permanently eats capacity within that
// session without ever corresponding to a real order, so callers wrap the flow
// in try/finally.
//
// Storage is in-memory for now, by instruction. Consequence stated plainly:
// restarting the server resets EVERY session's daily counters AND drops every
// session's open reservations. Persistence (checklist row #11, Tier 1 #4/#5)
// is a later concern; the accounting shape here — now keyed per session — is
// what a real DB-backed ledger would back.
// ============================================================================

export const RISK_CONFIG = {
  // Max collateral committable to a single market window, in USD (tUSDC).
  // Applies PER SESSION — this is each user's own per-window cap, not a
  // pool shared across users.
  maxStakePerWindowUsd: Number(process.env.AGENTRAIL_MAX_STAKE_USD ?? 5),
  // Max realized drawdown per UTC day before all further orders are refused.
  // Applies PER SESSION, for the same reason.
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

// session_id -> ledger state. Unbounded for now, same as the old single
// object was unbounded in time — a real deployment persists this (Tier 1 #4)
// rather than growing it forever in process memory.
const ledgers = new Map();

function requireSessionId(session_id) {
  const sid = String(session_id ?? '').trim();
  if (!sid) {
    throw new Error('risk.mjs: session_id is required for every risk-accounting call. ' +
      'This is not a tool-facing limit (which would be a policy violation) — it identifies ' +
      'whose budget is being read or mutated, and there is no longer a global fallback ledger.');
  }
  return sid;
}

function getLedger(session_id) {
  const sid = requireSessionId(session_id);
  let s = ledgers.get(sid);
  if (!s) { s = freshState(); ledgers.set(sid, s); }
  return s;
}

function rollDayIfNeeded(state) {
  const d = utcDay();
  if (state.day !== d) {
    // Carry open reservations across a day boundary: they represent in-flight
    // orders that still need resolving. Dropping them would leak capacity in the
    // other direction (a commit arriving with no reservation to match).
    const carried = state.reservations;
    const seq = state.seq;
    Object.assign(state, freshState());
    state.reservations = carried;
    state.seq = seq;
  }
  return state;
}

// --- derived views over open reservations, now scoped to one session's state
const reservedTotal = (state) => {
  let t = 0;
  for (const r of state.reservations.values()) t += r.amountUsd;
  return t;
};
const reservedForMarket = (state, marketId) => {
  let t = 0;
  for (const r of state.reservations.values()) if (r.marketId === marketId) t += r.amountUsd;
  return t;
};

// Committed exposure to one market window = real spend + open reservations,
// within one session.
const windowExposure = (state, marketId) =>
  (state.perMarket[marketId] ?? 0) + reservedForMarket(state, marketId);

// Drawdown, deliberately CONSERVATIVE — see PHASE-C-LOG.md TASK 3.
// Collateral that is spent but not yet redeemed counts as a loss until a payout
// offsets it, and OPEN RESERVATIONS count too, so concurrent orders FROM THE
// SAME SESSION cannot collectively breach that session's daily cap either.
// Over-states loss while positions are open, which fails CLOSED.
const drawdown = (state) => Math.max(0, state.spendUsd + reservedTotal(state) - state.payoutUsd);

export function riskSnapshot(session_id) {
  const state = rollDayIfNeeded(getLedger(session_id));
  return {
    sessionId: requireSessionId(session_id),
    day: state.day,
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd,
      maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd, source: RISK_CONFIG.source },
    limitsAreToolParameters: false,
    limitsScope: 'per session_id — each user has their own independent budget against the same env-configured limit values',
    spendUsd: Number(state.spendUsd.toFixed(6)),
    payoutUsd: Number(state.payoutUsd.toFixed(6)),
    reservedUsd: Number(reservedTotal(state).toFixed(6)),
    openReservations: state.reservations.size,
    drawdownUsd: Number(drawdown(state).toFixed(6)),
    remainingDailyLossBudgetUsd: Number(Math.max(0, RISK_CONFIG.maxDailyLossUsd - drawdown(state)).toFixed(6)),
    perMarketCommittedUsd: Object.fromEntries(
      Object.entries(state.perMarket).map(([k, v]) => [k, Number(v.toFixed(6))])),
    perMarketExposureUsd: Object.fromEntries(
      [...new Set([...Object.keys(state.perMarket),
        ...[...state.reservations.values()].map((r) => r.marketId)])]
        .map((k) => [k, Number(windowExposure(state, k).toFixed(6))])),
    storage: 'in-memory, per session_id — resets on server restart, which also drops open reservations for every session (by instruction; persistence is a later concern, Tier 1 #4)',
    drawdownDefinition: 'spend + open reservations − payout, floored at 0, WITHIN THIS SESSION. Unredeemed positions and in-flight reservations both count as loss until resolved (conservative, fails closed).',
  };
}

/**
 * Evaluate BEFORE any order is broadcast, and RESERVE on approval — for one
 * session's own ledger only.
 *
 * !! THIS MUTATES STATE. On `allow: true` it returns a `reservationId` and the
 * amount is immediately held against that session's caps. The caller MUST
 * resolve it via commitReservation() or releaseReservation() — see the module
 * header. Every call must pass the SAME session_id through the whole
 * reserve -> commit/release lifecycle; a reservationId is only ever looked up
 * within the ledger it was created in.
 *
 * estimatedSpendUsd must be the WORST-CASE spend (quantity × our limit price),
 * not the expected spend, so the check fails closed on an adverse fill.
 */
export function checkPreOrder({ session_id, marketId, estimatedSpendUsd }) {
  const sid = requireSessionId(session_id);
  const state = rollDayIfNeeded(getLedger(sid));
  const spend = Number(estimatedSpendUsd);
  const base = { sessionId: sid, checkedAt: new Date().toISOString(), estimatedSpendUsd: Number(spend.toFixed(6)),
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd, maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd },
    reservationId: null };

  if (!Number.isFinite(spend) || spend < 0) {
    return { ...base, allow: false, code: 'invalid_estimated_spend',
      reason: `estimatedSpendUsd=${estimatedSpendUsd} is not a usable number — refusing (fail closed).` };
  }

  // 1. max stake per window, within this session. Counts real spend AND open
  //    reservations for this market FROM THIS SESSION, so concurrent callers
  //    using the same session_id see each other's in-flight exposure.
  const already = windowExposure(state, marketId);
  const windowTotal = already + spend;
  if (windowTotal > RISK_CONFIG.maxStakePerWindowUsd) {
    return { ...base, allow: false, code: 'max_stake_per_window_exceeded',
      alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
      ofWhichReservedUsd: Number(reservedForMarket(state, marketId).toFixed(6)),
      wouldTotalUsd: Number(windowTotal.toFixed(6)),
      reason: `session ${sid}: stake would commit ${windowTotal.toFixed(6)} USD to window ${marketId} (${already.toFixed(6)} already committed or reserved + ${spend.toFixed(6)} requested), exceeding the server-side max of ${RISK_CONFIG.maxStakePerWindowUsd} USD. This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  // 2. max daily loss, within this session. Also counts open reservations.
  const dd = drawdown(state);
  if (dd + spend > RISK_CONFIG.maxDailyLossUsd) {
    return { ...base, allow: false, code: 'max_daily_loss_exceeded',
      drawdownUsd: Number(dd.toFixed(6)),
      ofWhichReservedUsd: Number(reservedTotal(state).toFixed(6)),
      wouldReachUsd: Number((dd + spend).toFixed(6)),
      reason: `session ${sid}: current daily drawdown ${dd.toFixed(6)} USD (including in-flight reservations) + this order's ${spend.toFixed(6)} USD would reach ${(dd + spend).toFixed(6)} USD, exceeding the server-side daily loss cap of ${RISK_CONFIG.maxDailyLossUsd} USD (day ${state.day}, UTC). This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  // ---- APPROVED: reserve immediately, in the same synchronous step as the
  // check. No await between deciding and holding, so nothing can interleave.
  const reservationId = `rsv_${sid}_${state.day}_${++state.seq}`;
  state.reservations.set(reservationId, { marketId, amountUsd: spend, at: new Date().toISOString() });
  state.events.push({ at: new Date().toISOString(), kind: 'reserve', marketId, usd: spend, reservationId });

  return { ...base, allow: true, reservationId,
    drawdownUsd: Number(dd.toFixed(6)),
    alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
    reservedNowUsd: Number(spend.toFixed(6)),
    reason: `session ${sid}: within limits (window ${windowTotal.toFixed(6)}/${RISK_CONFIG.maxStakePerWindowUsd} USD, daily drawdown ${(dd + spend).toFixed(6)}/${RISK_CONFIG.maxDailyLossUsd} USD) — ${spend.toFixed(6)} USD reserved as ${reservationId}` };
}

/**
 * Resolve a reservation into the real spend, within the given session's
 * ledger. Releases the difference between the reserved worst case and what
 * was actually spent. actualSpentUsd may be 0 (a reverted placement moves no
 * collateral), which is a full release.
 */
export function commitReservation({ session_id, reservationId, marketId = null, actualSpentUsd }) {
  const sid = requireSessionId(session_id);
  const state = rollDayIfNeeded(getLedger(sid));
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
    return { ...riskSnapshot(sid), warning: `reservation ${reservationId} was not open in session ${sid}'s ledger (already resolved, never created, or created under a different session_id); recorded ${safeActual} USD of real spend without a matching reservation.` };
  }

  state.reservations.delete(reservationId);
  if (safeActual > 0) {
    state.spendUsd += safeActual;
    state.perMarket[rsv.marketId] = (state.perMarket[rsv.marketId] ?? 0) + safeActual;
  }
  state.events.push({ at: new Date().toISOString(), kind: 'commit', marketId: rsv.marketId,
    reservedUsd: rsv.amountUsd, actualUsd: safeActual,
    releasedDifferenceUsd: Number((rsv.amountUsd - safeActual).toFixed(6)), reservationId });
  return riskSnapshot(sid);
}

/** Drop a reservation without recording any spend, within one session's ledger. */
export function releaseReservation({ session_id, reservationId, why = 'unspecified' }) {
  const sid = requireSessionId(session_id);
  const state = rollDayIfNeeded(getLedger(sid));
  const rsv = state.reservations.get(reservationId);
  if (!rsv) return riskSnapshot(sid);
  state.reservations.delete(reservationId);
  state.events.push({ at: new Date().toISOString(), kind: 'release',
    marketId: rsv.marketId, usd: rsv.amountUsd, reservationId, why });
  return riskSnapshot(sid);
}

/**
 * Record collateral spent with no prior reservation, within one session's
 * ledger. Retained for setting up test scenarios and for any caller outside
 * the reserve/commit flow.
 */
export function recordSpend({ session_id, marketId, spentUsd }) {
  const sid = requireSessionId(session_id);
  const state = rollDayIfNeeded(getLedger(sid));
  const v = Number(spentUsd);
  if (!Number.isFinite(v) || v <= 0) return riskSnapshot(sid);
  state.spendUsd += v;
  state.perMarket[marketId] = (state.perMarket[marketId] ?? 0) + v;
  state.events.push({ at: new Date().toISOString(), kind: 'spend', marketId, usd: v });
  return riskSnapshot(sid);
}

/** Record a redemption payout for one session, which reduces that session's drawdown. */
export function recordPayout({ session_id, marketId, payoutUsd }) {
  const sid = requireSessionId(session_id);
  const state = rollDayIfNeeded(getLedger(sid));
  const v = Number(payoutUsd);
  if (!Number.isFinite(v) || v <= 0) return riskSnapshot(sid);
  state.payoutUsd += v;
  state.events.push({ at: new Date().toISOString(), kind: 'payout', marketId, usd: v });
  return riskSnapshot(sid);
}

/** Test-only: full ledger for one session, including open reservations. Not an MCP tool. */
export function _riskEvents(session_id) { return [...getLedger(session_id).events]; }
export function _openReservations(session_id) {
  return [...getLedger(session_id).reservations.entries()].map(([id, r]) => ({ reservationId: id, ...r }));
}

/** Test-only: every session_id with any ledger state. Not an MCP tool. */
export function _allLedgerSessionIds() { return [...ledgers.keys()]; }

/** Test-only: clear in-memory accounting for one session (or all, if omitted). Not an MCP tool. */
export function _resetRiskState(session_id) {
  if (session_id === undefined) { ledgers.clear(); return { ok: true, clearedAll: true }; }
  const sid = requireSessionId(session_id);
  ledgers.set(sid, freshState());
  return riskSnapshot(sid);
}
