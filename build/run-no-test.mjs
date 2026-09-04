// One-off disposable script for the live NO-side test — bypasses PowerShell's
// shell-quoting entirely by hardcoding the call instead of passing JSON through argv.
import { place_order } from './mcp-core.mjs';

const res = await place_order({
  session_id: 'live_test_1',
  market_id: process.argv[2],   // pass the market_id as a plain positional arg, no JSON quoting needed
  direction: 'NO',
  targetDollarAmount: 1,
  maxSlippagePct: Number(process.argv[3] ?? 5),  // optional 3rd arg widens the tolerance for a thin testnet book
});

console.log(JSON.stringify(res, null, 2));
