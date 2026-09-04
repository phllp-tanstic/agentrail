# NO-side betting on DreamDEX Event Contracts — investigation findings

**Date:** 2026-09-02
**Scope:** Read-only research. No code written, no `.mjs` touched, no transaction broadcast.
**Question (verbatim from the project docs):** DreamDEX describes "four fill paths" — direct Up, direct Down, mint-a-pair, burn-a-pair. Which path(s) apply to placing a NO-side order? Is it `placeBinaryOrder` with a different outcome index, a different function (mint-a-pair then sell the NO leg), or something else?

---

## 0. TL;DR verdict

1. **The "four fill paths" are *fill-routing outcomes inside the matching engine*, not four different entry functions.** They describe what happens *after* two orders cross. The only discovery/settlement functions are `placeBinaryOrder` (orders), `mintSet`/`burnSet` (complete sets), and the settlement singleton (redeem).
2. **A NO-side directional bet is the same `placeBinaryOrder` call as YES — with `kind = 2` (`BUY_NO`), not a different function.** There is no "outcome index" argument in the v2 ABI; the first `uint8` is an `OrderKind` enum (`0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO`).
3. **The `price` argument is *always* the YES-side price** — even for NO orders. A correct BUY_NO must pass `price = 1 − downPrice`. This is stated by the SDK's ABI comments, implemented in the SDK's unified `createOrder`/`toNativePrice`, and independently **confirmed on-chain** by the escrow amount pulled in the repo's own historical BUY_NO transaction (see §5).
4. **The repo's two historical NO attempts never filled because they were priced in NO terms, not YES terms** (0.58 and 0.999 passed verbatim). Run 2's order was a NO bid at 0.001 in Down terms — a price with *zero* possible counterparty. Whether everything about run 1's non-fill is explained by mispricing alone is **still not fully certain** (see §7 — the repo's own record says the cause is "genuinely undetermined", and this investigation narrows but does not forensically close it).
5. **"Mint-a-pair then sell the NO leg" is NOT the way to place a NO bet.** That is market-making / inventory management (mint complete set → sell one leg). It is the docs' recommended flow only for *sell-side inventory*. A directional NO bet is simply `BUY_NO`.

> **Read §11 (addendum, 2026-09-02) before acting on anything here.** A follow-up
> scan of the live testnet indexer found that NO-side fills **are routine on this
> venue family — including the operator-4 venue AgentRail trades** — all settling as
> MINT_A_PAIR, and the decoded real BUY_NO placements confirm the YES-terms price
> convention from third-party usage. §11 also closes the "run-1 non-fill" gap via
> the empirically inferred mint crossing rule (`P_m ≥ P_t`). §7 items 1 and 3 remain
> the only genuinely open questions.

---

## 1. How this was researched

| # | Source | What it gave us |
|---|---|---|
| 1 | `docs.dreamdex.io` — fetched successfully (`.md` versions + llms.txt). Prior automated fetches that failed were a Windows path issue on our side, not robots-blocking; direct fetches work. | The four fill paths in DreamDEX's own words; escrow & complete-set semantics; recipes; contracts & addresses; gotchas. |
| 2 | `node_modules/@somnia-chain/markets-sdk@0.28.1` — `dist/tradeAbi.js`, `dist/writer.js`, `dist/orders.js`, `dist/store.js`, `dist/unified/exchange.js`, `dist/createClient.js`, `dist/binary/sets.js` | Exact ABI signatures, the `ORDER_KIND` enum, escrow math per side, the `createOrder` NO branch, the `toBinaryBook` derivation, and the `fillKind`/_isPair matrix. |
| 3 | Somnia testnet chain (read-only RPC + Blockscout API) | Decoded the two historical BUY_NO transactions' calldata and token transfers; confirmed verified-source state of the module proxy and the pool proxy. |
| 4 | This repo's research/ + build/ artifacts (`PROOF-LOG.md`, `phase-a-lifecycle.mjs`, `part3-win-proof.mjs`, `depth-probe.mjs`, `PART2-DEPTH.json`, `_log-entry-a1.md`, `run2-entry.md`, `dreamdex-verification.md`, `intent.mjs`) | The prior NO-side attempts, exact prices, tx hashes, gas. |

