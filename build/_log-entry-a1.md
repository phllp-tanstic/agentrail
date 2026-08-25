
# ============================================================================
# BUILD SESSION — 2026-08-24. PHASE A: full lifecycle, REAL broadcasts.
# ============================================================================

Signing key: `AGENTRAIL_OWNER_KEY` read from `.env` via `node --env-file`. Never
printed, never logged, never written to any artifact. Only the derived public
address appears below.

**Owner / dedicated-wallet address: `0x291411D322ECBd4E9b86F05077c0931586142990`**
Network: Somnia Shannon **testnet**, chainId 50312, RPC
`https://api.infra.testnet.somnia.network`, indexer `https://dev.smk.somnia.host/v1/graphql`.

Plan per the corrected architecture: **per-user dedicated wallet on the SELF
call path (`placeBinaryOrder`, `0x718c2d4d`)**. The delegated
operator-registry path is closed (STEP 2b–2e) and was not re-investigated.

**Doc discrepancy noted as an aside, not chased:** `research/AgentRail-Build-Spec.md`
on disk is timestamped 04:17, i.e. *before* the 05:13–06:00 STEP 2c/2d/2e
findings. Its §3/§6 still lead with the delegated `0x5d97c566` path and still
describe `OnlyApprovedContracts()` as "the operator-authorization gate." The
file was **not** corrected. This session followed the corrected plan as given in
the instructions (self path + dedicated wallet), which matches STEP 2e's
confirmed fallback. Flagged so the stale doc is not later mistaken for ground truth.

---

## PHASE A — RUN 1

**Result: steps 1-5 PASS with real on-chain transactions. Step 6 (redeem) FAILED
on a missing prerequisite that this run identified precisely.** Script:
`build/phase-a-lifecycle.mjs`, one continuous run, no manual steps between
stages. Machine output: `build/PHASE-A-RESULT.json`. Total wall clock 44.0s.

### Prerequisites the run had to solve first (both were real, both are now closed)

1. **Collateral was zero.** The funded wallet held 1 SOMI (gas) and **0 tUSDC**.
   `TestUSDC` (`0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, 6 dec) *is*
   source-verified on Blockscout v2 and exposes `faucet(uint256)`
   (`0x57915897`) with `FAUCET_PER_TX() = 10000`. Ten common mint/faucet
   selectors were probed by `eth_call`; only `faucet(uint256)` did not revert.
   - **tx `faucet` — `0x22eca75165dbbc61483c7e9dd4f463b9d3acd49b94cac754ee15ff665af964c5`**
     status success, block 469932233 -> balance 0 -> **10000 tUSDC**.
2. **ERC20 allowance, and the spender is the POOL, not a fixed router.** The
   pre-approval simulation reverted
   `0xfb8f41b2 = ERC20InsufficientAllowance(address=0x6a2ce98f392eda26c68e9762fc3632dd32d034b7, 0, 459000)`
   — the revert *names its own spender*, and it is the per-window pool address.
   So allowance is **per-pool**, i.e. one approval per window, which is an
   onboarding cost that must be designed for (it is not a one-time setup).
   - **tx `approve` — `0x8a606d0c866552e08e3f4a2364f79f71686f1cd005cd86134947778c13b0c7c8`**
     status success, block 469932288. Post-approval simulation: **NO REVERT, clean.**

### STEP 1 — status gate on a live binary market: **PASS**

Selected `0x...8373` BTC, **interval 60s**, pool
`0x6a2ce98f392eda26c68e9762fc3632dd32d034b7`, at T-36s, chosen as the shortest
window carrying two-sided book depth. `operatorId=4`,
`venueId=0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f`.

`getMarketOnchain(marketId)` -> `{status: 1, finalized: false, isResolved: false}`.
Gate `status === 1` -> **OPEN**, order proceeded. (Note: on-chain `status` is a
**number** here, `1`; the indexer market object reports the string
`"Trading"`. Both forms must be accepted by the gate.)

### STEP 2 — integer tick snapping: **PASS**

Pool book params: `tickSize=1000 lotSize=1000 minQuantity=1000`, 6 decimals.
Prices snapped by crossing the best ask by 5 ticks:

| Side | best ask | snapped crossing bid | on-tick |
|---|---|---|---|
| YES | 454000 | **459000** (p=0.459) | true |
| NO | 575000 | **580000** (p=0.58) | true |

Negative control carried in the same run, to show the snapper is doing real
work rather than passing trivially: the naive 18-decimal path on the same
probability yields **`459000000000000019`**, `onTick(1e15) = false` — the
mainnet bug, reproduced inline. Testnet 6 decimals cannot expose it; the
snapper is what makes the mainnet path correct.

### STEP 3 — REAL order via `placeBinaryOrder` (SELF path): **PASS, filled**

Selector emitted **`0x718c2d4d`**, calldata **292 bytes** (= 4 + 9x32) — both
match ground truth exactly. `qty=1000000` (1.0 unit), `expireTimestampNs`
pinned to market expiry (`1787566140000000000`) to avoid
`OrderExpiryBeyondMarket()`.

- **tx `placeBinaryOrder_BUY_YES` — `0x12a0edbcde00ee934990cc3906ad50eb780535b58c9f21c8e3a6003a32ab2692`**
  status **success**, block 469932317, gas 828612, **8 logs**.
- **tx `placeBinaryOrder_BUY_NO` — `0xb6812575a71e719041feb64c3b47808dd11e2c6586b8b12e52029d417b493e19`**
  status success, block 469932354, gas 281962, 4 logs.

**Fill confirmed by balance delta, not by log-guessing:** ERC6909
(`0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9`) balance of `yesTokenId` went
**0 -> 1000000**, and collateral went **10000 -> 9999.266 tUSDC** (-0.734). The
owner's own wallet paid, and the outcome tokens landed in the owner's own
wallet — the custody claim, observed directly.

**The BUY_NO leg did NOT fill** (`no6909` stayed 0; 4 logs and 281962 gas vs.
828612 for the filled leg — it rested as a maker order). It was placed only as
insurance so that one held side would be guaranteed a winner. That insurance
therefore did not take effect, and it is the direct cause of the step-6 outcome
below.

### STEP 4 — settlement: **PASS**

Waited ~24s to the expiry timestamp, then polled. Finalization was effectively
immediate on the first poll: `{status: 4, finalized: true, isResolved: true,
winningOutcome: 1}`. So a 60s testnet window settles fast enough to demo live.
**`winningOutcome = 1` (NO won) — the held YES position was the LOSER.**

### STEP 5 — discovery via `listBinaryMarkets({status:"Finalized"})`: **PASS**

| Check | Result |
|---|---|
| our market in `listLiveBinaryMarkets()` (default discovery) | **false** |
| our market in `listBinaryMarkets({status:"Finalized"})` | **true** (of 100 returned) |

`payoutNumerators = ["0", "10000000"]`, `payoutDenominator = "10000000"`,
`voided = false`. This is the §3 Trap-1 claim reproduced live against a position
we actually own: the settled market is invisible to default discovery and only
the Finalized-status scan finds it. A redeem bot on default discovery would
have reported nothing owed.

### STEP 6 — REAL redeem: **FAIL — blocked, cause identified**

`redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx,
uint256 amount)` on the binary module, encoded from `binaryModuleWriteAbi`.
Simulated before broadcast, and the simulation reverted, so **nothing was
broadcast for this leg**:

```
redeem(4, 0x1a1e...050f, 0x...8373, outcomeIdx=0, amount=1000000)
selector 0x5b1ffcf2
  -> 0xdeda9030 = InsufficientPermission()
