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
      .describe('Only enforced with targetDollarAmount. If the best ask moves adversely by more than this percentage between the read used for sizing and the read immediately before broadcast, the order is refused with reason "slippage_exceeded" rather than placed. The deliberate cross_ticks premium is not counted as slippage.'),
    cross_ticks: z.number().int().default(20)
      .describe('How many ticks above the best resting ask to bid. 20 is the value that filled in the Phase A proof.'),
    window_seconds: z.number().int().default(300)
      .describe('Asserted against the market\'s actual intervalSec; a mismatch is refused.'),
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
  },
}, wrap(core.redeem));

await server.connect(new StdioServerTransport());
