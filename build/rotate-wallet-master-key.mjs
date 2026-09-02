// Rotates every wallet record to a NEW master key. Needed whenever the old
// master key is considered compromised (e.g. pasted somewhere it shouldn't
// have been) — re-encrypting under a fresh key with the old one discarded is
// the only real remediation; there is no way to "un-expose" the old key.
//
// DRY RUN BY DEFAULT. Pass --confirm to actually rotate. Always backs up first.
// Verifies every record decrypts under the NEW key and matches the OLD key's
// plaintext before declaring success — a silent rotation bug would be
// indistinguishable from success until the next real signing attempt.
//
// Usage:
//   AGENTRAIL_WALLET_MASTER_KEY=<OLD 64-hex-char key> \
//   AGENTRAIL_WALLET_MASTER_KEY_NEW=<NEW 64-hex-char key> \
//   node build/rotate-wallet-master-key.mjs [--confirm]
import fs from 'node:fs';
import { STORE_PATH, _crypto } from './wallet.mjs';

const CONFIRM = process.argv.includes('--confirm');

console.log(`Store path: ${STORE_PATH}`);

let store;
try { store = _crypto.readStore(); }
catch (e) { console.error(`Could not read the store: ${e.message}`); process.exit(1); }

const sids = Object.keys(store.wallets);
const encrypted = sids.filter((sid) => store.wallets[sid].encPrivateKey !== undefined);
const legacy = sids.filter((sid) => store.wallets[sid].privateKey !== undefined);

console.log(`Total records: ${sids.length}`);
console.log(`Encrypted (rotatable): ${encrypted.length}`);
if (legacy.length > 0) {
  console.log(`WARNING: ${legacy.length} record(s) are still PLAINTEXT (not yet migrated) and will be SKIPPED by rotation — run migrate-wallet-store.mjs first for those: ${legacy.join(', ')}`);
}
if (encrypted.length === 0) {
  console.log('Nothing to rotate.');
  process.exit(0);
}

let oldKey, newKey;
try {
  oldKey = _crypto.loadMasterKey(); // reads AGENTRAIL_WALLET_MASTER_KEY (the OLD/compromised one)
} catch (e) {
  console.error(`OLD key: ${e.message}`);
  process.exit(1);
}
const newHex = process.env.AGENTRAIL_WALLET_MASTER_KEY_NEW;
if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) {
  console.error('AGENTRAIL_WALLET_MASTER_KEY_NEW must be set to a 64-hex-char (32-byte) key, distinct from AGENTRAIL_WALLET_MASTER_KEY. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (newHex.toLowerCase() === process.env.AGENTRAIL_WALLET_MASTER_KEY.toLowerCase()) {
  console.error('AGENTRAIL_WALLET_MASTER_KEY_NEW is identical to the old key — refusing, since the point of rotation is that they differ.');
  process.exit(1);
}
newKey = Buffer.from(newHex, 'hex');

console.log(`\nRecords that would be rotated: ${encrypted.join(', ')}`);

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing was written. Re-run with --confirm to actually rotate.');
  process.exit(0);
}

const backupPath = `${STORE_PATH}.pre-rotation-${Date.now()}.bak`;
fs.copyFileSync(STORE_PATH, backupPath);
console.log(`\nBackup written: ${backupPath}`);

// Decrypt every record under the OLD key first, fully, before writing anything —
// so a bad old key fails loudly before any data is touched, not mid-rotation.
const decrypted = {};
for (const sid of encrypted) {
  try {
    decrypted[sid] = _crypto.decryptPrivateKey(store.wallets[sid].encPrivateKey, oldKey);
  } catch (e) {
    console.error(`FAILED to decrypt ${sid} under the OLD key — aborting before writing anything: ${e.message}`);
    process.exit(1);
  }
}

for (const sid of encrypted) {
  const w = store.wallets[sid];
  store.wallets[sid] = { address: w.address, encPrivateKey: _crypto.encryptPrivateKey(decrypted[sid], newKey),
    createdAt: w.createdAt, label: w.label ?? null };
}
_crypto.writeStore(store);
console.log(`Rotated ${encrypted.length} record(s) to the new key.`);

console.log('\nVerifying every rotated record decrypts under the NEW key and matches the pre-rotation plaintext...');
const reread = _crypto.readStore();
let failed = 0;
for (const sid of encrypted) {
  let underNew;
  try {
    underNew = _crypto.decryptPrivateKey(reread.wallets[sid].encPrivateKey, newKey);
  } catch (e) {
    console.error(`  ${sid}: FAILED to decrypt under the new key: ${e.message}`);
    failed++; continue;
  }
  if (underNew !== decrypted[sid]) {
    console.error(`  ${sid}: decrypted value under the new key does NOT match the original — DATA CORRUPTION`);
    failed++;
  } else {
    console.log(`  ${sid}: OK`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} record(s) FAILED verification. Backup at ${backupPath} still holds the pre-rotation (old-key-encrypted) data — do not delete it. Investigate before trusting the rotated store or discarding the old key.`);
  process.exit(1);
}

console.log(`\nAll ${encrypted.length} record(s) verified under the new key. The OLD master key (AGENTRAIL_WALLET_MASTER_KEY) can now be discarded — it no longer decrypts anything in this store. Set AGENTRAIL_WALLET_MASTER_KEY to the NEW key value everywhere this server runs, going forward.`);
