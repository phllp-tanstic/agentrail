// ============================================================================
// AgentRail MCP SERVER — stdio transport.
//
// A THIN registration layer over ./mcp-core.mjs. There is deliberately no logic
// in this file beyond schema declaration and result serialisation: everything
// that touches the chain lives in mcp-core.mjs, which wraps the proven build/
// scripts. If you are looking for behaviour, look there.
//
// Run:  node build/mcp-server.mjs        (expects AGENTRAIL_OWNER_KEY in env)
// Test: node build/mcp-test.mjs          (calls the same functions directly)
// ============================================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as core from './mcp-core.mjs';

const server = new McpServer({ name: 'agentrail', version: '0.1.0' });

// Every tool returns JSON text. bigints are stringified by core.jsonSafe.
const wrap = (fn) => async (args) => {
  try {
    const res = await fn(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(core.jsonSafe(res), null, 2) }],
      isError: res?.ok === false };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false,
      error: e.shortMessage ?? e.message, stack: undefined }, null, 2) }], isError: true };
  }
};

const SCOPE = 'PROVEN SCOPE ONLY: single-sided YES bets on 300-second windows, via the self `placeBinaryOrder` path. NO-side orders, other window lengths, and the delegated operator path are refused — they are unproven or closed. Somnia Shannon testnet.';

server.registerTool('list_markets', {
  title: 'List tradeable DreamDEX event-contract windows',
  description: `Live binary markets that are (a) 300-second windows, (b) OPEN on the on-chain status gate (getMarketOnchain().status === Trading), and (c) backed by real resting YES-side ask depth. Sorted soonest-settlement first. ${SCOPE}`,
  inputSchema: {
    window_seconds: z.number().int().default(300)
      .describe('Window length. Only 300 is in proven scope; anything else is refused.'),
    require_yes_liquidity: z.boolean().default(true)
      .describe('Drop markets with zero resting yesAsks depth. Depth is cheap to check (one order-book read per candidate) so this defaults on.'),
    min_seconds_to_expiry: z.number().int().default(25)
      .describe('Skip markets settling too soon to place into.'),
    max_seconds_to_expiry: z.number().int().default(290)
      .describe('Skip markets whose settlement is too far out to wait for.'),
  },
}, wrap(core.list_markets));

server.registerTool('place_order', {
  title: 'Place a YES-direction bet on a 300s window',
  description: `Snaps the crossing price to a valid integer tick (shared build/tick-snap.mjs), auto-approves the per-pool ERC20 allowance, enforces server-side risk guardrails, simulates, then broadcasts via the self \`placeBinaryOrder\` path. Fill is confirmed by ERC6909 + collateral BALANCE DELTA, never by transaction status. If the receipt-time read shows no fill, the order is polled every 5s for up to 60s. Returns \`fill.fillStatus\` as one of three DISTINCT states, which must not be collapsed: **FILLED** (confirmed by balance increase, with observed latency in \`fill.resolution\`), **PENDING** (accepted and resting, unresolved at the 60s deadline — \`fill.filled\` is \`null\`, NOT false; recheck with get_position), **NOT_FILLED** (terminal — window expired unfilled). Size EITHER by \`stake_units\` (raw outcome-token quantity) OR by \`targetDollarAmount\` (cash) — not both. A reverted broadcast returns \`{ok:false, reason:'reverted'}\` and is retried automatically exactly once; it is a normal, often state-dependent outcome. Risk limits (max stake per window, max daily loss) are enforced server-side from environment configuration and are deliberately NOT parameters of this tool. ${SCOPE}`,
  inputSchema: {
    market_id: z.string().describe('marketId from list_markets.'),
    direction: z.enum(['YES', 'NO']).default('YES')
      .describe('Only YES is supported. NO is refused: a BUY_NO has never filled at any expressible price and the cause is undetermined.'),
    stake_units: z.number().optional()
      .describe('Sizing mode A: OUTCOME-TOKEN QUANTITY to buy, not a cash amount. 1.0 = one unit, the size proven in Phase A. Mutually exclusive with targetDollarAmount. Defaults to 1.0 if neither is given.'),
    targetDollarAmount: z.number().optional()
      .describe('Sizing mode B: target CASH to spend, in USD (tUSDC). Quantity is derived as targetDollarAmount / current best ask, rounded to the minQuantity grid. Actual spend is reported as fill.collateralSpent alongside dollarSizing.varianceUsd — do not assume the target is hit exactly. Mutually exclusive with stake_units.'),
    maxSlippagePct: z.number().default(5)
      .describe('Only enforced with targetDollarAmount. If the best ask moves adversely by more than this percentage between the read used for sizing and the read immediately before broadcast, the order is refused with reason "slippage_exceeded" rather than placed. The deliberate cross_ticks premium is not counted as slippage. CLAMPED server-side to a 50% ceiling — a higher value is reduced to 50 and reported as slippage.clamped, NOT rejected. A non-numeric value falls back to 5 rather than silently disabling the guard.'),
    cross_ticks: z.number().int().default(20)
      .describe('How many ticks above the best resting ask to bid. 20 is the value that filled in the Phase A proof.'),
    window_seconds: z.number().int().default(300)
      .describe('Asserted against the market\'s actual intervalSec; a mismatch is refused.'),
    session_id: z.string().optional()
      .describe('Which user/session trade log to record this order under. Optional — defaults to AGENTRAIL_SESSION_ID or "default". Pass the same session_id used for generate_wallet to keep one user\'s wallet, orders and redemptions in a single history.'),
  },
}, wrap(core.place_order));