```

**Cause, confirmed by selector arithmetic rather than guessed:**
`keccak256("InsufficientPermission()")[0:4]` = **`0xdeda9030`** — an exact
match. That error is the ERC6909 permission error, and the module must burn the
owner's ERC6909 outcome tokens to pay out. The owner never granted the module
permission over those tokens. The token's own ABI carries exactly the two
functions that would grant it: **`setOperator(address,bool)`** and
**`approve(address,uint256,uint256)`**. Neither was called in this run.

So this is a **missing approval prerequisite, not a blocked path** — the same
shape as the ERC20 allowance the run already discovered and solved one step
earlier. It is the direct analogue on the ERC6909 side.

**Two aggravating factors in this run, both addressed in run 2:** (a) the ERC6909
operator approval was absent, and (b) the only position held was the *losing*
side, so even a successful redeem would have paid zero and would have been a
weak proof.

**PHASE A RUN 1 VERDICT: INCOMPLETE — go/no-go gate NOT yet passed.** Five of
six steps proven with real transactions; the sixth has a precisely identified,
one-call fix. Run 2 is a single focused attempt to close it.

### Asides logged, deliberately not chased (per the no-new-investigation rule)

1. **`0x5b1ffcf2` is `redeem(uint32,bytes32,bytes32,uint8,uint256)`.** Verified
   by selector arithmetic. STEP 2e recorded `0x5b1ffcf2` as the *dominant
   unindexed inbound selector* to `binaryMarketsModule` (21 mainnet / 284
   testnet) and could not name it. It is redemption traffic. Recorded because it
   fell out for free; the delegated-path question it came from stays closed.
2. **Trap 2 as written in the spec is not what happened.** §3 says "redeeming a
   losing position doesn't revert, it just pays zero." Here the losing-position
   redeem *did* revert — but with `InsufficientPermission()`, an approval error
   that would fire for a winning position too. So this run does **not** refute
   Trap 2; it never got far enough to test it. Not to be recorded as a
   contradiction either way until a redeem with the approval in place is run.
3. **Per-pool ERC20 allowance.** The spender named by the revert is the pool
   itself, and binary pools are per-window. Every new window needs its own
   `approve`, which is a real recurring cost on the self path and is worth
   knowing before the demo choreography is fixed.
