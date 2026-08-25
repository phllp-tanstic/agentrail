# DreamDEX Event Contracts — SDK Verification for AgentRail

**Date:** 2026-08-23
**Scope:** Verifying the DreamDEX Event Contracts developer surface against AgentRail's design assumptions (an MCP server letting AI agents trade Event Contracts on a user's behalf).
**Verdict in one line:** wallet-pull custody and the no-deposit flow hold up; the builder-fee business model does not work on event contracts as deployed; and autonomous trading is blocked less by custody than by operator-grant lifecycle.

---

## How this was verified

The docs site blocks plain scraping but serves clean Markdown at `<url>.md` — that is what was read, not rendered HTML.

| Source | What it is |
|---|---|
| `docs.dreamdex.io/developers/event-contracts` | Overview / minimal loop |
| `…/event-contracts/market-structure` | Contract family, fill paths, escrow |
| `…/event-contracts/recipes` | Per-action snippets |
| `…/event-contracts/contracts-and-addresses` | Deployed core, collateral |
| `…/event-contracts/gotchas` **[added]** | 13 verified failure modes |
| `…/trading/readme-1/operators` **[added]** | Operators & Session Keys (canonical) |
| `…/developers/http-api/builder-fees` **[added]** | Builder-code mechanism |
| `…/welcome/making-your-first-deposit` **[added]** | USDso acquisition |
| `github.com/somnia-chain/dreamdex-bot-kit/…/session-keys.md` | Split-key operator model |
| `@somnia-chain/markets-sdk@0.28.1` | README + shipped `.d.ts` / ABI files from the npm tarball |
| `prd.smk.somnia.host/v1/graphql` | Live indexer (venue fee params, pool census) |
| `api.infra.mainnet.somnia.network` | Live mainnet `eth_call` reads |

Sources marked **[added]** were not in the original brief but were decisive; they are attributed inline throughout.

**On the on-chain reads.** Every read below used a matched spot-pool control, so a `0` result means "false" rather than "wrong selector." Keccak-256 was implemented locally (Node lacks it — `hashlib`/`crypto` ship NIST SHA-3, which uses different padding) and self-tested against the empty-string vector, `transfer(address,uint256)` → `0xa9059cbb`, and `balanceOf(address)` → `0x70a08231`. As independent validation, the computed selector for `placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)` came out `0x80054449`, matching the value dreamDEX publishes on its operators page.

---

## 1. Fund custody — auto-pull from wallet, no deposit step

**Answer:** The default path pulls funds **from the trader's wallet at placement**. There is no mandatory deposit into a separate escrow or margin balance. A per-pool vault exists and is checked *first*, but it is a payout fallback that reads 0 in normal operation, so in practice placement draws the wallet. Refunds return to the wallet, not to a vault balance.

The complete "Escrow and complete sets" section, verbatim:

> * **Buys** escrow collateral at placement (worst case, vault-first: your per-pool vault balance is spent before your wallet).
> * **Sells** escrow the outcome tokens themselves — you can only sell what you hold. New tokens come from minting a **complete set**: 1 USDso mints 1 Up + 1 Down (`mintCompleteSet`), and merging a pair returns 1 USDso (`mergeCompleteSet`).
> * Refunds settle in your **wallet**. Cancelling a resting bid returns the exact escrow to it, and a taker is charged the fill price rather than the price it offered. The pool vault is a payout fallback that reads 0 in normal operation, which is why placement can draw it first without you ever seeing a balance there.

On which contract holds funds: "**Pool (order book)** — The CLOB you trade on. Extends the same on-chain matching engine as spot, and **owns all escrow**."

Corroborated by Gotchas #7 **[added source]**: "Escrow leaves the wallet and comes back to it. Cancel a resting bid and the exact escrow returns; cross a 0.945 ask with a 0.98 bid and you are charged 0.945, not 0.98."

And by the SDK — `PlaceOrderParams.autoApprove` is *"Approve the escrow token to the pool if allowance is short (default true)"*, i.e. ERC-20 allowance plus `transferFrom` at placement. That is auto-pull.

**The exception:** a deposit-first mode exists and is opt-in — `setManualVaultMode` plus pre-funding the pool vault. This is what the bot-kit's split-key setup uses. It is *not* required for delegated trading (see §3).

### The four fill paths

Up and Down trade on a **single** book quoted in Up terms; a Down price is always `1 − up price`.

