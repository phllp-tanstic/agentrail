# AgentRail — PHASE D LOG (slippage clamp, dedicated wallets, intent validation)

Live, append-only record of Phase D. Written incrementally, one entry per task.

Session start: 2026-08-26.

## Ground truth carried in from Phase C (NOT re-verified)

- Four MCP tools built and proven against real testnet transactions:
  `list_markets`, `place_order`, `get_position`, `redeem`.
- Risk guardrails are **concurrency-safe** (reserve-on-check), with a committed
  re-runnable suite at `build/risk-test.mjs` — **28/28**.
- The redeem guard is proven live in **both** directions (BLOCK preserved a losing
  position; ALLOW paid +1.000000 tUSDC).
- Scope fences stay and are enforced, not documented: **YES direction only**,
  **300s windows only**, **self `placeBinaryOrder` path only**.
- `place_order` fill resolution is three-state (`FILLED` / `PENDING` /
  `NOT_FILLED`); `filled: null` means PENDING and must not be read as a non-fill.

## Scope for this session

| Task | Change |
|---|---|
| 0 | Clamp `maxSlippagePct` to a server-side ceiling (defence-in-depth) |
| 1 | `generate_wallet` + `get_wallet_balance` — purpose-only keypair per session |
| 2 | `parse_intent` — validate/normalize already-extracted intent into `place_order` args |

**Explicitly out of scope, not started:** the trade log (next session), momentum
ladder, wiring generated wallets into `place_order`'s signing path.

---

## TASK 0 — `maxSlippagePct` clamped to a server-side ceiling

**Why this is defence-in-depth and not a design change.** `maxSlippagePct` stays a
caller-adjustable parameter — unlike the risk caps, which are env-only and absent
from the tool schema by design. The difference is deliberate: the risk caps bound
*total exposure*, so a caller raising one defeats the guardrail entirely; slippage
tolerance is a per-order execution preference, like a limit price. What a ceiling
prevents is not misuse of a legitimate knob but an *absurd* value silently
disabling a protection the caller still believes is on.

**Implemented:** `SLIPPAGE_PCT_CEILING = 50`. A request above it is **clamped, not
rejected** — the order still proceeds, under the ceiling. Rejecting would turn a
harmless overshoot into a failed trade; clamping keeps the protective floor while
honouring the intent.

### Second defect found in the same expression, fixed in the same edit

Reading the parse line, `maxSlippagePct` was:

```js
const maxSlippagePct = Number(input.maxSlippagePct ?? input.max_slippage_pct ?? 5);
```

A non-numeric value (`"aggressive"`, `{}`, `[1,2]`) makes `Number(...)` return
**`NaN`**, and the guard is a single comparison:

```js
if (sizingMode === 'DOLLAR' && slippagePct > maxSlippagePct)   // NaN -> ALWAYS false
```

**Every comparison against `NaN` is false, so the slippage guard silently stopped
existing** — the order would broadcast with no slippage protection at all, and
nothing in the response would say so. That is the exact failure mode this task
exists to prevent, reached by a different input, so it is fixed here rather than
noted for later: a non-finite value falls back to the default of 5.

### The floor is deliberately NOT clamped

Only the ceiling is enforced. A negative `maxSlippagePct` makes the guard refuse
unconditionally (`0 > -1`), which is how Phase C exercised the refusal branch. That
is a degenerate input but it fails **closed** — it refuses orders, it does not place
unprotected ones. The rule applied: clamp what is unsafe, leave what is merely
strict. Clamping the floor would also have broken a working test technique for no
safety gain.

### Reported, never silent

The effective value and the fact of clamping are both in the response, so a caller
cannot be protected differently than it thinks:

```json
"slippage": {
  "maxSlippagePct": 50,
  "requestedMaxSlippagePct": 500,
  "clamped": true,
  "clampNote": "requested 500% exceeded the server-side ceiling of 50% and was clamped down. ..."
}
```

`zod` was left permissive (no `.max(50)`) so the clamp is what runs. A schema max
would make the MCP layer *reject* the call, which is the behaviour this task
explicitly did not want.

### Test — absurd value clamped, live

`maxSlippagePct: 500` on market `0x…9b84`, `targetDollarAmount: 0.35`:

| Field | Value |
|---|---|
| `requestedMaxSlippagePct` | **500** |
| effective `maxSlippagePct` | **50** — clamped |
| `clamped` | **true** |
| `ceiling` | 50 |
| observed `slippagePct` | −5.905% (favourable — the ask moved 779000 → 733000) |
| outcome | **`ok:true`**, FILLED 0.449 units for 0.319239 USD, reservation COMMITTED |

Result: **PASS** — clamped rather than accepted literally, and the order still
proceeded, which is the intended non-punitive behaviour.

Note the live run only exercises the clamp *path*, not the clamp *taking effect on a
refusal* — the observed move was favourable (−5.9%), so neither 500% nor 50% would
have refused it. What is proven live is that the effective value the guard uses is
50, not 500. The comparison arithmetic itself is Phase C-proven.

Also verified offline, since the live run exercises only one of these cases —
**8/8 PASS**:

| Input | Effective | Clamped | Note |
|---|---|---|---|
| `500` | **50** | true | |
| `1e9` | **50** | true | |
| `50` (exactly the ceiling) | **50** | false | boundary is inclusive, not clamped |
| `5` (default) | **5** | false | |
| `"aggressive"` | **5** | false | non-finite fallback |
| `{}` | **5** | false | non-finite fallback |
| `Infinity` | **5** | false | non-finite fallback — caught by `Number.isFinite`, not by the ceiling |
| `-1` | **-1** | false | floor deliberately not clamped |

