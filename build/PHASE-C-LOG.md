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

## TASK 1 — a reverted broadcast returns a structured failure instead of throwing

**Implementation.** `send()` gained an option rather than changing behaviour for
existing callers: `send(txlog, label, req, { throwOnRevert })`. It still throws by
default — `redeem` depends on that — and `place_order` now passes
`throwOnRevert: false` so it gets the receipt back and can classify the outcome
itself. The broadcast is additionally wrapped in try/catch to catch send-layer
failures that never produce a receipt at all.

**Two distinct failure classes, deliberately not merged:**

| Class | Detected as | `reason` | `retryable` |
|---|---|---|---|
| On-chain revert | receipt returned, `status !== 'success'` | **`reverted`** | **`true`** |
| Send-layer failure | exception before/instead of a receipt (nonce, RPC, funds) | **`send_error`** | **`false`** |

A revert is retryable because it **changed no state** and Phase B proved the cause
can be transient — the identical calldata replayed at its own block succeeded,
consistent with resting liquidity being taken by a competing fill in the same
block. A send-layer failure is a different problem and retrying it blindly is not
justified, so it surfaces immediately.

The returned object states this explicitly rather than leaving the caller to infer
it, because Task 3's retry policy depends on the distinction:

> the placement transaction reverted on-chain (tx …). This is a NORMAL, often
> state-dependent outcome — Phase B observed a revert after a clean simulation
> where the identical calldata replayed at its own block succeeded […] It is not
> necessarily a sign of a deeper problem. No collateral was committed by a
> reverted transaction.

**Consistency sweep.** While making the revert path structured I found the other
failure paths in `place_order` were returning prose in the `reason` field, which is
the same inconsistency in a different place — `reason` was sometimes a machine code
and sometimes a sentence. All of them now return a **stable machine code** in
`reason` with the prose moved to `detail`:

`direction_out_of_scope`, `window_out_of_scope`, `market_id_required`,
`ambiguous_sizing`, `invalid_target_dollar_amount`, `market_not_found`,
`window_mismatch`, `status_gate_closed`, `no_resting_liquidity`, `zero_quantity`,
`max_stake_per_window_exceeded`, `max_daily_loss_exceeded`, `slippage_exceeded`,
`allowance_failed`, `simulation_reverted`, `reverted`, `send_error`.

This is a **breaking change to the shape of `reason`** on paths that previously
returned prose. Recorded as a deliberate change, not a silent one: a caller that
was string-matching `reason` for human text will now find a code there. Nothing
in-tree did that.

---

## TASK 2 — dollar-denominated sizing with a slippage refusal

**Implementation.** `place_order` now has two mutually exclusive sizing modes, and
refuses `ambiguous_sizing` if both are supplied rather than silently preferring
one. Neither given defaults to `stake_units: 1.0`, preserving Phase B behaviour.

| Mode | Input | Quantity derivation |
|---|---|---|
| `UNITS` (unchanged) | `stake_units` | `minQuantity × 1000 × stake_units` — the proven Phase A sizing |
| `DOLLAR` (new) | `targetDollarAmount` | `targetDollarAmount / referencePrice`, rounded to the `minQuantity` grid |

Both spellings are accepted (`targetDollarAmount` / `target_dollar_amount`,
`maxSlippagePct` / `max_slippage_pct`) so the camelCase names Phase C specified work
alongside the snake_case convention the existing surface uses.

### One deliberate deviation from the instruction, with the reason

The task said to snap the derived quantity "through the existing tick-snap logic."
**I did not do that, because it would silently corrupt the order size.**
`snapPriceToTick()` ends with:

```js
if (snapped > ONE - t) snapped = ONE - t;
```

That ceiling exists because the function snaps a **probability**, which cannot
exceed 1. A quantity has no such bound. Concretely, at `DEC=6` a legitimate size of
**2.012 units (2012000 raw) would be clamped to 999000 — a silent ~2× under-size**,
and every order above 1.0 unit would be capped at 0.999 units.