Caveat on the docs fetch: `docs.dreamdex.io` was fully reachable from this environment. The previous "robots-blocked" report was not reproduced here — the docs' own GitBook `llms.txt` says it is *published specifically for agents*.
---

## 2. The four fill paths, in DreamDEX's own terms (verbatim)

From `docs.dreamdex.io/developers/event-contracts/market-structure.md`:

> ## The order book: one book, two sides
> Up and Down trade on a **single** order book quoted in Up terms; a Down price is always `1 − up price`. Crossing orders settle by one of four paths:
>
> | Crossing pair | Path | What happens |
> |---|---|---|
> | Buy Up × Sell Up | direct | Up tokens ↔ collateral swap |
> | Buy Down × Sell Down | direct | Down tokens ↔ collateral swap |
> | Buy Up × Buy Down | **mint-a-pair** | Both pay collateral; the pool mints a fresh Up/Down pair, one side each |
> | Sell Up × Sell Down | burn-a-pair | Both positions burn; each seller is paid their share |
>
> Mint-a-pair is the cold-start mechanism: two opposite-side buyers need no seller and no market maker — which also means you can quote **both sides with zero inventory** (a resting Buy Up at *p* plus Buy Down at *1 − p* is a complete two-sided quote).

And the same page's escrow section:

> * **Buys** escrow collateral at placement (worst case, vault-first: your per-pool vault balance is spent before your wallet).
> * **Sells** escrow the outcome tokens themselves — you can only sell what you hold. New tokens come from minting a **complete set**: 1 USDso mints 1 Up + 1 Down (`mintCompleteSet`), and merging a pair returns 1 USDso (`mergeCompleteSet`).
> * Refunds settle in your **wallet** …

The repo already quoted this table verbatim in `dreamdex-verification.md` (§2, lines 52–65) — this investigation independently re-fetched the same page and confirmed the quote is current.

**The same matrix exists in the SDK**, as a mirror of the pool's `BinaryPool._isPair` matrix (`dist/store.js:62–84`):

```ts
export function fillKind(takerSide, makerSide) {
    if ((takerSide === "BUY_YES" && makerSide === "SELL_YES") || ...) return "DIRECT_YES";
    if ((takerSide === "BUY_NO" && makerSide === "SELL_NO") || ...) return "DIRECT_NO";
    if ((takerSide === "BUY_YES" && makerSide === "BUY_NO") || ...) return "MINT_A_PAIR";
    if ((takerSide === "SELL_YES" && makerSide === "SELL_NO") || ...) return "BURN_A_PAIR";
    ...
}
```
`store.js` comment: *"Classify a binary fill from its two sides … Mirror of the indexer's `fillKind` (`BinaryPool._isPair` matrix — keep in lockstep)."*

---

## 3. Which fill path(s) correspond to a NO-side directional bet?

A directional NO bet = **buy the Down outcome = `BUY_NO`**. Depending on what it crosses, it settles by one of exactly two of the four paths:

- **Direct Down** — when BUY_NO crosses a resting **SELL_NO**. ("Buy Down × Sell Down → direct: Down tokens ↔ collateral swap.")
- **Mint-a-pair** — when BUY_NO crosses a resting **BUY_YES**. ("Buy Up × Buy Down → mint-a-pair: both pay collateral; the pool mints a fresh Up/Down pair, one side each.") — this is the realistic path on the current testnet book, which is essentially all BUY_YES resting depth (see §6).

There are **no separate "go short" or "NO" functions**. The four paths are *matching outcomes*, named by the pair of sides that crossed. You never "call" mint-a-pair or direct-Down; you place an order and the engine decides.

`docs.dreamdex.io/developers/event-contracts.md` (the developer overview) makes the two-sided-book point directly:

> **One book, two sides.** Up and Down trade on a single order book; a Down price is always 1 minus the Up price. Two opposite-side buyers can cross with no seller at all — the pool mints a fresh Up/Down pair from their combined collateral (so you can quote both sides with zero inventory).

---
## 4. Is it the same `placeBinaryOrder` call with a different index? Yes — and "index" is the `kind` enum, not an outcome index.