`Infinity` is worth calling out: it is the one input that would defeat a
ceiling-only check written as `requested > CEILING` *after* coercion, since
`Infinity > 50` is true and would clamp — but `Number.isFinite` catches it first and
routes it to the default. Either path is safe here; the ordering is deliberate so
the *reason* reported is the accurate one.

---

## TASK 1 — dedicated purpose-only wallets

**Implementation.** New module `build/wallet.mjs` (store + keypair generation, no
chain access) plus `get_wallet_balance` in `mcp-core.mjs` (needs the RPC client).
Three tools registered: `generate_wallet`, `get_wallet_balance`, `list_wallets`.

### The custody claim has to change, and that is the most important thing here

Spec §3 calls the architecture "confirmed non-custodial, and it's the strongest
trust story in the whole pitch," on the strength of operator delegation: the
*owner's* wallet funds the order and receives the fill, and the operator key is
scoped by `OperatorPermissionsRegistry` to place/cancel/reduce so it
**architecturally cannot move funds**.

**A generated wallet whose private key AgentRail holds is a different model, and it
is custodial.** AgentRail can move those funds; nothing on-chain prevents it. The
protection is not cryptographic, it is exposure-limiting — the wallet is
purpose-only and holds only what the user deposits to trade.

Both designs are legitimate, and spec §2's product flow describes this one. But the
non-custodial claim **does not transfer to it**, so the tool says so in its own
response rather than letting a caller inherit the §3 framing:

> CUSTODIAL over this wallet. AgentRail generated and holds the private key
> server-side, so it CAN move these funds — nothing on-chain prevents it. […] Do not
> describe this wallet as non-custodial.

Flagging this rather than quietly shipping it: if the demo narrates "non-custodial"
while showing a generated wallet, that is a claim the judges could correctly
challenge. The accurate pitch is that **both** models exist — delegation for a
user's main wallet, a bounded purpose-only wallet for users who prefer not to
connect one at all.

### Design decisions worth recording

**`generate_wallet` is idempotent.** Calling it twice for the same `session_id`
returns the **first** wallet with `created: false`. Silently minting a second
keypair is the worst available behaviour: a caller that deposited into wallet A,
called again, and received wallet B would have **stranded the deposit** in an
address it no longer knows. `force_new: true` overrides, and even then the previous
record is re-keyed under a suffixed id rather than deleted, so its funds stay
reachable server-side.

**Atomic writes.** The store is written to a temp file and `rename()`d over the
target. `rename` is atomic within a filesystem, so a crash mid-write leaves either
the old store or the new one, never a truncated one. This matters more than in a
typical store: **a truncated store is unrecoverable loss of funds.**

**A corrupt store is never auto-replaced.** An unreadable file throws rather than
being reset to `{}`, which would orphan any funds it holds while appearing to work.

**tUSDC and SOMI are reported separately, not as one `funded` boolean.** They are
not interchangeable — tUSDC is the collateral an order spends, SOMI pays gas to
broadcast it — so a wallet with collateral but no SOMI **cannot place an order at
all**. `readiness.blockedBy` names which is missing.

**No export path, deliberately.** No function returns a private key. That keeps key
material out of model context and out of transcripts. The consequence, stated
because it is easy to forget: a user cannot independently sweep these funds without
server cooperation — the custodial tradeoff again.

### Limitations, stated plainly (same discipline as `risk.mjs`'s in-memory note)

1. **Keys are PLAINTEXT JSON on local disk.** No encryption, no KMS, no HSM. A real
   deployment needs one; this is hackathon scope.
2. **No recovery.** Raw keypairs, no seed phrase. Losing the file loses the funds.
3. **Single-process.** Writes are atomic against a *crash* but not against two
   *processes* writing concurrently, which could clobber.
4. **Not wired into signing.** `place_order` still signs with
   `AGENTRAIL_OWNER_KEY`. These tools create and observe a dedicated wallet;
   routing execution through it is separate, unimplemented work. The tool response
   says this in a `notWiredYet` field so it cannot be mistaken for a working
   end-to-end custody switch.

The store path is `AGENTRAIL_WALLET_STORE` or `build/.wallet-store.json`.
**`.gitignore` was updated before the file was ever created**, with three patterns
(`.wallet-store.json`, `build/.wallet-store.json`, `*.wallet-store.json`) so a
relocated store cannot be committed by accident. Verified: `git check-ignore`
matches, and `git status` does not list it.

### Test — live deposit, end to end

| Step | Result |
|---|---|
| `generate_wallet {session_id:"phase-d-test-user"}` | **`created: true`**, address `0x3c0551fE…3F1F`, no key returned |
| baseline `get_wallet_balance` | tUSDC **0**, SOMI **0**, `readyToTrade: false`, `blockedBy: ["no tUSDC collateral","no SOMI for gas"]` |
| deposit (ad-hoc script, from the funded key) | SOMI `0x4e1d67f3…ca4c` **success**; tUSDC `0x64414f58…1289` **success** |
| `get_wallet_balance` after | tUSDC **2** (raw `2000000`), SOMI **0.05** (raw `50000000000000000`), **`readyToTrade: true`**, `blockedBy: null` |

**PASS.** The deposit is reflected by direct on-chain reads
(`eth_getBalance` + ERC20 `balanceOf`), not an indexer, so it appears as soon as it
is mined.

The funding script lives in `.scratch/`, not `build/`, on purpose: **in production
the user deposits from their own wallet**, so AgentRail needs no funding tool. Adding
one would have implied a money-movement capability the design does not want.

### Test — safety behaviours, 6 refusals + idempotency + key non-leakage

| Case | Result |
|---|---|
| same `session_id` twice | **`created: false`**, identical address — no silent rotation |
| `session_id: ""` / omitted | **`session_id_required`** |
| unknown session | **`session_not_found`** |
| neither `session_id` nor `address` | **`session_id_or_address_required`** |
| `session_id` + a *different* `address` | **`session_address_mismatch`** — refuses rather than guessing |
| malformed address | **`invalid_address`** |
| raw address not in the store | **`ok`, `known: false`** — public read still served, flagged as unsignable |

