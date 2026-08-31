# AgentRail — Build Spec
### DreamDEX × Somnia Hackathon

This supersedes the earlier 10-idea ranking doc. Everything else is dropped. This is the single source of truth going forward.

---

## 1. What it is

An MCP server that turns DreamDEX Event Contracts into a tool any AI agent — Claude, ChatGPT, a custom autonomous agent — can trade on by natural-language instruction, with hard-coded risk guardrails and execution against a purpose-generated, user-funded trading wallet whose blast radius is capped to exactly what the user deposited.

**Problem:** DreamDEX Event Contracts settle every 15 minutes to an hour. Clicking a UI that often isn't a sustainable user behavior — the people best positioned to trade this profitably are the ones least willing to babysit a browser tab. Meanwhile every serious AI agent framework now expects to reach financial primitives through tools, not screens, and nobody has built that tool for Event Contracts.

**Positioning against the two obvious objections:**
- *"Isn't this just a chatbot on top of an existing market?"* No — a thin wrapper would be one bespoke chat UI calling one API. AgentRail is protocol-agnostic infrastructure: any MCP client can use it, any third-party agent can call it programmatically, and every action is risk-gated and logged on-chain for audit. That's a trust layer, not a chat skin.
- *"Isn't this just an AI wrapper with no real differentiation?"* The LLM's job isn't decoration — it's the entire interface layer, replacing a UI that genuinely doesn't scale to 15-minute re-engagement cycles. Remove the AI and there's no product; remove a typical hackathon chatbot's AI and there's usually still a normal app underneath.
- **This is also, directly, DreamDEX's own stated vision** — their own marketing already describes wanting to be "purpose built for the agentic era of finance" with native MCP support, treating automated participants as core users. AgentRail is the literal realization of that. Judges evaluating this are checking whether you understood their own strategy correctly — an easier bar than convincing them of a totally novel thesis.

---

## 2. Product experience

**Core flow:** User connects an MCP client, gets a fresh, AgentRail-generated trading address, and deposits only what they're willing to have at risk — $20, $50, whatever. That's the entire blast radius; the user's main wallet is never touched. Sets guardrails once (max stake per window, daily loss cap). From then on: type "put $10 on ETH up next 15m if it's broken above the 1h high" → agent parses intent → shows calculated stake/direction/window/payout for confirmation → executes → position tracked in an auditable trade log → auto-redeemed on settlement.

**Strategy mode — "momentum ladder" (not a separate product):** invoked the same way, by NL instruction — e.g. "keep riding BTC up, size up 20% on a win, stop after two losses." This auto-rolls from one settled window straight into the next, sized off the prior result.

**Naming discipline, deliberately:** do not call this a "perp" or "synthetic perpetual" anywhere in the pitch. A perp pays continuously, proportional to how far price moved. A chain of fixed-payout binary contracts pays a flat amount per window regardless of magnitude — it's a path-dependent, compounding ladder, not continuous exposure, and a judge who's traded a real perp will catch the mischaracterization in seconds. Call it a **momentum ladder** or **auto-continuation strategy**. This is the more precise claim, not a weaker one — precision reads as competence here.

**Trade log:** a bare page is enough — this is the answer to "how do I trust an AI traded for me," not a UI investment.

---

## 3. Confirmed technical architecture

Everything in this section is verified against live on-chain reads and the shipped SDK/ABI — not inferred from docs alone.

**SDK & order placement.** `@somnia-chain/markets-sdk` for discovery and reads: `loadMarkets()` / `isBinaryMarket()` to find live windows, `fetchOrderBook()` for live odds. The convenience `createOrder()` method does **not** work for delegated execution — it's not exposed for binary markets with an `owner` parameter. **Confirmed live on-chain: the real dispatched selector is `0x5d97c566`**, tested with a positive control (an unsigned/empty call correctly returns nothing — no function dispatched) versus the real encoded call (which correctly reaches downstream checks — `ERC20InsufficientAllowance` on testnet, `TradingNotActive`/`InvalidPrice` on mainnet — proving the calldata is structurally valid and reaches real business logic, not swallowed by an unknown-selector revert). This must be hand-encoded against the raw ABI. This is the real technical core of the build, not a config detail. (`OperatorPermissionsRegistry`'s `placeOrderFor` selector, `0x80054449`, is confirmed to belong to **spot** pools — calling it against a binary pool correctly reverts `OnlyApprovedContracts()`, i.e. it's not even the right function to be checking permissions against for this call path. Don't reuse the spot selector by copy-paste.)

