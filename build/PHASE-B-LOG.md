# AgentRail — PHASE B LOG (MCP server)

Live, append-only record of Phase B: wrapping the proven Phase A path in four MCP
tools. Written incrementally, one entry per step.

Session start: 2026-08-25. Timebox: 60 minutes.

**Nothing here is an investigation.** Every tool wraps a script in `build/` that
already has a live testnet proof behind it in `research/PROOF-LOG.md`. Where a
behaviour is not already proven, it is refused by the tool rather than attempted.

## Scope, fixed at session start

| In scope | Out of scope (deferred, NOT touched) |
|---|---|
| Single-sided **YES**-direction bets | NO-side fills (closed — two non-fill phenomena logged, cause undetermined) |
| **300s** windows only | 60s windows (empty books in every sample) and all other intervals |
| Self path `placeBinaryOrder` (`0x718c2d4d`) | Delegated `placeBinaryOrderFor` / operator-registry path (closed) |
| Redeem via `Finalized`-status scan + hard guard | Refund mechanism for expired unfilled orders (closed — works, cause not root-caused) |

Also explicitly not in this session: NL parsing, risk guardrails (max stake /
daily loss), dedicated-wallet generation.

## Ground truth carried in from Phase A (NOT re-verified)

- Self path `placeBinaryOrder` (`0x718c2d4d`) clears the `OnlyApprovedContracts()`
  gate; the delegated path does not.
- Fills execute at the **maker's** price, not the taker's limit.
- A losing redeem does **not** revert — it burns the position and pays zero.
  Client-side `redeemGuard` is the only protection and must fail closed.
- ERC20 allowance is **per-pool** and recurs per window; the ERC6909
  `setOperator` grant is **token-wide** and does not recur.
- `listBinaryMarkets({status:"Finalized"})` is disjoint from default discovery —
  default discovery silently reports nothing owed.
- Proven end to end: fund → gate → snap → place → settle → discover → guard →
  redeem → paid (+1.000000 tUSDC, redeem tx `0x9d97aeed…4366`).

---

## STEP 0 — Context read and reuse inventory (prerequisite, not a proof step)

**What I did:** Read `research/AgentRail-Build-Spec.md` in full and
`research/PROOF-LOG.md` in full (all entries through RUN 3 / PART 4). Inventoried
`build/`. Read in full: `build/part3-win-proof.mjs` (the proven end-to-end
winning path), `build/redeem-guard.mjs` (the shipped guard), and the STEP 5 /
5b / 6 sections of `build/phase-a-lifecycle.mjs` (Finalized discovery, ERC6909
operator grant, guarded redeem).

**Reuse decisions — what each tool wraps, and the exact source it is lifted from:**

| Tool | Wraps | Source of truth |
|---|---|---|
| `list_markets` | `pickYesMarket()` filter chain + status gate | `part3-win-proof.mjs:98-120`, `:139-143` |
| `place_order` | tick snap → per-pool approve → sim → place → balance-delta fill check | `part3-win-proof.mjs:146-182` |
| `get_position` | ERC6909 `balanceOf` per token id + `getMarketOnchain` | `part3-win-proof.mjs:71`, `phase-a-lifecycle.mjs:268` |
| `redeem` | `Finalized` scan → ERC6909 `setOperator` (read first) → `redeemGuard` → broadcast → balance delta | `phase-a-lifecycle.mjs:253-330`, `part3-win-proof.mjs:199-244` |

**Tick-snap reuse — how "don't rewrite it" was honoured.** `exactToRaw` /
`snapPriceToTick` / `isOnTick` existed as **byte-identical inline copies** in both
`phase-a-lifecycle.mjs:147-162` and `part3-win-proof.mjs:74-89` (verified
identical, not merely similar). Rather than write a third copy for the MCP layer,
I extracted the three functions **verbatim** into `build/tick-snap.mjs` and had
both callers and the MCP layer import it — the same refactor pattern Part 3
applied to `redeemGuard`, and for the same reason: three copies cannot be kept
from drifting. The function bodies are unchanged character-for-character.