server.registerTool('get_position', {
  title: 'Get held position and market status',
  description: `For one market: the owner's ERC6909 balance in both outcome token ids, plus whether the market is Trading / Finalized on-chain. winningOutcome is withheld until the market is finalized, because getMarketOnchain returns 0 as a pre-settlement default which misreads as "YES won". ${SCOPE}`,
  inputSchema: { market_id: z.string().describe('marketId to inspect.') },
}, wrap(core.get_position));

server.registerTool('redeem', {
  title: 'Redeem finalized winning positions (hard-guarded)',
  description: `Discovers settled positions via listBinaryMarkets({status:"Finalized"}) — NOT default discovery, which is a disjoint set and silently reports nothing owed. Ensures the token-wide ERC6909 operator grant (read first, never assumed). Then runs the shared redeemGuard on every leg BEFORE any broadcast: a BLOCK refuses and reports, leaving the position intact. This matters because a losing redeem does NOT revert — it burns the position and pays zero with a success receipt. Payout is confirmed by tUSDC balance delta. ${SCOPE}`,
  inputSchema: {
    market_id: z.string().optional()
      .describe('Restrict to one market. Omit to scan every finalized market for held positions.'),
    dry_run: z.boolean().default(false)
      .describe('Run discovery and the guard, report what would happen, broadcast nothing.'),
    session_id: z.string().optional()
      .describe('Which user/session trade log to record each leg under. Optional — defaults to AGENTRAIL_SESSION_ID or "default". Every leg gets its own entry, so a guard BLOCK is logged separately from any payout.'),
  },
}, wrap(core.redeem));

server.registerTool('generate_wallet', {
  title: 'Create a purpose-only dedicated wallet for a session',
  description: `Generates a fresh keypair for a session and returns ONLY the address — the private key is never returned to the caller and stays server-side. Per the spec's custody model, a user funds this purpose-only wallet with what they intend to trade instead of exposing a main wallet, so the blast radius is bounded by the deposit. IDEMPOTENT: calling twice for the same session_id returns the FIRST wallet with created:false rather than generating a second one, because rotating an address that may already hold a deposit would strand those funds. CUSTODY, stated plainly: this is a CUSTODIAL model — AgentRail holds the key and CAN move these funds. That is a DIFFERENT model from the operator-delegation design, where the operator key is scoped on-chain and architecturally cannot move funds; do not describe this wallet as non-custodial. Keys are plaintext JSON on local disk with no encryption and no recovery path. NOTE: place_order does not yet sign with this wallet — routing execution through it is separate, unimplemented work.`,
  inputSchema: {
    session_id: z.string().describe('Identifier the wallet is stored under and looked up by later. Required, non-empty.'),
    label: z.string().optional().describe('Optional human-readable note stored alongside the address.'),
    force_new: z.boolean().default(false)
      .describe('Generate a replacement keypair even though one exists for this session_id. The previous record is retained server-side under a suffixed key rather than deleted, but is no longer reachable by this session_id. Only pass true if you accept that.'),
  },
}, wrap(core.generate_wallet));