**A specific, numeric, reproducible proof of the 18-decimal price bug exists now**, not just a description of the mechanism: encoding a price of 0.62 through the SDK's naive conversion on mainnet-scale (18) decimals produces `619999999999999996` instead of `620000000000000000` — four wei short of the real tick — and submitting it reverts `InvalidPrice(619999999999999996, 1000000000000000)`. The on-tick version of the exact same call instead reaches `TradingNotActive()` (a market-timing issue, unrelated to price) — meaning the on-tick path is validated clean up to that point. Testnet's off-tick equivalent produces the *identical* naive value to the on-tick one at 6 decimals (rounding error doesn't bite at that precision), which is exactly why testnet can never catch this.

**Custody model — corrected, following overnight research. The delegated (non-custodial operator) path is confirmed blocked, not confirmed working.** `placeBinaryOrderFor` — the delegated entrypoint — reverts `OnlyApprovedContracts()` for every caller tested (a plain EOA, MultiSend, a real Safe, a SafeProxyFactory), on both chains, regardless of any operator grant. Deep tracing (state-diff, call-tree, event-log, and public-selector-database checks) confirmed this gate reads from opaque, unverified pool/module implementation contracts — not from `OperatorPermissionsRegistry` — and no successful call to this entrypoint exists anywhere in this venue's transaction history. Real order flow on this venue runs through an unverified per-pool adapter proxy that isn't publicly callable. **Treat delegated third-party execution as unavailable without DreamDEX-side allowlist access — not something a client-side workaround can reach.**

**What is proven working: the self path (`placeBinaryOrder`, not the `...For` variant).** Called directly by the funds' actual owner, it clears every gate and reaches the correct downstream checks (`ERC20InsufficientAllowance` on testnet, `TradingNotActive()` on mainnet — both real, expected business-logic reverts, not permission failures). **The trust model this forces: AgentRail generates a fresh, purpose-only address per user and holds that key server-side — never the user's main wallet.**

**Say this precisely, every time, in the pitch: this is a custodial wallet, not a non-custodial one.** AgentRail holds a real private key and can move whatever funds sit in that generated address — that is the literal definition of custodial, and no amount of hedged phrasing changes that. The honest, still-genuinely-good trust story is narrower and different in kind: **"your main wallet is never touched, and exposure is capped to exactly what you explicitly deposited into a dedicated account."** That is a real, defensible claim. **"Non-custodial" is not** — don't say it, don't imply it, don't let a rushed live-demo answer round it up. If a judge asks "so AgentRail holds my key?" the correct answer is "yes, for a dedicated account holding only what you chose to risk — never your main wallet," not a deflection toward "non-custodial." This distinction only matters because the *earlier*, abandoned architecture (delegated operator keys, confirmed blocked above) really would have been non-custodial in the strict sense — it's easy to let that framing bleed into how the shipped system gets described. It shouldn't.

**This is worth stating as a finding in its own right, not hiding.** The `OnlyApprovedContracts()` gate is a real, undocumented access-control layer — selector, storage slot, and call tree all mapped precisely — that blocks third-party delegated execution on this venue entirely, for anyone, not just AgentRail. That's a genuine piece of technical depth to bring to judges, independent of which custody model shipped.

**Grant scope and pool-address prediction — confirmed real, but now secondary.** Everything in the earlier research (pool addresses forward-computable via `CREATE`+nonce, Safe MultiSend batching mechanically works, registry non-registration) is still true and still good work — it's just no longer the thing standing between AgentRail and a working demo, since the gate blocking delegated execution isn't the operator registry at all (see above). Worth revisiting only if DreamDEX opens delegated access later.

**Price handling — a real, confirmed mainnet-only bug.** USDso runs 18 decimals on mainnet, 6 on testnet. The SDK's naive price conversion (`price.toFixed(18)` → `parseUnits`) produces off-tick values for most ordinary probabilities on mainnet — of typical prices, only 0.25/0.5/0.75 survive cleanly, everything else reverts `InvalidPrice`. Testnet will never reveal this. Requires integer-tick snapping through the raw trader tier.

**Redemption — now confirmed live, end to end, with a state-delta proof, plus one trap that's more severe than first logged.** A real `redeemFor`-style call was broadcast against a real held position and succeeded (ERC6909 balance burned to zero, tx confirmed on-chain) — the mechanism works, not just the encoding. This required an ERC6909 `setOperator` grant on the outcome token first (a genuine missing-permission prerequisite, now closed and confirmed persistent — it doesn't need repeating per market, unlike the ERC20 collateral allowance, which does recur per pool). `redeemMany` batches multiple positions in one tx. Trap 1, confirmed with real numbers: of markets checked, 12 were live and 50 were finalized, with **zero overlap** — `loadMarkets()`'s default discovery and the finalized set are fully disjoint; use `listBinaryMarkets({status:"Finalized"})` instead. **Trap 2, confirmed live and worse than originally logged: redeeming a losing position does not revert — it succeeds, and irreversibly burns that position for zero payout.** This is not a harmless no-op; it's silent, permanent destruction of a real holding with a `status: success` receipt. Any code treating transaction success as proof of a good outcome will misreport a real loss as a win. **A hard client-side guard — check the actual winning outcome and refuse to broadcast redeem against a losing position — is mandatory, not optional, independent of anything else in this section.** A non-zero (winning) payout has not yet been observed live — every real test so far happened to hold the losing side.