**Environment:** Node v24.16.0. `@modelcontextprotocol/sdk` installed this
session (43 packages, 0 vulnerabilities). Signing key `AGENTRAIL_OWNER_KEY`
present in `.env`, owner `0x291411D322ECBd4E9b86F05077c0931586142990` — the same
funded testnet owner used in Phase A runs 1-3.

**One adaptation, stated because it is a real change and not a pure wrap:** the
Phase A scripts read `research/onchain-proof/error-selectors.json` by a
**cwd-relative** path. An MCP server is launched by its client with an arbitrary
working directory, so that path is resolved relative to the module file
(`import.meta.url`) instead. Same file, same contents; resolution only.

**Result:** PASS (context loaded, all four tools mapped to proven source).

---

## STEP 1 — Extract the tick-snap logic instead of rewriting it

**Result: PASS.** Refactor only. No new price logic was written, and the four
tick values proven live in Phase A all reproduce through the extracted module.

**Precision on the "byte-identical" claim.** The two inline copies
(`phase-a-lifecycle.mjs:147-162`, `part3-win-proof.mjs:74-89`) diff to **exactly
one line**, and only in a trailing comment:

```
< function exactToRaw(value, decimals) {              // float-free decimal -> raw
> function exactToRaw(value, decimals) {
```

With comments stripped the two blocks are **identical**. So: code
character-for-character identical, one comment present in one copy and not the
other. `build/tick-snap.mjs` preserves that comment, making the extracted module
an exact match for the `phase-a-lifecycle.mjs` original.

**What changed.** `exactToRaw` / `snapPriceToTick` / `isOnTick` now live in
`build/tick-snap.mjs`. Both proven scripts had their inline block deleted and now
`import { exactToRaw, snapPriceToTick, isOnTick } from './tick-snap.mjs'`. The MCP
layer imports the same module. Three copies became one, so the "single source of
truth" claim is literally true rather than aspirational.

Both proven scripts were modified, which is worth stating plainly: they are
historical proof artifacts whose results are already saved
(`PHASE-A-RESULT.json`, `PART3-RESULT.json`), so the edit cannot retroactively
affect any recorded proof. It was done anyway because leaving them unrepointed
would have left three drifting copies while claiming one.

**Verification 1 — all four modules still parse:** `node --check` OK on
`tick-snap.mjs`, `redeem-guard.mjs`, `part3-win-proof.mjs`,
`phase-a-lifecycle.mjs`.

**Verification 2 — the extracted module reproduces every tick value that was
proven on-chain in Phase A** (tickSize 1000, 6 decimals):

| Source | Input | Expected | Got | On-tick |
|---|---|---|---|---|
| PART 3 attempt 2 (the win) ETH | bestAsk 614000 +20 ticks | `634000` | **`634000`** | yes |
| PART 3 attempt 1 BTC | bestAsk 364000 +20 ticks | `384000` | **`384000`** | yes |
| RUN 2 YES leg | bestAsk 277000 +500 ticks | `777000` | **`777000`** | yes |
| RUN 2 NO leg (cap behaviour) | 1250000 (over `ONE`) | `999000` = `ONE − tick` | **`999000`** | yes |

**4/4 reproduce.** The `ONE − tickSize` ceiling that run 2 hit is preserved
exactly, so the snapper's expressible-price limit is unchanged.

---

## STEP 2 — Files built

**Result: PASS.** Four files, ~640 lines total. All `node --check` clean.

| File | Role |
|---|---|
| `build/tick-snap.mjs` | Extracted tick math (STEP 1). Imported by both proven scripts **and** the MCP layer. |
| `build/mcp-core.mjs` | The four tools as plain async functions. All chain logic lives here. |
| `build/mcp-server.mjs` | MCP stdio server. Schema declaration + serialisation **only** — no logic. |
| `build/mcp-test.mjs` | Test harness. Two modes: direct in-process call, and a real MCP protocol round-trip. |