server.registerTool('get_wallet_balance', {
  title: 'Check tUSDC and SOMI balance for a wallet',
  description: `Direct on-chain reads (eth_getBalance + ERC20 balanceOf) of a generated wallet's collateral and gas balances, so a caller can confirm a deposit landed BEFORE attempting to trade. Not an indexer read, so a deposit appears as soon as it is mined. Accepts either session_id (resolved through the wallet store) or a raw address; an address not in the store is still reported, since these are public reads, but flagged known:false because AgentRail holds no key for it. Reports tUSDC and SOMI SEPARATELY and does not collapse them into one "funded" flag: tUSDC is the collateral an order spends and SOMI pays the gas to broadcast it, so a wallet holding collateral but no SOMI cannot place an order at all.`,
  inputSchema: {
    session_id: z.string().optional().describe('Session whose wallet to check. Either this or address is required.'),
    address: z.string().optional().describe('Raw 0x address to check. Either this or session_id is required.'),
  },
}, wrap(core.get_wallet_balance));

server.registerTool('list_wallets', {
  title: 'List known dedicated wallets (addresses only)',
  description: 'Every session/address pair in the wallet store. Addresses and metadata only — private keys are never returned by any tool.',
  inputSchema: {},
}, wrap(core.list_wallets));

server.registerTool('parse_intent', {
  title: 'Validate and normalize a trading intent into place_order arguments',
  description: `Takes ALREADY-EXTRACTED structured intent and returns exactly what place_order needs, refusing anything unsupported before it can reach the chain. THIS TOOL DOES NOT DO NATURAL-LANGUAGE UNDERSTANDING and does not call an LLM — YOU (the calling agent) read the user's sentence and extract direction/asset/window/amount; this validates and normalizes them deterministically. It accepts synonyms (up/long -> YES, bitcoin -> BTC, "5m" -> 300, "$10" -> 10), resolves the asset to a live gated market with real YES depth, and returns a \`confirmation\` block with estimated units, cost, max payout and payout multiple to show the user BEFORE executing. IT PLACES NOTHING — pass the returned \`placeOrderArgs\` to place_order after the user confirms. Refusals use stable machine codes in \`reason\`: direction_not_supported (NO side — never filled at any expressible price, cause undetermined), window_not_supported (only 300s is proven; 60s liquidity is UNRELIABLE, not confirmed empty), asset_not_supported, ambiguous_sizing, sizing_required, invalid_target_dollar_amount, no_tradeable_market (transient, not invalid), no_market_with_adequate_runway (markets exist but all settle too soon to confirm — see min_seconds_to_expiry). ${SCOPE}`,
  inputSchema: {
    direction: z.string().optional()
      .describe('Direction the user wants, as extracted. Synonyms accepted: YES/up/long/higher/bullish -> YES; NO/down/short/lower/bearish -> NO (refused, with the documented reason).'),
    asset: z.string().optional()
      .describe('Asset as extracted. Accepts BTC/bitcoin/XBT and ETH/ether/ethereum. Only BTC and ETH are in scope.'),
    window_seconds: z.union([z.number(), z.string()]).optional()
      .describe('Settlement window. Accepts 300, "300s", "5m", "5 minutes". Only 300s is in proven scope; anything else is refused rather than substituted.'),
    targetDollarAmount: z.union([z.number(), z.string()]).optional()
      .describe('Cash to spend. Accepts 10, "10", "$10", "10 USD". Mutually exclusive with stake_units.'),
    stake_units: z.union([z.number(), z.string()]).optional()
      .describe('Raw outcome-token quantity, NOT a cash amount. Mutually exclusive with targetDollarAmount.'),
    maxSlippagePct: z.number().optional().describe('Passed through to place_order. Clamped there to a 50% ceiling.'),
    cross_ticks: z.number().int().optional().describe('Passed through to place_order. Defaults to the proven 20 if omitted.'),
    resolve_market: z.boolean().default(true)
      .describe('Resolve the asset to a live market_id (needs a market read). Set false to validate the intent only, offline; placeOrderArgs is then incomplete.'),
    min_seconds_to_expiry: z.union([z.number(), z.string()]).optional()
      .describe('Minimum runway a market must have to be SELECTABLE, in seconds (accepts 90, "90s", "2m"). Defaults to 60 — enough time for a human to read the confirmation and reply before the window closes. Markets below it are skipped rather than selected, and are still reported in marketResolution.runway.skippedForInadequateRunway with their real secondsToExpiry, so nothing is hidden. If markets exist but none clear the floor, the refusal is the DISTINCT code no_market_with_adequate_runway, not no_tradeable_market. Pass 0 to disable the floor (only appropriate for a caller with no human confirmation step).'),
    raw_text: z.string().optional()
      .describe('The user\'s original sentence. Echoed back for audit ONLY — it is never parsed by this tool.'),
  },
}, wrap(core.parse_intent));