**Status gating.** `loadMarkets()`/the indexer can lag on-chain truth. Gate every write on `getMarketOnchain(marketId).status === 1` immediately before submitting — the single most avoidable way to fail a live demo is submitting into a window that's already closed on-chain.

**USDso acquisition.** Not something a new user already holds — a Somnia-native stablecoin (1:1 against USDC.e via Frax). Onboarding needs a deposit/buy/mint step (5–30 min), plus SOMI for gas outside sponsored pairs. Real friction, worth acknowledging in the demo rather than assuming it away.

---

## 4. Known blockers, and how each is actually being handled

No outreach to the DreamDEX team on any of these — everything below is either solved through public/on-chain research or accepted as a fixed constraint for this build.

| Blocker | Status | Handling |
|---|---|---|
| Builder fee (`builder`/`builderFeeBpsTimes1k`) | **Confirmed dead.** `maxBuilderFeeBps = 0` on-chain on every live event-contract venue (spot runs the identical mechanism at 1%). Frozen per-venue at pool creation — can't be fixed retroactively. | Not a contingent fallback — the **actual** business model is off-chain subscription (§5), full stop. |
| Operator-key fee skim | **Confirmed impossible.** Operator permissions are scoped to place/cancel/reduce only — cannot move funds or receive a cut of a fill (§3). | No workaround pursued; this is the security model working as designed, not a gap. |
| Pool recycling / per-window operator grants | **Partially solved, confirmed by on-chain evidence — one real piece still open.** Confirmed (address-matched against real deployed pools): deployment is plain `CREATE` from a fixed deployer, even nonces only, fully predictable — future pool addresses are computable today. **Not yet confirmed:** whether the registry accepts a grant on a not-yet-deployed address, and whether multiple grants can be composed into a single signature. Credible but unverified (reported in detail, not backed by a saved successful test in the recovered artifacts): the registry's grant appears keyed to the calling address itself, meaning a naive relayed multicall wouldn't preserve the original owner's identity — real batching would need something that preserves the signer, like an ERC-4337 or Safe-style smart account, both of which were confirmed deployed on Somnia (Multicall3 was not). Treat "batched pre-authorization" as a promising, evidenced direction, not a solved mechanism yet. | Build the address-prediction piece now — it's confirmed and cheap. Attempt the pre-grant-on-undeployed-address test directly (a few minutes of real work) before committing to a demo choreography either way. If it fails: accept live per-window grants as a real, disclosed UX cost, scope the demo to one or two windows, and be upfront about it rather than hiding it. |
| 18-decimal price-tick bug | **Confirmed and solved.** Integer-tick snapping computed from the pool's actual tick size, unit-tested against 18-decimal math independent of testnet dev loop (which can't expose the bug at all). | Must-build item, not optional. |
| Redemption discovery gap | **Confirmed and solved.** `listBinaryMarkets({status:"Finalized"})` instead of default discovery. | Must-build item. |

