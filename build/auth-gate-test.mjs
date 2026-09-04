// Offline integration check: proves requireApiKey is actually wired into
// place_order, redeem, withdraw, get_position, and get_wallet_balance — not
// just that accounts.mjs works in isolation (accounts-test.mjs already
// proves that). This calls the REAL exported mcp-core.mjs functions with
// invalid/missing credentials and confirms each refuses or throws BEFORE any
// chain call is attempted — provable offline because requireApiKey is a
// synchronous throw at the very top of each function, before any `await`.
//
// Run: node build/auth-gate-test.mjs
import os from 'node:os';
import path from 'node:path';

const TEST_ACCOUNTS = path.join(os.tmpdir(), `agentrail-auth-gate-accounts-${process.pid}.json`);
const TEST_WALLETS = path.join(os.tmpdir(), `agentrail-auth-gate-wallets-${process.pid}.json`);
process.env.AGENTRAIL_ACCOUNTS_STORE = TEST_ACCOUNTS;
process.env.AGENTRAIL_WALLET_STORE = TEST_WALLETS;
process.env.AGENTRAIL_WALLET_MASTER_KEY = (await import('node:crypto')).randomBytes(32).toString('hex');

const { create_account } = await import('./accounts.mjs');
const core = await import('./mcp-core.mjs');

let pass = 0, fail = 0;
function check(n, desc, cond, detail = '') {
  if (cond) { pass++; console.log(` ${n}. [PASS] ${desc}`); }
  else { fail++; console.log(` ${n}. [FAIL] ${desc}`); }
  if (detail) console.log(`         ${detail}`);
}
async function rejects(promiseFn) {
  try { await promiseFn(); return null; } catch (e) { return e; }
}

console.log('=== SETUP ===\n');
const acct = create_account({ session_id: 'authtest_1' });
console.log(`created test account for authtest_1 (real api_key, kept in-memory only, never printed here)\n`);

console.log('=== place_order ===\n');

const r1 = await rejects(() => core.place_order({ session_id: 'authtest_1', market_id: '0xdead', direction: 'YES', targetDollarAmount: 1 }));
check(1, 'place_order with NO api_key throws before any chain call',
  r1 !== null && /create_account|api_key/i.test(r1.message), r1 ? r1.message.slice(0, 90) : 'did not throw');

const r2 = await rejects(() => core.place_order({ session_id: 'authtest_1', api_key: 'wrong-key', market_id: '0xdead', direction: 'YES', targetDollarAmount: 1 }));
check(2, 'place_order with a WRONG api_key throws before any chain call',
  r2 !== null && /rotate_api_key|api_key/i.test(r2.message), r2 ? r2.message.slice(0, 90) : 'did not throw');

const r3 = await rejects(() => core.place_order({ session_id: 'someone_elses_session', api_key: acct.apiKey, market_id: '0xdead', direction: 'YES', targetDollarAmount: 1 }));
check(3, 'a REAL api_key does NOT work for a DIFFERENT session_id (no cross-session reuse)',
  r3 !== null && /account_not_found|No account exists/i.test(r3.message), r3 ? r3.message.slice(0, 90) : 'did not throw');

console.log('\n=== redeem ===\n');

const r4 = await rejects(() => core.redeem({ session_id: 'authtest_1', market_id: '0xdead' }));
check(4, 'redeem with NO api_key throws before any chain call',
  r4 !== null && /api_key/i.test(r4.message));

const r5 = await rejects(() => core.redeem({ session_id: 'authtest_1', api_key: 'wrong-key', market_id: '0xdead' }));
check(5, 'redeem with a WRONG api_key throws before any chain call',
  r5 !== null && /api_key/i.test(r5.message));

console.log('\n=== withdraw ===\n');

const r6 = await rejects(() => core.withdraw({ session_id: 'authtest_1', to_address: '0x' + '1'.repeat(40), asset: 'tUSDC', amount: 1 }));
check(6, 'withdraw with NO api_key throws before any chain call',
  r6 !== null && /api_key/i.test(r6.message));

const r7 = await rejects(() => core.withdraw({ session_id: 'authtest_1', api_key: 'wrong-key', to_address: '0x' + '1'.repeat(40), asset: 'tUSDC', amount: 1 }));
check(7, 'withdraw with a WRONG api_key throws before any chain call',
  r7 !== null && /api_key/i.test(r7.message));

console.log('\n=== get_position (session_id path) ===\n');

const r8 = await rejects(() => core.get_position({ session_id: 'authtest_1', market_id: '0xdead' }));
check(8, 'get_position with NO api_key throws before any chain call',
  r8 !== null && /api_key/i.test(r8.message));

console.log('\n=== get_wallet_balance ===\n');

const r9 = await rejects(() => core.get_wallet_balance({ session_id: 'authtest_1' }));
check(9, 'get_wallet_balance with NO api_key throws when session_id is used',
  r9 !== null && /api_key/i.test(r9.message));

// This sandbox has no network route to the real RPC, so the raw-address path
// will throw on the network call itself — that's expected here and is NOT
// what this check is testing. The point is narrower: does it get PAST the
// auth gate without an api_key error? A thrown network error still proves
// that, since requireApiKey is never reached for the address-only path.
const r10 = await rejects(() => core.get_wallet_balance({ address: '0x' + '2'.repeat(40) }));
check(10, 'get_wallet_balance by raw address (no session_id) does NOT require api_key — public on-chain data, no session tie',
  r10 === null || !/api_key/i.test(r10.message),
  r10 ? `threw, but NOT for api_key reasons (network-layer only): ${r10.message.slice(0, 70)}` : 'succeeded outright');

console.log('\n=== generate_wallet ===\n');

const r11 = await rejects(() => Promise.resolve(core.generate_wallet({ session_id: 'authtest_1' })));
check(11, 'generate_wallet with NO api_key throws (does not silently create a wallet)',
  r11 !== null && /api_key/i.test(r11.message));

// Positive case: a REAL api_key for the RIGHT session actually gets past the
// auth gate — proven because generate_wallet succeeds (it needs no chain
// access at all, only the wallet store, so this can run fully offline).
const r12 = core.generate_wallet({ session_id: 'authtest_1', api_key: acct.apiKey });
check(12, 'generate_wallet with the CORRECT api_key for the CORRECT session succeeds',
  r12.ok === true && r12.created === true, `ok=${r12.ok} created=${r12.created}`);

console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