**Design decision — why the tools are plain functions with a thin server on top.**
`mcp-server.mjs` contains no chain code at all; it registers schemas and
serialises results. That keeps every tool callable and testable without a
transport (`node build/mcp-test.mjs <tool> '<args>'`), while the same functions
are what the MCP client reaches. The harness's `--mcp` mode drives the actual
server over stdio with a real MCP `Client`, so the wiring is tested too and not
just the functions underneath it.

**Scope fences are enforced in code, not documented in prose.** `place_order`
refuses `direction: "NO"` and any `window_seconds !== 300`, and returns the
reason plus the PROOF-LOG citation rather than attempting the call. This is the
deferred-items instruction expressed as a runtime refusal:

```
direction=NO is out of proven scope. Only YES is supported. A BUY_NO has never
filled at any expressible price across two runs (0.58 and 0.999, byte-identical
gas), and the cause is undetermined — logged, not root-caused.
```

Refusals return `ok:false, refused:true` and are distinguished from errors, so a
calling agent can tell "unsupported by design" from "something broke."

---

## STEP 3 — MCP transport works

**Result: PASS.** `node build/mcp-test.mjs --mcp --list` connected a real MCP
`Client` to `build/mcp-server.mjs` over stdio; the server advertises **4 tools**
with the expected schemas and `required` fields (`place_order` → `market_id`,
`get_position` → `market_id`, the other two fully optional). Every test below was
run through this transport, not by calling the functions directly, so each result
also exercises registration and serialisation.

---

## STEP 4 — Tool 1 `list_markets`: PASS

Two invocations, and the first one is worth keeping because it exposed a real
operational edge rather than a bug.

**Invocation 1 — `tradeable: 0`.** 12 live markets seen, 10 skipped for wrong
interval, **2 skipped as `outsideTimeWindow`**. Those two were the 300s BTC and
ETH markets. A direct probe of the live listing explained it:

| intervalSec | T (s) | assets |
|---|---|---|
| 60 | 29 | BTC, ETH |
| **300** | **269** | **BTC, ETH** |
| 900 | 869 | BTC, ETH |
| 3600 | 3569 | BTC, ETH |
| 14400 | 7169 | BTC, ETH |
| 86400 | 79169 | BTC, ETH |

**Finding, logged because it affects any polling caller: the BTC and ETH 300s
windows roll in lockstep** — identical `T` on every sample. So the default
eligibility band (25–290s of a 300s window) is dead for ~35s of every 300s cycle,
and during that gap `list_markets` correctly returns zero for *both* assets
simultaneously rather than one at a time. Not a failure — the filter behaved as
specified — but a caller must treat an empty result as "retry in ~10s," not
"no liquidity." Also visible here: six intervals exist live (60/300/900/3600/
14400/86400); only 300 is in proven scope, and the other 10 markets were
correctly refused.

**Invocation 2 — `tradeable: 1`.** Same 12 live markets, at T-246:

| Field | Value |
|---|---|
| marketId | `0x…8d05` BTC, `intervalSec` 300 |
| pool | `0x4da0c6bc534460102c98b2774c00ca807e5ae18c` |
| **status gate** | `onchainStatus: 1` → **OPEN** |
| **real resting yesAsks depth** | **990 units** — the same figure as both PART 3 attempts |
| best yesAsk | `497000` (p=0.497) |
| skipped | 10 wrong interval, **1 noYesDepth** (the ETH 300s market) |

The depth filter did real work: ETH's 300s market was live and status-open but had
zero resting `yesAsks`, and was dropped. Depth is one order-book read per
candidate — cheap, so it is checked rather than assumed, per the tool spec.

---

## STEP 5 — Tool 2 `place_order`: PASS mechanically, and it caught a fill subtlety

**Result: PASS on every stage, with one real defect found in my own fill check and
fixed. Reported in full because the fix came after the first live test.**

Placed into `0x…8d05` (the market from STEP 4), `stake_units: 1.0`, `cross_ticks: 20`.

