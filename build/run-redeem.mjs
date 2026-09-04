// Disposable script — calls redeem with positional args, bypassing this
// terminal's shell-quoting problem the same way the other run-*.mjs scripts do.
// Usage: node build/run-redeem.mjs <market_id> [session_id] [--dry-run]
import { redeem } from './mcp-core.mjs';

const dryRun = process.argv.includes('--dry-run');
const positional = process.argv.slice(2).filter((a) => a !== '--dry-run');

const res = await redeem({
  market_id: positional[0],
  session_id: positional[1] ?? 'live_test_1',
  dry_run: dryRun,
});
console.log(JSON.stringify(res, null, 2));
