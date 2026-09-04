// Disposable script — reads the trade log with positional args.
// Usage: node build/run-trade-log.mjs [session_id] [limit]
import { get_trade_log } from './mcp-core.mjs';

const res = await get_trade_log({
  session_id: process.argv[2] ?? 'live_test_1',
  limit: Number(process.argv[3] ?? 5),
});
console.log(JSON.stringify(res, null, 2));