| Stage | Result |
|---|---|
| status gate | `status=1` → OPEN, checked immediately before the write |
| book re-read at placement | best yesAsk **`212000`** — moved from `497000` ~30s earlier, so re-reading at placement time (not trusting the `list_markets` snapshot) mattered |
| **tick snap** (shared module) | `212000 + 20×1000` → **`232000`**, `onTick: true`, ceiling not hit |
| path | selector **`0x718c2d4d`** = self `placeBinaryOrder`, 292-byte calldata |
| per-pool ERC20 allowance | auto-detected via `0xfb8f41b2`, spender = the pool, approved: tx `0xf4e365fb…5430` (gas 259,745) |
| simulation | NO REVERT |
| order tx | **`0xf8ce822d3408a73fe17910c90fbbad5cc5cbe6710a90f741e161c824fde152fd`** success, block 470504138, gas 2,882,718, 4 logs |
| fill check at receipt | ERC6909 `0 → 0`, collateral **−0.232** → reported **`filled: false`** |

**The tool's headline behaviour was correct and is the point of the whole
balance-delta discipline: the transaction returned `status: success` and the tool
still reported `filled: false`.** A caller trusting tx status would have recorded
a fill that had not happened.

**But `filled: false` turned out not to be the durable answer.** `get_position` on
the same market ~40s later read **`yesBalanceRaw: 1000000`** — 1.0 unit held. The
order had rested and then filled. The collateral figure identifies which side we
were on: **−0.232, exactly our own limit price**, not the `0.212` ask. Phase A
proved fills execute at the *maker's* price, so paying our own limit means we
rested and someone crossed *us* — we were the maker, not the taker.

**Fix applied (and flagged as a deviation from a pure wrap):** if the
post-receipt read shows no fill, `place_order` now re-reads once after 8s and
reports both observations — `filledAtReceipt`, `recheck`, and a `durability` note
pointing the caller at `get_position` for the authoritative holding. This makes
the existing balance-delta check reliable rather than introducing a new
mechanism; no timing assumption is baked into the headline `filled` value beyond
"either read showed an increase."

**Deliberately NOT investigated:** why a 20-tick crossing bid against 990 units of
resting depth rests instead of taking. That is the open non-fill phenomenon
(PART 3 attempt 1, gas 3,280,841 vs this run's 2,882,718 — both expensive
non-fills, same signature) and it is closed for this session. Logged, not chased.

---

## STEP 6 — Tool 3 `get_position`: PASS, in both market states

Tested on `0x…8d05` twice, before and after settlement — so both status branches
are exercised:

| | While Trading | After settlement |
|---|---|---|
| `status.label` | **`Trading`** | **`Finalized`** |
| `onchainStatus` | `1` | — |
| `tradingGateOpen` | `true` | `false` |
| `settled` | `false` | `true` |
| `winningOutcome` | **`null`, withheld** | `1` |
| `yesBalanceRaw` / units | `1000000` / `1` | `1000000` / `1` |
| `noBalanceRaw` | `0` | `0` |
| `hasPosition` | `true` | `true` |
| collateral | `9999.596` | `9999.596` |

**The pre-settlement `winningOutcome` trap is handled, not merely documented.**
`getMarketOnchain` returns `winningOutcome: 0` before settlement as a default,
which reads as "YES won." Rather than pass that through, the tool returns `null`
plus an explicit note while `settled` is false. An agent reading this tool cannot
be misled into thinking YES won a market that has not resolved.

---

## STEP 7 — `place_order` fill-check fix re-validated live

**Result: PASS.** The STEP 5 fix was applied *after* its first live test, so it was
re-run against a fresh 300s window (`0x…8d15` BTC, T-50, best ask 0.284, 990 units
depth) to confirm the recheck path actually fires:

| Field | Value |
|---|---|
| tick snap | `284000 + 20×1000` → **`318000`**, on-tick |
| order tx | `0x6a2f8cb865b6571ef5ee21648e89d0704de5f23c1247804c61b5f4190edaeca9` success, gas 3,482,718 |
| **`filledAtReceipt`** | **`false`** — the receipt-time read again saw nothing |
| **`recheck`** | **`{afterMs: 8000, erc6909: "1000000", changed: true}`** |
| **`filled`** (headline) | **`true`**, 1.0 unit |
| collateralSpent | **0.318** — our own limit price again, i.e. maker fill, consistent with STEP 5 |