---

## 5. Business model

**Subscription. No contingent plan, no "until DreamDEX turns on fees" language anywhere in the pitch.** This isn't a fallback — it's confirmed to be the only channel available under the current permission model (§3, §4). Structure: flat access tier for NL/agent trading, optional pro tier for multi-agent or autonomous strategy-mode access. If DreamDEX independently changes the fee cap or registry status later, the code should already be structured so flipping on an additional on-chain revenue stream is a small change, not a rebuild — but that's an upside to design for, not something to promise.

---

## 6. MVP scope

**Status: fully built and tested, as of Phase D.** Every item below is done — 9 MCP tools live over real stdio (`list_markets`, `place_order`, `get_position`, `redeem`, `generate_wallet`, `get_wallet_balance`, plus a third wallet tool, `parse_intent`, `get_trade_log`), concurrency-safe risk guardrails (28/28 tests), redeem guard proven live both directions, dedicated custodial wallets with proven non-leakage, structured errors throughout, and a complete honest audit trail including refusals. What remains is demo rehearsal, not new building — see §8's runway-checking tactic and the one open item below.

**One accepted, low-stakes gap:** the trade log's adapter for a real (not offline-simulated) redeem-guard BLOCK, and for ZERO_PAYOUT/PENDING/REVERTED entry shapes, isn't independently proven live — only offline, where the guard's output is controlled directly. The underlying guard itself is proven live in both directions already (Phase B); what's unproven here is only whether the *logging* of that specific event is shaped correctly. A bug here means an inaccurate audit-trail entry, not a fund-safety issue — logging is explicitly designed to never affect the underlying action. Not worth manufacturing an artificial loss to force this proof; verify opportunistically if a rehearsal run happens to produce one.

**Must build**
- On-chain status gate before every order (`getMarketOnchain().status === 1`).
- Order placement via the confirmed-working self path (`placeBinaryOrder`, `0x718c2d4d`) against a fresh, AgentRail-generated address per user — not the delegated `...For` path, which is confirmed blocked (§3).
- Per-user dedicated wallet generation and a clear, honest deposit flow — this replaces the operator-grant flow entirely; there's nothing to grant on this path.
- Integer-tick price snapping, validated against 18-decimal mainnet math.
- Redemption via `redeemFor`, discovered via `listBinaryMarkets({status:"Finalized"})`. The signature/encoding is confirmed correct; a real submitted redemption is not yet proven — get one on-chain before this goes in the demo.
- NL intent parser → structured order, with explicit confirm-before-execute showing stake/direction/window/payout.
- Hard-coded server-side risk guardrails (max stake/window, daily loss cap) — enforced in code, never trusted to the model.
- Minimal auditable trade log.
- Momentum-ladder strategy mode, NL-invoked (§2) — cheap to add once the core loop works, gives the demo a second beat.

**Nice to have**
- A second MCP client connected live in the demo, to prove "any agent," not one chatbot.
- Telegram relay as a secondary access channel.
- Basic named strategy templates ("momentum," "mean-reversion") selectable without raw NL.

**Do not build yet**
- Any multi-account / copy-trading execution.
- Any UI beyond the trade log.
- Assets/windows beyond what's confirmed live (BTC/ETH, 15m/1h).
- A trained predictive model for direction-calling — this is an execution/interface layer, not an alpha model.

---

## 7. Build sequence, risk-ordered

Research is done — recovered from the on-chain artifacts of the sessions that ran it, not a clean final report, but the underlying evidence is solid and is folded into §3–§4 above. Two concrete, fast tests are still open before the build sequence starts; do these first since they change scope, not after.