### 4a. The ABI (from the installed SDK 0.28.1, `dist/tradeAbi.js:11–20`)

```ts
export const binaryPoolWriteAbi = parseAbi([
    // Settlement-extraction v2: ... `kind` is the OrderKind enum
    // (0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO); `price` is always the
    // YES-side price. builderFee MUST be uint96 ...
    "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
    "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
    ...
    "function mintSet(address yesTo, address noTo, uint256 amount)",
    // Burn complete-pair: caller surrenders `amount` YES + `amount` NO, gets
    // `amount` collateral back ...
    "function burnSet(uint256 amount)",
]);
```

Selector computed locally: `keccak("placeBinaryOrder(uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)")[:4] = 0x718c2d4d` — exact match to the selector Ground Truth already confirms the repo trades with. So the "outcome index (0 = YES)" in our earlier project notes is really `kind = 0 = BUY_YES`.

The enum, from `dist/writer.js:36–46` (identical to the comment in `tradeAbi.js`):

```ts
/**
 *  v2 OrderKind enum for `placeBinaryOrder` (0 BUY_YES, 1 SELL_YES, 2 BUY_NO,
 *  3 SELL_NO) — the side is explicit, NOT encoded in userData. The pool maps kind
 *  onto the base book's (isBid, price) internally; the SDK just forwards the enum.
 */
export const ORDER_KIND = { BUY_YES: 0, SELL_YES: 1, BUY_NO: 2, SELL_NO: 3 };
```

Also from `dist/store.js:47–61`: `ORDER_KIND_SIDE = ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"]` is described as the *"ONLY authoritative side-attribution source — v2 no longer encodes the side in `userData` (now opaque MM bookkeeping)"*.

### 4b. Per-side escrow — confirmed by the SDK and by on-chain behavior

`dist/writer.js:458–476`:

```ts
    // v2: the YES/NO side is an explicit OrderKind enum ... NOT encoded in userData ...
    function escrow(p, { outcomeToken, yesId, noId, collateral }) {
        switch (p.side) {
            case "BUY_YES":
                return { kind: "erc20", token: collateral, amount: (p.quantity * p.price + oneBase - 1n) / oneBase };
            case "BUY_NO":
                return { kind: "erc20", token: collateral, amount: (p.quantity * (oneBase - p.price) + oneBase - 1n) / oneBase };
            case "SELL_YES":
                return { kind: "erc6909", outcomeToken, id: yesId, amount: p.quantity };
            case "SELL_NO":
                return { kind: "erc6909", outcomeToken, id: noId, amount: p.quantity };
        }
    }
```

Read this carefully: **BUY_NO escrows `qty × (1 − price)`.** Since the escrow is derived from `(1 − price)`, `price` *must be in YES terms* or the escrow is wrong. This is *not* an implementation quirk we are inferring — it is **observable on chain** (next section).

### 4c. The SDK's own combined path for buying NO

`dist/unified/exchange.js` — `createOrder` on a binary market (the documented way to trade by symbol):

```ts
if (t.market.marketType === "BINARY") {
    const yesish = t.outcomeIndex !== 1;
    const binarySide = yesish
        ? side === "buy" ? "BUY_YES" : "SELL_YES"
        : side === "buy" ? "BUY_NO" : "SELL_NO";
    result = await this.trader.placeOrder({
        pool: t.pool,
        side: binarySide,
        price: this.toNativePrice(t, limitPrice),
        quantity,
        orderType, ...
    });
}
```

with the price converter:

```ts
/** YES-terms raw price for this tradable's human price (NO inverts). */
toNativePrice(t, price) {
    const d = this.decimalsOf(t);
    const raw = Structs.toRaw(price, d.price);
    // The NO complement `one - raw` preserves grid alignment ...
    if (t.market.marketType === "BINARY" && t.outcomeIndex === 1)
        return 10n ** BigInt(d.price) - raw;   // <- For the #NO symbol: price := 1 − downPrice
    return raw;
}
```

And the docs' Recipes page states the display convention: *"Prices are Up probabilities in (0, 1). The Down book is the same book read from the other side: quote `no` and the SDK converts to Up terms for you."*