The recheck caught a fill the receipt-time read missed, in exactly the pattern
STEP 5 diagnosed. Two independent observations now show the same thing: on this
venue a `BUY_YES` at a crossing price **rests and is then taken**, debiting our
limit rather than the ask. The tool reports that correctly instead of reporting a
false negative.

---

## STEP 8 — Tool 4 `redeem`: PASS, and BOTH guard paths proven live

**Result: PASS. This is the strongest result of the session — it closes a gap
Phase A left open.** PROOF-LOG PART 3 recorded the guard's **BLOCK path as "NOT
exercised live"** (attempt 1 didn't fill, attempt 2 won outright). Both paths are
now exercised on-chain, through the MCP tool.

### 8a — BLOCK on a real losing position (market `0x…8d05`)

The position from STEP 5 settled against us. Run **twice** — once with
`dry_run: true`, once for real — because a refusal that only happens under
`dry_run` would prove nothing:

| | |
|---|---|
| discovery | `listBinaryMarkets({status:"Finalized"})`, **100 finalized markets scanned**, our position found |
| ERC6909 operator | `isOperatorBefore: true` → **ALREADY GRANTED, redundant broadcast SKIPPED** (read first, not assumed) |
| guard `winOnchain` / `winIndexed` | `1` / `1` — sources agree, so condition 3 passed and condition 4 did the blocking |
| **guard verdict** | **`allow: false` — "LOSER — outcomeIdx=0 !== winningOutcome=1; broadcasting would BURN 1000000 tokens for ZERO payout"** |
| `broadcast` | **`false`** |
| **`tx`** | **`{}` — empty. Nothing was broadcast on the real (non-dry) run either.** |
| post-check via `get_position` | `yesBalanceRaw: 1000000` **unchanged**, collateral unchanged |

The refusal is structural, not a `dry_run` artifact: in the code the guard runs
*before* the `dry_run` branch, so a BLOCK short-circuits both modes identically.
Verified by the real run producing an empty `tx` map and an intact balance.

**This is precisely the burn that run 2 suffered** (tx `0x643c7a22…352b`: status
`success`, 1000000 → 0, payout 0). Through the MCP tool it did not happen — the
losing position is still sitting in the wallet, preserved.

### 8b — ALLOW on a real winning position, with a non-zero payout (market `0x…8d15`)

The position from STEP 7 settled in our favour:

| | |
|---|---|
| **guard verdict** | **`allow: true` — "WINNER — outcomeIdx=0 === on-chain winningOutcome=0"**, `winOnchain: 0`, `winIndexed: 0`, `settledOnchain: true` |
| redeem simulation | NO REVERT |
| **redeem tx** | **`0x1240d9b4006a70c3930f9de6fdb8b49d3f4b53d610ff252676b4a3156ccaf97f`** |
| **tUSDC balance** | `9999.278` → **`10000.278`** |
| **payout** | **`+1.000000`, `nonZero: true`** |
| ERC6909 | `1000000` → **`0`** (burned, as it should be for a winner) |
| summary | `redeemedCount: 1, blockedCount: 0, totalPayoutUnits: "1.000000"` |

Bought the winning side at **0.318**, redeemed for **1.000** → **+0.682 net on the
trade.** Confirmed by balance delta, not by transaction status — the same standard
the research phase held throughout.

### Session collateral reconciliation — exact, nothing unaccounted

| Movement | Amount | Balance |
|---|---|---|
| session start | — | `9999.828` |
| `0x…8d05` order (filled at our limit, maker) | −0.232 | `9999.596` |
| `0x…8d15` order (filled at our limit, maker) | −0.318 | `9999.278` |
| `0x…8d15` redeem payout | **+1.000** | **`10000.278`** |
| **net** | **+0.450** | |