**Key non-leakage, verified in its strongest form.** A weak substring check would be
misleading here, because the response *does* contain the literal text
`privateKey` — as the field name `privateKeyReturned: false`, an assertion rather
than key material. So the check used was direct: read the actual key out of the
store via the module-private accessor, confirm it is a real 64-hex key, then assert
**that exact string does not appear anywhere in the response**.

```
store DOES hold a key for it:              true
that exact key appears in the response?    false
contains any 0x+64hex private key?         false
```

---

## TASK 2 — `parse_intent`: validate and normalize, never interpret

**Implementation.** Pure logic in new module `build/intent.mjs`
(`normalizeIntent`, `normalizeWindowSeconds`, `normalizeDollarAmount`) — no chain
imports, no network, so it is fully testable offline. `parse_intent` in
`mcp-core.mjs` wraps it and adds the two things that need a market read: resolving
`asset` → a live `market_id`, and building the confirm-before-execute summary.

**The contract boundary, which is the design point.** This tool does **not** do
natural-language understanding and does not call an LLM. The calling agent reads the
user's sentence and extracts the fields; this validates and normalizes them. Keeping
the LLM out means the validation layer is **deterministic and offline-testable** —
which is the entire reason it is worth having as a separate tool rather than trusting
the model to produce correct `place_order` args directly.

`raw_text` is accepted and echoed back for audit, with an explicit note that it was
**not** parsed. That keeps the audit trail honest about where the interpretation
actually happened.

**It places nothing.** It returns `placeOrderArgs` for the caller to pass to
`place_order` after the user confirms, which is spec §2's confirm-before-execute
step.

### What "normalize" actually covers

| Input | Normalized |
|---|---|
| `up` / `long` / `higher` / `bullish` | `YES` |
| `down` / `short` / `lower` / `bearish` | `NO` → then **refused** |
| `bitcoin` / `XBT` / `BTC-USD` | `BTC` |
| `"5m"` / `"300s"` / `"5 minutes"` / `300` | `300` |
| `"$2.50"` / `"10 USD"` / `"$1,000"` | `2.5` / `10` / `1000` |
| `side` / `symbol` / `duration` / `stake` / `amount` | the canonical field names |

A NO synonym is resolved to `NO` **first and then refused**, rather than reported as
unrecognized — so the user is told their downside bet is unsupported, not that the
word "short" was gibberish. Assertion 13 pins that.

### Refusals, and two distinctions worth keeping separate

All use the established shape (`reason` = stable machine code, `detail` = prose):
`direction_required`, `direction_unrecognized`, `direction_not_supported`,
`asset_required`, `asset_not_supported`, `window_unrecognized`,
`window_not_supported`, `ambiguous_sizing`, `sizing_required`,
`invalid_target_dollar_amount`, `invalid_stake_units`, `no_tradeable_market`.

Two pairs that a single code would have conflated:

- **`window_unrecognized` vs `window_not_supported`.** `"next tuesday"` is
  uninterpretable; `60` is perfectly well-formed and merely out of scope. Those are
  different problems for a caller — one is a re-extraction, the other is telling the
  user the venue does not offer it.
- **`no_tradeable_market` is not an invalid request.** It means the intent was
  valid but no matching live market exists right now. The detail says so explicitly
  and lists `assetsAvailable`, because a caller that treats it as a validation error
  would wrongly tell the user their instruction was malformed.

**Nothing is defaulted where defaulting would pick a trade size.** A missing size is
`sizing_required`, even though `place_order` itself would default to 1.0 unit.
Choosing how much of a user's money to stake is not this tool's call. A missing
*window* does default to 300 — the only supported value — but attaches a warning
rather than doing it silently.

### The two scope refusals state the evidence accurately, including its limits

The brief described 60s windows as "documented as empty in testing." **The record
does not support that phrasing, so the refusal does not use it.** What PROOF-LOG
RUN 3 PART 2 actually shows:

- 0 of 2 sampled 60s books had any depth at T-47s; 2 of 2 sampled 300s books had 3
  levels per side.
- **Runs 1 and 2 both filled on 60s markets.** Run 2 read 200 units at T-26s.
- The log's own caveat: "12 live markets, 4 probed, one moment in time — this is a
  snapshot, not a distribution."

So the accurate statement is that 60s depth is **unreliable**, not absent, and the
fence is a deliberate reliability choice. The refusal says exactly that. The
practical outcome is identical (refuse, suggest 300) but a caller relaying "60s
markets are always empty" to a user would be passing on a claim the evidence does
not carry.

Similarly the NO refusal cites what the evidence **rules out**: run 2's book held
200 units of matchable liquidity behind the NO quote (`noAsk 750000` mirrors a real
resting `yesBid` at 0.250, 200× the 1.0 unit attempted), so a thin book does *not*
explain the non-fill. The display-layer-vs-matching-engine hypothesis is named as a
hypothesis and flagged unverified. The cause is undetermined, and the refusal says
so rather than inventing one. It also warns against substituting a YES bet, since
that is the *opposite* position.

### Test — 24/24 offline, `build/intent-test.mjs` (new, re-runnable)

`node build/intent-test.mjs`, no network. The four cases Phase D asked for:

| # | Case | Result |
|---|---|---|
| **1** | **valid** — YES / BTC / 300s / $2 | **PASS** — `{direction:'YES', window_seconds:300, targetDollarAmount:2}`, `market_id` correctly absent (the resolver adds it) |
| **2–4** | **NO requested** | **PASS** — `direction_not_supported`, citing the 200-units evidence, "cause undetermined", and a warning not to substitute YES |
| **5–6** | **60s window** | **PASS** — `window_not_supported`, `nearestSupported: 300`, evidence stated as a snapshot with "runs 1–2 DID fill" |
| **7–10** | **malformed / missing** | **PASS** — `"ten dollars"` → `invalid_target_dollar_amount`; missing size → `sizing_required`; missing direction → `direction_required`; missing asset → `asset_required` |

Plus 11–22 on normalization (synonyms, alternate field names, ambiguous sizing,
zero/negative sizes, the clamp warning, `raw_text` echo) and 23–24 unit-testing the
two normalizers across 21 further inputs, including `"$1,000"` → `1000` and
`"ten"` → `null`.

### Test — live, market resolution and the confirmation block

`{direction:"up", asset:"bitcoin", window:"5m", amount:"$2"}`:

| Field | Value |
|---|---|
| interpretation | `up -> YES`, `bitcoin -> BTC`, `"5m" -> 300s`, `"$2" -> $2 of cash` |
| resolved market | `0x…9bdf` BTC, pool `0xeff1a5…b1da`, gate **OPEN**, depth 990 units |
| best YES ask | `0.746` (implied probability **74.60%**) |
| estimated units | **2.680965** |
| max payout if YES wins | **2.680965 USD** → profit **0.680965**, payout multiple **1.3405×** |
| loss if YES loses | 2 USD |
| `placedAnything` | **false** |

**PASS.** The economics are the spec §2 confirmation content
(stake/direction/window/payout), carried with four caveats rather than presented as
a quote — the `cross_ticks` premium means real cost exceeds the at-ask estimate, the
grid shifts quantity, and this venue was observed moving 83% between two reads.

### Test — refusals short-circuit before any chain read

Measured through the full tool, not the pure function:

| Case | Result | Latency |
|---|---|---|
| NO side | `direction_not_supported` | **2ms** |
| 60s window | `window_not_supported` | **1ms** |
| malformed amount | `invalid_target_dollar_amount` | **0ms** |
| unsupported asset | `asset_not_supported` | **0ms** |
| valid, `resolve_market:false` | `ok`, `marketResolution.attempted:false` | **1ms** |

None of the refusals carry a `marketResolution` key at all, and all return in ≤2ms
— proof they refuse **before** any market read rather than validating afterwards.
That is the point of catching this ahead of `place_order`.

### Test — integration: `parse_intent` output fed straight into `place_order`

The test that actually matters for the contract, since `placeOrderArgs` is only
useful if it is directly consumable. Intent
`{direction:"up", asset:"ETH", window:"5m", amount:"$0.50"}`, no hand-editing
between the two calls:

| Stage | Value |
|---|---|
| `parse_intent` confirmation | *"Buy $0.5 of ETH YES on a 300s window settling in 217s."* |
| estimated cost / max payout / multiple | 0.5 USD / **0.776398 USD** / **1.5528×** |
| `placeOrderArgs` | `{market_id:"0x…9bec", direction:"YES", window_seconds:300, targetDollarAmount:0.5}` |
| `place_order` result | **`ok:true`**, **FILLED**, **0.776 units**, spent **0.493536 USD** |
| variance vs the $0.50 target | **−1.29%** |
| slippage observed | −1.24% (favourable), against the default 5% |
| reservation | **COMMITTED** |
| txs | `a1_approve`, `a1_placeBinaryOrder_BUY_YES` |

**PASS — the args were consumed with no modification.** Worth noting how closely the
confirmation predicted the outcome: estimated **0.776398** units against **0.776**
actually filled, the difference being `minQuantity` grid rounding. So the payout
figure shown to a user for confirmation was accurate to the grid on a book that
happened to stay stable — the caveats remain necessary precisely because that
stability is not guaranteed.

This run also drew a market with **217s** to expiry rather than the 49s of the
earlier test, which is the variance the finding below is about.

### Finding — `parse_intent` selects the SOONEST-settling window, which fights the confirm step

Market selection takes `candidates[0]` from `list_markets`, which sorts
soonest-settlement-first. In the live run above that resolved a market with
**49 seconds to expiry**.

For a *confirm-before-execute* flow that is the wrong end of the list: the user has
to read the confirmation and reply, and a 49-second window can expire during that
exchange — after which `place_order` correctly refuses on `status_gate_closed`, but
the user has been shown a confirmation for a bet that is no longer available.

Not changed, and reported rather than quietly "fixed", because the right default is
a product decision: soonest-settling is genuinely what a momentum trader wants, and
`list_markets`' own `min_seconds_to_expiry` (default 25) already floors it. The
mitigations in place are that `secondsToExpiry` is reported prominently in both
`marketResolution` and `confirmation`, and `otherCandidates` lists the alternatives
so a caller can choose a longer one. **The obvious refinement for a later session:**
a `min_seconds_to_expiry` passthrough on `parse_intent`, so a caller can demand
enough runway to confirm.

---

## PHASE D VERDICT

**PASS on all three tasks.** The MCP surface goes from 4 tools to 8.

| Task | Built | Tested |
|---|---|---|
| **0** — slippage clamp | `SLIPPAGE_PCT_CEILING = 50`, clamped not rejected, reported via `slippage.clamped` / `requestedMaxSlippagePct`. Floor deliberately left unclamped (fails closed). Plus a **NaN fallback** — a non-numeric value had silently disabled the guard entirely, since every comparison against `NaN` is false | **PASS** — live `500 → 50, clamped:true`, order still filled; **8/8** offline incl. `Infinity`, `{}`, the exact-50 boundary, and `-1` |
| **1** — dedicated wallets | `build/wallet.mjs` + `get_wallet_balance`; idempotent generation, atomic temp+rename writes, corrupt store never auto-replaced, tUSDC and SOMI reported separately, no export path | **PASS** — live deposit (2 tUSDC + 0.05 SOMI) reflected, `readyToTrade` false → true; **7** safety cases incl. 6 refusals; key non-leakage proven by comparing the response against the actual stored key |
| **2** — `parse_intent` | `build/intent.mjs` (pure) + `parse_intent` (market resolution + confirm-before-execute economics). No LLM, deterministic, places nothing | **PASS** — **24/24** offline; live resolution with payout economics; refusals short-circuit in ≤2ms with no chain read; **integration: `placeOrderArgs` fed unmodified into `place_order` → FILLED 0.776 units** |

