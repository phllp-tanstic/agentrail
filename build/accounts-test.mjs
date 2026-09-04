// Offline, no-network test suite for accounts.mjs.
// Run: node build/accounts-test.mjs
import os from 'node:os';
import path from 'node:path';

const TEST_STORE = path.join(os.tmpdir(), `agentrail-accounts-test-${process.pid}.json`);
process.env.AGENTRAIL_ACCOUNTS_STORE = TEST_STORE;

const { create_account, rotate_api_key, list_accounts, _verifyApiKey, _accountExists,
  requireApiKey, _resetAccountsStoreForTests } = await import('./accounts.mjs');

let pass = 0, fail = 0;
function check(n, desc, cond, detail = '') {
  if (cond) { pass++; console.log(` ${n}. [PASS] ${desc}`); }
  else { fail++; console.log(` ${n}. [FAIL] ${desc}`); }
  if (detail) console.log(`         ${detail}`);
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

_resetAccountsStoreForTests();
console.log(`scratch store: ${TEST_STORE}\n`);

console.log('=== CREATION ===\n');

const created = create_account({ session_id: 'sA' });
check(1, 'create_account succeeds and returns a real api_key, once',
  created.ok === true && created.created === true && typeof created.apiKey === 'string'
  && created.apiKey.startsWith('ar_sk_'), `apiKey prefix=${created.apiKey.slice(0, 6)}`);

check(2, 'the returned api_key has real entropy (64 hex chars after the prefix)',
  /^ar_sk_[0-9a-f]{64}$/.test(created.apiKey));

check(3, '_accountExists confirms the account is stored', _accountExists('sA') === true);

const dup = create_account({ session_id: 'sA' });
check(4, 'creating a SECOND account for the same session_id is REFUSED, not silently reissued',
  dup.ok === false && dup.refused === true && dup.reason === 'account_already_exists');

const noSid = create_account({ session_id: '' });
check(5, 'an empty session_id is refused',
  noSid.ok === false && noSid.reason === 'session_id_required');

console.log('\n=== VERIFICATION ===\n');

check(6, 'the real api_key verifies successfully',
  _verifyApiKey('sA', created.apiKey).ok === true);

check(7, 'a wrong api_key (same length) is rejected',
  _verifyApiKey('sA', 'ar_sk_' + '0'.repeat(64)).ok === false
  && _verifyApiKey('sA', 'ar_sk_' + '0'.repeat(64)).reason === 'invalid_api_key');

check(8, 'a wrong-length api_key does not throw (timingSafeEqual length mismatch handled)',
  (() => { const r = _verifyApiKey('sA', 'too-short'); return r.ok === false; })());

check(9, 'an api_key for a NONEXISTENT session_id is rejected with a distinct reason',
  _verifyApiKey('sZZZ', created.apiKey).reason === 'account_not_found');

check(10, 'missing credentials (either side) is rejected before touching the store',
  _verifyApiKey('sA', null).reason === 'missing_credentials'
  && _verifyApiKey(null, created.apiKey).reason === 'missing_credentials');

console.log('\n=== requireApiKey (throwing gate) ===\n');

const okThrow = throws(() => requireApiKey('sA', created.apiKey));
check(11, 'requireApiKey does NOT throw for a valid session_id/api_key pair', okThrow === null);

const badThrow = throws(() => requireApiKey('sA', 'wrong-key'));
check(12, 'requireApiKey THROWS for an invalid api_key, with a message naming rotate_api_key',
  badThrow !== null && /rotate_api_key/.test(badThrow.message));

const missingThrow = throws(() => requireApiKey('sA', null));
check(13, 'requireApiKey THROWS when api_key is missing, pointing at create_account',
  missingThrow !== null && /create_account/.test(missingThrow.message));

console.log('\n=== ROTATION ===\n');

const rotateNoProof = rotate_api_key({ session_id: 'sA', current_api_key: 'wrong' });
check(14, 'rotation WITHOUT the correct current key is refused',
  rotateNoProof.ok === false && rotateNoProof.reason === 'invalid_current_api_key');

const rotated = rotate_api_key({ session_id: 'sA', current_api_key: created.apiKey });
check(15, 'rotation WITH the correct current key succeeds and returns a NEW key',
  rotated.ok === true && typeof rotated.apiKey === 'string' && rotated.apiKey !== created.apiKey);

check(16, 'the OLD api_key no longer verifies after rotation',
  _verifyApiKey('sA', created.apiKey).ok === false);

check(17, 'the NEW api_key verifies correctly after rotation',
  _verifyApiKey('sA', rotated.apiKey).ok === true);

const rotateNoAccount = rotate_api_key({ session_id: 'sNoSuch', current_api_key: 'anything' });
check(18, 'rotating a nonexistent account is refused with a distinct reason',
  rotateNoAccount.ok === false && rotateNoAccount.reason === 'account_not_found');

console.log('\n=== METADATA / VISIBILITY ===\n');

create_account({ session_id: 'sB', label: 'second tester' });
const listed = list_accounts();
check(19, 'list_accounts reports every account, metadata only',
  listed.ok === true && listed.count === 2
  && listed.accounts.some((a) => a.sessionId === 'sB' && a.label === 'second tester'));

const listedStr = JSON.stringify(listed);
check(20, 'list_accounts NEVER includes a hash, salt, or api_key field',
  !/hash|salt|apiKey/i.test(listedStr));

console.log('\n=== NO SECRET EVER LEAKS INTO AN UNEXPECTED RESPONSE ===\n');

const allResponses = JSON.stringify([dup, noSid, rotateNoProof, rotateNoAccount, listed]);
check(21, 'no real api_key value appears in any REFUSAL or listing response',
  !allResponses.includes(created.apiKey.slice(6)) && !allResponses.includes(rotated.apiKey.slice(6)));

_resetAccountsStoreForTests();
console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