−0.232 − 0.318 + 1.000 = **+0.450 exactly.** No stuck or unexplained collateral.
The `0x…8d05` losing position (1.0 YES token) is **still held, not burned** — the
guard's entire purpose, visible in the ledger.

---

## PHASE B VERDICT

**PASS. Four MCP tools built as thin wrappers over the proven Phase A path, each
tested once against Somnia Shannon testnet through the real MCP stdio protocol.**

| Tool | Tested | Result |
|---|---|---|
| `list_markets` | 2× | **PASS** — status gate + 300s filter + real yesAsks depth; correctly returned 1 of 12 live markets, dropping 10 wrong-interval and 1 zero-depth |
| `place_order` | 2× (live tx) | **PASS** — gate → tick snap → per-pool approve → sim → broadcast → fill by balance delta. Found and fixed a receipt-time-read defect; refix re-validated live |
| `get_position` | 2× | **PASS** — correct in both `Trading` and `Finalized`; withholds the pre-settlement `winningOutcome` default |
| `redeem` | 3× (live tx) | **PASS** — Finalized-scan discovery, ERC6909 grant read-first, **BLOCK proven live** (position preserved) **and ALLOW proven live** (+1.000000 payout) |

**Transactions broadcast this session (all status success):**

| Label | Hash |
|---|---|
| `approve` (pool `0x4da0c6bc…e18c`) | `0xf4e365fbcd46500b2d91f812b34acd915cc7eb14547546b1a9aa41a810825430` |
| `placeBinaryOrder_BUY_YES` (`0x…8d05`) | `0xf8ce822d3408a73fe17910c90fbbad5cc5cbe6710a90f741e161c824fde152fd` |
| `approve` (pool for `0x…8d15`) | `0xccac56cc9942324e3a8a2fa46dc6dbc5c61eed885cc342dfec087c346986cbef` |
| `placeBinaryOrder_BUY_YES` (`0x…8d15`) | `0x6a2f8cb865b6571ef5ee21648e89d0704de5f23c1247804c61b5f4190edaeca9` |
| **`redeem` WINNER (`0x…8d15`)** | **`0x1240d9b4006a70c3930f9de6fdb8b49d3f4b53d610ff252676b4a3156ccaf97f`** |

`setOperator` was correctly **not** broadcast (already granted, token-wide).
No transaction was broadcast for the blocked losing redeem.

### What this session did NOT do — stated so it is not mistaken for covered

- **No NL parsing, no risk guardrails (max stake / daily loss), no
  dedicated-wallet generation.** Out of scope by instruction; next session.
- **Nothing was added for the deferred items, and none were touched:** the
  delegated operator-registry path, the NO-side fill mechanism, and the
  expired-order refund mechanism remain closed. `place_order` *refuses* NO rather
  than attempting it.
- **The two non-fill phenomena were not investigated.** Two more expensive
  receipt-time non-fills were observed here (gas 2,882,718 and 3,482,718) that
  both later filled as maker. Logged as a data point that the earlier "non-fill"
  observations may partly be *deferred* fills; deliberately not chased.
- **`stake_units` is outcome-token quantity, not a cash stake.** Converting a
  dollar stake to quantity would require assuming a fill price, which is new
  logic; the tool reports actual `collateralSpent` instead. Worth revisiting when
  NL parsing lands, since a user will say "$10".
- **Only one asset/interval combination was exercised** (BTC and ETH 300s). 900s /
  1h / 4h / 24h windows exist live and are refused, not tested.
- **Timing latency for the fill recheck is fixed at 8s**, chosen from two
  observations. Not a characterised distribution.

---

## STEP 9 — Final regression sweep

**Result: PASS.** Run after all edits, because STEP 1 modified two shared modules
that the proven scripts depend on.

| Check | Result |
|---|---|
| `redeemGuard` unit tests (the 7 cases from PART 1) | **7/7 PASS** — behaviour unchanged by the tick-snap extraction |
| Blocked losing position still held | `yesBalanceRaw: 1000000`, `label: Finalized` — **preserved, not burned** |
| Final collateral | **`10000.278`** — matches the reconciliation above exactly |
| `node --check` on all 7 modules | **OK** — `tick-snap`, `redeem-guard`, `mcp-core`, `mcp-server`, `mcp-test`, `part3-win-proof`, `phase-a-lifecycle` |