| Crossing pair | Path | What happens |
|---|---|---|
| Buy Up × Sell Up | direct | Up tokens ↔ collateral swap |
| Buy Down × Sell Down | direct | Down tokens ↔ collateral swap |
| Buy Up × Buy Down | **mint-a-pair** | Both pay collateral; the pool mints a fresh Up/Down pair, one side each |
| Sell Up × Sell Down | burn-a-pair | Both positions burn; each seller is paid their share |

> Mint-a-pair is the cold-start mechanism: two opposite-side buyers need no seller and no market maker — which also means you can quote **both sides with zero inventory** (a resting Buy Up at *p* plus Buy Down at *1 − p* is a complete two-sided quote).

**Source:** https://docs.dreamdex.io/developers/event-contracts/market-structure · https://docs.dreamdex.io/developers/event-contracts/gotchas

---

## 2. Deposit step on the Recipes page — absent

**Answer: No.** There is no deposit / fund-account snippet, so **there is no function signature to quote.** Flagging that explicitly: the page does not contain one.

Complete list of Recipes sections, as proof of exhaustiveness: Find a market worth trading · Read the book · Read a market's volume · Size to the venue's lot grid · Price on the tick grid, as integers · Take liquidity · Rest a quote · Get inventory so you can sell · Manage working orders · Know what actually filled · Check your positions · Redeem after settlement · Follow a series as it rolls · Where to go next.

The page's own tier table names trading, reads, and redemption — funding is not a tier:

> | Unified | `exchange.*` | Trading by symbol in human units. Most of your bot. |
> | Client (reads) | `exchange.client.*` | On-chain truth: market status, outcome balances. |
> | Trader (writes) | `exchange.trader.*` | The few writes the unified tier does not model, notably redeeming a specific outcome. |

The nearest thing is **inventory**, not funding, and it is explicitly for sell-side inventory:

```ts
await exchange.mintSet(market.symbol, 10);    // 10 collateral -> 10 Up + 10 Down
await exchange.burnSet(market.symbol, 10);
```

This is consistent with §1 — there is no deposit snippet because the default flow needs no deposit. Deposit functions exist elsewhere: `depositVault(fund, poolAddress, usdsoAddress, amountRaw)` in the bot-kit (manual vault mode only), and the app's UI deposit flow.

**Source:** https://docs.dreamdex.io/developers/event-contracts/recipes

---

## 3. Session keys — a real keypair, restricted on-chain per function selector

**Answer: the first mechanism, not the relayer pattern.** It is a genuine keypair held server-side ("hot key on the server"), cryptographically restricted on-chain to specific function selectors. It is *not* a registered contract placing orders without a per-user key — though a contract address can also be an operator (the SpotRouter is one), so the same primitive covers both shapes.

The model, verbatim:

> - **Fund key (owner)** — cold, used rarely. Holds the money. Deposits working capital into the pool's vault and grants the operator permission. This is the only key that can withdraw.
> - **Operator key (the bot)** — hot, on the server. Places/cancels orders **on the owner's behalf** via `placeOrderFor` / `cancelOrderFor`. It can't deposit, withdraw, or grant approvals — those are owner-scoped — and every fill settles to the **owner's** vault, never the operator's.

### How "cannot withdraw" is actually enforced

**Contract-level function restriction, and nothing else:**

> Authorization is recorded in the on-chain **OperatorPermissionsRegistry**, per function selector, and the pool enforces it inside every `placeOrderFor` / `cancelOrderFor`. Revocation is immediate.

Explicitly **not** a spending cap and **not** a time limit. No expiry, TTL, or notional-cap field is documented anywhere in either source. The guarantee is that withdrawal entrypoints are `msg.sender`-scoped to the owner and were never granted. Confirmed on the operators page **[added source]**: "Deposits, withdrawals, and approvals stay `msg.sender`-scoped to the owner" and "the operator key can never move funds out — it can only open, cancel, and reduce orders that belong to the owner."

| Capability | Function | Selector |
|---|---|---|
| Place orders | `placeOrderFor` | `0x80054449` |
| Cancel orders | `cancelOrderFor` | `0xe37b444b` |
| Reduce orders | `reduceOrderFor` | `0x364c2587` |

Each selector is an independent grant. Scoping: `setOperatorApprovalGlobal` (all registry-listed pools, **including ones added later**), `setOperatorApprovalForPool` (single pool — "it need not be in the registry"), and `setOperatorDenialForPool` as a kill switch that trumps both. Resolution rule:

```
isApproved = NOT perPoolDenied AND (perPoolApproved OR (globalApproved AND poolRegistered))
```

Live-verified in the bot-kit doc: "an operator key placed and cancelled an order for the owner, and the order settled to the owner — the operator never held funds."

### Does this work for event contracts? Yes — verified on-chain

Both documented sources are written against **spot** (`session-keys.md` uses the spot pair `USDC.e:USDso` via `@dreamdex-bot-kit/core`; the operators page scopes everything to "official SpotPool"). Neither demonstrates operator mode on an event-contract pool. Resolved by direct reads:

- **`placeBinaryOrderFor` is deployed and dispatched on binary pools.** On this contract family an absent function reverts with empty `0x`, while `placeBinaryOrderFor` returns a decodable custom error — `0x3fb0ba2e` = `OnlyApprovedContracts()`, decoded against the SDK's 418-entry `contractErrorsAbi`. Spot's `placeOrderFor` returns the *identical* error from the same ungranted EOA, so both planes behave the same: that is the final revert when a caller has neither a per-user grant nor allowlist membership.
- **Grants are expressible for binary pools.** `OperatorPermissionsRegistry.isApprovedForPool(binaryPool, owner, operator, 0x80054449)` answers cleanly (`false`) rather than reverting — grant slots are keyed by pool address and are pool-type agnostic.

Two real gaps remain:

1. **No pool-side pre-flight on binary.** `isOperatorAuthorized` is **absent on binary pools** (present on spot, returns `false`). The SDK's `client.isOperatorAuthorized` will revert on event contracts — pre-flight against the registry's `isApprovedForPool` instead.
2. **The SDK does not expose the binary delegation path.** The binary `PlaceOrderParams` has **no `owner` field**, and the operator-grant helpers live in `package/dist/spot/operatorGrants.d.ts`. So `exchange.trader.placeOrder` cannot route through `placeBinaryOrderFor` — AgentRail must encode that entrypoint against the exported ABI itself. Budget for it; it is not a config flag.

### Naming collision — do not conflate these

`operatorId` throughout markets-sdk means a *venue operator* — a market-listing business entity, `registerOperator(feeRecipient, enabled, policy, context)` on MarketsCore. That is a completely different concept from the session-key operator of the OperatorPermissionsRegistry. Grepping for "operator" in the SDK returns mostly the former.

**Source:** https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/docs/session-keys.md · https://docs.dreamdex.io/trading/readme-1/operators · live mainnet reads

---

## 4. USDso — a Somnia-native stablecoin; a new user needs an acquire step

**Answer:** A stablecoin, minted 1:1 against USDC.e via Frax, redeemable back to USDC. Not a wrapped-USD primitive, and **not something a new user already holds** — every pair trades against it, so acquiring it is mandatory onboarding.

> **Collateral** is per-venue: USDso (`0x00000022dA000002656c64D9eA6011ea952D008A`, 18 decimals) on mainnet; a faucet-enabled test USDC (6 decimals) on testnet.

> **Deposits.** Every pair trades against our stablecoin **USDso**. Bring **USDC / USDC.e** cross-chain and you'll receive USDso via our 1:1 swap contract (plus, optionally, some SOMI for gas); USDso is redeemable for USDC.

> USDso mints 1:1 against USDC.e.

Three acquisition routes, easiest first: (1) the app Deposit module with USDC on any LayerZero-supported chain; (2) buy it on the `USDC.e ↔ USDso` CLOB pair; (3) the Frax Mint & Burn widget — "Mint USDso directly through our partner Frax's embedded widget", taking "roughly 5–30 minutes depending on source asset and chain."

Gas: "The **SOMI ↔ USDso** and **USDC.e ↔ USDso** pairs are sponsored; otherwise you need SOMI for gas."