**Regression:** 10 modules `node --check` clean; `risk-test` **28/28**;
`intent-test` **24/24**; `redeemGuard` **9/9**; all **8 tools** advertised over the
real MCP stdio protocol.

**Transactions this session (all status success):**

| Purpose | Hash |
|---|---|
| slippage-clamp live order (`0x…9b84`) | approve + order, FILLED 0.449u / 0.319239 USD |
| wallet funding — SOMI | `0x4e1d67f3…ca4c` |
| wallet funding — tUSDC | `0x64414f58…1289` |
| integration order (`0x…9bec`) | approve + order, FILLED 0.776u / 0.493536 USD |

### The one thing that needs a decision, not more code

**The custody claim.** Spec §3 calls the architecture "confirmed non-custodial" on
the strength of operator delegation. **The dedicated-wallet model added in Task 1 is
custodial** — AgentRail holds the key and can move the funds. Both models are
legitimate and §2 describes this one, but the §3 claim does not transfer to it. If
the demo narrates "non-custodial" while showing a generated wallet, that is a claim
a judge could correctly challenge. The accurate framing is that **both** paths
exist: delegation for a user's own wallet, a bounded purpose-only wallet for users
who prefer not to connect one. The tool responses already say this; the pitch needs
to match.

### Carried forward

- **Trade log** — explicitly next session's work, not started.
- **Wire generated wallets into signing.** `place_order` still signs with
  `AGENTRAIL_OWNER_KEY`; per-session signing is unimplemented and the tool says so
  in `notWiredYet`. This is the gap between "wallets exist" and "users have wallets".
- **Encrypt the wallet store** — plaintext keys on disk, no recovery path.
- **`min_seconds_to_expiry` on `parse_intent`** — so a confirm step has runway.
- **Dollar-target undershoot** (from Phase C) — re-derive quantity at placement-time
  price rather than reference price.
- **`reverted` branch** (from Phase C) — still needs an opportunistic live execution.
- **Risk + wallet state persistence** — both in-memory/flat-file, single-process.
- Not started, as scoped: momentum-ladder mode.

---

# PHASE D — CONTINUED (tasks A and B)

Same session, later. Tasks 0–2 above are committed (`549c2b2`). What follows is two
precision fixes to `parse_intent` and the trade log, which the section above listed
as "explicitly next session's work, not started".

---

## TASK A.1 — the 60s refusal wording

**The claim to fix was not where the brief expected it.** `parse_intent`'s own 60s
refusal was *already* accurate — Task 2 above corrected it in the previous session
and pinned it with assertion 6. Re-reading it confirmed it said "UNRELIABLE, not
that it is always absent" and cited runs 1 and 2 filling on 60s markets.

Grepping for the absolute phrasing found it in a **different, user-facing refusal**:

```js
// build/mcp-core.mjs — list_markets
`Only 300s windows are supported: 60s books were empty in every sample taken`
```

plus the same claim in mcp-core's scope-fence header comment. So the correction was
applied there. Two notes on why that is the same fix rather than a wider one:

- It is the identical overreach in the identical codebase, in a refusal a caller
  reads. Leaving it would mean `parse_intent` and `list_markets` state *different*
  strengths of claim about the same evidence.
- `parse_intent` cannot surface it — `normalizeIntent` refuses a 60s window before
  the market read, so the value reaching `list_markets` is always 300. The
  inaccuracy was reachable only by calling `list_markets` directly, which an agent
  is expected to do.

Both now say what PROOF-LOG's own verdict says — *"treat 60s as unreliable"*, and
*"so 60s books do fill in"*. `parse_intent`'s wording was sharpened further to state
**"UNRELIABLE, NOT confirmed empty"** and to say the probe covered **one specific
timing offset**, rather than leaving the reader to infer that from "T-47s".

**Not changed:** `part3-win-proof.mjs` and `phase-a-lifecycle.mjs` carry the phrase
in comments. Those are historical run scripts whose output is already in PROOF-LOG,
and their wording is precise about its own sample ("empty 2/2 at T-47s"). Rewriting a
completed run's comments would edit the record rather than the product.

Assertion 6 was tightened to fail on the absolute phrasing, not just to look for the
accurate one — it now asserts `!/(were|are|always)\s+empty/` against the detail, so
the claim cannot regress silently.

---

## TASK A.2 — `min_seconds_to_expiry` on `parse_intent`

**Implemented.** Default **60s** — the number is chosen for the confirm step, not
the market: the user has to read stake/direction/window/payout and reply, and the
Phase D finding above recorded a live resolution at **49s to expiry**, which cannot
survive that exchange.

Pure validation lives in `intent.mjs` as `normalizeMinSecondsToExpiry` (accepts
`90`, `"90"`, `"90s"`, `"2m"`), so it is offline-testable like the rest of that
module. `parse_intent` applies it to **selection**.

### The floor is applied to selection, NOT to visibility — deliberately

The obvious implementation is to pass the floor down to `list_markets`, which
already has a `min_seconds_to_expiry` parameter. **That would have hidden exactly the
information this feature exists to surface.** A filtered-out market is invisible in
the response, so a caller could not see that a nearer window existed and was
declined. Instead `parse_intent` asks `list_markets` for a *wider* set
(`min(ourFloor, 25)`) and applies its own floor afterwards, so:

- `otherCandidates` still lists every alternative with its real `secondsToExpiry`,
  now annotated `belowRunwayFloor: true|false`
- `marketResolution.runway.skippedForInadequateRunway` names what was dropped
- `confirmation.runwayNote` states the real runway to the user
- `min_seconds_to_expiry: 0` reproduces the old behaviour exactly

### The same NaN class of defect, caught before it shipped

The floor is applied as `secondsToExpiry >= floor`. **Every comparison against NaN is
false**, so `min_seconds_to_expiry: "soon"` would have rejected *every* market and
refused with `no_market_with_adequate_runway` — a refusal that looks correct and
states a cause that is not the real one. That is the Task 0 slippage defect reached
from a different input, so it is handled the same way: fall back to the default and
attach a warning saying why it was not passed through. A **negative** floor is
normalized to 0 with a warning that the protection is now off (meaningless rather
than unsafe — every market clears it).

### A new refusal code, kept distinct on purpose

`no_market_with_adequate_runway` is **not** `no_tradeable_market`. Same distinction
as `window_unrecognized` vs `window_not_supported`: the remedies differ. Markets for
the asset exist and are **open** — they just all settle too soon to confirm. A caller
told "no tradeable market" would wrongly report the venue as having nothing. The
detail says so explicitly (`NOT "no market available" (they exist)`), and when the
floor exceeds `list_markets`' own 290s ceiling it says the floor is **unsatisfiable
by construction, not by conditions** — a caller told "conditions" retries forever.

### Test — 29/29 offline (`build/intent-test.mjs`, +5 new)

| # | Case | Result |
|---|---|---|
| 25 | default is 60s, flagged `wasDefaulted` | PASS |
| 26 | `90` / `"90"` / `"90s"` / `"2m"`→120 / `0` / `45` | PASS — 6 forms |
| 27 | `"soon"` → falls back to 60 **with the NaN explanation** | PASS |
| 28 | `-30` → 0, warning says the protection is off | PASS |
| 29 | the floor never leaks into `placeOrderArgs` | PASS |

### Test — 11/11 live, and it reproduced the exact bad case

Polled live markets until one fell below the floor, then ran the **same intent twice
back to back**:

| Floor | Result |
|---|---|
| `0` | resolved market `…9f40` at **T=55s** — the old behaviour, reproduced |
| `60` (default) | **refused** `no_market_with_adequate_runway`, reporting the 53s market it declined |

Plus: `285` → refusal naming every skipped market with its timing; `400` →
`floorUnsatisfiableByConstruction: true`; a non-numeric floor still resolved a market
(T=262s) under the fallback rather than refusing everything.

Timing assertions are inequalities, never equality — the clock moves between two RPC
round-trips (a market read at T=98s reads 94s moments later), so an equality
assertion would fail for reasons that are not the code's.

### Finding — the floor is a GATE, not a SELECTOR, and the earlier session overstated the mitigation

Probing `listLiveBinaryMarkets` directly (no order-book or status reads) shows the
venue lists **exactly one market per (asset, interval) pair**:

```
BTC interval=  60s T=  26s     BTC interval= 300s T= 266s     BTC interval=3600s T=2066s
ETH interval=  60s T=  26s     ETH interval= 300s T= 266s     ETH interval=3600s T=2066s
...12 live markets, and 300s windows per asset: {"BTC":[266],"ETH":[266]}
```

So for a single asset on a 300s window there is **never a second candidate**.
Consequences, stated because they change what this fix actually does:

1. **`otherCandidates` is empty in practice.** The Phase D finding above proposed the
   floor partly because "`otherCandidates` lists the alternatives so a caller can
   choose a longer one". **There are no alternatives.** That mitigation was
   over-optimistic and is corrected here.
2. **The observable behaviour is refusal, not substitution.** The "skip to a later
   market" path is implemented and correct, but is unreachable under current venue
   behaviour. The live test therefore proves the **refusal** branch; the selection
   branch is proven only by the floor arithmetic. Flagged rather than implied.
3. **A real UX cost: the last 60s of every 300s cycle now refuses.** That is ~20% of
   wall-clock time in which a valid request is answered "wait for the next window".
   That is the right trade for a confirm-before-execute flow — showing a confirmation
   for a window that closes mid-conversation is worse — but it is a cost, not free,
   and the demo should expect to hit it.

---

## TASK B — the trade log

**Implemented.** New module `build/trade-log.mjs` (append-only store + adapters, no
chain access) and `get_trade_log`, registered as the **9th** MCP tool. Storage is
JSON Lines, one file per session, at `AGENTRAIL_TRADE_LOG_DIR` or
`build/.trade-log/<session>.jsonl`. **`.gitignore` was updated before any file
existed** — verified with `git check-ignore`, and `git status` does not list it.

### The design point: a log that recorded only successes would be worse than none

It would read as a complete history while hiding the decisions that mattered most. So
refusals are **first-class entries**, not errors dropped on the way out:

| Live entry | What it records |
|---|---|
| `ORDER → REFUSED (slippage_exceeded)` | *"NOTHING was broadcast"*, the machine reason, the prose why, and `riskReservation: RELEASED` |
| `ORDER → FILLED` | 0.458 units of ETH YES for 0.349912 tUSDC, variance −0.0251%, confirmed by ERC6909 delta |
| `REDEEM → REDEEMED` | paid 0.458 tUSDC, *"NOT transaction status — a losing redeem also returns success"* |
| `WALLET → CREATED` | the address, `CUSTODIAL`, `privateKeyReturned: false`, and that signing is not wired up |
| `WALLET → BASELINE` (`actor: OBSERVED`) | first balance read, explaining why no delta is shown |

