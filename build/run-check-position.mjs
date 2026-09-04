// Disposable script — checks market status + position for a session, using
// positional args to sidestep this terminal's JSON-quote-stripping issue.
// Usage: node build/run-check-position.mjs <market_id> [session_id]
import { get_position } from './mcp-core.mjs';

const res = await get_position({
  market_id: process.argv[2],
  session_id: process.argv[3] ?? 'live_test_1',
});
console.log(JSON.stringify(res, null, 2));
