// One-off disposable script for the live NO-side test — bypasses PowerShell's
// shell-quoting entirely by hardcoding the call instead of passing JSON through argv.
// api_key comes from --api-key <key> or AGENTRAIL_API_KEY (write tools require it).
import { place_order } from './mcp-core.mjs';

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf('--api-key');
const api_key = flagIdx >= 0 ? argv.splice(flagIdx, 2)[1] : process.env.AGENTRAIL_API_KEY;
const flagIdx2 = argv.indexOf('--session');   // optional: session to order from (default live_test_1)

const res = await place_order({
  session_id: flagIdx2 >= 0 ? argv.splice(flagIdx2, 2)[1] : 'live_test_1',
  market_id: argv[0],            // pass the market_id as a plain positional arg, no JSON quoting needed
  direction: 'NO',
  targetDollarAmount: 1,
  maxSlippagePct: Number(argv[1] ?? 5),  // optional 3rd arg widens the tolerance for a thin testnet book
  api_key,
});

console.log(JSON.stringify(res, null, 2));
