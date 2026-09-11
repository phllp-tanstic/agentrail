// Disposable script — checks market status + position for a session, using
// positional args to sidestep this terminal's JSON-quote-stripping issue.
// Usage: node build/run-check-position.mjs <market_id> [session_id]
// api_key comes from --api-key <key> or AGENTRAIL_API_KEY (session paths require it).
import { get_position } from './mcp-core.mjs';

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf('--api-key');
const api_key = flagIdx >= 0 ? argv.splice(flagIdx, 2)[1] : process.env.AGENTRAIL_API_KEY;

const res = await get_position({
  market_id: argv[0],
  session_id: argv[1] ?? 'live_test_1',
  api_key,
});
console.log(JSON.stringify(res, null, 2));