server.registerTool('get_trade_log', {
  title: 'Read the append-only record of everything AgentRail did for a user',
  description: `The auditable trade log (spec §2/§6). Append-only JSON Lines, one file per session, never rewritten. Records order placements with their three-state fill outcome (FILLED / PENDING / NOT_FILLED, kept distinct — a PENDING order is NOT a non-fill), redemptions PER LEG, wallet generation, and observed deposits. REFUSALS ARE FIRST-CLASS ENTRIES, not omissions: a redemption BLOCKed by the guard is logged as prominently as one that paid out, together with the guard's reason and the fact that the position was left intact rather than burned — a log that recorded only successes would read as a complete history while hiding the decisions that mattered most. Every entry carries a self-contained \`summary\` that explains itself without cross-referencing any other entry or tool. \`actor\` separates what AgentRail DID ("AGENTRAIL") from on-chain facts it merely NOTICED ("OBSERVED") — a user's deposit is the latter, since AgentRail has no deposit tool by design. Returns counts over the whole file even when the entry list is filtered or truncated, and reports \`elided\` plus an \`integrity\` block (malformed lines, seq uniqueness) so a partial view is never mistaken for the whole record. No entry ever contains private key material.`,
  inputSchema: {
    session_id: z.string().optional()
      .describe('Whose history to read. Defaults to AGENTRAIL_SESSION_ID or "default". The response lists sessionsKnown if you need to discover ids.'),
    limit: z.number().int().default(50)
      .describe('Maximum entries to return. The MOST RECENT matching entries are returned and `elided` reports how many older ones were left out.'),
    kind: z.enum(['ORDER', 'REDEEM', 'WALLET']).optional()
      .describe('Filter to one category. Summary counts still cover the whole file.'),
    outcome: z.string().optional()
      .describe('Filter by outcome, e.g. FILLED, PENDING, NOT_FILLED, REFUSED, REVERTED, REDEEMED, BLOCKED, ZERO_PAYOUT, CREATED, DEPOSIT.'),
    refusals_only: z.boolean().default(false)
      .describe('Return only entries where ok:false — every refusal, block, revert and error. Use this for "show me everything AgentRail declined to do, and why".'),
    include_dry_runs: z.boolean().default(true)
      .describe('Dry-run redeem entries are logged and flagged dryRun:true so they can never be mistaken for a real broadcast. Set false to exclude them.'),
  },
}, wrap(core.get_trade_log));

await server.connect(new StdioServerTransport());
