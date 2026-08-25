# AgentRail — Build Spec
### DreamDEX × Somnia Hackathon

This supersedes the earlier 10-idea ranking doc. Everything else is dropped. This is the single source of truth going forward.

---

## 1. What it is

An MCP server that turns DreamDEX Event Contracts into a tool any AI agent — Claude, ChatGPT, a custom autonomous agent — can trade on by natural-language instruction, with hard-coded risk guardrails and fully non-custodial, delegated execution via on-chain operator keys.

**Problem:** DreamDEX Event Contracts settle every 15 minutes to an hour. Clicking a UI that often isn't a sustainable user behavior — the people best positioned to trade this profitably are the ones least willing to babysit a browser tab. Meanwhile every serious AI agent framework now expects to reach financial primitives through tools, not screens, and nobody has built that tool for Event Contracts.

**Positioning against the two obvious objections:**
- *"Isn't this just a chatbot on top of an existing market?"* No — a thin wrapper would be one bespoke chat UI calling one API. AgentRail is protocol-agnostic infrastructure: any MCP client can use it, any third-party agent can call it programmatically, and every action is risk-gated and logged on-chain for audit. That's a trust layer, not a chat skin.
- *"Isn't this just an AI wrapper with no real differentiation?"* The LLM's job isn't decoration — it's the entire interface layer, replacing a UI that genuinely doesn't scale to 15-minute re-engagement cycles. Remove the AI and there's no product; remove a typical hackathon chatbot's AI and there's usually still a normal app underneath.
- **This is also, directly, DreamDEX's own stated vision** — their own marketing already describes wanting to be "purpose built for the agentic era of finance" with native MCP support, treating automated participants as core users. AgentRail is the literal realization of that. Judges evaluating this are checking whether you understood their own strategy correctly — an easier bar than convincing them of a totally novel thesis.

---

## 2. Product experience

**Core flow:** User connects an MCP client, authorizes a scoped operator key (can trade, architecturally cannot withdraw — see §3), sets guardrails once (max stake per window, daily loss cap). From then on: type "put $10 on ETH up next 15m if it's broken above the 1h high" → agent parses intent → shows calculated stake/direction/window/payout for confirmation → executes → position tracked in an auditable trade log → auto-redeemed on settlement.

**Strategy mode — "momentum ladder" (not a separate product):** invoked the same way, by NL instruction — e.g. "keep riding BTC up, size up 20% on a win, stop after two losses." This auto-rolls from one settled window straight into the next, sized off the prior result.

**Naming discipline, deliberately:** do not call this a "perp" or "synthetic perpetual" anywhere in the pitch. A perp pays continuously, proportional to how far price moved. A chain of fixed-payout binary contracts pays a flat amount per window regardless of magnitude — it's a path-dependent, compounding ladder, not continuous exposure, and a judge who's traded a real perp will catch the mischaracterization in seconds. Call it a **momentum ladder** or **auto-continuation strategy**. This is the more precise claim, not a weaker one — precision reads as competence here.

**Trade log:** a bare page is enough — this is the answer to "how do I trust an AI traded for me," not a UI investment.

---

## 3. Confirmed technical architecture

Everything in this section is verified against live on-chain reads and the shipped SDK/ABI — not inferred from docs alone.

**SDK & order placement.** `@somnia-chain/markets-sdk` for discovery and reads: `loadMarkets()` / `isBinaryMarket()` to find live windows, `fetchOrderBook()` for live odds. The convenience `createOrder()` method does **not** work for delegated execution — it's not exposed for binary markets with an `owner` parameter. **Confirmed live on-chain: the real dispatched selector is `0x5d97c566`**, tested with a positive control (an unsigned/empty call correctly returns nothing — no function dispatched) versus the real encoded call (which correctly reaches downstream checks — `ERC20InsufficientAllowance` on testnet, `TradingNotActive`/`InvalidPrice` on mainnet — proving the calldata is structurally valid and reaches real business logic, not swallowed by an unknown-selector revert). This must be hand-encoded against the raw ABI. This is the real technical core of the build, not a config detail. (`OperatorPermissionsRegistry`'s `placeOrderFor` selector, `0x80054449`, is confirmed to belong to **spot** pools — calling it against a binary pool correctly reverts `OnlyApprovedContracts()`, i.e. it's not even the right function to be checking permissions against for this call path. Don't reuse the spot selector by copy-paste.)

**A specific, numeric, reproducible proof of the 18-decimal price bug exists now**, not just a description of the mechanism: encoding a price of 0.62 through the SDK's naive conversion on mainnet-scale (18) decimals produces `619999999999999996` instead of `620000000000000000` — four wei short of the real tick — and submitting it reverts `InvalidPrice(619999999999999996, 1000000000000000)`. The on-tick version of the exact same call instead reaches `TradingNotActive()` (a market-timing issue, unrelated to price) — meaning the on-tick path is validated clean up to that point. Testnet's off-tick equivalent produces the *identical* naive value to the on-tick one at 6 decimals (rounding error doesn't bite at that precision), which is exactly why testnet can never catch this.

**Custody model — confirmed non-custodial, and it's the strongest trust story in the whole pitch.** Auto-pull from the owner's wallet at order placement, fills settle straight back to the owner's wallet. Under operator delegation this still holds: `placeOrderFor` pulls the *owner's* funds and settles to the *owner's* wallet — the operator (AgentRail's server) never touches funds at any point.