**Bottom line (ABI + SDK): a NO-side order is `trader.placeOrder({ side: "BUY_NO", price: 1 − downPrice })` / `createOrder("<symbol>#NO", "limit", "buy", qty, downPrice)`, which encodes `placeBinaryOrder(2, ONE − downPrice, ...)`.** Mint-a-pair is not something you *call* — it's the settlement path when your BUY_NO crosses a BUY_YES.

---
## 5. On-chain confirmation: the historical BUY_NO attempt proves the price convention

The repo already broadcast two BUY_NO orders (Phase A runs 1 and 2). Both are on testnet and both were decoded in this investigation (read-only):

| | Run 1 | Run 2 |
|---|---|---|
| Tx | `0xb6812575a71e719041feb64c3b47808dd11e2c6586b8b12e52029d417b493e19` | `0x206c28cf1cb0ace32cce839ffbf0670b5db942a60c8a2dd89d79aefc2c6050b5` |
| Block | 469932354 | 470423028 |
| `placeBinaryOrder` args | `kind=2`, `price=580000` (0.58), qty 1.0, expire pinned | `kind=2`, `price=999000` (0.999), qty 1.0, expire pinned |
| Gas | 281,962 | 281,962 (byte-identical) |
| Logs | 4 | 4 |
| NO tokens received | 0 | 0 |

Decoded run-2 calldata (from the chain, via RPC — same bytes confirmed by Blockscout `raw_input`):

```
0x718c2d4d  kind=2  price=999000(0.999)  qty=1000000  expireNs=1787615220000000000  orderType=0  smo=0  builder=0x0  fee=0  userData=0
```

**The decisive on-chain detail:** Blockscout's token-transfer record for run 2 shows tUSDC moved from the wallet to the pool of **`1000` raw units (0.001 tUSDC)**. For a 1.0-unit BUY_NO at price 0.999:

- if the pool treated `price` as the NO-side price (the repo's assumption), escrow should have been ≈ `qty × 0.999` = 0.999 tUSDC → **does not match**;
- if the pool treated `price` as the **YES-side** price (the SDK convention), escrow should be `qty × (1 − 0.999)` = 0.001 tUSDC → **exact match**.

So the pool itself escrowed this BUY_NO according to `(1 − price)` — confirming `placeBinaryOrder`'s `price` argument is the YES-side price for every kind, exactly as the SDK comments claim. The repo's two NO attempts passed Down-term prices (0.58, 0.999) into a YES-term field. Their effective bids were:

- Run 1: NO bid at Down-price **0.42** (price arg 0.58).
- Run 2: NO bid at Down-price **0.001** (price arg 0.999).

Run 2's order could only ever have crossed a seller giving NO away at ≤ 0.001, or a BUY_YES bidding ≥ 0.999 — that is not a fillable order under any book state. **Run 2's non-fill is fully explained by price convention (mispricing), not by a missing NO side.**

Run 1 is *consistent with* the same explanation (a NO bid at 0.42 needs a genuine SELL_NO at ≤ 0.42 or a resting BUY_YES ≥ 0.58; see §7 for exactly why this is not 100% closed).

---

## 6. Why the NO "liquidity" the repo saw was a display artifact

`dist/orders.js:164–177` — the SDK derives the 4-sided book from the pool's 2-sided YES-terms book:

```ts
/**
 *  Expand a YES-terms book into the 4-sided binary shape: NO bids come from YES
 *  asks inverted (price = 1 − yesPrice) and vice-versa; quantities carry over.
 *  Shared by the on-chain read and the live-store book.
 */
export function toBinaryBook(yesBids, yesAsks, oneBase) {
    const noBids = yesAsks.map((l) => ({ price: oneBase - l.price, quantity: l.quantity }))...
    const noAsks = yesBids.map((l) => ({ price: oneBase - l.price, quantity: l.quantity }))...
    return { yesBids, yesAsks, noBids, noAsks };
}
```

`client.getBinaryOrderBook(pool)` (one-shot chain read) and `getLiveBinaryOrderBook` both go through this (`dist/createClient.js:211–234`, `453`). **There is no independent on-chain "NO book"** — the pool has one book, quoted in YES terms; `noBids`/`noAsks` are the same YES levels inverted (a "noAsk at 0.75" is literally a resting BUY_YES at 0.25). This is exactly what the repo's own `PART2-DEPTH.json` "mirror test" found (3/3 exact mirrors) and what `part3-win-proof.mjs` concluded: *"the NO side is a display mirror with zero literal resting orders."*

Consequences for implementation:
- **Bidding against a displayed `noAsk` is bidding against a BUY_YES order.** It can only fill via **mint-a-pair**, and only when prices satisfy the pool's crossing rule for two buys (see §7).
- On the testnet book seen in the probes, a NO taker's realistic fill path is **mint-a-pair** against resting BUY_YES liquidity, or placing your own BUY_NO to rest and waiting for a BUY_YES to cross it.
- `SELL_NO` orders are *real* too — but on the observed testnet book nobody rests sell-NO depth, so the **direct Down path** was not executable at the probe times.

---
## 7. What is still genuinely unknown (explicit gaps — not papered over)

1. **The pool's exact mint-a-pair crossing rule (price side, sum/exact-complement conditions) is unverified.** The SDK `_isPair` matrix tells us *which side-pairs* mint, burn, or trade direct — it does not tell us the price condition that decides a cross. The pool implementation contract (`0x48e523c9f22f98548d263f0aD444D732e5202C0E`, beacon impl of the run-2 pool `0x141f15dd…`) is **not source-verified** on either the testnet or mainnet explorer (both "/api?module=contract&action=getsourcecode" calls returned empty result arrays). The BinaryMarketsModule proxy is verified (`0x3ecC694C…` = `ERC1967Proxy`, impl `0x24f4607fbc0e3e3920ff6b054e6852dc0909c97c`), but the module doesn't contain the matching logic.
   - **What would confirm it:** access to `somnia-chain/somnia-dex-protocol` (the `somnia-dex-protocol/=lib/…` remapping in the verified build settings) — the contracts/SDK repo `somnia-chain/somnia-markets` is not publicly listed; or verification of the pool implementation on an explorer; or observed real mint-a-pair fills.
2. **Run 1's non-fill is not forensically closed.** The run-1 write-up (`_log-entry-a1.md`) shows the *snapshotted* book had a best NO ask of 0.575 (i.e., a resting BUY_YES at 0.425) with a BUY_NO bid at 0.58; under either price convention such a pair *ought* to have been crossable (sum 1.005 ≥ 1; or a NO bid ≥ the NO ask). It did not fill. The most probable explanations, in order: (a) the mirrored level was stale — the book demonstrably moves in seconds (the same run's YES fill charged 0.245 against a *displayed* best ask of 0.277, and the Phase-B log later recorded a 497000→212000 move inside ~30s); (b) some pool rule around pair-mint price equality we cannot see without the source. Because the exact placement-time book for run 1 was not saved as an artifact, **this cannot be adjudicated from the record.** The repo's own refusal text says the cause is "genuinely undetermined — logged, not root-caused" — this investigation narrows it to stale-book-vs-missing-source but does not claim to close it.
3. **The "0.250 / 200-unit" liquidity figure in `intent.mjs`'s refusal is not independently reproducible** — it matches the *shape* of the PART2 mirror data but not its prices (the saved probe shows 0.076/0.069/0.061 yes-bid levels, 200/330/460 units). It appears to have come from an unsaved live book. Under the SDK-correct price convention that figure would not have been crossable by either historical order anyway (0.58 and 0.999 are both above 0.25), which is consistent with both non-fills — but the *existence* of that specific resting liquidity is unverified.
4. **No real BUY_NO fill has ever been observed anywhere in this project's history** (including the two attempts above). "NO-side works" is therefore still a *strong inference* (ABI + SDK + on-chain escrow + matching-matrix), not a *proven fact*.
   - **What would confirm it:** a real NO-side fill on testnet, ideally a BUY_NO placed with an SDK-correct converted price (`price = ONE − downPrice`) against a live resting BUY_YES level (mint-a-pair), plus a subsequent redeem paying out. That is exactly the proof the Production Roadmap Tier 0 #1 gate should require.
---

## 8. Implementation implications (what a future build must get right)

These are research conclusions, not code — no `.mjs` has been modified.