The guard's 7/7 is re-run rather than assumed because the refactor touched files
`part3-win-proof.mjs` and `phase-a-lifecycle.mjs` import. Nothing regressed.

## How to run

```bash
# MCP server (stdio) — point an MCP client at this
AGENTRAIL_OWNER_KEY=0x… node build/mcp-server.mjs

# test harness — real MCP protocol round-trip
node build/mcp-test.mjs --mcp --list
node build/mcp-test.mjs --mcp list_markets '{}'
node build/mcp-test.mjs --mcp place_order  '{"market_id":"0x…","stake_units":1.0}'
node build/mcp-test.mjs --mcp get_position '{"market_id":"0x…"}'
node build/mcp-test.mjs --mcp redeem       '{"dry_run":true}'

# same tools, direct in-process call (no transport)
node build/mcp-test.mjs list_markets '{}'
```

---

## STEP 10 — `place_order` fill resolution: one-shot recheck → bounded poll

**Result: PASS.** Targeted fix, not an investigation. The 8s one-shot recheck from
STEP 5 is replaced with a bounded poll, and — the substantive change — the tool no
longer collapses "still resolving" into "did not fill". Both the `FILLED`-at-receipt
and the `PENDING`-at-timeout branches are proven live below.

### Why the boolean was wrong

STEP 5/7 established that an order which rests is often taken seconds later, with
us as maker. A one-shot 8s recheck returning `filled: false` therefore reported two
genuinely different facts identically:

- the order is **still resolving** and may yet fill, versus
- the order **did not fill** and never will.

A caller cannot act correctly on those with one boolean. A Phase C guardrail that
reads "didn't fill" and re-places would **double the position** if the first order
was merely pending.

### What it does now

Poll the same ERC6909 read `get_position` uses, **every 5s for up to 60s**, entered
only when a receipt shows `status: success` with no balance increase. Three
terminal states:

| `fillStatus` | `filled` | Meaning |
|---|---|---|
| **`FILLED`** | `true` | Confirmed by ERC6909 increase. `fill.resolution` carries the observed latency. |
| **`PENDING`** | **`null`** — deliberately not `false` | Accepted and resting, unresolved at the 60s deadline. **May still fill.** Payload carries an explicit instruction to recheck via `get_position`. |
| **`NOT_FILLED`** | `false` | **Terminal** — the window expired with the order unfilled. |

Two details worth recording:

- **The poll stops early at expiry.** An order cannot fill after the window closes,
  so hitting expiry breaks the loop and returns `NOT_FILLED` rather than polling on
  and mislabelling a terminal state as `PENDING`. `poll.stoppedReason` records
  which of `filled` / `expiry` / `timeout` ended it.
- **Reported latency is an upper bound**, stated in the payload: at 5s granularity
  the fill landed somewhere in the 5s before the observing poll. Measured from
  receipt confirmation. `poll.observations` carries every timestamped read, so the
  raw series is inspectable rather than only the summary.

### Observed resolution latency — the number Phase C needs

Three live placements on fresh 300s windows, all through the MCP transport:

| # | Market | Best ask → snapped bid | `fillStatus` | **Latency observed** | Poll entered? |
|---|---|---|---|---|---|
| 1 | `0x…8d61` BTC | `497000` → `517000` | `FILLED` | **0s** (`resolvedAt: receipt`) | no |
| 2 | `0x…8d6e` ETH | `561000` → `581000` | `FILLED` | **0s** (`resolvedAt: receipt`) | no |
| 3 | `0x…8d62` ETH | — | **tx REVERTED** | n/a | n/a |

**Latency result: 0s on every fill observed this session — all three successful
placements filled by the time of the first post-receipt read.** Contrast with
STEPS 5 and 7, where the same order type on the same market class rested and
resolved only later (~8s and ~40s). So the distribution is **bimodal**: immediate
fills and deferred fills both occur, which is precisely why a single point-in-time
read was never a safe basis for a boolean.