**Operator permissions — confirmed real, confirmed hard-scoped.** A genuine keypair AgentRail holds server-side, restricted per-function-selector by `OperatorPermissionsRegistry` (`placeOrderFor` `0x80054449` / `cancelOrderFor` `0xe37b444b` / `reduceOrderFor` `0x364c2587`), instantly revocable. Critically: **the operator key architecturally cannot move funds, grant approvals, or receive any share of a fill** — it is scoped to those three selectors and nothing else. This is why "the AI can trade for you but can't drain your wallet" is a true statement here, not a marketing claim, and also why no clever on-chain fee-skim by the operator is possible (see §4).

**Grant scope — the real operational constraint, now with a real answer, not a hoped-for one.** Resolution rule: `isApproved = NOT perPoolDenied AND (perPoolApproved OR (globalApproved AND poolRegistered))`. Binary pools are **confirmed not registered** in `SpotPoolRegistry` — confirmed against the registry's real function set (`registerPool`, `registerPools`, `unregisterPool`, `isRegistered`) — so a global approval does not cover them. Per-pool grants only, and binary pools barely recycle.

**But pool addresses are predictable, confirmed.** Deployment is plain `CREATE` (not `CREATE2`) from a single deployer address, using only even nonces (2, 4, 6, 8...) — each deployed pool is a lightweight ~291-byte beacon proxy. Standard `CREATE` addresses are `keccak256(rlp(deployer, nonce))` — fully deterministic from public information. This was verified by computing predicted addresses for existing pools and matching them against real deployed addresses across the full even-nonce sequence. **This means future pool addresses (the next window's, and the one after that) are computable today, before they're deployed.** What's *not* yet proven: whether `setOperatorApprovalForPool` actually accepts a grant on an address with no code deployed yet, and whether multiple such grants can be composed into one signature (see §4 for exactly what's confirmed vs. still open on that second part).

**Price handling — a real, confirmed mainnet-only bug.** USDso runs 18 decimals on mainnet, 6 on testnet. The SDK's naive price conversion (`price.toFixed(18)` → `parseUnits`) produces off-tick values for most ordinary probabilities on mainnet — of typical prices, only 0.25/0.5/0.75 survive cleanly, everything else reverts `InvalidPrice`. Testnet will never reveal this. Requires integer-tick snapping through the raw trader tier.

**Redemption — mechanism confirmed at the encoding layer; live on-chain success not yet proven.** `redeemFor`/`signRedeemAuth` is a genuine custody-free relayer pattern: owner pre-signs once, AgentRail submits and pays gas, payout is hard-pinned to the owner. `redeemMany` batches multiple positions in one tx. A real EIP-712 signature was generated and a full, well-formed `redeemFor` call assembled from it — proving the signing scheme itself is exercisable — but it was never actually broadcast, so there's no confirmed successful redemption transaction yet, only a validly-encoded one. Trap 1, confirmed with real numbers: of markets checked, 12 were live and 50 were finalized, with **zero overlap** — `loadMarkets()`'s default discovery and the finalized set are fully disjoint. A redeem-by-scan bot using default discovery will silently report nothing owed while real winnings sit unclaimed; use `listBinaryMarkets({status:"Finalized"})` instead. Trap 2: redeeming a losing position doesn't revert, it just pays zero — check the outcome before spending gas on it.

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

**Must build**
- On-chain status gate before every order (`getMarketOnchain().status === 1`).
- Hand-encoded `placeBinaryOrderFor` against the raw ABI (real dispatched selector `0x5d97c566` — not the spot `placeOrderFor` selector, don't reuse it).
- Per-pool operator grant flow. Address prediction is confirmed (plain `CREATE`, even nonces). Pre-granting on an undeployed address and composing multiple grants into one signature are not yet confirmed — test both before committing to which demo path you're building toward (§7).
- Integer-tick price snapping, validated against 18-decimal mainnet math.
- Redemption via `redeemFor`, discovered via `listBinaryMarkets({status:"Finalized"})`. The signature/encoding is confirmed correct; a real submitted redemption is not yet proven — get one on-chain before this goes in the demo.
- Operator-key onboarding, implemented and tested directly against a binary pool (not assumed identical to the spot-documented flow).
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

Two branches, chosen based on the pool-precompute research outcome:

- **If pre-computation works:** lead with it. "We pre-authorized the next six windows in a single signature" is a stronger trust story than granting live, and it's a genuine technical result worth stating plainly.
- **If it doesn't:** grant live, on stage, and narrate it as the actual signature a wallet would show, explicitly revocable — turning a real protocol limitation into evidence of contract-level understanding rather than hiding it.

Either way, the core sequence: open an MCP client (ideally a judge's own laptop) → type a natural-language instruction → show the order hit the live order book over WebSocket → show settlement → show auto-redemption landing in the wallet. If time and stability allow, follow with the momentum-ladder mode as a second beat: one NL instruction, multiple auto-continued rounds, visible compounding sizing.

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