### Six decisions worth recording

**1. Logging is wrapped AROUND `place_order`, not sprinkled through it.** That
function has **fourteen distinct terminal return paths**; a log call at each one
would eventually miss a new one. The core became `place_order_inner` and the export
wraps it, so every outcome — every refusal, a revert, a send error, and a thrown
error — produces exactly one entry by construction. `redeem` got the same treatment.

**2. A log write NEVER fails the action it records.** Every append is wrapped and
returns an error object rather than throwing. This is the one place the log is
allowed to lose information, and the reasoning is specific: by the time an order
outcome is logged, **the transaction has already broadcast**. Throwing there would
report a failure for an order that really filled and would unwind risk accounting for
a trade that genuinely happened — corrupting real state to protect a record of it.
The failure surfaces as `tradeLog.error` in the response instead of vanishing.
Assertions 29–30 pin this by monkeypatching `appendFileSync` to throw.

**3. A thrown error is logged and RE-THROWN unchanged.** An attempted order that blew
up belongs in an honest record, but swallowing the throw would change the tool's
contract. Its entry says the outcome is **UNKNOWN from that entry alone** and names
`get_position` as the way to find out — it does not claim nothing happened.

**4. Session ids are sanitised before becoming filenames.** A caller-supplied string
used as a path is a directory traversal. Only `[A-Za-z0-9._-]` survives, `..` is
collapsed, and an id with no alphanumerics becomes `unnamed` rather than a filename of
punctuation. **Disclosed rather than hidden: sanitisation is not injective** —
`"a/b"` and `"a_b"` share a file — so every entry carries the *original* id, keeping
the file unambiguous when two sessions collide into it. Assertion 2 proves
empirically that `"../../pwned"` writes inside the log dir.

**5. Actions and observations are marked differently (`actor`).** `AGENTRAIL` means
AgentRail did it; `OBSERVED` means AgentRail noticed an on-chain fact it did not
cause. **This is what makes deposits loggable at all:** AgentRail has no deposit tool
by design — in production the user deposits from their own wallet — so a deposit can
only be observed. `get_wallet_balance` compares against the last recorded balance and
writes `DEPOSIT_OBSERVED` / `BALANCE_DECREASE_OBSERVED` only when something actually
moved, with `performedByAgentRail: false`. Conflating the two would be a false claim
about a money movement. A decrease is logged too, flagged as usually an order's
collateral spend — logging only increases would leave gaps in a record that claims to
be complete.

**6. One entry PER REDEEM LEG.** A BLOCK and a payout in the same call must not merge
into a single "redeem happened" line — the refusal is the point. A `BLOCKED` entry
states the position was *"left INTACT, not burned"* and why that matters (a losing
redeem does not revert; it burns the position and pays zero with a success receipt).
Dry runs are logged but flagged `dryRun: true` so they can never read as a real
broadcast.

**PENDING is never collapsed.** `fill.filled` stays `null` and the summary says *"NOT
a non-fill… may still fill before expiry… Recheck with get_position"*.

### Deliberately NOT logged, and why

`parse_intent` and `list_markets`. Both validate or read and place nothing, and a
caller may run `parse_intent` speculatively many times per real order — logging them
would bury the actions the file exists to record. **That is a judgement call, not an
oversight**, and it cuts against the trust story in one way worth naming: a
`parse_intent` refusal *is* a refusal, and "the agent declined before touching the
chain" is a good demo beat. The module header says where a `recordIntent()` adapter
would go if that is wanted.

### Test — 31/31 offline (`build/trade-log-test.mjs`, new, re-runnable)

`node build/trade-log-test.mjs`, no network, throwaway temp log dir so it can never
touch a real history. Adapters are driven with **synthetic** tool responses on
purpose: the outcomes hardest to produce on demand against a live venue — a guard
BLOCK, a PENDING fill, a reverted broadcast, a zero payout — are exactly the ones an
audit log must get right, so they are pinned deterministically.

Coverage: 4 sanitisation/traversal cases · 6 order outcomes (FILLED / PENDING /
NOT_FILLED / REFUSED / REVERTED / thrown) · 6 redeem cases (BLOCK + payout in one call
as two entries, ZERO_PAYOUT flagged as guard failure, dry run, nothing-owed) · 6
wallet/deposit cases incl. the unchanged-balance no-op · 5 read-side cases ·
append-only verified **byte-wise** (new content starts with the exact previous bytes)
· malformed-line reporting · the two never-throw assertions · key material.

**Key non-leakage, in its strongest form.** A substring search for `privateKey` is
misleading here — the wallet adapter legitimately writes the field *name*
`privateKeyReturned: false`, an assertion rather than key material. So the offline
check is structural (no adapter dereferences `.privateKey` or calls
`_privateKeyForSession`; no entry carries a `"privateKey":` field), and the live suite
reads the **actual key** out of the store and asserts that exact string appears
nowhere in the real log file:

```
store holds a real key for this session:   true
that exact key appears in the log file:    false
```

### Test — live, a complete round trip in one log

Session `phase-d-tradelog`, real actions in order, then read back through the tool:

| # | Entry | Live result |
|---|---|---|
| 1 | `WALLET/WALLET_CREATED` | `0x288fB1b3…4Da7`, custody stated, no key returned |
| 2 | `WALLET/BALANCE_FIRST_OBSERVED` | baseline 0 tUSDC / 0 SOMI, `actor: OBSERVED` |
| 3 | `ORDER/PLACE_ORDER → REFUSED` | `slippage_exceeded`, nothing broadcast, reservation **RELEASED** |
| 4 | `ORDER/PLACE_ORDER → FILLED` | **0.458 units for 0.349912 tUSDC**, variance −0.0251% |
| 5 | `REDEEM/REDEEM_SCAN → NOTHING_OWED` | 100 finalized scanned, distinct from a refusal |
| 6 | `REDEEM/REDEEM_LEG → WOULD_REDEEM` | dry run, guard **ALLOW**, flagged `dryRun` |
| 7 | `REDEEM/REDEEM_LEG → REDEEMED` | **paid 0.458 tUSDC**, confirmed by balance delta |