**Flag — 18 decimals is the root cause of a live footgun.** A USD stablecoin at 18 decimals (not USDC's 6) is what makes Gotcha #3 fire: `createOrder` converts via `parseUnits(price.toFixed(18), 18)`, and `(0.05).toFixed(18)` is `"0.050000000000000003"` — three wei off the tick grid, rejected with `InvalidPrice`. "Of fifteen ordinary probabilities only 0.25, 0.5 and 0.75 survive that conversion." Testnet is 6 decimals and never shows it, so **testnet looks clean while every mainnet order fails.** Any AgentRail order path must snap prices to integer ticks and use the raw trader tier.

**Source:** https://docs.dreamdex.io/developers/event-contracts/contracts-and-addresses · https://docs.dreamdex.io/welcome/making-your-first-deposit

---

## 5. Builder / fee attribution — fields exist with spot's exact names, but the cap is zero on event contracts

**Answer: present in the API, disabled on-chain.** Not "just undocumented" in either direction — the exact fields can be quoted *and* the chain demonstrably rejects them.

### The fields exist, named identically to spot

Binary `PlaceOrderParams` (`package/dist/trade.d.ts`, v0.28.1, lines 146 and 151):

```ts
/**
 *  Routing/builder frontend address to attribute the order to. Requires the
 *  trader to have opted this builder in via {@link Trader.approveBuilder}.
 *  Omit (or zero) for no routing fee.
 */
builder?: Address;
/**
 *  Per-order builder/routing fee in the pool's native bps×1000 unit (≤ the
 *  venue's frozen `maxBuilderFee` ceiling AND ≤ the trader's approval). 0 = none.
 */
builderFeeBpsTimes1k?: bigint;
```

On-chain, in the **binary** pool write ABI — note this is `placeBinaryOrder`, the event-contract entrypoint:

```
function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs,
  uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k,
  uint64 userData) payable returns (bool success, uint128 id)
```

The binary pool also carries `approveBuilder(address,uint256)`, `getBuilderApproval`, `getEffectiveBuilderApproval`, and `getMaxBuilderFeeBpsTimes1k()`. The ABI comment calls this "Builder/routing opt-in (**SpotPool parity**)". Opt-in params:

```ts
export interface ApproveBuilderParams {
    pool: Address;            // "Pool address (binary, spot, or perp). The approval is per-pool."
    builder: Address;
    maxFeeBpsTimes1k: bigint; // "Max per-order builder fee to allow (pool bps×1000). 0 revokes."
    gas?: bigint;
}
```

### But the effective cap is zero on every event-contract venue

Live mainnet `getMaxBuilderFeeBpsTimes1k()`:

| Pool | Raw | Decoded |
|---|---|---|
| Binary ETH `0x39b9…4bb4` | `0` | builder codes **disabled** |
| Binary BTC `0xd229…f736` | `0` | builder codes **disabled** |
| Spot `USDC.e:USDso` | `100000` | **100 bps = 1%** |
| Spot `SOMI:USDso` | `100000` | 100 bps = 1% |
| Spot `WBTC:USDso` | `100000` | 100 bps = 1% |

Indexer agrees across every venue row: `makerFeeBps: "0"`, `takerFeeBps: "0"`, `maxBuilderFeeBps: "0"`, `routingFeeBps: "0"`, `settlementFeeBps: "0"`. A `distinct_on: maxBuilderFeeBps` query returns the single value `"0"`, and `where: {maxBuilderFeeBps: {_neq: "0"}}` returns an empty set.

Per the Builder Fees page **[added source]**: "A cap of `0` means builder codes are disabled for that pool." The SDK ships the matching revert selectors — `BuilderCodesNotSupported`, `BuilderFeeExceedsCap`, `BuilderFeeExceedsApproval`, `BuilderNotApproved`.

The binary pools *do* answer `getBuilderApproval` and `getEffectiveBuilderApproval` (both `0`), so the whole builder surface is deployed there — just capped at zero. **This is better than "unsupported": dreamDEX already operates builder codes at 1% on spot**, so there is a precedent to point at. But the cap is frozen per venue at creation, so it can only change for newly created venues.

### Two further limits

- **Not on the constructor.** `new SomniaMarkets({ indexerUrl, chain, wsRpcUrl, addresses, privateKey })` has no builder or attribution field, and there is no account- or API-key-level config — the SDK is keypair-based with no accounts layer.
- **Not on the unified tier.** `builder` appears only on raw trader params. `exchange.createOrder(...)` has no passthrough, so attribution forces you onto `exchange.trader.placeOrder` — the tier that also demands hand-quantized integer ticks and lots.

### One live-but-not-fee-bearing channel

`redeem` / `redeemMany` accept `operatorId?: number` ("Routing operator id (uint32) for attribution; 0 = none") and `venueId?: Hex`, and the indexer tracks `builderFeesCollected` per Operator and Venue. That is attribution plumbing, but at a zero cap it records nothing chargeable.

**Source:** `@somnia-chain/markets-sdk@0.28.1` → `dist/trade.d.ts`, `dist/tradeAbi.js` · https://docs.dreamdex.io/developers/http-api/builder-fees · live indexer + mainnet reads

---

## 6. Redemption — `exchange.trader.redeem(...)`, per position; batching exists but is undocumented

**Exact name and signature as documented on Recipes** — one call per `(market, outcome)` pair, inside a nested loop:

```ts
const res = await exchange.trader.redeem({
  marketId: marketId as `0x${string}`,
  market: oc.marketAddress,
  outcomeToken: oc.outcomeToken,
  outcomeIdx: outcome,
  amount: held[outcome],
});
```

**Manual per position, as written.** Recipes iterates settled markets, then outcomes within each. Voided markets need both sides claimed explicitly: "Voided: claim both sides at 0.5. Resolved: only the winning side pays" — and "The convenience method infers the winner from the market, which is meaningless on a voided market where both sides pay 0.5."

### But the SDK ships a batch call Recipes never mentions

```ts
redeemMany(params: RedeemManyParams): Promise<TxResult>;

export interface RedeemManyParams {
    /** Per-market redemptions. `outcomeIdx` is required per entry (0 = YES, 1 = NO). */
    entries: { marketId: Hex; outcomeIdx: 0 | 1; amount: bigint }[];
    operatorId?: number;
    venueId?: Hex;
    outcomeToken?: Address;
    module?: Address;
    autoApprove?: boolean;
    gas?: bigint;
}
```

### And a relayer path well suited to a custody-free agent

```ts
signRedeemAuth(params: SignRedeemAuthParams): Promise<RedeemAuthorization>;
redeemFor(params: RedeemForParams): Promise<TxResult>;
```

Documented as: "The on-chain payout is hard-pinned [to the owner, who] keeps every cent of the proceeds" and "The caller pays gas; the module pays the owner." The owner pre-signs; AgentRail submits and pays gas; proceeds cannot be diverted. **Neither `redeemMany` nor `redeemFor` appears on the Recipes page** — worth knowing before hand-rolling the loop.

### Automation boundary

Resolution is automatic; redemption is not. "When the oracle posts the settlement answer at expiry, **Somnia's on-chain reactivity delivers that event straight to the hub's callback** — no keeper, no cron job, no operator in the loop… redemption opens immediately." Claiming still requires someone to send a transaction.

**Two traps:** settled markets vanish from discovery — "the registry sweep behind `loadMarkets()` skips finalized binary markets outright — so filtering it for inactive rows returns an empty set and a redeem-by-scan bot silently reports nothing to claim while real winnings sit unredeemed." Use `listBinaryMarkets({ status: "Finalized" })`. And "Redeeming a losing position does not revert. It succeeds and pays nothing, so check the outcome before you spend gas."

**Source:** https://docs.dreamdex.io/developers/event-contracts/recipes · `dist/trade.d.ts`

---

## On-chain verification summary

All reads live against `api.infra.mainnet.somnia.network`, each with a matched spot control.

| Read | Binary pool | Spot control | Interpretation |
|---|---|---|---|
| `getMaxBuilderFeeBpsTimes1k()` | `0` | `100000` (1%) | Builder codes **disabled on event contracts**, live on spot |
| `getBuilderApproval(a,b)` | `0` | `0` | Builder surface **deployed** on binary |
| `getEffectiveBuilderApproval(a,b)` | `0` | `0` | Builder surface deployed on binary |
| `SpotPoolRegistry.isRegistered(pool)` | `0` | `1` | Binary pools **not registered** → global grants can't reach them |
| `isOperatorAuthorized(o,op,sel)` | **REVERT** | `0` | Pool-side pre-flight **absent on binary** |
| `OperatorPermissionsRegistry.isApprovedForPool(...)` | `0` (clean) | `0` (clean) | Grants **are expressible** for binary pools |
| `placeBinaryOrderFor(...)` | `0x3fb0ba2e` = `OnlyApprovedContracts()` | same error | Function **deployed and dispatched** |
| `totallyFakeFn12345()` (control) | `0x` empty | `0x` empty | Absent functions revert with empty data |

**Pool census (indexer):** 6,142 distinct binary pool addresses across 6,660 binary markets ever created — a recycling factor of **1.1**. Recycling happens (~518 pools have served more than one market) but the dominant pattern is a **fresh pool address per window**.

---

## Changes this forces

**✅ Wallet-pull custody — the assumption holds, and survives delegation.** Default is auto-pull from wallet with refunds back to wallet. The operators page confirms this persists under delegation: "an operator's `placeOrderFor` pulls the owner's input from the **owner's wallet** and delivers fills back to it… the operator funds nothing." The bot-kit's `setManualVaultMode` + `depositVault` is *the bot-kit's choice*, not a requirement. **Do not copy it by default** — it would reintroduce a deposit step you don't need.

**⚠️ No deposit step — true for trading, but onboarding is not zero-step.** Two prerequisites remain: (a) the user must hold USDso, which almost nobody does — a LayerZero deposit, a CLOB buy, or a 5–30 minute Frax mint; (b) they need SOMI for gas outside the sponsored pairs. Whatever the product says about "no deposit," USDso acquisition has to be in the flow.

**🔴 Builder-fee-on-every-order — broken as deployed.** `maxBuilderFeeBps` is `0` on every event-contract venue, which the docs define as builder codes *disabled*; a non-zero `builderFeeBpsTimes1k` will revert. dreamDEX also zeroes maker, taker, and settlement fees, so there is no rebate to split. Options: ask dreamDEX to set a non-zero cap on **new** event-contract venues (they already run 1% on spot); monetize off-chain (subscription / seat / spread); or use `operatorId`/`venueId` attribution to evidence volume for an off-chain rev-share. **Resolve this before building more of the monetization path.**

**🔴 Operator-grant lifecycle is the real blocker on autonomy.** Per-pool grants are the *only* path for event contracts (binary pools are not in `SpotPoolRegistry`, so the global branch of the resolution rule can never fire), and a new pool address appears almost every window. Net effect:

> Per-pool grants only + a fresh pool per window = **one user signature per market window.**

For 5-minute or hourly cadences that is fatal to autonomous operation. Three ways out, in descending preference:

1. **Ask dreamDEX to register event-contract pools in `SpotPoolRegistry`.** Then one `setOperatorApprovalGlobal` covers all of them, including future ones. Smallest change on their side, largest unlock on yours.
2. **Get an AgentRail contract onto the approved-contracts allowlist** (the `OnlyApprovedContracts()` path). Removes per-user grants entirely, but it is a permissioned integration and puts you in the order path as a contract.
3. **Grant per pool as windows roll.** Works today with no cooperation, but costs a signature per window — viable only for long-dated windows.

**🟡 Session keys need SDK-level work for event contracts.** Delegation is mechanically available — `placeBinaryOrderFor` is deployed and grants are expressible — but markets-sdk does not expose it: the binary `PlaceOrderParams` has no `owner` field and the grant helpers sit under `spot/`. AgentRail must encode `placeBinaryOrderFor` against the exported ABI. Also pre-flight authorization via the registry's `isApprovedForPool`, **not** the pool's `isOperatorAuthorized`, which reverts on binary pools.

**⚠️ Attribution and correctness both force you off the unified tier.** `builder` isn't on `createOrder`, and the 18-decimal float bug means `createOrder`'s price conversion fails on mainnet regardless. Plan on `exchange.trader.placeOrder` with integer ticks and lots as the primary order path from day one, not as an optimization.

**➕ Free wins available.** `redeemMany` (one tx, many positions) and `signRedeemAuth`/`redeemFor` (user pre-signs, AgentRail submits and pays gas, proceeds hard-pinned to the user) are both shipped and both absent from the docs. The relayer path in particular enables a genuinely custody-free "auto-claim winnings" feature.

---

## Open items

Both original on-chain questions are now closed. What remains needs a human answer from dreamDEX — and both can go in a single message:

1. **Will you register event-contract pools in `SpotPoolRegistry`?** Without it, a global operator grant cannot reach event contracts and AgentRail needs a user signature per market window.
2. **Will you set a non-zero `maxBuilderFeeBps` on new event-contract venues?** Spot pools already run a 1% cap; event-contract venues are frozen at 0, which disables builder codes and removes on-chain fee attribution.

Lower-priority, resolvable without them:

- **Minimum viable SDK version.** Docs say "use 0.25.0 or newer"; latest is `0.28.1`, which is what was inspected. The `redeemMany` and binary-`builder` surfaces are confirmed there and not for earlier versions.
- **Why `isOperatorAuthorized` is absent on binary pools while `placeBinaryOrderFor` enforces authorization internally.** Cosmetic for now — pre-flight against the registry — but worth confirming the enforcement path with dreamDEX before relying on delegated event-contract orders in production.
- **The pool census (6,142 / 6,660) is as reported by the indexer** and was not cross-checked against chain history.