1. **Encode NO as `placeBinaryOrder(kind=2, price=oneBase − downPrice, …)`.** Same call, same 9 args, same selector `0x718c2d4d`; the `kind` slot changes from 0 to 2 and the price is converted.
2. **Do not bid against `noAsks`.** They are derived. Read `yesBids` (or the unfiltered levels) to find the real counterparty; for a NO taker the realistic fill is mint-a-pair against a resting BUY_YES, not direct.
3. **`mintSet`/`burnSet` are for inventory, not for taking a NO position.** "Mint-a-pair then sell the NO leg" is the docs' sell-side workflow: `mintSet(symbol, N)` → `createOrder("<symbol>#NO", "limit", "sell", N, price)` — i.e. `SELL_NO`. If the goal is *negative exposure* (bet Down), just `BUY_NO`.
4. **Slippage/sizing tooling must use the same price axis as the pool.** The SDK's `quoteBinaryStakeOverBook`/`quoteBinarySellOverBook` kernels (which sweep `noAsks`/`noBids` and convert to YES-terms via `oneCollateral − price`) are the reference implementations for a correct quote/limit.
5. **The direction gate in `intent.mjs`/`mcp-core.mjs` and the `direction_not_supported` refusal can cite this report** when NO support is unblocked by a live fill proof.
---

## 9. Sources & citations

