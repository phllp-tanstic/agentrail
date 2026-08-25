// ============================================================================
// HARD CLIENT-SIDE REDEEM GUARD — single source of truth.
// Imported by every script that can broadcast a redeem. Do not inline a copy.
//
// WHY THIS EXISTS: run 2 (tx 0x643c7a22…352b) proved that redeeming a LOSING
// position does NOT revert — it returns status=success, burns the outcome tokens
// (ERC6909 1000000 -> 0) and pays ZERO. There is no on-chain protection and no
// revert for a simulation or try/catch to catch, so the only possible protection
// is client-side, and it MUST fail CLOSED: every ambiguity blocks the broadcast.
//
// Authority is the ON-CHAIN read (oc.winningOutcome), never the indexer's.
// See research/PROOF-LOG.md "PHASE A — RUN 3 / PART 1".
// ============================================================================

export function redeemGuard({ leg, oc, indexerWinningOutcome = null }) {
  const winOnchain = Number(oc?.winningOutcome ?? -1);
  const winIndexed = (indexerWinningOutcome === undefined || indexerWinningOutcome === null)
    ? null : Number(indexerWinningOutcome);
  const settledOnchain = oc?.finalized === true || oc?.isResolved === true;
  const base = { winOnchain, winIndexed, settledOnchain };

  // 1. not settled on-chain -> refuse
  if (!settledOnchain) {
    return { ...base, allow: false,
      reason: `market NOT finalized on-chain (finalized=${oc?.finalized} isResolved=${oc?.isResolved}) — refusing to redeem` };
  }
  // 2. outcome index out of range / missing (getMarketOnchain defaults to 0 pre-settlement)
  if (winOnchain !== 0 && winOnchain !== 1) {
    return { ...base, allow: false,
      reason: `oc.winningOutcome=${winOnchain} is not a valid outcome index — refusing` };
  }
  // 3. indexer disagrees with chain -> refuse (fail closed, do not pick a side)
  if (winIndexed !== null && winIndexed !== winOnchain) {
    return { ...base, allow: false,
      reason: `indexer winningOutcome=${winIndexed} DISAGREES with on-chain ${winOnchain} — refusing (fail closed)` };
  }
  // 4. THE LOSER CASE — the one that burned run 2's position
  if (leg.idx !== winOnchain) {
    return { ...base, allow: false,
      reason: `LOSER — outcomeIdx=${leg.idx} !== winningOutcome=${winOnchain}; broadcasting would BURN ${leg.amount} tokens for ZERO payout` };
  }
  return { ...base, allow: true,
    reason: `WINNER — outcomeIdx=${leg.idx} === on-chain winningOutcome=${winOnchain}` };
}