```
total=7  refusedOrFailed=1  observations=1  dryRuns=2
byKind={"WALLET":2,"ORDER":2,"REDEEM":3}
byOutcome={"CREATED":1,"BASELINE":1,"REFUSED":1,"FILLED":1,
           "NOTHING_OWED":1,"WOULD_REDEEM":1,"REDEEMED":1}
integrity: malformed=0  seq=OK — unique
```

**13/13 live assertions PASS** (one was rewritten mid-run: the first version flagged
any 64-hex string as a possible key, which market ids also are — the strong version
comparing against the actual stored key is the one that counts, and it passed
throughout).

The round trip is the trust story in one file: spent **0.349912**, redeemed
**0.458**, net **+0.108088** — with the refused order sitting alongside it, saying
what was declined and why.

### Live gaps, stated rather than glossed

- **A guard BLOCK was not reproduced live this session.** The position won, so the
  guard correctly ALLOWed. The BLOCK entry's shape is pinned offline (assertions
  11–13) where the guard's output is controlled exactly, and the guard itself was
  proven live in **both** directions in earlier phases. What is *not* proven live is
  the adapter turning a real BLOCK into an entry.
- `ZERO_PAYOUT`, `PENDING`, `NOT_FILLED` and `REVERTED` entries are offline-only for
  the same reason — they need market conditions that cannot be summoned.
- **Multi-process `seq`.** The counter is in-memory, initialised from the file. A
  second process would restart it and emit duplicate `seq` values. `ts` and file order
  stay correct, and `get_trade_log` reports a `seqIntegrity` warning rather than
  presenting a corrupted sequence as clean. Same class of disclosure as `risk.mjs`'s
  in-memory note.
- **`_lastBalanceFor` scans every session file per call.** Fine at this scale,
  O(files × entries); a real deployment would index the last-known balance.

---

## PHASE D VERDICT — tasks A and B

**PASS on both.** The MCP surface goes from 8 tools to **9**.

| Task | Built | Tested |
|---|---|---|
| **A.1** — 60s wording | The absolute claim was in `list_markets`' refusal and mcp-core's header comment, **not** in `parse_intent`, which was already accurate. Corrected there; `parse_intent`'s wording sharpened to "UNRELIABLE, NOT confirmed empty" naming one timing offset. Historical run scripts left alone | **PASS** — assertion 6 now fails on the absolute phrasing as well as requiring the accurate one |
| **A.2** — runway floor | `min_seconds_to_expiry`, default 60s. Applied to **selection, not visibility**, so skipped markets are still reported. New distinct code `no_market_with_adequate_runway`, plus an unsatisfiable-by-construction case. NaN falls back rather than rejecting every market | **PASS** — **29/29** offline; **11/11** live, reproducing the bad case (T=55s with the floor off) and the clear refusal with it on |
| **B** — trade log | `build/trade-log.mjs` + `get_trade_log`. Append-only JSONL, per session. Refusals first-class. Logging wrapped around `place_order`/`redeem` so no return path can miss it, and never able to fail the action. Sanitised session ids, `actor` splits actions from observations, one entry per redeem leg | **PASS** — **31/31** offline; **13/13** live with a full round trip (REFUSED → FILLED 0.458u → REDEEMED 0.458 tUSDC) in one log |

**Regression:** 18 modules `node --check` clean; `risk-test` **28/28**; `intent-test`
**29/29**; `trade-log-test` **31/31**; all **9 tools** advertised over the real MCP
stdio protocol, `get_trade_log` called end to end over the wire (`total=7 returned=2
elided=5`).

**Transactions this session part (all status success):**

| Purpose | Result |
|---|---|
| trade-log live order (`0x…9fbe`) | approve + order, **FILLED 0.458u / 0.349912 USD** |
| trade-log live redeem (`0x…9fbe`) | **payout 0.458 tUSDC**, confirmed by balance delta |

### The one thing that needs a decision, not more code

**The 60s floor refuses during the last 60s of every 300s cycle — ~20% of the time —
and there is nothing to substitute**, because the venue lists exactly one 300s market
per asset. The floor is correct for a confirm-before-execute flow, but the demo will
hit the refusal, so the choreography should either check timing before typing the
instruction or narrate the refusal as the guardrail working. Lowering the floor is
available (`min_seconds_to_expiry`) but trades away the thing it protects.

### Carried forward

- **`parse_intent` / `list_markets` are not in the trade log** — a deliberate
  boundary; a `recordIntent()` adapter is a small addition if the demo wants
  "declined before touching the chain" in the history.
- **A live guard BLOCK through the log adapter** — offline-pinned, guard itself
  live-proven earlier, adapter path not yet exercised on a real BLOCK.
- **Wire generated wallets into signing.** `place_order` still signs with
  `AGENTRAIL_OWNER_KEY`; the log records this explicitly so history cannot imply
  otherwise.
- **Encrypt the wallet store** — plaintext keys on disk, no recovery path.
- **Trade log is single-process** — `seq` duplicates across processes, disclosed and
  detected but not solved.
- **Dollar-target undershoot** (Phase C) — re-derive quantity at placement-time price.
- **`reverted` branch** (Phase C) — still needs an opportunistic live execution.
- **Risk + wallet + trade-log state persistence** — all flat-file/in-memory.
- Not started, as scoped: momentum-ladder mode.

---