**Phase C timing implication, stated as the evidence supports it:** the observed
set is {0s, 0s, ~8s, ~40s} across four fills, n=4, single session. That is enough
to justify the 60s ceiling as comfortably above anything seen, and enough to rule
out "fills are always immediate" — but it is **not a characterised distribution**,
and the 5s interval / 60s bound are engineering choices, not fitted parameters. A
guardrail should treat `PENDING` as a real state to wait on rather than assume a
latency figure.

### `PENDING` branch — PROVEN LIVE (forced-rest test)

The first forced-rest attempt was killed by a harness timeout mid-poll. Re-run
without one, it completed and produced the payload. Market `0x…8d79` BTC, T-148,
best ask 0.411, bid deliberately placed **200 ticks below** at `259000` (0.259) so
the order could not take:

| Field | Value |
|---|---|
| `fillStatus` | **`PENDING`** |
| **`filled`** | **`null`** — not `false`, exactly as intended |
| `filledAtReceipt` | `false` |
| `poll.count` / `stoppedReason` | **11 polls** / **`timeout`** |
| poll cadence observed | 5.8, 11.3, 16.6, 22.1, 27.5, 32.9, 38.3, 43.8, 49.2, 54.7, **60.2**s — clean ~5.4s spacing, terminated just past the 60s bound |
| collateral | `9998.792 → 9998.533` = **−0.259 locked at our own resting bid**, refundable at expiry (PART 4) |
| `pending` note | present, naming `get_position` as authoritative and warning against reading it as a non-fill |

The poll ran its full budget without a false positive, stopped at the bound rather
than overrunning, and returned the unresolved state as unresolved. **This is the
branch the whole step exists to add, and it now has a live payload behind it.**

### Branch status — final

| Branch | Proven live |
|---|---|
| `FILLED` at receipt | **yes** — 2 placements, latency **0s** |
| **`PENDING`** at 60s timeout | **yes** — 11 polls, `filled: null`, forced-rest test on `0x…8d79` |
| `FILLED` via poll | **no** — no deferred fill occurred while the new code was running (STEPS 5/7 observed the phenomenon under the old one-shot code: ~8s and ~40s) |
| `NOT_FILLED` at expiry | **no** — would require holding a resting order past expiry |

Three of the four paths through the new code are exercised; the two unexercised
ones are the same straight-line comparison on a later observation, and are noted
rather than claimed.

### Unplanned finding — a broadcast reverted after a clean simulation

Attempt 3 (`0x…8d62` ETH, T-178): `eth_call` simulation returned NO REVERT, then
the broadcast tx `0x71b63ff7fdcd6c41ca8d095624aa96dcea78221f7fe7ea0acf70518fb814af0f`
came back with a **failure receipt**. Replaying that exact calldata via `eth_call`
at its own block returns **success**, not a revert
(`0x…01, 0x…07, 0x…177e`) — so the failure is state-dependent and does not
reproduce post-block. Consistent with the resting liquidity being consumed by a
competing fill in the same block, but **not investigated** — logged and left.

**Two consequences worth acting on later, neither fixed here (out of scope for a
recheck→poll swap):**

1. **`place_order` throws rather than returning a structured refusal when a
   broadcast reverts.** `send()` raises and the exception propagates. Over MCP it
   is caught and surfaced as `isError: true`, so a client sees an error — but a
   direct caller gets an exception instead of `{ok:false, ...}`, inconsistent with
   every other failure path in the tool.
2. **A clean simulation is not a guarantee of inclusion.** Phase C
   auto-continuation logic must treat a reverted placement as a normal outcome,
   not an exceptional one.

### Collateral position at end of STEP 10

`9998.533`. Two resting unfilled orders from the forced-rest tests (−0.440 and
−0.259) are locked at their own bid prices and refund automatically at expiry
(PART 4, proven). One winning position from the first test is held and
unredeemed. Nothing is stuck; nothing requires action.


