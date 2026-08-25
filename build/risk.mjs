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
// Storage is in-memory for now, by instruction. Consequence stated plainly:
// restarting the server resets the daily counters. Persistence is a later
// concern; the accounting shape here is what persistence would back.
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

let state = { day: utcDay(), spendUsd: 0, payoutUsd: 0, perMarket: {}, events: [] };

function rollDayIfNeeded() {
  const d = utcDay();
  if (state.day !== d) {
    state = { day: d, spendUsd: 0, payoutUsd: 0, perMarket: {}, events: [] };
  }
}

// Drawdown definition, deliberately CONSERVATIVE — see PHASE-C-LOG.md TASK 3.
// Collateral that is spent but not yet redeemed counts as a loss until a payout
// offsets it. That over-states loss while positions are open, which fails CLOSED
// (refuses too early rather than too late). Mark-to-market on open positions
// would be the refinement; it is not implemented here.
const drawdown = () => Math.max(0, state.spendUsd - state.payoutUsd);

export function riskSnapshot() {
  rollDayIfNeeded();
  return {
    day: state.day,
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd,
      maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd, source: RISK_CONFIG.source },
    limitsAreToolParameters: false,
    spendUsd: Number(state.spendUsd.toFixed(6)),
    payoutUsd: Number(state.payoutUsd.toFixed(6)),
    drawdownUsd: Number(drawdown().toFixed(6)),
    remainingDailyLossBudgetUsd: Number(Math.max(0, RISK_CONFIG.maxDailyLossUsd - drawdown()).toFixed(6)),
    perMarketCommittedUsd: Object.fromEntries(
      Object.entries(state.perMarket).map(([k, v]) => [k, Number(v.toFixed(6))])),
    storage: 'in-memory — resets on server restart (by instruction; persistence is a later concern)',
    drawdownDefinition: 'spend − payout, floored at 0. Unredeemed positions count as loss until a payout offsets them (conservative, fails closed).',
  };
}

/**
 * Evaluate BEFORE any order is broadcast. Returns {allow, reason, ...detail}.
 * estimatedSpendUsd should be the WORST-CASE spend (quantity × our limit price),
 * not the expected spend, so the check fails closed on an adverse fill.
 */
export function checkPreOrder({ marketId, estimatedSpendUsd }) {
  rollDayIfNeeded();
  const spend = Number(estimatedSpendUsd);
  const base = { checkedAt: new Date().toISOString(), estimatedSpendUsd: Number(spend.toFixed(6)),
    limits: { maxStakePerWindowUsd: RISK_CONFIG.maxStakePerWindowUsd, maxDailyLossUsd: RISK_CONFIG.maxDailyLossUsd } };

  if (!Number.isFinite(spend) || spend < 0) {
    return { ...base, allow: false, code: 'invalid_estimated_spend',
      reason: `estimatedSpendUsd=${estimatedSpendUsd} is not a usable number — refusing (fail closed).` };
  }

  // 1. max stake per window — aggregates prior commitments to the SAME market,
  //    so several small orders in one window cannot together exceed the cap.
  const already = state.perMarket[marketId] ?? 0;
  const windowTotal = already + spend;
  if (windowTotal > RISK_CONFIG.maxStakePerWindowUsd) {
    return { ...base, allow: false, code: 'max_stake_per_window_exceeded',
      alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
      wouldTotalUsd: Number(windowTotal.toFixed(6)),
      reason: `stake would commit ${windowTotal.toFixed(6)} USD to window ${marketId} (${already.toFixed(6)} already committed + ${spend.toFixed(6)} requested), exceeding the server-side max of ${RISK_CONFIG.maxStakePerWindowUsd} USD. This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  // 2. max daily loss
  const dd = drawdown();
  if (dd + spend > RISK_CONFIG.maxDailyLossUsd) {
    return { ...base, allow: false, code: 'max_daily_loss_exceeded',
      drawdownUsd: Number(dd.toFixed(6)),
      wouldReachUsd: Number((dd + spend).toFixed(6)),
      reason: `current daily drawdown ${dd.toFixed(6)} USD + this order's ${spend.toFixed(6)} USD would reach ${(dd + spend).toFixed(6)} USD, exceeding the server-side daily loss cap of ${RISK_CONFIG.maxDailyLossUsd} USD (day ${state.day}, UTC). This limit is NOT a tool parameter and cannot be raised by a caller.` };
  }

  return { ...base, allow: true, drawdownUsd: Number(dd.toFixed(6)),
    alreadyCommittedThisWindowUsd: Number(already.toFixed(6)),
    reason: `within limits (window ${windowTotal.toFixed(6)}/${RISK_CONFIG.maxStakePerWindowUsd} USD, daily drawdown ${(dd + spend).toFixed(6)}/${RISK_CONFIG.maxDailyLossUsd} USD)` };
}

/** Record collateral actually spent, once a placement's spend is known. */
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

/** Test-only: clear in-memory accounting. Not exposed as an MCP tool. */
export function _resetRiskState() {
  state = { day: utcDay(), spendUsd: 0, payoutUsd: 0, perMarket: {}, events: [] };
  return riskSnapshot();
}
