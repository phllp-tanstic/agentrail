# AgentRail — PHASE C LOG (error consistency, dollar sizing, risk guardrails)

Live, append-only record of Phase C: three scoped changes to the Phase B MCP
tools. Written incrementally, one entry per task.

Session start: 2026-08-25.

## Ground truth carried in from Phase B (NOT re-verified)

- Four MCP tools built and proven against real testnet transactions.
- The redeem guard's **BLOCK and ALLOW paths are both proven live** (BLOCK
  preserved a losing position; ALLOW paid +1.000000 tUSDC).
- `place_order` fill resolution is a bounded poll returning
  **`FILLED` / `PENDING` / `NOT_FILLED`**, not a boolean. `filled: null` means
  PENDING and must not be read as a non-fill.
- Fills execute at the maker's price; a resting order can be taken later, debiting
  our own limit price. Observed fill latencies: {0s, 0s, ~8s, ~40s}, n=4.
- A clean `eth_call` simulation is **not** a guarantee of inclusion — Phase B saw
  a broadcast revert after a clean simulation, and the same calldata replayed at
  its own block returned success (state-dependent, not reproducible post-block).
- ERC20 allowance is per-pool and recurs per window; the ERC6909 `setOperator`
  grant is token-wide and does not recur.
- Scope fences stay: YES direction only, 300s windows only, self
  `placeBinaryOrder` path only.

## Scope for this session

| Task | Change |
|---|---|
| 1 | `place_order` returns `{ok:false, reason:'reverted', …}` instead of throwing |
| 2 | `targetDollarAmount` sizing + `maxSlippagePct` refusal, alongside the existing raw-quantity path |
| 3 | Server-side risk guardrails (max stake per window, max daily loss) + exactly one automatic retry on a retryable revert |

**Explicitly out of scope, not started:** NL parsing, dedicated-wallet generation,
trade log, persistent risk storage.

---

## STEP 0 — Context read (prerequisite, not a proof step)

**What I did:** Re-read `research/AgentRail-Build-Spec.md` (§3 architecture, §6 MVP
scope) and `build/PHASE-B-LOG.md` in full, including STEP 10's three-state fill
resolution and the reverted-broadcast finding that Task 1 addresses. Read the
current `place_order` implementation in `build/mcp-core.mjs:182-347` in full,
plus the shared `send()` helper and the `redeem` payout path that Task 3 hooks.

**Result:** PASS (context loaded).

---