Quantity granularity is `minQuantity` (1000 raw = 0.001 units), not `tickSize`, so
the derived quantity is rounded to the nearest `minQuantity` multiple with a floor
of one `minQuantity`. **The price path still uses the shared tick-snapper,
completely unchanged** — that is what the mainnet 18-decimal `InvalidPrice` bug
turns on, and it was not touched. The distinction is recorded in a code comment at
the site so it cannot be "fixed" back later by mistake.

### Slippage: what is and is not counted

`maxSlippagePct` (default 5) is enforced **only in DOLLAR mode**, since it exists to
protect a cash target. The book is read twice — once for sizing (`referencePrice`),
once immediately before broadcast (`placementPrice`) — and the check trips on

```
slippagePct = (placementPrice − referencePrice) / referencePrice × 100  >  maxSlippagePct
```

**The gap between those two reads is real, not theoretical:** the allowance
approval is a transaction and the simulation is a round trip, and Phase B observed
the best ask move `497000 → 212000` inside ~30s on this venue.

**The deliberate `cross_ticks` premium is NOT counted as slippage.** This is a
judgement call worth stating: our bid is intentionally placed above the ask, so
worst-case spend at our own limit always exceeds the reference-priced target. At a
low ask that premium is large in percentage terms — 20 ticks on an ask of 0.212 is
+9.4%, which would trip a 5% default on every single order and make the guard
useless. Slippage therefore measures **adverse market movement**, and the
crossing premium is reported separately as
`spendEstimate.worstCaseAtOurLimitUsd`. Both numbers are in the payload, so a
caller sees the full picture rather than one conflated figure.

### Variance is reported, never assumed

On a filled DOLLAR-mode order the response carries `dollarSizing`:
`requestedUsd`, `actualCollateralSpentUsd`, `varianceUsd`, `variancePct`. Variance
is expected and is not an error — quantity is rounded to the grid, a fill can
execute at the maker's price (better than our limit), and a PENDING/NOT_FILLED
order **locks** collateral at our limit rather than spending it. The note says so
explicitly so a caller compares the two figures instead of trusting the target.

---

## TASK 3 — server-side risk guardrails and the single automatic retry

**Implementation.** New module `build/risk.mjs`, imported by `mcp-core.mjs`.

**The limits are not tool parameters.** They come from
`AGENTRAIL_MAX_STAKE_USD` / `AGENTRAIL_MAX_DAILY_LOSS_USD` or the defaults
(5 USD per window, 10 USD daily), and are deliberately absent from
`place_order`'s `inputSchema`. If a limit were an input, a model could raise it
before placing and the guardrail would be decorative. This is the spec §6
requirement — *"enforced in code, never trusted to the model"* — expressed
structurally rather than by convention. `checkPreOrder` ignores any limit-shaped
keys passed to it, which is asserted by a test below.

**Where it runs:** immediately after sizing and price-snapping, and **before** the
allowance, the simulation and the broadcast. Nothing is spent by a refused order.

**What it checks:**

| Check | Condition |
|---|---|
| `max_stake_per_window_exceeded` | `alreadyCommittedToThisMarket + worstCaseSpend > maxStakePerWindowUsd` |
| `max_daily_loss_exceeded` | `drawdown + worstCaseSpend > maxDailyLossUsd` |
| `invalid_estimated_spend` | spend is not a finite non-negative number → refuse (fail closed) |

Two design points worth recording:

- **The check uses worst-case spend, not expected spend** — quantity × *our limit
  price*, not × the ask. Phase B observed exactly that outcome (order rested, then
  taken at our own limit), so the conservative figure is the realistic one.
- **Per-window means per market, and it aggregates.** Prior commitments to the same
  `marketId` are summed, so several small orders cannot together breach the cap; a
  different market window starts from zero.

