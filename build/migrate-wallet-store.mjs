// One-time, EXPLICIT migration: plaintext private keys -> AES-256-GCM encrypted
// at rest. Deliberately a separate script run by a human, not something that
// happens automatically inside a live signing call — key-format changes on a
// store holding real funds should be a decision, not a side effect.
//
// DRY RUN BY DEFAULT. Shows exactly what would change and writes nothing.
// Pass --confirm to actually migrate. Always makes a timestamped backup of the
// original store file before writing anything.
//
// Usage:
//   AGENTRAIL_WALLET_MASTER_KEY=<64 hex chars> node build/migrate-wallet-store.mjs
//   AGENTRAIL_WALLET_MASTER_KEY=<64 hex chars> node build/migrate-wallet-store.mjs --confirm
//
// Generate a master key first, if you don't have one:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
import fs from 'node:fs';
import path from 'node:path';
import { STORE_PATH, _crypto } from './wallet.mjs';

const CONFIRM = process.argv.includes('--confirm');

console.log(`Store path: ${STORE_PATH}`);

let store;
try {
  store = _crypto.readStore();
} catch (e) {
  console.error(`Could not read the store: ${e.message}`);
  process.exit(1);
}

const sids = Object.keys(store.wallets);
const legacy = sids.filter((sid) => store.wallets[sid].privateKey !== undefined);
const already = sids.filter((sid) => store.wallets[sid].encPrivateKey !== undefined);

console.log(`Total records: ${sids.length}`);
console.log(`Already encrypted: ${already.length}`);
console.log(`Plaintext, needing migration: ${legacy.length}`);

if (legacy.length === 0) {
  console.log(store.version === _crypto.STORE_VERSION
    ? 'Nothing to do — store is already fully migrated.'
    : `Nothing to do — no plaintext records found, but store.version=${store.version} (expected ${_crypto.STORE_VERSION}). Bumping version only.`);
  if (store.version !== _crypto.STORE_VERSION && CONFIRM) {
    store.version = _crypto.STORE_VERSION;
    _crypto.writeStore(store);
    console.log('Version bumped.');
  }
  process.exit(0);
}

console.log(`\nRecords that would be migrated: ${legacy.join(', ')}`);

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing was written. Re-run with --confirm to actually migrate.');
  process.exit(0);
}

// Only load the master key once we're actually about to encrypt something — a
// dry run has no need for it, and requiring it there was a real bug in an
// earlier version of this script (it demanded the key before ever checking
// whether this was a dry run, contradicting its own stated behavior).
let masterKey;
try {
  masterKey = _crypto.loadMasterKey();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Backup before touching anything real.
const backupPath = `${STORE_PATH}.pre-migration-${Date.now()}.bak`;
fs.copyFileSync(STORE_PATH, backupPath);
console.log(`\nBackup written: ${backupPath}`);

for (const sid of legacy) {
  const w = store.wallets[sid];
  const encPrivateKey = _crypto.encryptPrivateKey(w.privateKey, masterKey);
  store.wallets[sid] = { address: w.address, encPrivateKey, createdAt: w.createdAt, label: w.label ?? null };
}
store.version = _crypto.STORE_VERSION;
_crypto.writeStore(store);

console.log(`Migrated ${legacy.length} record(s). Store version now ${_crypto.STORE_VERSION}.`);

// Verify every migrated record round-trips BEFORE declaring success — this is
// the one place "should have worked" is not good enough, since a silent
// encryption bug here would look identical to success until the next real
// signing attempt, potentially mid-live-trade.
console.log('\nVerifying every migrated record decrypts back to its original key...');
const reread = _crypto.readStore();
let verifyFailed = 0;
for (const sid of legacy) {
  const original = JSON.parse(fs.readFileSync(backupPath, 'utf8')).wallets[sid].privateKey;
  let decrypted;
  try {
    decrypted = _crypto.decryptPrivateKey(reread.wallets[sid].encPrivateKey, masterKey);
  } catch (e) {
    console.error(`  ${sid}: FAILED to decrypt after migration: ${e.message}`);
    verifyFailed++;
    continue;
  }
  if (decrypted !== original) {
    console.error(`  ${sid}: decrypted value does NOT match the original key — DATA CORRUPTION`);
    verifyFailed++;
  } else {
    console.log(`  ${sid}: OK`);
  }
}

if (verifyFailed > 0) {
  console.error(`\n${verifyFailed} record(s) FAILED verification. The backup at ${backupPath} is your original, unmodified data — do not delete it. Investigate before trusting the migrated store.`);
  process.exit(1);
}

console.log('\nAll migrated records verified. The plaintext backup still contains the original keys in the clear — move it somewhere secure or delete it once you are confident the migration is correct and durable.');
