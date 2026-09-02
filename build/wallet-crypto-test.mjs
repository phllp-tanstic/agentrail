// Offline, no-network test suite for wallet.mjs's encryption-at-rest layer.
// Run: node build/wallet-crypto-test.mjs
//
// Uses a scratch store file and a throwaway master key — never touches a real
// wallet store or real key material.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_STORE = path.join(os.tmpdir(), `agentrail-wallet-crypto-test-${process.pid}.json`);
process.env.AGENTRAIL_WALLET_STORE = TEST_STORE;
process.env.AGENTRAIL_WALLET_MASTER_KEY = randomBytes(32).toString('hex');

const { generate_wallet, list_wallets, _privateKeyForSession, _resetStoreForTests, _crypto }
  = await import('./wallet.mjs');

let pass = 0, fail = 0;
function check(n, desc, cond, detail = '') {
  if (cond) { pass++; console.log(` ${n}. [PASS] ${desc}`); }
  else { fail++; console.log(` ${n}. [FAIL] ${desc}`); }
  if (detail) console.log(`         ${detail}`);
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

_resetStoreForTests();

console.log(`scratch store: ${TEST_STORE}\n`);
console.log('=== ROUND TRIP ===\n');

const created = generate_wallet({ session_id: 'sA' });
check(1, 'generate_wallet succeeds with a valid master key set',
  created.ok === true && created.created === true && /^0x[0-9a-fA-F]{40}$/.test(created.address),
  `address=${created.address}`);

check(2, 'the created record reports encrypted:true', created.encrypted === true);

const rawStore = JSON.parse(fs.readFileSync(TEST_STORE, 'utf8'));
check(3, 'the on-disk record has NO privateKey field',
  rawStore.wallets.sA.privateKey === undefined);
check(4, 'the on-disk record has an encPrivateKey with the expected shape',
  typeof rawStore.wallets.sA.encPrivateKey === 'object'
  && rawStore.wallets.sA.encPrivateKey.alg === 'aes-256-gcm'
  && typeof rawStore.wallets.sA.encPrivateKey.iv === 'string'
  && typeof rawStore.wallets.sA.encPrivateKey.ciphertext === 'string'
  && typeof rawStore.wallets.sA.encPrivateKey.authTag === 'string');
check(5, 'the on-disk ciphertext does not contain the address in any obvious plaintext form',
  !rawStore.wallets.sA.encPrivateKey.ciphertext.includes(created.address.slice(2).toLowerCase()));

const pk = _privateKeyForSession('sA');
check(6, '_privateKeyForSession decrypts to a well-formed private key',
  /^0x[0-9a-fA-F]{64}$/.test(pk));

const { privateKeyToAccount } = await import('viem/accounts');
const derived = privateKeyToAccount(pk);
check(7, 'the decrypted key actually derives the SAME address generate_wallet returned',
  derived.address.toLowerCase() === created.address.toLowerCase(),
  `derived=${derived.address} expected=${created.address}`);

console.log('\n=== TAMPER DETECTION (GCM auth tag) ===\n');

const tamperedStore = JSON.parse(fs.readFileSync(TEST_STORE, 'utf8'));
const origCt = tamperedStore.wallets.sA.encPrivateKey.ciphertext;
// flip one hex character in the ciphertext
const flipped = (origCt[0] === '0' ? '1' : '0') + origCt.slice(1);
tamperedStore.wallets.sA.encPrivateKey.ciphertext = flipped;
fs.writeFileSync(TEST_STORE, JSON.stringify(tamperedStore, null, 2));

const tamperErr = throws(() => _privateKeyForSession('sA'));
check(8, 'a tampered ciphertext throws on decrypt rather than returning garbage',
  tamperErr !== null, tamperErr ? `threw: ${tamperErr.message.slice(0, 60)}...` : 'did NOT throw — SEVERE');

// restore
fs.writeFileSync(TEST_STORE, JSON.stringify(rawStore, null, 2));
check(9, 'restoring the untampered store makes decryption succeed again',
  /^0x[0-9a-fA-F]{64}$/.test(_privateKeyForSession('sA')));

console.log('\n=== WRONG KEY ===\n');

const realKey = process.env.AGENTRAIL_WALLET_MASTER_KEY;
process.env.AGENTRAIL_WALLET_MASTER_KEY = randomBytes(32).toString('hex'); // different key
const wrongKeyErr = throws(() => _privateKeyForSession('sA'));
check(10, 'decrypting with the WRONG master key throws (GCM auth tag fails), not silent garbage',
  wrongKeyErr !== null);
process.env.AGENTRAIL_WALLET_MASTER_KEY = realKey; // restore

console.log('\n=== MASTER KEY VALIDATION ===\n');

const savedKey = process.env.AGENTRAIL_WALLET_MASTER_KEY;
delete process.env.AGENTRAIL_WALLET_MASTER_KEY;
const noKeyErr = throws(() => generate_wallet({ session_id: 'sB' }));
check(11, 'generate_wallet on a NEW session refuses outright with no master key set',
  noKeyErr !== null && /AGENTRAIL_WALLET_MASTER_KEY/.test(noKeyErr.message));

process.env.AGENTRAIL_WALLET_MASTER_KEY = 'not-hex-and-wrong-length';
const badKeyErr = throws(() => generate_wallet({ session_id: 'sC' }));
check(12, 'a malformed master key (wrong length/not hex) is refused, not truncated or padded',
  badKeyErr !== null && /64 hex/.test(badKeyErr.message));

process.env.AGENTRAIL_WALLET_MASTER_KEY = savedKey;

console.log('\n=== EXISTING-WALLET PATH DOES NOT NEED THE KEY ===\n');

const noKeyForList = (() => { delete process.env.AGENTRAIL_WALLET_MASTER_KEY; try { return list_wallets(); } finally { process.env.AGENTRAIL_WALLET_MASTER_KEY = savedKey; } })();
check(13, 'list_wallets works with no master key set (address-only, never touches key material)',
  noKeyForList.ok === true && noKeyForList.count >= 1);

const idempotentNoKey = (() => { delete process.env.AGENTRAIL_WALLET_MASTER_KEY; try { return generate_wallet({ session_id: 'sA' }); } finally { process.env.AGENTRAIL_WALLET_MASTER_KEY = savedKey; } })();
check(14, 'the idempotent "already exists" path for generate_wallet ALSO does not require the master key',
  idempotentNoKey.ok === true && idempotentNoKey.created === false);

console.log('\n=== LEGACY (PRE-ENCRYPTION) RECORD HANDLING ===\n');

const legacyStore = _crypto.readStore();
legacyStore.wallets.sLegacy = { address: '0x' + '11'.repeat(20), privateKey: '0x' + 'aa'.repeat(32),
  createdAt: new Date().toISOString(), label: null };
legacyStore.version = 1;
_crypto.writeStore(legacyStore);

const legacyErr = throws(() => _privateKeyForSession('sLegacy'));
check(15, 'a legacy plaintext record refuses to sign rather than silently using the plaintext key',
  legacyErr !== null && /migrate-wallet-store/.test(legacyErr.message));

const legacyList = list_wallets();
const legacyEntry = legacyList.wallets.find((w) => w.sessionId === 'sLegacy');
check(16, 'list_wallets still shows a legacy record (address-only) and flags it as unencrypted',
  legacyEntry && legacyEntry.encrypted === false);

const legacyGenerateNote = generate_wallet({ session_id: 'sLegacy' });
check(17, 'calling generate_wallet on an existing legacy record returns it unchanged AND warns it needs migration',
  legacyGenerateNote.created === false && /migrate-wallet-store/.test(legacyGenerateNote.note));

console.log('\n=== NO KEY EVER APPEARS IN A TOOL-FACING RESPONSE ===\n');

const allResponses = JSON.stringify([created, list_wallets(), idempotentNoKey, legacyGenerateNote]);
check(18, 'the decrypted private key never appears in any tool response, serialized',
  !allResponses.includes(pk.slice(2)));
check(19, 'no encPrivateKey internals (iv/ciphertext/authTag) leak into a tool response either',
  !/ciphertext|authTag/.test(allResponses));

_resetStoreForTests();
console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