1. **Test pre-granting on a predicted, not-yet-deployed pool address**, and test whether a batch of such grants can be composed into one signature via a Safe/ERC-4337-style smart account. A few hours at most — this directly determines whether §8's demo can lead with "pre-authorized six windows in one signature" or needs the live-grant fallback.
2. **Submit one real `redeemFor` call on-chain** (or `signRedeemAuth` + relayer submission) to confirm actual success, not just valid encoding — the signature scheme is proven to construct correctly, but no successful redemption transaction has actually landed yet.
3. **Prove the on-chain path end to end** (grant → gated order → fill → settlement → redeem), as one throwaway script, no MCP/NL/UI. This is the single go/no-go gate for the whole project — everything below already has strong supporting evidence, but a clean, uninterrupted run through the full sequence hasn't happened yet.
4. **Wrap the proven path in MCP tools** — `list_markets`, `place_order`, `get_position`, `redeem`. Mechanical once step 3 is solid.
5. **Add NL parsing, confirmation, and guardrails.** Build this last — it's the least risky piece; don't let it eat time steps above need.
6. **Add the momentum-ladder strategy mode** once the single-shot flow is solid.
7. **Choreograph and rehearse the demo** (§8).

---

## 8. Demo script

**Milestone: the full lifecycle is proven end to end with real transactions and a real non-zero payout** — fund → status-gate → tick-snap → place → settle → discover via Finalized-status scan → guard → redeem → paid, confirmed by balance delta (tUSDC +1.000000, ERC6909 burned), not just transaction status. This was the actual go/no-go gate for the whole project, and it passed.

**Milestone: Phase C mostly complete — one fix blocking before Phase D starts.** Structured, consistent failure responses now exist across `place_order` (a taxonomy of `reverted`/`retryable:true` vs `send_error`/`retryable:false`, with a stable machine-readable `reason` code plus prose `detail` everywhere, not inconsistently mixed as before). Dollar-denominated sizing (`targetDollarAmount`) exists alongside raw `stake_units`, with a working overspend guard (`slippage_exceeded`, refuses cleanly, nothing broadcast). Risk guardrails (`build/risk.mjs`) are live, env-sourced only (deliberately absent from the tool schema so a model cannot self-report a higher limit — tested explicitly), and correctly refuse in the sequential case.

**Known, accepted limitation: dollar sizing can undershoot the requested amount when the book moves between sizing and placement** — cause now confirmed, not just suspected: a controlled test with zero slippage hit the target to within 0.016%, directly isolating book movement (not the sizing math) as the source of the earlier −74.7% observation. Still a UX-accuracy gap, not a safety gap — `collateralSpent` is always reported honestly. **Hard requirement for Phase D's NL layer: always surface actual-vs-requested spend to the user; never assume or imply the target amount was hit.**

**Resolved: the check-then-act race in the risk cap is fixed and proven live, not just specified.** `checkPreOrder` now reserves the worst-case spend synchronously on approval (returns a `reservationId`); every exit path resolves it exactly once via `commitReservation`/`releaseReservation`, backstopped by `try/finally`. Proven with a committed, re-runnable test (`build/risk-test.mjs`, 28/28) whose test 13 reproduces the exact interleaving that used to leak — three concurrent $2 orders against a $5 cap now correctly cap out at $4 committed, where the old code let all three through. A related bug was found and fixed in the same pass: refusal-path responses were built from pre-release state (a JS `return` evaluates before `finally` runs), so callers could see a stale `reservation: OPEN` even though the underlying state was already correctly released — fixed by explicitly resolving before constructing the return payload, across all seven affected paths. Known, accepted limits going forward: in-memory only (a restart drops open reservations; a late commit after restart takes a fail-safe orphan path rather than corrupting state), and single-process (does not cover multiple server instances sharing a wallet — not a concern for the current single-instance architecture).

**Design note for Phase C, surfaced by Phase B testing: a clean simulation does not guarantee inclusion.** A broadcast reverted after simulating clean — state-dependent, consistent with a competing fill consuming the same resting liquidity in the same block, does not reproduce on replay. Any retry or auto-continuation logic (including the momentum-ladder mode) must treat a single reverted placement as a normal, expected outcome worth one immediate retry, not as evidence something is broken.