**Docs (fetched 2026-09-02, all reachable; `.md` versions):**
- `https://docs.dreamdex.io/developers/event-contracts/market-structure.md` — four fill paths table, escrow, lifecycle, one-book/two-sides ("Mint-a-pair is the cold-start mechanism…").
- `https://docs.dreamdex.io/developers/event-contracts.md` — "One book, two sides…" overview; SDK usage; "Mint and merge complete sets (1 USDso ⇄ 1 Up + 1 Down) for sell-side inventory."
- `https://docs.dreamdex.io/developers/event-contracts/recipes.md` — price convention ("Prices are Up probabilities…"), `mintSet`/`burnSet` snippets, redeem/`Finalized` scan.
- `https://docs.dreamdex.io/developers/event-contracts/contracts-and-addresses.md` — core addresses (match the repo's `CORE`/`mcp-core.mjs` constants), INCLUDING: "These are proxies, so each one's implementation can roll forward…".
- `https://docs.dreamdex.io/developers/event-contracts/gotchas.md` — 13 verified failure modes (gate on status, per-pool allowance, price grid, IOC/rest, expiry-as-dead-man's-switch, etc.).
- `https://docs.dreamdex.io/llms.txt` — full index; GitBook Ask usage (the `?ask=` endpoint timed out on two attempts — noted, not needed).

**SDK (installed, `@somnia-chain/markets-sdk@0.28.1`):**
- `dist/tradeAbi.js` — `placeBinaryOrder`/`placeBinaryOrderFor` full signatures + OrderKind comment; `mintSet`/`burnSet`; `binaryMarketReadAbi` (`payoutNumerators`, `yesId`, `noId`).
- `dist/writer.js` — `ORDER_KIND` enum (lines 36–46); escrow-per-side incl. BUY_NO `(qty × (ONE − price))` (lines 458–476).
- `dist/orders.js` — `toBinaryBook` derivation (164–177); `getBinaryBookParams`; `binaryOrderCall`/`placeOrder` (499–549).
- `dist/store.js` — `ORDER_KIND_SIDE` (47–61); `fillKind` = `_isPair` mirror (62–84).
- `dist/unified/exchange.js` — `createOrder` binary branch + `toNativePrice`/`priceView`/`sideView`; recipes examples incl. `createOrder("…#NO", "market", "sell", …)` and `mintSet`→sell-NO.
- `dist/createClient.js` — both binary-book reads route through `toBinaryBook`.

**On-chain (read-only):**
- `eth_getTransactionByHash` on `https://api.infra.testnet.somnia.network` for `0x206c28cf…` (run 2 BUY_NO): selector `0x718c2d4d`, `kind=2`, `price=999000`.
- Blockscout `https://shannon-explorer.somnia.network/api/v2/transactions/0x206c28cf…`: status ok, gas 281,962, token transfer tUSDC **1000 raw** (escrow = `(1 − 0.999)`), `proxy_type: eip1967_beacon`.
- Explorer `/api?module=contract&action=getsourcecode`: module `0x3ecC694C…` = verified `ERC1967Proxy` → impl `0x24f4607f…`; pool impl `0x48e523c9…` (testnet) and mainnet pools → **not verified**.

**Repo artifacts:**
- `build/_log-entry-a1.md` — run 1: BUY_YES filled, BUY_NO `0xb6812575…` at 0.58 rested (4 logs, 281,962 gas); book straddle evidence.
- `.scratch/run2-entry.md` + `build/PHASE-A-RESULT.json` — run 2: BUY_NO `0x206c28cf…` at 0.999; NO leg "failed to fill".
- `build/PART2-DEPTH.json` / `.scratch/part2-output.txt` — mirror test 3/3; displayed noAsks = inverted yesBids.
- `build/intent.mjs:129–136` — the current `direction_not_supported` refusal and its evidence text.
- `research/PROOF-LOG.md`, `research/AgentRail-Build-Spec.md` (§3/§10), `dreamdex-verification.md` — prior ground truth and the closed delegated path.
---

## 10. Suggested next step (for the Production Roadmap gate — not part of this read-only task)

One controlled test on testnet would close the two open gaps: place a **BUY_NO** with `price = oneBase − 0.25` (i.e., Down-price 0.25) in a 300s window whose book genuinely rests BUY_YES bids ≥ 0.75, sized at 1–2 units, then observe the fill → settle → redeem. If mint-a-pair fills it, both "NO-side works" and the mint crossing rule are demonstrated with a real receipt; if it does not, inspect the pool over the beacon impl or ask DreamDEX for the `somnia-dex-protocol` sources. That is the definitive evidence the Tier-0 gate should wait for.
---

## 11. ADDENDUM — 2026-09-02 follow-up: real NO-side fills observed on testnet (this closes most of §7)

Same read-only discipline (no key, no signing, no broadcast). Everything below was
recovered from the same testnet indexer (`https://dev.smk.somnia.host/v1/graphql`)
and RPC (`https://api.infra.testnet.somnia.network`) the repo already uses.
Reproduction scripts: `.scratch/no-side-scan.mjs` (order/fill census) and
`.scratch/no-side-decode.mjs` (calldata + venue decode).

### 11a. NO-side fills exist, on this protocol and on this project's own venue

Query: latest 100 fills whose maker side was `BUY_NO`/`SELL_NO` and latest 100
fills whose taker side was `BUY_NO`/`SELL_NO`. Both returned a full 100 (they are
recent and plentiful). Combined kind tally across the 200 rows: **196× `MINT_A_PAIR`,
4× `BURN_A_PAIR`, 0× `DIRECT_NO`.** No `DIRECT_NO` fill was found in any sample.

Scoped to the venue AgentRail trades (operatorId 4 / venue
`0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f`), the 10 most
recent NO-involving fills are all `BUY_YES × BUY_NO` MINT_A_PAIR, e.g.:
`0x40c8736f…` (t=1788316063), `0xb8d780d4…` (t=1788314542), `0x18ca0dc1…`,
`0xfd8186d3…`, `0xd8608a06…`. The most recent NO fill found on the wider testnet
(market id `…0x10a16`, operatorId 2 venue `0x679795a0…`, BTC 4h) is `0x8a59e2ba…`.

**Net effect on §7: "no real BUY_NO fill has ever been observed" is no longer true —
the project just never placed one correctly.** This venue fills NO orders routinely.

### 11b. Decoded real BUY_NO placements confirm the YES-terms price convention

Every real NO placement decoded via `eth_getTransactionByHash` is a plain
`placeBinaryOrder` (selector `0x718c2d4d`) with `kind = 2` and a **YES-term price**:

| Tx (taker BUY_NO) | price raw | ≡ Down limit | orderType | Fill |
|---|---|---|---|---|
| `0x8a59e2ba…` | 232000 (0.232) | 0.768 | 2 (MARKET/IOC) | MINT_A_PAIR @ 0.251 |
| `0x40c8736f…` | 515000 (0.515) | 0.485 | 0 (LIMIT) | MINT_A_PAIR @ 0.535 |
| `0xb8d780d4…` | 480000 (0.48) | 0.52 | 0 (LIMIT) | MINT_A_PAIR @ 0.500 |
| `0xc5672dd5…` (+ 3 more from same maker) | 570000 (0.57) | 0.43 | 0 (LIMIT) | MINT_A_PAIR @ 0.570 |

No real NO trader on testnet is sending Down-term prices. This independently
corroborates §4/§5 (ABI comment + SDK `createOrder`/`toNativePrice` + both
historical escrow amounts).

### 11c. The mint-a-pair crossing rule, inferred from real fills

In every decoded fill the resting **maker** is `BUY_YES` and the **taker** is
`BUY_NO`. With `P_t` = the NO order's YES-term limit and `P_m` = the resting YES
bid price (recorded fill price), the observable is consistently **`P_m ≥ P_t`**:
`0.535 ≥ 0.515`, `0.500 ≥ 0.48`, `0.570 ≥ 0.57`, `0.251 ≥ 0.232`. Equivalently, in
each side's own terms the two buyers' escrows sum to ≥ 1 (the mint must be fully
collateralized: `qty × P_m + qty × (1 − P_t) ≥ qty`). This matches the docs'
cold-start sentence — *"a resting Buy Up at p plus Buy Down at 1 − p is a complete
two-sided quote"* (sum exactly 1 is the boundary) — and the observed fills execute
at the maker's price (Gotcha #7: *"a taker is charged the fill price rather than
the price it offered"*).

**This closes §7 item 2 as well.** Under the correct price axis, both of the repo's
historical non-fills are now fully explained and no pool bug is needed:
- Run 2: `BUY_NO` at 0.999 (Down limit 0.001). Needs a YES bidder ≥ 0.999 to pair;
  none exists. Impossible order; the pool's 0.001 escrow was never going to clear.
- Run 1: `BUY_NO` at 0.58 (Down limit 0.42). The snapshot book held a resting
  BUY_YES at 0.425 → mint needs `0.425 ≥ 0.58` (false); combined escrow
  0.845 < 1. No cross was possible at that book. The order could only have filled
  if a YES bidder ≥ 0.58 appeared before expiry — none did within the window.
  The "stale book vs. hidden rule" ambiguity from §7 is resolved: the hidden rule
  and the stale book agree, and the non-fill follows from the rule alone.
  The rule is still **inferred from fills, not read from source** (the pool
  implementation remains unverified), so the exact boundary (`≥` vs `>`) stays
  unconfirmed by source — see §7 item 1, which remains open.

### 11d. Revised gap list (supersedes §7 where it conflicts)

| # | Status after addendum |
|---|---|
| 1. Pool mint rule from source | **Still open.** Inferred consistently from 6 decoded fills + both historical non-fills, but the pool implementation (`0x48e523c9…`) is still not source-verified on either explorer. Would close with the `somnia-dex-protocol` sources, an explorer verification, or a controlled self-placed mint fill. |
| 2. Run-1 non-fill | **Closed** — explained by the mint rule on the correct price axis (see 11c). |
| 3. `DIRECT_NO` path | **Still unobserved** (0 rows in samples). Sell-NO resting liquidity is essentially absent on these venues. Needs a real `BUY_NO × SELL_NO` fill (or an SELL_NO order someone crosses) to be proven live. |
| 4. "NO-side never filled" | **Closed** — real NO fills are routine on the project's own venue; the project simply never encoded one correctly. |
| 5. Exact fill-price convention on multi-level mint sweeps | Unobserved detail; not needed for a single-level taker order. |

### 11e. What a future build should encode (unchanged from §8, now with live precedent)

`placeBinaryOrder(2, ONE − downPrice, qty, …)` is exactly what the live NO traders
on this venue are sending. A NO taker should cross the real `yesBids` (the resting
BUY_YES side), with the crossing condition `yesBidPrice ≥ ONE − downLimit`
(i.e., send `price = ONE − downLimit ≤ yesBidPrice`). The §10 suggested test
remains the definitive end-to-end proof for this project's own wallet (fill → settle
→ redeem), but the "will the venue fill a correct NO order" question is now
answered by third-party fills rather than open.