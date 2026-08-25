# AgentRail — PROOF LOG

Live, append-only record of the four open-item proofs from
`AgentRail-Build-Spec.md` §7 / §10. Written incrementally, one entry per step,
immediately on completion of that step.

Session start: 2026-08-24. Timebox: 90 minutes.

Ground truth taken as settled (NOT re-verified, per instruction):
- Real dispatched binary-order selector `0x5d97c566` (not spot's `0x80054449`).
- Pools deploy via plain `CREATE` from fixed deployer, even nonces only.
- Binary pools are NOT registered in `SpotPoolRegistry`.
- Safe 1.3.0/1.4.1 + MultiSend + EntryPoint v0.6/0.7/0.8 live on Somnia; Multicall3 not deployed.
- 18-decimal mainnet price bug confirmed, solved by integer-tick snapping.
- `redeemFor`/`signRedeemAuth` signature construction confirmed correct, never broadcast.

---

## STEP 0 — Context read (prerequisite, not a proof step)

**What I did:** Read `research/AgentRail-Build-Spec.md` (all sections, incl. §3, §4,
§7, §10) and inventoried every non-`node_modules` file in `research/`
(`onchain-proof/`, 24 files; `pool-precompute/`, 47 files). Read in full:
`onchain-proof/config.mjs`, `onchain-proof/step2_operator_grant.mjs`,
`onchain-proof/step2-artifacts.json`, `onchain-proof/step5-6-artifacts.json`,
`pool-precompute/rpc.mjs`, `pool-precompute/25-batch-primitives.mjs`,
`pool-precompute/GRANT-TARGETS.json`.

**Exact values extracted (these are the inputs to steps 1–4):**

| Item | Value |
|---|---|
| Pool deployer (mainnet) | `0x1a478019Ae4d24249a962934af0f129CE98B5e6f` |
| `OperatorPermissionsRegistry` mainnet | `0xE7a190736B6024a4DbafadC04E283075877005ce` |
| `OperatorPermissionsRegistry` testnet | `0x15C7e8CE38F021c5b45d098AaD788f63090bF20A` |
| `setOperatorApprovalForPool` selector | `0x7bbc67e6` |
| ABI | `setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)` |
| `isApprovedForPool` ABI | `isApprovedForPool(address pool, address owner, address operator, bytes4 selector) → bool` |
| Highest confirmed real pool nonce | 274 (`0x843ca845bbad0db0954700264901de5e451940ae`) |
| Mainnet RPC | `https://api.infra.mainnet.somnia.network/` |
| Testnet RPC (config.mjs) | `https://api.infra.testnet.somnia.network` |
| Testnet RPC (rpc.mjs) | `https://dream-rpc.somnia.network/` |
| Prior redeem owner (unbroadcast) | `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A` |
| Prior redeem marketId | `0x…7a23`, operatorId 4, amount 1000, nonce 1, deadline 1787514334 |
| `redeemFor` selector | `0x84f093c0` |

**Blocker identified up front (affects steps 3 and 4):** no signing key is
available in this environment. `config.mjs` reads `AGENTRAIL_OWNER_KEY` /
`AGENTRAIL_OPERATOR_KEY` from env; both are unset, there is no `.env` file
anywhere in the tree, and no key material is stored in `.scratch/` or any
artifact. Steps 1 and 2 are simulation-only and are unaffected. Steps 3 and 4
require broadcasting real transactions from a funded account and are therefore
gated on key material that does not exist here. Recorded now rather than at the
end so the constraint is not mistaken for a failed test.

**Result:** PASS (context loaded, all step inputs resolved).

---

## STEP 1 — Pre-grant on a predicted, not-yet-deployed pool address

**Result: PASS** (with one stated limit, below.)

**What I did:** Wrote and ran `pool-precompute/STEP1-pregrant-undeployed.mjs`
against Somnia **mainnet** (`https://api.infra.mainnet.somnia.network/`).
Read-only throughout — `eth_getTransactionCount`, `eth_getCode`, `eth_call`. No
transaction was signed or broadcast. Full machine output saved to
`pool-precompute/STEP1-RESULT.json`.

**Deployer state at time of test:**
- Deployer: `0x1a478019Ae4d24249a962934af0f129CE98B5e6f`
- Current nonce: **939** (`0x3ab`), at block **393902778**

**Next 3 unreleased pool addresses** (next even nonces ≥ current nonce), each
confirmed `eth_getCode` → `0x`, i.e. zero code:

| Nonce | Predicted address | codeLen |
|---|---|---|
| 940 | `0x0A77bA8637E83DC06D887d111F847414030626f0` | 0 (UNDEPLOYED) |
| 942 | `0xf50f456D439f96C6D1bA3EB8f61bF238C97f793B` | 0 (UNDEPLOYED) |
| 944 | `0x07aB1cc669b8f2Ddb3F793c0D9d984886900e45d` | 0 (UNDEPLOYED) |

These three match `GRANT-TARGETS.json`'s `forwardWindow` entries for n=940 / 942
/ 944 exactly, so the address derivation used here reproduces the earlier
session's derivation.

**Positive control on the address math** (not a re-verification of the settled
even-nonce claim — a check that *this* script's derivation is sound): nonce 274
computes to `0x843Ca845bbaD0dB0954700264901de5e451940ae`, which **matches** the
known real deployed pool at that nonce, and that address has `codeLen=291` —
the expected ~291-byte beacon proxy. So the same code path that produced the
three predictions above reproduces a real pool.

**The actual question — does the registry accept a grant on an address with no
deployed code?** Target: `0x0A77bA8637E83DC06D887d111F847414030626f0` (nonce
940, zero code).

Exact calldata simulated (`setOperatorApprovalForPool(address,address,bytes4[],bool)`,
selector `0x7bbc67e6`, granting all three selectors `0x5d97c566` / `0xe37b444b`
/ `0x364c2587` to operator `0x9905123B35A841F34CEBE437289bb195ef24DA14`):

```
0x7bbc67e6
0000000000000000000000000a77ba8637e83dc06d887d111f847414030626f0
0000000000000000000000009905123b35a841f34cebe437289bb195ef24da14
0000000000000000000000000000000000000000000000000000000000000080
0000000000000000000000000000000000000000000000000000000000000001
0000000000000000000000000000000000000000000000000000000000000003
5d97c56600000000000000000000000000000000000000000000000000000000
e37b444b00000000000000000000000000000000000000000000000000000000
364c258700000000000000000000000000000000000000000000000000000000
```

**Exact results:**

| Simulated `from` | Target | Outcome |
|---|---|---|
| `0xAAaA000000000000000000000000000000000001` | undeployed `0x0A77…26f0` | **NO REVERT**, returned `0x` |
| `0xbBBb000000000000000000000000000000000002` | undeployed `0x0A77…26f0` | **NO REVERT**, returned `0x` |
| `0xAAaA000000000000000000000000000000000001` | real pool `0x843Ca845…40ae` | **NO REVERT**, returned `0x` |

Pre-state read, `isApprovedForPool(0x0A77…26f0, 0xAAaA…0001, 0x9905…DA14, 0x5d97c566)`:
raw `0x0000000000000000000000000000000000000000000000000000000000000000`,
decoded **`false`** — clean false before any grant, as expected.

**Conclusion:** the registry does **not** revert on a grant targeting an address
with no deployed code. It performs no existence/code check on the `pool`
argument. The undeployed target and a real deployed pool behave identically
under simulation. This does **not** hard-fail, so step 2 is unblocked.

**Stated limit on this result (important, do not overstate it):**
`setOperatorApprovalForPool` returns `void`, so a successful `eth_call` returning
`0x` proves only *absence of revert* — it is **not** proof that the grant's
`SSTORE` actually landed and would read back `true`. A function that silently
no-ops on an unknown pool would produce this identical output. I wrote
`pool-precompute/STEP1b-prove-sstore.mjs` to close that gap via
`debug_traceCall` + `prestateTracer` diffMode (proving the storage write) and an
`eth_call` state-override read-back; **it was not run** — the session was
interrupted before execution. So step 1's claim as it stands is: *the registry
accepts the call without reverting on a zero-code address.* The stronger claim —
*the grant takes effect on a zero-code address* — is **not yet proven** and
`STEP1b` is the pending test for it.

---

## STEP 1b — Does the grant on a zero-code address actually *take effect*?

**Result: PASS.** The gap flagged at the end of step 1 is now closed. The grant
is not a silent no-op: it performs real `SSTORE`s and reads back `true`.

**What I did:** Ran `pool-precompute/STEP1b-prove-sstore.mjs` against Somnia
mainnet. `debug_traceCall` with `prestateTracer` / `diffMode: true` to capture
the exact storage the grant would write, then `eth_call` with that diff applied
as a `stateDiff` state override to read the result back. Read-only; nothing
signed or broadcast. Machine output in `pool-precompute/STEP1B-RESULT.json`.

Target: `0x0A77bA8637E83DC06D887d111F847414030626f0` (deployer nonce 940,
`codeLen = 0`). Caller: `0xAAaA000000000000000000000000000000000001`.
Registry: `0xE7a190736B6024a4DbafadC04E283075877005ce`.

**Exact storage diff — 7 slots written, 3 set to `1`:**

```
0x26020e1c7792fbcb40f941ab69a9264b65b2f78487b792167ee4886b85b7a340 = 0x…01
0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc = 0x000000000000000000000000efdbf940edcecda6e581ad561eceef735d46f248
0x4980484ea24faac53f20bfa9e6c2e7542a08d831223f19f16349c4612bfe797e = 0x…00
0x4a571e5fc88bcde03b6dcbfd00471dc248d474b9def5d5bd023e1bdebc95e64a = 0x…01
0x5ac98bafa72694f421d3aa52b88d513231961e20728e069a2dbe4d16ce3fb988 = 0x…00
0xc453d35201a79485702499b79240ee80949630d558c50296c7160d2c71280139 = 0x…00
0xf253d1601c9481fe37bf3874ae69bc93e3744482681eaf60b0712362d18bbe87 = 0x…01
```

Three slots set to `1` for three granted selectors — a 1:1 match. (One slot
records an address, `0xefdbf940edcecda6e581ad561eceef735d46f248`; noted as
observed fact, not investigated further, and not load-bearing for this proof.)

**Read-back under the state override:**

| Read | Result |
|---|---|
| `isApprovedForPool(0x0A77…26f0, owner=0xAAaA…0001, op=0x9905…DA14, 0x5d97c566)` | **`true`** |
| `isApprovedForPool(0x0A77…26f0, owner=0xcccc…0003, op=0x9905…DA14, 0x5d97c566)` | **`false`** |
| same, selector `0x5d97c566` (owner=caller) | **`true`** |
| same, selector `0xe37b444b` (owner=caller) | **`true`** |
| same, selector `0x364c2587` (owner=caller) | **`true`** |

**Conclusion — two distinct findings:**

1. **Pre-granting on an undeployed address works.** The registry writes the
   approval and `isApprovedForPool` returns `true` for a pool address that has
   zero code and will not exist until the deployer reaches nonce 940. Step 1's
   weaker "doesn't revert" is now upgraded to "provably takes effect." Combined
   with step 1's positive control (nonce 274 → real pool, 291 bytes), the
   forward-computed addresses are grantable today.

2. **The grant is keyed to `msg.sender` as owner — independently reconfirmed
   here.** The identical storage diff yields `true` when queried with
   `owner = the caller` and `false` when queried with `owner = any other
   address`. This was already settled ground truth; it fell out of this test for
   free, and it is the precise reason step 2's `msg.sender`-preservation question
   is the thing that decides whether batching is viable.

**Note on failed first attempt (for reproducibility):** the first run of this
script crashed *after* printing the `owner=CALLER → true` line, with
`InvalidAddressError: Address "0xCCcc000000000000000000000000000000000003" is
invalid` from viem's checksum validation on my control address. The trace and the
positive read-back had already completed and were unaffected; I lowercased the
control address to `0xcccc…0003` and re-ran to obtain the negative control. Both
runs produced byte-identical storage diffs.

---

## STEP 2 — Composing 3 grants into one Safe MultiSend, and whose `msg.sender` the registry sees

**Result: PARTIAL.** Batching itself works — all 3 predicted pools × 3 selectors
land in a single transaction. But the literal question asked has a **negative**
answer, and it matters: **`msg.sender` as seen by the registry is NOT preserved
as the actual signer.** It becomes the Safe. The naive relayed-MultiSend path is
confirmed dead outright.

**What I did:** Ran `pool-precompute/STEP2-multisend-batch.mjs` and
`pool-precompute/STEP2b-reverts.mjs` against Somnia mainnet. Packed three
`setOperatorApprovalForPool` calls — one per predicted undeployed pool from step
1 (nonces 940 / 942 / 944), each granting all three selectors `0x5d97c566` /
`0xe37b444b` / `0x364c2587` — into one `multiSend(bytes)` payload (**1124 bytes**
of calldata). Simulated with `debug_traceCall` + `prestateTracer` diffMode, then
read every (pool × selector) pair back under the resulting `stateDiff` override
to determine which address the registry actually keyed the grants to. Read-only;
nothing broadcast. Machine output in `pool-precompute/STEP2-RESULT.json` and
`pool-precompute/STEP2-REVERTS.json`.

**MultiSend deployments confirmed live on Somnia mainnet:**

| Contract | Address | codeLen |
|---|---|---|
| MultiSend 1.4.1 | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` | 629 |
| MultiSendCallOnly 1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 410 |
| MultiSend 1.3.0 | `0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761` | 629 |
| MultiSendCallOnly 1.3.0 | `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` | 410 |

### Variant A — EOA calls MultiSend directly (the "naive relayed multicall")

Caller (the intended owner / "actual signer"): `0xAAaA000000000000000000000000000000000001`.

| MultiSend flavour | Slots written | Set to 1 | Approved for EOA | Approved for the MultiSend contract |
|---|---|---|---|---|
| MultiSend 1.4.1 | 0 | 0 | **0/9** | 0/9 |
| MultiSendCallOnly 1.4.1 | 19 | 9 | **0/9** | **9/9** |
| MultiSend 1.3.0 | 0 | 0 | **0/9** | 0/9 |
| MultiSendCallOnly 1.3.0 | 19 | 9 | **0/9** | **9/9** |

The two non-`CallOnly` variants wrote nothing because they reject a direct call
outright. Exact revert data, captured verbatim (identical for both 1.4.1 and
1.3.0):

```
0x08c379a0
0000000000000000000000000000000000000000000000000000000000000020
0000000000000000000000000000000000000000000000000000000000000030
4d756c746953656e642073686f756c64206f6e6c792062652063616c6c6564
207669612064656c656761746563616c6c00000000000000000000000000000000
```
decoded `Error(string)`: **`"MultiSend should only be called via delegatecall"`**

The two `MultiSendCallOnly` variants *do* execute and *do* write 9 approval
flags — but keyed to **the MultiSendCallOnly contract's own address**, not to the
EOA that sent the transaction. Read-back is unambiguous:
`isApprovedForPool(pool, owner=EOA, …)` → **`false`** for all 9 pairs;
`isApprovedForPool(pool, owner=MultiSendCallOnly, …)` → **`true`** for all 9.

**This confirms the previously-flagged-but-unverified suspicion as FAIL:** a
relayed multicall does not preserve the original owner's identity. The grants it
writes are owned by the relaying contract and are worthless to the user. That
item can now be moved from "credible but unverified" to **confirmed dead**.

### Variant B — Safe-style delegatecall to MultiSend

Modelled faithfully by overriding a synthetic Safe address
(`0xdddd000000000000000000000000000000000004`) with MultiSend 1.4.1's real
on-chain bytecode (629 bytes, fetched via `eth_getCode`), then calling it from
the EOA. MultiSend's logic then executes in the Safe's context, so its inner
`CALL`s carry `msg.sender = the Safe` — exactly what
`Safe.execTransaction(..., operation=DelegateCall, to=MultiSend)` produces. This
also clears the delegatecall guard above, confirming the model is the right one.

| Probed owner | Result |
|---|---|
| the Safe (`0xdddd…0004`) | **`true`** — coverage **9/9** |
| the EOA signer (`0xAAaA…0001`) | **`false`** — coverage **0/9** |
| the MultiSend singleton (`0x38869bf6…B526`) | **`false`** |

19 slots written, 9 set to `1` — i.e. all 3 predicted pools × all 3 selectors
granted in a **single** transaction, on addresses that have no code yet.

### Conclusion

Two separate answers, and conflating them would be a mistake:

1. **Can multiple grants be composed into one transaction? YES.** 3 pools × 3
   selectors = 9 approvals in one `multiSend` call, 1124 bytes, on
   forward-computed addresses with zero deployed code. Combined with steps 1 and
   1b, "pre-authorize the next N windows in one signature" is a real, working
   mechanism.

2. **Is `msg.sender` preserved as the actual signer? NO.** The registry sees the
   Safe, never the EOA that signed. So the demo claim cannot be "one signature
   from your wallet pre-authorizes six windows" if "your wallet" means an EOA —
   the grants would be keyed to the wrong owner and every subsequent
   `placeBinaryOrderFor(owner=EOA, …)` would fail its permission check.

**What this actually requires architecturally** (stated as the consequence, not
as a new verified claim): the user's on-chain trading identity must *be* the Safe
— funds held by the Safe, orders placed with `owner = Safe address`. Under that
model the grant is keyed to precisely the right owner and batching is sound; the
EOA is only the key that authorizes the Safe. Whether `placeBinaryOrderFor` in
fact accepts a contract account as `owner`, and how the custody/auto-pull path in
§3 behaves when the owner is a Safe rather than an EOA, are **not tested here**
and are the next thing that would need proving before §8's demo leads with the
pre-authorization story.

Nothing about this blocks steps 3 or 4, so it is not a hard-fail — but it does
change the onboarding shape (deploy a Safe per user) rather than being a free win.

---

## STEP 2b — Does `placeBinaryOrderFor` accept a CONTRACT as `owner`?

**Result: PASS on the question asked** (no contract-specific rejection) — **plus an
unexpected, scope-relevant finding that supersedes part of the reasoning in the
existing artifacts.** Read both halves; the second matters more.

**What I did:** Two scripts, both read-only, nothing signed or broadcast.
- `onchain-proof/STEP2b-contract-owner.mjs` — hold all 10 `placeBinaryOrderFor`
  args constant, vary only `owner`, compare which revert comes back, using the
  same bogus-selector control as `step4_encode_order.mjs`. Output:
  `onchain-proof/STEP2B-RESULT.json`.
- `onchain-proof/STEP2b-ii-past-gate.mjs` — synthesise the operator grant via
  `debug_traceCall` and replay the order with that storage diff applied to the
  registry as a state override, to see what lies *beyond* the permission gate.
  Output: `onchain-proof/STEP2B-II-RESULT.json`.

Calldata was hand-encoded against `binaryPoolWriteAbi`, selector **`0x5d97c566`**,
**324 bytes** (= 4 + 10×32, as expected), price snapped on-tick.

### Part 1 — owner class makes no difference

Testnet pool `0x5df066ab7cd4bb86fa6516b2512199cd89b92cdf` (6 dec, tickSize 1000,
priceOn `620000`); mainnet ETH pool `0x39b910486dbc82510d0990caa8b4af05da864bb4`
(18 dec, tickSize `1000000000000000`, priceOn `620000000000000000`).

| `owner` | codeLen | Revert (both testnet AND mainnet) |
|---|---|---|
| CONTROL — bogus selector `0xdeadbe01` + identical tail | — | **EMPTY `0x`** — not dispatched |
| EOA `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A` | 0 | `0x3fb0ba2e = OnlyApprovedContracts()` |
| MultiSend 1.4.1 `0x38869bf6…B526` | 629 | `0x3fb0ba2e = OnlyApprovedContracts()` |
| Safe singleton 1.3.0 `0xd9Db270c…9552` | 22958 | `0x3fb0ba2e = OnlyApprovedContracts()` |
| SafeProxyFactory 1.3.0 `0xa6B71E26…6AB2` | 3774 | `0x3fb0ba2e = OnlyApprovedContracts()` |
| step-2 Safe `0xdddd…0004` + injected Safe 1.3.0 code | 22958 (override) | `0x3fb0ba2e = OnlyApprovedContracts()` |

The control returns empty `0x` while every real call returns a *named, decodable*
custom error — so the triangulation is working, the selector dispatches, and all
ten arguments decode. And the revert is **byte-identical** across an EOA owner and
four different contract owners, on both chains.

**Answer to the question asked: there is no `owner.code.length` check and no
contract-specific early rejection.** A Safe as `owner` is treated exactly like an
EOA at this stage. So step 2's architectural requirement (the Safe *is* the
trading identity) is not contradicted by the order path.

**Correction to my own step-2 log entry:** I described the step-2 Safe as a real
deployed contract. It was not — `0xdddd…0004` was synthetic, given MultiSend code
by override. Here I used four genuinely deployed contracts as `owner` plus the
synthetic address with real Safe code injected. All five agree.

### Part 2 — the unexpected finding: the registry grant does not open this gate

`OnlyApprovedContracts()` is annotated in `step4_encode_order.mjs` as "the
operator-authorization gate," i.e. the thing an operator grant is supposed to
clear. **That interpretation does not survive testing.** I synthesised a real
grant — `setOperatorApprovalForPool(livePool, operator, [0x5d97c566, 0xe37b444b,
0x364c2587], true)` sent from the prospective owner, **7 slots written, 3 set to
`1`** (the same signature step 1b verified reads back `true`) — applied it to the
registry as a `stateDiff` override, and replayed the order:

| Chain | Owner | Without grant | With grant applied | Gate opened? |
|---|---|---|---|---|
| Testnet (`0xb0b41c61…3e36`, registry `0x15C7e8CE…F20A`) | EOA | `0x3fb0ba2e` | `0x3fb0ba2e` | **no** |
| Testnet | Safe (real Safe code) | `0x3fb0ba2e` | `0x3fb0ba2e` | **no** |
| Mainnet ETH (registry `0xE7a19073…05ce`) | EOA | `0x3fb0ba2e` | `0x3fb0ba2e` | **no** |
| Mainnet ETH | Safe (real Safe code) | `0x3fb0ba2e` | `0x3fb0ba2e` | **no** |

Granting changes nothing. The revert is identical with and without the approval
in place, for both owner classes, on both chains. The name is the tell:
`OnlyApprovedContracts` reads as *the caller must be an approved contract* — i.e.
the pool appears to gate on `msg.sender` against an allowlist of periphery
contracts, which is a **different mechanism from the operator registry** and is
not satisfied by any registry grant. Our `from` here is a plain operator EOA.

**What this means for the build, stated at the strength the evidence supports:**
the operator EOA may not be able to call `placeBinaryOrderFor` on a binary pool
directly at all — calls may have to route through a whitelisted contract. If so,
that is a larger scope item than per-window grants, and it sits *upstream* of
everything in step 2: batching grants perfectly is worth nothing if the order call
itself is rejected for coming from an unapproved caller.

**Explicitly NOT established, and needed before acting on this:**
- What the allowlist is, where it lives, and who administers it — not identified.
- Whether some other caller (the `binaryMarketsModule` at
  `0x3ecC694Cef705358864a646142ac17A90E29e388`, or a router) is the approved
  entry point that AgentRail should be calling instead of the pool directly.
- Whether my synthesised grant is keyed exactly as the pool's own lookup expects.
  The override provably works for `isApprovedForPool` (step 1b), but if the pool
  consults a different registry instance or a different key layout, a correct
  grant might still open the gate. This is the single most likely way the above
  conclusion is wrong, and it is cheap to check.

This does **not** invalidate settled ground truth: `0x5d97c566` still dispatches
(324-byte calldata, all args decode, named custom error vs. empty `0x` for the
control). It relocates *which* check is blocking.

**Note on an apparent tension with §3:** §3 records the real call reaching
`ERC20InsufficientAllowance` on testnet. Every probe here reaches
`OnlyApprovedContracts()` instead. The live testnet pool also rotated mid-session
(`0x5df066ab…2cdf` → `0xb0b41c61…3e36`), and §3's allowance result may have come
from the `placeBinaryOrder` *self* path rather than the `…For` path. Recorded as
an observed discrepancy for whoever picks this up; not re-litigated here, since
re-deriving settled findings was out of scope for this session.

---

## STEP 2c — What does the `OnlyApprovedContracts()` gate actually SLOAD?

**Outcome: (b).** The check reads a slot in **the pool's own storage**. The
`OperatorPermissionsRegistry` is **never touched** — it does not appear in the
call tree or in the set of accounts accessed, on either chain. Facts only below;
no interpretation of what the gate is *for*, per instruction.

**What I did:** `onchain-proof/STEP2c-trace-gate.mjs` — traced the real,
**non-overridden** reverting call three ways (`callTracer` with logs,
`prestateTracer` with `diffMode: false` for every account/slot read, and the
struct logger with stack enabled), plus the self-path comparison. Then
`onchain-proof/STEP2c-ii-slot-derivation.mjs` to attempt to derive the slot and
locate a setter. Read-only, no state overrides anywhere. Output:
`STEP2C-RESULT.json`, `STEP2C-II-RESULT.json`.

Testnet pool this run: `0xc09e4a5bdee2899962727125fb5eaeb896798e46` (the live pool
rotated again mid-session). Mainnet ETH pool: `0x39b910486dbc82510d0990caa8b4af05da864bb4`.
`from` (msg.sender) = `0xf790ece943559b79e17d327885df0ba94cf68151` (operator EOA).
`owner` arg = `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A`.

### The call tree — identical on testnet and mainnet

```
d0 CALL         <pool>                                      sel=0x5d97c566  ERR=EXECUTION_REVERTED  out=0x3fb0ba2e
d1 STATICCALL   0x85c01b5ef4f4ed59cac69749565e309f01b14dbc  sel=0x5c60da1b  out=0x00000000
d1 DELEGATECALL 0x48e523c9f22f98548d263f0ad444d732e5202c0e  sel=0x5d97c566  ERR=EXECUTION_REVERTED  out=0x3fb0ba2e
```

- `0x85c01b5ef4f4ed59cac69749565e309f01b14dbc` — the **beacon**, codeLen 605.
  `0x5c60da1b` is `implementation()`.
- `0x48e523c9f22f98548d263f0ad444d732e5202c0e` — the **implementation**, codeLen 40566.
- External calls: **2**. Calls to `OperatorPermissionsRegistry`: **0**
  (testnet `0x15C7e8CE…F20A`, mainnet `0xE7a19073…05ce` — neither appears).

### Every storage slot read in the entire call — exactly 2 SLOADs

`prestateTracer`, `diffMode: false`:

| Contract | codeLen | Slots read | Slot → value |
|---|---|---|---|
| beacon `0x85c01b5e…4dbc` | 605 | 1 | `0x…0001` → `0x…48e523c9f22f98548d263f0ad444d732e5202c0e` (the impl) |
| **the POOL itself** (`0xc09e4a5b…8e46` / `0x39b91048…4bb4`) | 291 | 1 | **`0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7` → `0x0000000000000000000000000000000000000000000000000000000000000000`** |
| impl `0x48e523c9…2c0e` | 40566 | 0 | — |
| operator EOA `0xf790ece9…8151` | 0 | 0 | — |
| `OperatorPermissionsRegistry` | — | **absent from the touched set** | — |

### The struct log — the SLOAD immediately preceding the REVERT

518 steps, **2 SLOADs total** in the whole execution:

```
pc=66     d1 STATICCALL    stackTop=0x1fee328 , 0x85c01b5ef4f4ed59cac69749565e309f01b14dbc , 0x80
pc=366    d2 SLOAD         stackTop=0x1 , 0x5c60da1b
pc=221    d1 DELEGATECALL  stackTop=0x1fee0af , 0x48e523c9f22f98548d263f0ad444d732e5202c0e , 0x0
pc=8264   d2 SLOAD         stackTop=0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7 , 0xff , 0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a
pc=7181   d2 REVERT        stackTop=0x0 , 0x4 , 0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a
pc=236    d1 REVERT        stackTop=0x0 , 0x4
```

SLOAD #1 (`pc=366`) is the beacon resolving `implementation()` from its slot `0x1`.
SLOAD #2 (`pc=8264`) is **the gate**: slot
`0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7`, read in the
pool's storage context (delegatecall), returns **zero**, and the very next
control-flow event is `REVERT` at `pc=7181` emitting `0x3fb0ba2e`. Byte-identical
on both chains.

Note the stack at that SLOAD carries `0x19e7e376…ff2a` — **the `owner` argument** —
two slots down, and `0xff` between. So the slot appears to be derived from the
`owner` address, not from `msg.sender`. Recorded as an observation of what is on
the stack; not asserted as the derivation.

### Slot derivation and setter hunt — both NEGATIVE

- Brute-forced `keccak256(abi.encode(key, p))` for `p` = 0…199 against keys
  {owner, operator/msg.sender, pool, impl, binaryMarketsModule, zero}, and the
  nested form `keccak256(abi.encode(k2, keccak256(abi.encode(k1, p))))` for all
  36 key pairs × `p` = 0…59. **No match.** So it is not a plain address-keyed
  mapping at a low integer base slot.
- Scanned the 40566-byte implementation for 22 guessed selector names
  (`setApprovedContract`, `approvedContracts`, `isApprovedContract`, `setOperator`,
  `setWhitelist`, `permissionsRegistry`, `operatorRegistry`, `setRouter`, …).
  **None present.** So the administering function was not identified.

**Unconfirmed hypothesis for why the brute force failed** (flagged as hypothesis,
not a finding): the `0xff` on the stack next to the slot is characteristic of
ERC-7201 namespaced storage (`… & ~bytes32(uint256(0xff))`), which would put the
mapping's base at a keccak-derived namespace rather than a small integer — exactly
the case my scan cannot reach. Testing that needs the namespace string, which I
do not have.

### The self path is NOT behind this gate

Same pool, same args, same `from`, only the function differs:

| Path | Selector | Revert |
|---|---|---|
| `placeBinaryOrderFor` (delegated) — testnet | `0x5d97c566` | `0x3fb0ba2e = OnlyApprovedContracts()` |
| `placeBinaryOrder` (self) — testnet | `0x718c2d4d` | **`0xfb8f41b2 = ERC20InsufficientAllowance(address,uint256,uint256)`** |
| `placeBinaryOrderFor` (delegated) — mainnet ETH | `0x5d97c566` | `0x3fb0ba2e = OnlyApprovedContracts()` |
| `placeBinaryOrder` (self) — mainnet ETH | `0x718c2d4d` | **`0xa491421c = TradingNotActive()`** |

The self path clears the gate entirely and reaches the funds check on testnet and
the market-timing check on mainnet. This also resolves the §3 tension flagged in
step 2b: §3's `ERC20InsufficientAllowance` is the **self** path, and it reproduces
exactly. §3's `TradingNotActive` reproduces on the mainnet self path.

### Summary of facts established here

1. The gate is **(b)** — a slot in the pool's own storage, not the operator
   registry. The registry is not read on this path at all.
2. Exact slot: `0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7`.
   Current value: **`0x0`** (zero) on both the live testnet pool and the mainnet
   ETH pool.
3. Slot derivation: **not determined.** Setter/getter: **not found.**
4. The delegated path (`placeBinaryOrderFor`) is gated; the self path
   (`placeBinaryOrder`) is not, on both chains.

No conclusion drawn about what the gate governs or what it implies for the build —
that call is left to the reader, per instruction.

---

## STEP 2d — Three independent attempts to identify the gate from the outside

**Result: 1 of 3 partially positive, 2 of 3 negative — plus one unplanned
finding from check 3 that is the strongest signal in this entry.** Facts and
limits only; no conclusion drawn.

**What I did:** `onchain-proof/STEP2d-explorer-logs-history.mjs` (first pass, two
methods failed for mechanical reasons — recorded below) and
`onchain-proof/STEP2d-ii-blockscout-v2.mjs` (second pass, worked). Read-only.
Output: `STEP2D-RESULT.json`, `STEP2D-RESULT-V2.json`,
`STEP2D-SRC-mainnet-beacon.json`, `STEP2D-SRC-testnet-beacon.json`.

**Two mechanical failures in the first pass, for reproducibility:**
- `eth_getLogs` over full history is impossible on these RPCs:
  `{"code":-1,"message":"block range exceeds 1000","data":null}`. The chain is at
  block ~393.9M, so a 1000-block cap rules out historical log scanning by RPC.
- The legacy Blockscout shim `/api?module=contract&action=getsourcecode` returns
  HTTP 200 with an empty result on these hosts. Both explorers speak Blockscout
  **v2** (`/api/v2/...`); the second pass uses that.

Explorers found and usable: `https://explorer.somnia.network` (mainnet),
`https://shannon-explorer.somnia.network` (testnet).
`somnia.blockscout.com` 404s; both `socialscan.io` hosts fail to connect.

### Check 1 — verified source: NEGATIVE for the contract that matters

| Contract | Network | `is_verified` | Name | source chars | ABI entries |
|---|---|---|---|---|---|
| implementation `0x48e523c9…2c0e` | mainnet | **false** | — | 0 | 0 |
| implementation `0x48e523c9…2c0e` | testnet | **false** | — | 0 | 0 |
| beacon `0x85c01b5e…4dbc` | mainnet | **true** | `UpgradeableBeacon` | 2219 | 11 |
| beacon `0x85c01b5e…4dbc` | testnet | **true** | `UpgradeableBeacon` | 2219 | 11 |

The beacon is verified but it is stock OpenZeppelin `UpgradeableBeacon` — it holds
no allowlist. **The 40566-byte implementation, which contains the gate, is not
verified on either network.** So the variable name and setter could not be read
from source. Check 1 does not close the question.

### Check 2 — event-log scan: NEGATIVE (no decodable allowlist event)

Via `/api/v2/addresses/{addr}/logs`:

| Address | Sampled | Distinct topic0 | Decoded |
|---|---|---|---|
| beacon `0x85c01b5e…4dbc` | 2 | 2 | `Upgraded(address indexed implementation)` ×1; `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` ×1 |
| implementation `0x48e523c9…2c0e` | 1 | 1 | `Initialized(uint64 version)` ×1 |
| hot pool BTC `0xd22908ed…f736` | 50 | 5 | none decoded |
| hot pool ETH `0x39b91048…4bb4` | 50 | 5 | none decoded |

Pool topic0 histogram (identical shape on both pools) — one rare, four recurring:

```
 1x 0x9f15802f3d01a772129264277df8d4179b39f69e1604da331602636c0985d45f   <- rare / lifecycle-shaped
12x 0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d
12x 0x74d63d9f1c4826854a227aa41c4a51723497a608aa14aa50e8153744f081d4e6
12x 0x06ff08ed6b6987bb7df963009d8b54dc03988f4e465c009924929bb010fe03e7
13x 0xcdd45acd62788abc10f79d86fac34df2a63e1a3b20f061c5bcf431ff6a09b866
```

The admin-shaped candidate is the single-occurrence `0x9f15802f…d45f`. It was
**not decoded** — because the implementation is unverified, the explorer has no
ABI for pool events, so none of the five topics resolve to a name. The two
admin-shaped events that *did* decode (`Upgraded`, `OwnershipTransferred`) are
beacon-level upgrade/ownership plumbing, not a caller allowlist.

**Limit:** only the first page (50 log items) per address was sampled. These are
sample counts, not lifetime totals, and an allowlist event occurring outside that
window would not appear.

### Check 3 — a historically successful `placeBinaryOrderFor`: NONE FOUND, and something else showed up

Across four long-lived mainnet binary pools, paging tx history with `filter=to`:

| Pool | Txs inspected | `0x5d97c566` | `0x718c2d4d` | Top selector |
|---|---|---|---|---|
| `0xd22908ed…f736` (BTC) | 168 | 0 | 0 | `0x2f2461cd` ×168 |
| `0x39b91048…4bb4` (ETH) | 175 | 0 | 0 | `0x2f2461cd` ×175 |
| `0x3a7be335…8a75` | 82 | 0 | 0 | `0x2f2461cd` ×82 |
| `0x843ca845…40ae` | 87 | 0 | 0 | `0x2f2461cd` ×87 |

**Successful `placeBinaryOrderFor` (`0x5d97c566`) transactions found: 0.**
**Successful `placeBinaryOrder` (`0x718c2d4d`) transactions found: 0.**

The unplanned finding: **every single one of the 512 inspected top-level
transactions to these four pools carries the same selector, `0x2f2461cd`.** Not
one order-path selector — neither delegated nor self — appears as a top-level
transaction to any of these pools. So on this venue, orders do not reach a binary
pool as a directly-addressed transaction; `0x2f2461cd` is the only thing that
does. What `0x2f2461cd` is, and what contract real order flow enters through
instead, is **not identified here** — I had a script drafted to check the
`binaryMarketsModule` (`0x3ecC694Cef705358864a646142ac17A90E29e388`) tx history and
the senders of those `0x2f2461cd` txs, but the 20-minute hard stop was reached
before it ran. That is the obvious next check.

**Limits on check 3, stated explicitly:** capped at 4 pages per pool (~50 txs per
page) on 4 of the 8 hot pools, mainnet only, ordered newest-first. This is a
recent-history sample, not an exhaustive history scan. `filter=to` also only
returns transactions *addressed to* the pool — an order routed through another
contract that then internally calls the pool would **not** appear here at all,
which is consistent with what the uniform `0x2f2461cd` result suggests.

### What these three checks did and did not establish

Established:
- The implementation holding the gate is **not source-verified** on either network;
  the beacon is, but it is stock `UpgradeableBeacon`.
- No allowlist-shaped event could be **decoded** on pool, beacon, or
  implementation. Five pool event topics exist; none resolve without an ABI.
- **Zero** successful `placeBinaryOrderFor` transactions were found by this method.
- All 512 inspected top-level pool transactions use the single selector
  `0x2f2461cd`.

Not established, and explicitly not to be read as proven absent:
- Whether any successful delegated order has *ever* occurred on this venue — the
  sample is recent-history-only and cannot see calls routed via another contract.
- What `0x2f2461cd` is, or which contract is the real order entry point.
- The gate's storage layout, its setter, or who administers it.

Per instruction: absence of evidence from these three methods is recorded as
"not found by these three methods," and nothing beyond that is inferred.

---

## STEP 2e — Is `binaryMarketsModule` the real order entry point? (+ what is `0x2f2461cd`)

**Result: DELEGATED PATH UNRESOLVED as of 2026-08-24 06:00 WAT. Self-path
(`placeBinaryOrder`, `0x718c2d4d`) is the confirmed fallback.** Two scoped checks
were run, cheapest first; both are read-only. Neither the module nor any layer
below it resolved to a readable order surface, so per instruction the delegation
research is stopped here — **no STEP 2f opened.** Pitch direction is deferred to
the human, not decided in this session.

**What I did:** Two checks, no key, no `eth_call` order simulation, no
name-guessing.
- Check 1 — public selector databases (openchain.xyz `signature-database/v1`
  and 4byte.directory) for `0x2f2461cd` and `0x5d97c566`.
- Check 2 — `onchain-proof/STEP2e-module-entry.mjs` and its completion
  `onchain-proof/STEP2e-ii-verify-adapters.mjs`: module code + EIP-1967 proxy
  resolution, Blockscout-v2 verification/ABI, module inbound tx history with
  distinct-sender counts, the senders of the top-level `0x2f2461cd` pool txs,
  the pool's internal-tx callers, and a cross-reference of all three sender
  sets. Output: `STEP2E-RESULT.json`, `STEP2E-II-RESULT.json`, plus the saved
  ABI/metadata JSONs.

### Check 1 — selector databases: NEGATIVE, clean

| Selector | openchain | 4byte |
|---|---|---|
| `0x2f2461cd` | `null` (count 0) | `null` (count 0) |
| `0x5d97c566` (the "real order" selector) | `null` (count 0) | `null` (count 0) |
| `0x718c2d4d` (self path) | `null` (count 0) | — |

All three are custom DreamDEX selectors, indexed nowhere public. Check 1 cannot
name `0x2f2461cd`. (It does independently confirm that the settled-ground-truth
selectors are custom, not standardised — consistent with §3, not a new finding.)

### Check 2 — the module is a proxy over an UNVERIFIED implementation

`binaryMarketsModule` `0x3ecC694…9e388` is an **`ERC1967Proxy`** (codeLen 130),
identical address on mainnet and testnet. Its EIP-1967 implementation is
`0xdf87ac5c4760e2f1dd78e054ce0629a26a4ca5ca` (codeLen **31419**), and that
implementation is **`is_verified=false` on both networks.** The only "verified"
artifact is the proxy shell itself (7 ABI entries = stock ERC1967 plumbing,
zero business functions). So there is **no readable module ABI** — the real
logic is as opaque as the pool implementation was in STEP 2c/2d.

### Check 2 — module inbound traffic is admin + one opaque selector, NOT orders

Blockscout-v2 `filter=to` on the module (mainnet: 29 txs/1 page; testnet:
300 txs/6 pages):

| Selector | mainnet | testnet | Name (openchain / blockscout) |
|---|---|---|---|
| `0x5b1ffcf2` | 21 | 284 | **null — unindexed** (dominant inbound call) |
| `0x4f1ef286` | 2 | — | `upgradeToAndCall` |
| `0xf2fde38b` | 1 | — | `transferOwnership` |
| `0xf5b7ba39` | 1 | — | `setOutcomeToken(address)` |
| `0x3d312f6d` | 1 | — | `setAdapterApproved(address,bool)` |
| `0x88cb9474` | — | 10 | null — unindexed |
| `0x4efe024a` | — | 5 | null — unindexed |
| `0x84f093c0` | — | 1 | `redeemFor` (matches §3's redeem selector) |

- **Order selectors `0x5d97c566` and `0x718c2d4d` never appear inbound to the
  module** (0 occurrences, both nets). `0x2f2461cd` also never appears inbound
  to the module.
- Distinct inbound senders: **3 (mainnet) / 13 (testnet)** — admin/keeper
  scale, not a retail user base.
- Every inbound call that *could* be named is an **admin/ownership/upgrade**
  operation (`transferOwnership`, `upgradeToAndCall`, `setSettlement`,
  `setOutcomeToken`, `setAdapterApproved`). The high-frequency call
  `0x5b1ffcf2` is unindexed and unreadable.

The presence of `setAdapterApproved(address,bool)` as an admin function is
noted as an observed fact — the module administers an "adapter" allowlist —
but its relationship to the pool's `OnlyApprovedContracts()` gate is **not**
established here (see limits).

### Check 2 — `0x2f2461cd` is one EOA keeper hitting pools directly; the pool's only internal caller is a separate per-pool adapter

Senders of the top-level `0x2f2461cd` txs (Blockscout-v2, mainnet):

| Pool | `0x2f2461cd` txs | Distinct senders | Sender |
|---|---|---|---|
| BTC `0xd22908ed…f736` | 169 | **1** | `0xff825f7b…39db` |
| ETH `0x39b91048…4bb4` | 176 | **1** | `0xff825f7b…39db` |

`0xff825f7b…39db` has **codeLen 0 → it is an EOA.** So `0x2f2461cd` is a single
dedicated keeper EOA calling pools directly at high frequency. **It is not order
flow and not the module.** (What the call *does* is still unnamed — unindexed
selector, unverified target — but its role is now pinned: a keeper op, not a
user/agent trade path.)

Pool internal-tx callers (Blockscout-v2 `internal-transactions?filter=to`,
mainnet, 150 each):

| Pool | Sole internal caller | codeLen | Verified? |
|---|---|---|---|
| BTC | `0x42040dc4…6791` | **291** | **false** |
| ETH | `0x554080c9…518f` | **291** | **false** |

Each pool is fed internally by exactly **one** contract, a **different address
per pool**, each a **291-byte proxy** (the same size as the beacon-proxy pools),
and **both unverified.** The **`binaryMarketsModule` is NOT an internal caller
of either pool.**

### Cross-reference

| Question | Answer |
|---|---|
| Is the module among the pools' top-level `0x2f2461cd` senders? | **No** |
| Is the module an internal caller of the pools? | **No** |
| Distinct pool-`0x2f2461cd` senders | 1 (the keeper EOA) |
| Distinct module-inbound senders | 14 (union of both nets) |
| Overlap (same address drives pool keeper op *and* module) | **0** |

So the module and the pool-keeper EOA are disjoint subsystems, and the thing
that actually reaches into the pool is neither of them — it is a per-pool
291-byte adapter proxy that is itself unverified.

### Why this triggers the stop rule (does NOT cleanly resolve)

The clean-resolution outcome would have been: *the module has verified source →
read its named order function → retarget STEP 3 at it.* That did not happen.
Instead every layer that matters is opaque in the same way STEP 2c/2d already
were:

1. Module implementation (31 KB) — **unverified**, no ABI.
2. The pool's sole internal caller — a per-pool **adapter proxy, unverified**.
3. The order selectors (`0x5d97c566`, `0x718c2d4d`) — **do not reach the
   module**, and are indexed nowhere.
4. The module's dominant inbound selector (`0x5b1ffcf2`) — **unindexed**,
   unreadable.

This is precisely the "gated / routed by something equally opaque" case.
Per instruction I am **not** opening STEP 2f to chase the adapter's beacon
implementation or to decode `0x5b1ffcf2` by trace. Logged and stopped.

**Confirmed fallback:** the **self path `placeBinaryOrder` (`0x718c2d4d`)**
remains the one order entry proven (STEP 2c) to clear the `OnlyApprovedContracts()`
gate and reach real downstream business logic (`ERC20InsufficientAllowance` on
testnet, `TradingNotActive` on mainnet). Delegated placement stays unresolved.

### Explicit limits (per "no conclusion beyond what these checks show")

- **Not established:** what `0x2f2461cd`, `0x5b1ffcf2`, `0x88cb9474`,
  `0x4efe024a` actually do; the module impl's function set; the adapter proxies'
  implementation or function set; whether `setAdapterApproved` is what writes
  the pool's `OnlyApprovedContracts` slot; whether the per-pool adapter is the
  approved caller that clears that gate. All of that would require the branch
  I was told not to open.
- **Sampling caps:** module inbound history was 1 page (29 txs) mainnet / 6
  pages (300 txs) testnet; pool `0x2f2461cd` senders and internal callers were
  4 pages / 3 pages respectively, newest-first, mainnet only. A caller or
  selector outside those windows would not appear. "Distinct senders = 1/3/13"
  are sample counts, not lifetime totals.
- **Inference flagged as inference:** the adapter→pool internal-call structure
  and the `setAdapterApproved` allowlist are *consistent with* the STEP 2c gate
  reading an approved-caller set, but this session did not test that link, and
  it is not asserted.

---

## PHASE A — RUN 2 (2026-08-25) — closing the run-1 redeem blocker

**Result: STEP 6 REDEEM MECHANISM PROVEN — the `InsufficientPermission()` blocker
is CLOSED. But the economic proof is still incomplete: payout was 0, because the
NO leg AGAIN failed to fill and the held side lost AGAIN.** Fresh market, one
continuous run, 34.7s wall clock. Machine output: `build/PHASE-A-RESULT.json`.
Run 1's write-up: `build/_log-entry-a1.md`.

Owner `0x291411D322ECBd4E9b86F05077c0931586142990`, Somnia Shannon testnet.
Fresh market `0x…8bad` BTC, interval 60s, pool
`0x141f15ddbb6edc9c2d8ce5d8b39108469ac5edc2` — **not** run 1's `0x…8373`, which
is finalized. Self path only (`placeBinaryOrder`, `0x718c2d4d`); the delegated
path stayed closed and was not touched.

### The three edits, and what each actually did

| Edit | Intent | Landed? | Achieved its goal? |
|---|---|---|---|
| 1 — `5n` → `500n` tick crossing | make both legs marketable so both fill | yes | **NO — see below** |
| 2 — new STEP 5b ERC6909 operator grant | unblock redeem | yes | **YES — blocker closed** |
| 3 — dynamic `outcomeIdx` | redeem the side that won | **no change needed** | n/a — already dynamic |

**Edit 3 finding, recorded because it was asked for explicitly: `outcomeIdx` was
ALREADY DYNAMIC, not hard-coded.** `build/phase-a-lifecycle.mjs:278-283` reads
`found.winningOutcome ?? oc?.winningOutcome` from settlement, builds one leg per
side actually held (`idx:0` YES / `idx:1` NO), tags `winner: win === N`, and sorts
winner-first. Run 1's `outcomeIdx=0` log line was that logic behaving correctly on
a wallet that held only YES. No code change was made to that section.

### STEP 5b — ERC6909 operator grant: **PASS, and it was the ALREADY-GRANTED case**

Read before broadcasting, as instructed — did not assume:

```
isOperator(owner=0x291411D3…2990, operator=0x3ecC694C…9e388) -> true   <- read BEFORE any broadcast
setOperator calldata: selector=0x558a7297 bytes=68
   simulation -> NO REVERT (returns 0x…01)
CASE: ALREADY GRANTED — isOperator already true, skipping the redundant broadcast.
```

So the owner's standalone `setOperator(MODULE,true)` from earlier
(`0x9652abf7…d661`) **was made from this same owner address and is live**. The
grant persists across markets — it is token-wide, not per-market and not
per-pool, which is a materially different onboarding cost from the ERC20
allowance (below). **No redundant transaction was broadcast.** `isOperator` exists
on the token and is exposed by `SDK.erc6909Abi`, so the skip decision was made on
a real read, not an inference.

### STEP 6 — REAL redeem: **BROADCAST AND SUCCEEDED. The run-1 blocker is closed.**

```
redeem(4, 0x1a1e…050f, 0x…8bad, outcomeIdx=0, amount=1000000)
selector 0x5b1ffcf2
  -> simulation: NO REVERT          (run 1: 0xdeda9030 = InsufficientPermission())
  -> tx 0x643c7a229991f745e02b59fcee6904dcedfe192cd1683315d969a66d5cfc352b
     status success, block 470423221, gas 441677, 4 logs
```

Verified by state delta, not by transaction status alone, per the two required checks:

| Check | Before | After | Verdict |
|---|---|---|---|
| **ERC6909** `balanceOf(owner, yesTokenId)` | `1000000` | **`0`** | **burned — real state change, module exercised its operator right** |
| **tUSDC** `balanceOf(owner)` | `9999.441` | `9999.441` | **payout `0`** |

The ERC6909 delta is the positive proof: the module could not touch these tokens
in run 1, and in run 2 it burned all 1.0 of them. `InsufficientPermission()` does
not reproduce. That specific blocker is **closed**.

### But the run is NOT a full pass — two things did not go as planned

**1. Edit 1 did not work, and its premise appears to be wrong.** The edit landed
mechanically and correctly:

| Side | best ask | +500 ticks | snapped bid | on-tick | filled? |
|---|---|---|---|---|---|
| YES | 277000 | 777000 | **777000** (p=0.777) | true | **yes, 0 → 1000000** |
| NO | 750000 | 1250000 → capped | **999000** (p=0.999) | true | **NO — stayed 0** |

The NO bid was snapped to `999000` = `ONE - tickSize`, i.e. **the maximum price the
snapper can express**, crossing a best ask of 0.750 by ~25 points. It still did not
fill. Gas and log count for the NO leg were **281962 / 4 logs — byte-identical to
run 1's unfilled NO leg** (281962 / 4), despite the price moving from 0.58 to
0.999. Identical gas at a radically different price means price was never the
discriminating variable.

**Conclusion: "the NO leg didn't fill because it wasn't priced aggressively
enough" is refuted.** No expressible price fills it. The cause is something other
than price, and per the session's no-new-investigation rule I stopped here rather
than diagnosing it. Logged, not chased.

**2. Consequently the payout proof is still missing.** Only YES was held;
`winningOutcome = 1` (NO won) for the second run in a row, so the redeem burned
the losing side for zero. `payoutNumerators = ["0","10000000"]`,
`payoutDenominator = "10000000"`, `voided = false`. A non-zero payout has still
never been observed.

### Unplanned finding — Trap 2 is now CONFIRMED, and it is worse than the spec says

Run 1's aside #2 recorded that Trap 2 ("redeeming a losing position doesn't
revert, it just pays zero") was untestable because the call reverted on
permissions first. **Run 2 tested it, and it holds:** the losing-side redeem did
not revert, returned success, and paid 0. The spec's wording understates the
consequence — **the 1.0 losing outcome token was BURNED (`1000000 → 0`) in
exchange for nothing.** It is not a harmless no-op that pays zero; it is a silent,
irreversible destruction of the position with a `status: success` receipt. Any
redeem bot that treats `status === 'success'` as proof of payout will report a win
on this transaction. The `winner` flag is already computed in the script, so
gating the broadcast on it is a one-line guard — noted, not implemented this run.

### Observed and NOT explained (flagged, deliberately not chased)

- **Collateral arithmetic does not reconcile.** YES filled 1.0 unit against a
  stated best ask of `277000` (0.277), but total collateral delta was
  **`-245000` (0.245)** — less than the best ask, and with a BUY_NO order
  supposedly resting at 0.999 that locked nothing observable. Either
  `yesAsks[0]`/`noAsks[0]` from `getBinaryOrderBook` is not the best executable
  level, or resting buy orders lock no collateral, or both. Not investigated.
- `getMarketOnchain` returns `winningOutcome: 0` **pre-settlement** (STEP 1) as a
  default, becoming `1` at settlement (STEP 4). Reading it before
  `finalized === true` would silently yield "YES won." The script already gates on
  finalization.
- Settled `status` is **`4`**, not the `3` the script's poll predicate also accepts.
  `finalized`/`isResolved` carried the break, so this was harmless here.
- **ERC20 allowance is per-pool and recurred**, as run 1 found: the fresh window
  needed its own `approve`
  (`0x8c8d26499e35f7ecb2e6a8be48d5af9be726df7e68643e12d97f404b6cc2895d`), spender
  named by the revert as the pool `0x141f15dd…edc2`. Contrast with the ERC6909
  operator grant, which did **not** recur.

### Transactions broadcast this run (all status success)

| Label | Hash | Block | Gas |
|---|---|---|---|
| `approve` | `0x8c8d26499e35f7ecb2e6a8be48d5af9be726df7e68643e12d97f404b6cc2895d` | 470422986 | 259745 |
| `placeBinaryOrder_BUY_YES` | `0x89f21fa986fc92ee5421ad8ecb1857ed7f8c65f86adf22e73f520759945a41f8` | 470423013 | 828612 |
| `placeBinaryOrder_BUY_NO` | `0x206c28cf1cb0ace32cce839ffbf0670b5db942a60c8a2dd89d79aefc2c6050b5` | 470423028 | 281962 |
| `redeem_YES` | `0x643c7a229991f745e02b59fcee6904dcedfe192cd1683315d969a66d5cfc352b` | 470423221 | 441677 |

`setOperator` was correctly **not** broadcast (already granted).

### PHASE A RUN 2 VERDICT

**PARTIAL PASS.** Steps 1-5 and 5b pass; step 6 executes for real and the
run-1 blocker is closed with state-delta proof. **Not a full pass:** the payout
leg is unproven because no expressible price fills the NO side, so the wallet has
now twice held only the losing side. The remaining gap is a **fill problem, not a
permission problem** — a different question from the one this run was scoped to
answer, and it is left open rather than investigated.

---

## PHASE A — RUN 3 / PART 1 (2026-08-25) — hard client-side redeem guard

**Result: PASS.** Safety fix, not an investigation. Added to
`build/phase-a-lifecycle.mjs` STEP 6.

### Why it is client-side and why it must fail closed

Run 2 established that a losing redeem is **not** a recoverable error: tx
`0x643c7a22…352b` returned `status: success`, burned the position
(`ERC6909 1000000 -> 0`) and paid `0`. There is no revert, so there is nothing
for a simulation or a try/catch to catch. The chain offers no protection here,
which means the only place protection can exist is the client, and it must
refuse on **every** ambiguity rather than proceed.

### What was added

A `redeemGuard(leg)` function plus a call site placed **before the simulation and
unconditionally before any broadcast** in the redeem loop. Authority is the
**on-chain** `oc.winningOutcome`, not the indexer's. Four independent refusal
conditions, all fail-closed:

| # | Condition | Behaviour |
|---|---|---|
| 1 | `oc.finalized !== true && oc.isResolved !== true` | BLOCK — market not settled on-chain |
| 2 | `oc.winningOutcome` not in `{0,1}` | BLOCK — out-of-range / missing outcome |
| 3 | indexer `winningOutcome` disagrees with on-chain | BLOCK — sources disagree, fail closed |
| 4 | `leg.idx !== oc.winningOutcome` | **BLOCK — the loser case that burned run 2's position** |

Only when all four pass does it return `allow: true`. On a block the script logs
`NOT BROADCAST — position left intact (N tokens preserved, not burned)`, records
the reason under `R.steps.step6_guard_<LEG>`, and `continue`s to the next leg.

Guard placement is deliberately **before** the `rawCall` simulation: a losing
redeem simulates clean, so ordering the guard after the simulation would imply
the simulation contributes safety here. It does not.

Condition 3 also closes the pre-settlement trap logged in run 2: `getMarketOnchain`
returns `winningOutcome: 0` as a **default before settlement**, which reads as
"YES won." Conditions 1 and 2 both independently block that state.

### Verification — unit test against the real function, not a replica

The `redeemGuard` source text was extracted from `build/phase-a-lifecycle.mjs` by
regex and evaluated, so the assertions below exercise the shipped code path:

| Case | `oc` | leg | Expected | Got |
|---|---|---|---|---|
| **the exact run-2 scenario** — held YES, NO won | `{finalized:true,winningOutcome:1}` | `idx:0` | BLOCK | **BLOCK** |
| held NO, NO won (the Part 3 winner case) | `{finalized:true,winningOutcome:1}` | `idx:1` | ALLOW | **ALLOW** |
| held YES, YES won | `{finalized:true,winningOutcome:0}` | `idx:0` | ALLOW | **ALLOW** |
| market not finalized | `{finalized:false}` | `idx:0` | BLOCK | **BLOCK** |
| `winningOutcome` absent (→ -1) | `{finalized:true}` | `idx:0` | BLOCK | **BLOCK** |
| indexer 0 vs on-chain 1 | `{finalized:true,winningOutcome:1}` | `idx:1` | BLOCK | **BLOCK** |
| pre-settlement `winningOutcome:0` default | `{finalized:false,winningOutcome:0}` | `idx:0` | BLOCK | **BLOCK** |

**7/7 pass.** The guard would have prevented run 2's burn.

Note this makes the script strictly safer but not more capable: with a
losing-only position it now redeems **nothing** and the position is retained
rather than destroyed. A real winning payout remains unproven — that is Part 3.

---

## PHASE A — RUN 3 / PART 2 (2026-08-25) — full order-book depth diagnostic

**Result: NEITHER BRANCH CLEANLY — closer to branch B, and it needs your call
before Part 3 runs.** Read-only; no key loaded, nothing signed, nothing
broadcast. Script `build/depth-probe.mjs`, machine output
`build/PART2-DEPTH.json`. 3.4s.

The headline is structural and was not anticipated by either branch of the
instruction: **the NO side is not an independent order book. It is the exact
arithmetic mirror of the YES book.** Both directions verified, every level.

### The book's real shape

`getBinaryOrderBook` returns four arrays — `yesBids`, `yesAsks`, `noBids`,
`noAsks`. On both markets that had any depth, all four are the *same six resting
orders* viewed twice:

| Mirror direction | Levels checked | Exact matches (price AND identical qty) |
|---|---|---|
| `noAsk` == `ONE - yesBid` | 6 (3 per market × 2 markets) | **6 / 6** |
| `noBid` == `ONE - yesAsk` | 6 | **6 / 6** |

Market `0x…8bcd` BTC, 300s, at T-107s — the complete book:

| yesBids | yesAsks | noBids (= 1−yesAsk) | noAsks (= 1−yesBid) |
|---|---|---|---|
| 0.076 × 200 | 0.095 × 200 | 0.905 × 200 | 0.924 × 200 |
| 0.069 × 330 | 0.107 × 330 | 0.893 × 330 | 0.931 × 330 |
| 0.061 × 460 | 0.114 × 460 | 0.886 × 460 | 0.939 × 460 |

Quantities are identical across each mirrored pair, not merely similar.
`0x…8bce` ETH is the same structure with different prices.

**Consequence for depth accounting:** the naive read is "990 units on each of
four sides = 3960 units of liquidity." The real figure is **990 bids + 990 asks
on a single YES book**; the NO arrays are a projection and double-count it. Any
depth metric that sums all four sides overstates liquidity by 2×.

### Answering the question as asked: is there real resting NO liquidity?

Two defensible answers, and the distinction is the whole finding:

- **As independent resting NO orders: NO — zero, at any price, in every market
  sampled.** There is one book, and it is the YES book.
- **As matchable liquidity backing the displayed NO quote: YES.** `noAsk 0.924`
  is a real resting `yesBid 0.076` for 200 units. Genuine liquidity, just
  expressed in YES terms.

### So why did run 2's BUY_NO not fill? Reconstruction

Run 2 logged `yesAsks[0] = 277000 / 200u` and `noAsks[0] = 750000 / 200u`.
Applying the now-verified mirror rule, `noAsk 750000` **is** a real resting
`yesBid = ONE − 750000 = 250000` (0.250) for 200 units.

So the book was **not empty at run-2 time**. A real resting bid existed at 0.250
for 200 units — 200× the 1.0 unit we tried to sell into it. A `BUY_NO @ 0.999`
is economically `SELL_YES @ 0.001`, which that bid should have taken instantly.
It did not.

**Therefore branch A ("thin book, not a bug") does NOT explain run 2.** The
liquidity was there. This is branch B.

### Leading hypothesis — labelled as hypothesis, NOT verified, NOT acted on

The mirror finding supports one explanation that fits every observation at once:
**the YES-bid ↔ NO-ask equivalence may be implemented only in the display layer,
not in the matching engine.** If the engine matches a `BUY_NO` solely against
literal resting NO asks — of which there are provably zero — then:

- no price can ever fill a `BUY_NO` ✓ (matches the refuted 500-tick result)
- gas is identical at 0.58 and 0.999 ✓ (no match-loop iterations either time)
- the UI still shows NO depth ✓ (derived for display)
- `BUY_YES` fills normally ✓ (real resting `yesAsks`)

This is coherent and it is the single best fit, but it is an inference about
matching-engine internals that this diagnostic did **not** test. Confirming it
would require probing the engine directly — a new investigation thread, which I
did not open. **Recorded as hypothesis only, per the stop rule.**

### Separate finding, actionable and unrelated to the above: 60s windows are often completely empty

| Interval | Markets sampled | Books with any depth |
|---|---|---|
| **60s** | 2 (BTC, ETH, both at T-47s) | **0 / 2 — all four sides empty, 0 levels** |
| **300s** | 2 (BTC, ETH, both at T-107s) | **2 / 2 — 3 levels per side** |

Runs 1 and 2 both used **60s** markets. Their books happened to be populated at
selection time (run 2 read 200 units at T-26s), so 60s books do fill in — but at
T-47s here, both were bare. 300s windows carried depth in every sample.
Sampling caps: 12 live markets, 4 probed, one moment in time — this is a snapshot,
not a distribution. **Practical consequence: prefer 300s windows for any run that
needs a fill, and treat 60s as unreliable.** Not investigated further.

### PART 2 VERDICT and why PART 3 DID NOT RUN

Part 3 was explicitly gated on Part 2 confirming "thin book, not a bug." **Part 2
does not confirm that** — run 2's book demonstrably held 200 units of matchable
liquidity behind the NO quote, so the non-fill is not explained by thinness. Per
the instruction for the branch-B case, I logged it and stopped rather than
attempting a fix or proceeding.

**Note for the go/no-go decision:** the missing payout proof does not actually
depend on resolving the NO-fill question. The **YES** side has real, matchable
resting asks and has filled reliably in both runs. A single-sided YES bet,
repeated across fresh 300s windows until a win, would obtain the non-zero payout
proof while sidestepping the NO-fill issue entirely — which is what Part 3
already describes ("pick whichever side currently has visible resting depth").
Part 3 is therefore viable as written; it is held only because its stated gate
was not met. Awaiting your go-ahead.

---

## PHASE A — RUN 3 / PART 3 (2026-08-25) — REAL WINNING PAYOUT, at last

**Result: PASS. A non-zero winning payout has now been observed on-chain and
confirmed by balance delta.** This was the one proof missing across runs 1 and 2.
Script `build/part3-win-proof.mjs`, machine output `build/PART3-RESULT.json`.
227.4s wall clock, 2 of a budgeted 5 attempts used.

Strategy per the Part 2 finding: **YES-only, single-sided, 300s windows.** The
NO-fill question was sidestepped entirely rather than solved — no `BUY_NO` was
placed. 60s windows were excluded (empty books, 2/2 samples).

Guard logic was first refactored out of `build/phase-a-lifecycle.mjs` into
**`build/redeem-guard.mjs`**, imported by both that script and the Part 3 script,
so the live run exercises the *shipped* guard rather than a copy. Re-verified
after the refactor: the same 7 unit cases, **7/7 pass**, behaviour identical.

### Attempt 1 — NO FILL (no position, nothing to redeem)

Market `0x…8c07` BTC 300s, pool `0xf43f41ea…75ad`, T-218s.
Real resting `yesAsks` depth **990 units**, best ask **364000** (0.364).
Crossing bid **384000** (0.384, on-tick, +20 ticks).

| | |
|---|---|
| tx | `0x5106bf8150f67794932355159959264a74363eb335bf50fc387e50f8067d6d02` |
| status | success, block 470443869, **gas 3,280,841**, 4 logs |
| ERC6909 delta | **0 → 0 (no fill)** |
| collateral | −0.384 — locked at the bid's own limit price |

**A `BUY_YES` crossing a real resting ask by 20 ticks, with 990 units available,
did not fill.** Recorded plainly because it matters for the record (see below).

### Attempt 2 — FILLED, WON, REDEEMED, PAID

Market `0x…8c08` ETH 300s, pool `0x0914a6be…9b3c`, T-208s.
Real resting `yesAsks` depth **990 units**, best ask **614000** (0.614).
Crossing bid **634000** (0.634, on-tick, +20 ticks — the same +20 as attempt 1).

| Stage | Detail |
|---|---|
| order tx | `0xc5a1e655d611dc5fbb3ea4eb80e4bd1efc1538bdecc354f4733d270276685d2b` success, block 470443940, gas 1,425,054, 8 logs |
| fill | **ERC6909 0 → 1000000** (1.0 unit) |
| cost | **−0.614 tUSDC — filled AT THE ASK (0.614), not at our 0.634 bid.** Correct maker-price CLOB behaviour. |
| settlement | `{status: 4, finalized: true, isResolved: true, winningOutcome: 0}` — **YES WON** |
| indexer cross-check | Finalized entry found, `winningOutcome = 0` — agrees with chain |
| **GUARD** | **ALLOW** — `WINNER — outcomeIdx=0 === on-chain winningOutcome=0` |
| redeem sim | NO REVERT |
| **redeem tx** | **`0x9d97aeedd655066a8cd906e2fcf47952b74948ec68f40b3739bd1e3edeca4366`** success, block 470446008, gas 472,707, 5 logs |

**The payout proof, by balance delta rather than transaction status:**

| Check | Before | After | Delta |
|---|---|---|---|
| **tUSDC** `balanceOf(owner)` | `9998.444` | `9999.444` | **+1.000000 — NON-ZERO** |
| **ERC6909** `balanceOf(owner, yesTokenId)` | `1000000` | `0` | burned |

**+1.000000 tUSDC for 1.0 unit redeemed — exactly 1:1**, matching
`payoutNumerators/payoutDenominator = 10000000/10000000 = 1.0`. Bought the winning
side at 0.614, redeemed for 1.000: **+0.386 net on the trade.** The full lifecycle
— fund → gate → snap → place → settle → discover → guard → redeem → get paid — is
now proven end to end with real transactions.

### The guard, live: ALLOW proven, BLOCK **not** exercised this run

Honest accounting of the secondary proof that was asked for:

| Path | Status |
|---|---|
| **ALLOW on a winner** | **PROVEN LIVE** — attempt 2, gated the real redeem that paid out |
| **BLOCK on a loser** | **NOT exercised live this run** |

The BLOCK path never fired because no attempt produced a *losing filled
position*: attempt 1 didn't fill (no tokens, nothing to redeem) and attempt 2 won
outright. So the BLOCK path remains supported by the 7/7 unit tests plus run 2's
real-world demonstration of the burn it prevents — but it did not get a live
on-chain rehearsal. Stated rather than glossed, since a live BLOCK was part of the
ask.

### Bearing on the Part 2 hypothesis — a correction to the record

Part 2's leading hypothesis was that `BUY_NO` cannot fill because the NO side has
no literal resting orders (only a display mirror of the YES book). **Attempt 1
weakens that hypothesis:** a `BUY_YES` also failed to fill against 990 units of
real, literal, resting `yesAsks` while crossing by 20 ticks — and attempt 2, with
the *same* +20-tick crossing on the same kind of book, filled. So non-filling is
**not NO-specific**, and "no literal resting orders on that side" cannot be the
whole explanation.

Distinguishing datum, recorded not interpreted: the non-fill burned **3,280,841
gas / 4 logs** — the highest of any order placed in any run, and 2.3× the
*successful* fill's 1,425,054. A non-fill that costs more gas than a fill is not
the signature of "no matching logic ran," which is what run 2's cheap 281,962-gas
NO non-fill suggested. These two non-fills look like different phenomena.

Per the standing no-new-investigation rule I did not pursue this. It is logged as
an open question that supersedes part of Part 2's hypothesis.

### Also observed, not chased

- **A resting unfilled buy locks collateral at its own limit price** (attempt 1:
  exactly −0.384 for a 0.384 bid). This is now established, and it does **not**
  reconcile with run 2's −0.245 total, where a supposedly-resting 0.999 NO order
  locked nothing observable. Another sign run 2's NO leg did not simply "rest."
- **Attempt 1's 0.384 tUSDC has not returned.** Net collateral across the whole
  run: `9999.442 → 9999.444` (+0.002) = −0.384 locked, −0.614 paid, +1.000 paid
  out. The market has since expired with the order unfilled; whether that
  collateral is recoverable (cancel / expiry refund) is **not established**.
- Filled orders execute at the **maker's** price, not the taker's limit
  (paid 0.614 on a 0.634 bid) — favourable and worth relying on.

### PART 3 VERDICT

**PASS.** Non-zero winning payout confirmed by tUSDC balance delta (+1.000000)
and ERC6909 burn (1000000 → 0), gated by the shared guard's live ALLOW.
Redeem tx `0x9d97aeed…4366`.

---

## PHASE A — RUN 3 / PART 4 (2026-08-25) — is locked collateral on an expired unfilled order recoverable?

**Result: PASS — fully recovered, automatically, with no owner action required.**
Scope was recovery only; the deferred non-fill question stays closed and was not
touched. Read-only check, nothing broadcast.

### The question

Part 3 attempt 1 (`0x5106bf81…6d02`, pool `0xf43f41ea…75ad`, market `0x…8c07`)
placed a `BUY_YES` that never filled and locked **0.384 tUSDC** at its own limit
price. That market then expired with the order still resting. Part 3 closed with
the money still out: balance `9999.444` against a `9999.442` start, i.e. the
0.384 unaccounted for.

### The answer

| | |
|---|---|
| balance at Part 3 end | `9999.444` (0.384 locked) |
| **balance now** | **`9999.828`** |
| delta | **+0.384000 — the exact locked amount, to the last unit** |

**No cancel call was made. No transaction was broadcast by the owner between Part
3 finishing and this check.** The collateral returned on its own.

### Full-run reconciliation — nothing is stuck

| Movement | Amount |
|---|---|
| balance at Part 3 start | `9999.442` |
| attempt 1 rest (locked) | −0.384 |
| attempt 2 fill (paid at maker's ask) | −0.614 |
| attempt 2 redeem payout | +1.000 |
| attempt 1 refund (automatic) | **+0.384** |
| **balance now** | **`9999.828`** |

Net versus Part 3 start: **+0.386000**, which equals the pure trade P&L
(1.000 payout − 0.614 entry) **exactly**. **Remaining stuck collateral: 0.**
The entire run now accounts for precisely the trading result and nothing else.

### Mechanism — plausible, and explicitly NOT verified

`binaryPoolWriteAbi` carries three functions consistent with what was observed:

```
cancelOrder(uint128 orderId)
cancelExpiredOrders(uint128[] orderIds)
sweepExpiredAtLevel(bool isBid, uint256 price, uint256 maxCount)
```

The last two are expiry-specific and permissionless-looking, which is consistent
with a keeper sweeping expired orders and releasing their locked collateral —
matching a refund that arrived with no action from us. **This is inference from
the ABI plus the observed refund, not a verified mechanism:** no sweep transaction
was located, and no attempt was made to attribute the refund to a specific call.
Confirming it would need the tx that did it, which is outside this check's scope.

`cancelOrder(uint128)` also exists as a manual escape hatch should a refund ever
*not* arrive — untested, since it was not needed here.

### Practical consequence for the build

Unfilled resting orders are **not** a leak. Collateral locked by an order that
expires unfilled comes back without intervention. A bot does not need to track
and cancel stale orders to avoid losing funds — though it should still expect the
collateral to be **temporarily** unavailable between placement and expiry, which
is a working-capital consideration rather than a loss. Timing was not measured
precisely: the refund was present at the first check, a few minutes after
expiry, so the upper bound on latency is "under roughly ten minutes," not tighter.