**Scope the demo to the proven path: single-sided, YES-direction bets, preferring 300-second windows.** Two things are documented, deferred limitations, not blockers, and not to be re-investigated before the hackathon deadline: (1) buying the NO side did not reliably fill in testing, with two apparently different non-filling behaviors observed (one cheap/immediate, one costing more gas than a successful fill) — mechanism undetermined; (2) 60-second windows' liquidity is **unreliable, not confirmed empty** — a narrow 2-sample depth probe found no resting liquidity at one specific timing offset (T-47s), but Phase A runs 1 and 2 both actually filled on 60s markets. The evidence doesn't support "always empty," only "not dependable" — 300s windows are the safer default for anything that needs to fill on a schedule, but 60s isn't proven broken. If there's genuine spare time after the demo is solid, the cheapest next check is whether NO-side liquidity behaves differently on an actively-traded mainnet market — but this is optional polish, not required scope.

**Confirmed operational finding: only one 300s market exists per asset at a time, so the final ~60 seconds of every 5-minute cycle is a hard refusal with no fallback candidate** — `otherCandidates` being empty in that window is expected, not a bug. Mitigate with a simple pre-demo tactic: **check runway on both BTC and ETH immediately before going live, and trade whichever currently has more time remaining.** Two independent ~80%-good windows join to roughly 96% odds at least one is usable, versus a real 1-in-5 chance of a refusal if committed to one asset blind.

Demo choreography: user connects, gets a fresh AgentRail-generated address, deposits a small amount live on stage (or shows a pre-funded one to save time), then the core sequence — open an MCP client (ideally a judge's own laptop) → type a natural-language instruction for a YES-direction bet on a 300s window (checking runway on both assets first, per above) → show the order hit the live order book over WebSocket → show settlement → show the guard evaluate the outcome → show real redemption landing back in that same dedicated address → pull up `get_trade_log` to show the complete, honest record, including anything that got refused along the way. Be upfront in the framing: **"this is a custodial wallet — AgentRail holds the key, but this account only ever holds what was explicitly deposited into it. Your main wallet is never touched."** Do not say "non-custodial" (§3). If time allows, follow with the momentum-ladder mode as a second beat: one NL instruction, multiple auto-continued rounds, visible compounding sizing. Worth one line acknowledging the research explicitly: "we also mapped a real, undocumented permission gate blocking third-party delegated execution on this venue — happy to go deeper on that if you're curious," which turns a genuine limitation into a demonstration of depth.

---

## 9. Mapping to the actual judging criteria

- **Innovation & Originality:** not a market clone, not a copy-trading app, not a game skin — infrastructure nobody else at this event will think to build, and directly extends what DreamDEX's own agent-native positioning implies but hasn't shipped.
- **Technical Implementation:** the real integration is deeper than a thin API wrapper — hand-encoded ABI calls, on-chain permission-registry management, a confirmed mainnet-only pricing bug worked around. This is evidence of contract-level understanding, which is a stronger signal than a frictionless build would have been.
- **UX & Design:** the entire interface is natural language inside a tool the user already has open — no app to learn, no UI to design beyond a trade log.
- **Business & Ecosystem Impact:** subscription is a real, committed model, not a hand-wave; removes the single biggest UX barrier (manual 15-minute re-engagement) that otherwise caps how often anyone trades this product.
- **Presentation & Demo:** resolves in real time, legible to a non-crypto judge in under 30 seconds, no narration required.

---

## 10. Open items

- Pre-grant-on-undeployed-address and grant-batching, per §7 steps 1–2 — the one area where evidence is strong but not yet conclusive.
- One live, submitted `redeemFor`/`signRedeemAuth` transaction, to move redemption from "correctly encoded" to "actually works."
- A single uninterrupted run through the full order lifecycle (grant → order → fill → settle → redeem) — individual pieces are each proven separately with real revert data and matched addresses, but not yet chained in one continuous run.
- No direct outreach to DreamDEX planned or needed — every blocker in §4 is either solved through public research or accepted as a fixed, disclosed constraint.

*§3–§4 and this section were reconstructed directly from the raw on-chain research artifacts (JSON logs of real testnet/mainnet reads, revert data, and matched pool addresses) after the agent sessions that produced them were interrupted mid-write. Findings backed by a saved artifact with reproducible data are stated as confirmed; findings that were only narrated in a terminal transcript without a corresponding saved result are flagged explicitly as credible-but-unverified. Don't upgrade the second category to "confirmed" without independently re-running them.*