**Drawdown definition, deliberately conservative:** `spend − payout`, floored at 0.
Collateral that is spent but not yet redeemed **counts as a loss until a payout
offsets it**. That over-states loss while positions are open, which fails *closed*
— it refuses too early rather than too late. `redeem` now feeds `recordPayout()` on
a non-zero payout, so a winning redemption reduces the drawdown and re-opens
capacity. Mark-to-market on open positions is the obvious refinement and is not
implemented. Storage is in-memory by instruction: **a server restart resets the
daily counters**, stated plainly since that is a real limitation of this session's
scope.

**The retry (Task 1's note, applied).** `place_order` runs an attempt loop with
`MAX_ATTEMPTS = 2` — so **exactly one** automatic retry, never more:

- Only a `reverted` broadcast is retried. `send_error` is not.
- The retry **re-reads the book and re-sizes at current prices** rather than
  replaying stale calldata, because a revert can mean the resting liquidity we
  sized against is gone.
- **The risk check does not re-run on the retry.** A retry is the same trading
  intent, not new exposure; re-running it would double-count the stake against the
  per-window cap and could refuse a legitimate retry. `attempts[1].riskCheck`
  records that it was skipped and why.
- Every attempt is recorded in the `attempts` array, so a caller can see the revert
  that triggered the retry even when the retry succeeds.

### Test — 8/8 offline assertions on the guardrail logic

Run against the real `risk.mjs` exports (limits at defaults 5 / 10 USD):

| # | Assertion | Result |
|---|---|---|
| 1 | small order within limits → allow | **PASS** |
| 2 | single order above per-window max → refuse | **PASS** — `max_stake_per_window_exceeded` |
| 3 | **five 0.9 USD orders then one more aggregates to 5.4 > 5** → refuse | **PASS** — `wouldTotalUsd: 5.4` |
| 4 | a different market window is unaffected by the first's commitments | **PASS** — allow |
| 5 | daily loss cap trips at 9.6 + 0.9 = 10.5 > 10 | **PASS** — `wouldReachUsd: 10.5` |
| 6 | **a 5.0 USD payout reduces drawdown and re-opens capacity** | **PASS** — drawdown 9.6 → 4.6, allow |
| 7 | non-numeric spend → refuse (fail closed) | **PASS** — `invalid_estimated_spend` |
| 8 | **caller passing `maxStakePerWindowUsd: 1000` cannot raise the limit** | **PASS** — still refused |

Assertion 8 is the one that matters most: it proves the limits are not
caller-influenceable, which is the whole point of putting them server-side.

### Test — live refusals through the real tool, on market `0x…8e4b` BTC (ask 0.618)

| Test | Input | Result |
|---|---|---|
| **A — max stake per window** | `stake_units: 20` | **`ok:false, reason:'max_stake_per_window_exceeded'`** — worst case **12.76 USD** vs the 5 USD cap. **`txBroadcast: []`** |
| **B — ambiguous sizing** | both `stake_units:1` and `targetDollarAmount:0.5` | **`ok:false, reason:'ambiguous_sizing'`** |
| **C — slippage guard** | `targetDollarAmount: 0.4, maxSlippagePct: -1` | **`ok:false, reason:'slippage_exceeded'`** — **`txBroadcast: []`** |

All three refused **cleanly — a structured object, no exception, no transaction**,
and `riskSnapshot().perMarketCommittedUsd` was still `{}` afterwards, confirming a
refused order commits nothing to the accounting.

**Test C's dollar-sizing arithmetic, verified in passing:** target 0.40 USD at a
reference ask of `618000` (0.618) →`impliedQuantityRaw: 647249` → grid-rounded to
**`647000` (0.647 units)** → `estimatedSpendAtPlacementPriceUsd: 0.399846`. That is
**0.04% off the 0.40 USD target**, which is the `minQuantity` rounding and nothing
else.

**Honest note on how C was triggered:** `maxSlippagePct: -1` makes the guard refuse
unconditionally (observed movement was `0.0000%`, and `0 > -1`). That proves the
refusal *branch* executes and returns the right shape, but it is a degenerate
threshold rather than a real adverse move. A natural trip needs the ask to move
between the two reads, which is not controllable in a quick test. Recorded as
"branch proven, realistic trigger not observed" rather than implying a market-driven
refusal was witnessed.

### Test — TASK 2 normal case, live fill on market `0x…8e64` ETH

`targetDollarAmount: 0.40`, default `maxSlippagePct: 5`. Filled at receipt.

| Stage | Value |
|---|---|
| reference ask | `162000` (0.162) |
| derived quantity | `impliedQuantityRaw 2469135` → grid **`2469000` = 2.469 units** |
| price snap | `162000 + 20×1000` → **`182000`**, on-tick |
| **placement-time ask** | **`27000`** — the book moved −83.3333% between the two reads |
| slippage verdict | **allowed** — movement was *favourable* (negative), the guard only trips on adverse |
| `fillStatus` | **`FILLED`**, latency **0s** at receipt, **2.469 units** |
| `collateralSpent` | **0.101229 USD** |
| `dollarSizing.varianceUsd` | **−0.298771 (−74.69%)** |
| risk accounting | `spendUsd 0.101229`, `drawdownUsd 0.101229`, `remainingDailyLossBudgetUsd 9.898771` |
| attempts | **1** — no retry needed |
| txs | approve `0x758f9a91…9f92`, order `0x7a6b4531…11e5` |

**Sign convention confirmed correct:** an −83% (favourable) move was allowed rather
than refused. The guard is one-sided by design — it protects against *overspending*,
not against a better price.

### Finding worth flagging — a dollar target can undershoot badly, not just round

The variance here is **−74.69%**, which is not `minQuantity` rounding; it is two
orders of magnitude larger than the 0.04% seen in Test C. The cause: quantity is
fixed at sizing time from the reference price (0.162), then the ask collapsed to
0.027 and the fill executed at the much better maker price. So 2.469 units cost
0.101 USD instead of 0.40 USD.

That is a *favourable* fill — more units per dollar — but a caller who asked for
"0.40 USD of exposure" received about 0.10 USD of it. **The guard is asymmetric: it
refuses an overspend but nothing corrects an undershoot.** The tool reports the gap
plainly, which is what the "report variance, never assume" design exists for, so
this is working as specified rather than a defect — but the magnitude is worth
knowing before anything automated sizes off it.

Recorded, not fixed (outside Task 2's scope). The obvious refinement for a later
session: re-derive quantity from the **placement-time** price rather than the
reference price, so the dollar target tracks the book it will actually execute
against. That would also make `maxSlippagePct` purely a safety rail instead of
partly a sizing input.

**Second-order note on the 5% default:** this venue's book moved 83% inside the
few seconds between two reads. Phase B saw `497000 → 212000` in ~30s. A 5% default
is therefore *tight* relative to real volatility here, and adverse trips should be
expected in normal operation rather than treated as anomalies. Not changed — 5% is
a reasonable protective default, and the refusal is cheap and informative.

---

## TASK 1 test — the `reverted` branch could NOT be triggered live. Stated plainly.

**Result: implementation PASS, live execution of the `reason:'reverted'` branch NOT
achieved.** Three approaches were tried; none produced a broadcast revert.

**Approach 1 — place near expiry** so the gate is open and the simulation passes but
the tx lands after the window closes. Polled the 2–9s-to-expiry band for 3 minutes:
**never caught one.** The reason is structural — Somnia block times are
sub-second, so a tx submitted at T-5s is included well inside the window. Landing
after expiry needs sub-second submission timing, which is not reliably hittable.

**Approach 2 — provoke a same-block race.** Fired **3 concurrent placements** at one
market (`0x…8e8a` ETH, 990 units depth, ask 0.388), each 1.0 unit, hoping one would
lose the race for resting liquidity and revert. **All three filled** (0.304 USD
each, `attempts: 1`, no retry). No revert.

**Approach 3 — verify the classifier against real revert data.** Fetched the actual
receipt for Phase B's revert, tx
`0x71b63ff7fdcd6c41ca8d095624aa96dcea78221f7fe7ea0acf70518fb814af0f`:

```
raw receipt status = 0x0   ->   viem status = 'reverted'
classifier condition (rcpt.status !== 'success')  ->  true
=> classified reverted = true, retryable = true
```

So the branch's **entry condition is confirmed correct against a real reverted
receipt**, and the branch body is a straight-line construction of the return object.
But confirming the predicate is not the same as executing the path, and this log
does not claim it is.

**Why this is hard, which is itself the finding:** the simulation gates every
*deterministic* failure — bad price, insufficient allowance, closed market, zero
quantity — and each of those returns its own specific code well before a broadcast.
What is left for a broadcast revert is only genuine same-block state races, which
cannot be summoned on demand. That is consistent with Phase B, where the one
observed revert was accidental and did not reproduce on replay. **A reverted
placement is rare, which is exactly why it needed to stop being an exception** —
rare failures are the ones that crash callers.

**What is proven for Task 1:** the throw is gone (`throwOnRevert: false` plus
try/catch), every other failure path returns the structured shape, and the four
paths that *were* reachable live all returned `{ok:false, reason:<code>, detail:…}`
with no exception — `max_stake_per_window_exceeded`, `ambiguous_sizing`,
`slippage_exceeded`, and (Phase B) `status_gate_closed`.

---

## Unplanned finding — the risk cap has a check-then-act race under concurrency

> **SUPERSEDED — this gap is now CLOSED. See "TASK 4 — the concurrency gap is
> closed" at the end of this log.** The analysis below is kept intact as the record
> of how the hole was found and specified; its closing statement ("the caps hold for
> sequential calls and can be exceeded by concurrent ones") is **no longer true**.

**This is a real hole in the "cannot be bypassed" guarantee and is logged
prominently rather than buried.** It was surfaced by Approach 2 above.

`checkPreOrder()` reads `state.perMarket[marketId]`, but `recordSpend()` is only
called **after the fill resolves**, seconds later. So concurrent `place_order` calls
all evaluate against the same stale committed total.

Observed directly: the three racing orders each read
`alreadyCommittedThisWindowUsd: 0` and each was approved. They totalled **0.912
USD**, which is under the 5 USD cap, so **no breach actually occurred here** — but
the arithmetic is the point:

> three concurrent 2 USD orders would each see 0 committed, each be approved, and
> together commit 6 USD against a 5 USD cap.

MCP clients do issue tool calls in parallel, so this is reachable in normal use, not
a contrived scenario. The sequential aggregation path is correct and tested
(assertion 3, `wouldTotalUsd: 5.4`); it is only the concurrent path that leaks.

**The fix, specified but NOT implemented** (per the standing instruction to report
rather than chase past scope): make the check *reserve*. `checkPreOrder` becomes
`reserve()`, which on approval immediately adds the worst-case estimate to a
`reserved` bucket counted alongside `spendUsd`; the caller then either
`commitReservation(actualSpend)` or `releaseReservation()` on any refusal, revert,
or throw. In `place_order` that wants a `try/finally` around the attempt loop so no
early return can leak a reservation. Roughly 15 lines in `risk.mjs` plus a
restructure of `place_order`'s return paths.

Until then, the honest statement of the guarantee is: **the caps hold for
sequential calls and can be exceeded by concurrent ones.**

> **Update: "until then" ended — the fix above was implemented and proven. The
> current guarantee is stated in TASK 4 below.**

---

## PHASE C VERDICT

**PASS on all three tasks, with one branch unexecuted and one concurrency gap
found and reported.**

| Task | Built | Tested |
|---|---|---|
| **1** — structured revert | `send(…, {throwOnRevert:false})` + try/catch; `reverted` (retryable) vs `send_error` (not); all failure paths return machine codes in `reason`, prose in `detail` | **Partial** — 4 failure paths returned the structured shape live with no exception; the `reverted` branch itself could not be provoked in 3 attempts, though its predicate is confirmed against a real reverted receipt |
| **2** — dollar sizing | `targetDollarAmount` alongside `stake_units` (mutually exclusive), `maxSlippagePct` default 5, variance reported | **PASS** — normal case filled 2.469 units for 0.101 USD; grid rounding verified to 0.04% on a static book; slippage refusal returned `slippage_exceeded` with nothing broadcast |
| **3** — risk guardrails | `build/risk.mjs`, limits from env only and absent from the tool schema, evaluated pre-broadcast; exactly one retry on a retryable revert | **PASS** — 8/8 offline assertions incl. "caller cannot raise the limit"; live refusal at 12.76 USD vs the 5 USD cap with `txBroadcast: []`; live accounting recorded 0.101229 USD spend and 9.898771 USD remaining |

**Regression:** all 6 modules `node --check` clean; `redeemGuard` **7/7**; `redeem`
still discovers via the Finalized scan and still **BLOCKED a losing position**
(2.469 units preserved) after the payout-hook edit.

**Transactions broadcast this session (all status success):**

| Purpose | Hash |
|---|---|
| approve + order — dollar-mode normal case (`0x…8e64`) | `0x758f9a91…9f92`, `0x7a6b4531…11e5` |
| 3× concurrent race orders (`0x…8e8a`) | filled, 0.304 USD each |

### Carried forward

- ~~**Concurrency gap in the risk cap** — fix specified above. Highest-value item.~~
  **DONE — closed and proven in TASK 4 below.**
- **Dollar-target undershoot** — re-derive quantity from the placement-time price.
- **`reverted` branch** — still needs a live execution; may only appear
  opportunistically in normal operation.
- **In-memory risk state** — resets on restart; persistence deferred by instruction.
- Not started, as scoped: NL parsing, dedicated-wallet generation, trade log.

---

## TASK 4 — the concurrency gap is closed (reserve-on-check)

Picking up the item the previous entry left as "specified but NOT implemented". The
implementation had in fact been written into `risk.mjs` and `mcp-core.mjs` but was
**untested and unlogged** — the code had run ahead of the record. This entry closes
that gap: it tests what was built, reports a reporting defect found while doing so,
and states the resulting guarantee.

### What the fix does

`checkPreOrder()` now **mutates state**: on approval it reserves the worst-case
spend in the *same synchronous step* as the decision and returns a `reservationId`.
There is no `await` between deciding and holding, so nothing can interleave between
them. Both caps count open reservations:

```
windowExposure(marketId) = perMarket[marketId] + reservedForMarket(marketId)
drawdown()               = spendUsd + reservedTotal() − payoutUsd   (floored at 0)
```

The caller must then resolve the reservation exactly once, via
`commitReservation({reservationId, actualSpentUsd})` — which records the real spend
and **releases the difference** between the reserved worst case and what actually
moved — or `releaseReservation({reservationId, why})`.

### Test — 28/28 offline assertions, `build/risk-test.mjs` (new, re-runnable)

The previous entry's 8 assertions were run inline and left no artifact. They are now
a committed file, re-expressed for the reserve-on-check API and extended to 28.
`node build/risk-test.mjs`, no network, limits asserted at defaults 5/10 first
because every number depends on that.

**Group A — cap enforcement (1–10):** all 8 original assertions still pass, plus a
refused order reserves nothing (3) and `RISK_CONFIG` is not mutated by a caller's
attempt to override it (10).

**Group B — reservation lifecycle (11–28).** The one that matters:

| # | Assertion | Result |
|---|---|---|
| **13** | **three concurrent 2 USD orders against a 5 USD cap cannot all pass** | **PASS — 2 approved, 1 refused, final exposure 4 USD** |
| **14** | the refused caller saw the others' reservations, not a stale zero | **PASS — observed 4 USD held** |

Test 13 reproduces the exact interleaving that leaked: each caller runs
`checkPreOrder`, then **awaits** (as `place_order` does across allowance,
simulation and broadcast), then resolves. The observed sequence:

```
A: allow=true   saw 0 already held
B: allow=true   saw 2 already held
C: allow=false  saw 4 already held  -> max_stake_per_window_exceeded
```

Under the old check-then-act code all three read `0` and all three were approved.
That is the hole, closed and demonstrated rather than asserted.

The rest of Group B pins the lifecycle: an open reservation counts toward the cap
immediately (11–12); commit with actual < reserved releases the difference and that
capacity is genuinely reusable (15–16); a reverted placement commits 0 and records
no spend (17); explicit release frees capacity (18); the daily cap counts
reservations too, so concurrent orders cannot breach it either (24–25); and every
transition lands in an auditable ledger with the released difference recorded
(27–28).

**Two assertions deliberately record limitations rather than successes:**

- **20** — `commitReservation()` on an already-resolved reservation *does* add the
  spend again. This is intentional: money that really moved must never be silently
  dropped, so an orphaned commit is recorded with a `warning` rather than discarded.
  The cost is that a buggy double-commit double-counts. **21** proves
  `place_order`'s own `reservationResolved` flag makes commit exactly-once, which is
  what actually protects the ledger.
- **22** — a reservation that is never resolved **permanently eats capacity**: a
  leaked 4 USD reservation refuses a subsequent legitimate 2 USD order. This is the
  failure the `try/finally` backstop exists to prevent, demonstrated so the reason
  for that block is on record.

### Defect found while testing — the payload misreported released reservations

Not a state bug; a **reporting** bug, on exactly the paths where the caller most
needs the truth.

`place_order`'s refusal paths return `{ ...R, riskStatus: riskSnapshot() }`. A
`return` expression is fully evaluated **before** the `finally` block runs, and the
spread copies `R`'s values at that moment. So on a refusal that happened *after*
reserving, the backstop correctly released the reservation, but the payload the
caller received had already been built from the pre-release state. Confirmed with a
minimal repro before changing anything:

```js
try { return { ok:false, ...R }; }        // R.reservation === {resolution:'OPEN'}
finally { R.reservation = {resolution:'RELEASED_BY_BACKSTOP'}; }
// -> caller receives {resolution:'OPEN'}
```

The state was always correct — capacity was freed, so this **failed safe**. But
`riskStatus` exists precisely to tell the caller the accounting state, and on these
paths it reported phantom exposure that no order explained.

**Fix:** a `release(why)` helper mirroring `commit()`, called explicitly on every
refusal that can occur after reserving, *before* the return value is built — so the
payload and the state agree. The `finally` block stays, now narrowed to its real
job: catching a thrown error or a future early return that forgets to resolve.

Paths that now release explicitly: `allowance_failed`, `slippage_exceeded`,
`simulation_reverted`, `exhausted_attempts`, and — **only reachable on a retry**,
when attempt 1's reservation is already open — `status_gate_closed`,
`no_resting_liquidity`, `zero_quantity`. The `reverted` / `send_error` and success
paths already resolved before returning and were unaffected.

### Test — live, both resolutions, through the real tool

**RELEASED** — market `0x…990b`, `targetDollarAmount: 0.4`, `maxSlippagePct: -1`:

| Field | Value |
|---|---|
| risk check | **allowed**, reserved **0.416160 USD** as `rsv_2026-08-25_1` |
| outcome | **`ok:false, reason:'slippage_exceeded'`** |
| `reservation.resolution` | **`RELEASED`** — *before the fix this read `OPEN`* |
| `riskStatus` | `reservedUsd: 0`, `openReservations: 0`, `perMarketExposureUsd: {}` |
| transactions | **none** |

**COMMITTED** — market `0x…99ff`, `targetDollarAmount: 0.4`, default 5% slippage:

| Field | Value |
|---|---|
| reference ask | `376000` (0.376) |
| quantity | `impliedQuantityRaw 1063829` → grid **`1064000` = 1.064 units** |
| reserved worst case | **0.421344 USD** (quantity × our limit) |
| slippage | **0.0000%** — the book did not move between the two reads |
| `fillStatus` | **`FILLED`**, latency **0s**, 1.064 units |
| actual collateral | **0.400064 USD** |
| `reservation.resolution` | **`COMMITTED`** — difference **0.021280 USD released** |
| `riskStatus` | `spendUsd 0.400064`, `reservedUsd 0`, `openReservations 0`, `remainingDailyLossBudgetUsd 9.599936` |
| `dollarSizing.variancePct` | **+0.016%** |
| txs | approve `0x499af6f9…82d9`, order `0x0ab6aaf8…6d58` (both success) |

**This incidentally strengthens the earlier undershoot finding.** The previous entry
recorded a **−74.69%** variance and attributed it to quantity being fixed at the
reference price while the book moved. Here the book *didn't* move (slippage
0.0000%) and the same code hit the target to **+0.016%** — the grid rounding alone.
That is direct evidence the diagnosis was right: the undershoot is caused by book
movement between sizing and fill, **not** by the sizing arithmetic. The specified
refinement (re-derive quantity from the placement-time price) is therefore aimed at
the correct cause. Still not implemented — out of scope here.

### Regression

- All modules `node --check` clean.
- `risk-test.mjs` **28/28** after the `place_order` edits.
- `redeemGuard` **9/9** (the original 7 cases plus `isResolved`-as-settled and an
  outcome-0 winner). `redeem-guard.mjs` was not modified this session.
- A live order still fills and still commits correctly, per the table above.

### The guarantee, restated

The previous entry's honest statement was "the caps hold for sequential calls and
can be exceeded by concurrent ones." That is now replaced by:

> **The caps hold under concurrent `place_order` calls.** Exposure is reserved
> atomically with the approval decision, both caps count open reservations, and
> every exit path resolves its reservation exactly once — explicitly on all known
> paths, with a `try/finally` backstop for the unexpected.

Two honest limits remain, unchanged and by instruction:

- **State is in-memory.** A restart resets the daily counters *and drops open
  reservations*. A commit arriving after a restart finds no reservation and takes the
  orphan path — it records the real spend and returns a `warning`, which is the
  fail-safe direction (money that moved is still counted).
- **Single process only.** Reservations are held in one process's memory, so the
  guarantee covers concurrent calls into *one* server, not two servers sharing a
  wallet. Multi-process would need shared storage — the accounting shape here is
  what it would back.

---

## PHASE C VERDICT — addendum after TASK 4

| Task | Status |
|---|---|
| 1 — structured revert | **PASS on implementation**; the `reverted` branch itself is still unexecuted live (predicate confirmed against a real reverted receipt) |
| 2 — dollar sizing | **PASS** |
| 3 — risk guardrails | **PASS** |
| **4 — concurrency fix** | **PASS** — 28/28 offline including the three-way race; both reservation resolutions proven live; one reporting defect found and fixed |

**Still carried forward:**

- **Dollar-target undershoot** — re-derive quantity from the placement-time price.
  Cause now confirmed (book movement, not arithmetic).
- **`reverted` branch** — needs an opportunistic live execution.
- **Risk state persistence** — in-memory; single-process.
- Not started, as scoped: NL parsing, dedicated-wallet generation, trade log,
  momentum-ladder mode.

---
