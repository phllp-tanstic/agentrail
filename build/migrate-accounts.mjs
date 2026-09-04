// Backfills an account (and a real, one-time-shown api_key) for every session
// that already exists in the wallet store but has no account yet. Necessary
// because auth was added AFTER wallets already existed for real sessions —
// there is no way to know what an "original" api_key would have been, so
// this creates a genuinely new one for each.
//
// DRY RUN BY DEFAULT. Pass --confirm to actually create accounts.
//
// Usage:
//   node build/migrate-accounts.mjs           (dry run — lists what would be created)
//   node build/migrate-accounts.mjs --confirm (creates real accounts, prints each api_key ONCE)
import { list_wallets } from './wallet.mjs';
import { create_account, _accountExists } from './accounts.mjs';

const CONFIRM = process.argv.includes('--confirm');

const wallets = list_wallets();
const sessionIds = wallets.wallets.map((w) => w.sessionId);
const needsAccount = sessionIds.filter((sid) => !_accountExists(sid));

console.log(`Wallet store sessions: ${sessionIds.length}`);
console.log(`Already have an account: ${sessionIds.length - needsAccount.length}`);
console.log(`Need a NEW account backfilled: ${needsAccount.length}`);

if (needsAccount.length === 0) {
  console.log('Nothing to do — every wallet-store session already has an account.');
  process.exit(0);
}

console.log(`\nSessions that would get a new account: ${needsAccount.join(', ')}`);

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing was created. Re-run with --confirm to actually create accounts.');
  process.exit(0);
}

console.log('\nCreating accounts. EACH api_key BELOW IS SHOWN EXACTLY ONCE — save them now:\n');
const results = [];
for (const sid of needsAccount) {
  const res = create_account({ session_id: sid, label: 'backfilled by migrate-accounts.mjs' });
  if (!res.ok) {
    console.error(`  ${sid}: FAILED — ${res.detail ?? res.reason}`);
    results.push({ sid, ok: false });
    continue;
  }
  console.log(`  session_id: ${sid}`);
  console.log(`  api_key:    ${res.apiKey}`);
  console.log('');
  results.push({ sid, ok: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`Created ${results.length - failed} of ${needsAccount.length} accounts.` + (failed ? ` ${failed} FAILED — see above.` : ''));
console.log('\nEvery write tool (place_order, redeem, withdraw, generate_wallet) now requires the matching api_key for each session_id shown above. Store these somewhere durable — they cannot be re-fetched, only rotated.');
