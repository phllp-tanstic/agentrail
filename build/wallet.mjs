// ============================================================================
// DEDICATED WALLET STORE — purpose-only keypair per session.
//
// WHY THIS EXISTS: the custody model in AgentRail-Build-Spec.md §2 is that a user
// never exposes their main wallet. AgentRail generates a fresh, purpose-only
// keypair, the user deposits only what they intend to trade, and the blast radius
// of anything going wrong is bounded by that deposit.
//
// ------------------------------------------------------------------ READ THIS
// THIS IS A CUSTODIAL MODEL, and it is a DIFFERENT trust model from the
// operator-delegation one described in spec §3. State the difference plainly
// rather than inheriting the non-custodial claim:
//
//   - Spec §3 (operator delegation): the OWNER's wallet funds the order and
//     receives the fill. The operator key is scoped by OperatorPermissionsRegistry
//     to place/cancel/reduce and ARCHITECTURALLY CANNOT move funds. "The AI can
//     trade for you but cannot drain your wallet" is literally true there.
//
//   - This module (dedicated wallet): AgentRail generates and HOLDS the private
//     key. It therefore CAN move those funds. Nothing in the contract prevents it.
//     The protection is not cryptographic against AgentRail itself, it is
//     exposure-limiting: the wallet is purpose-only and holds only the deposit.
//
// Both are legitimate designs and the spec's product flow (§2) describes this one.
// But do not describe this as "non-custodial" — it is not.
//
// ------------------------------------------------------- KEY STORAGE (v2, THIS REVISION)
// Private keys are now ENCRYPTED AT REST — AES-256-GCM, via Node's built-in
// `crypto` module (deliberately no new dependency for something this sensitive).
// This replaces the PLAINTEXT JSON storage of the previous revision, which is
// disclosed as fixed in Production Roadmap Tier 0 #3.
//
// STATE PLAINLY WHAT THIS IS AND ISN'T, so it is never overclaimed later:
//   - IS: the on-disk file no longer contains usable key material by itself.
//     A copy of the store file alone (backup, misconfigured permissions,
//     accidental commit) does not leak funds.
//   - IS NOT: a KMS/HSM-backed signing path. The master key that decrypts
//     everything still exists as plaintext in this process's environment
//     variables and, briefly, in memory during signing. Anyone with process
//     access (a shell on this host, a memory dump, a compromised dependency)
//     can still recover keys. That gap is what Tier 0 #3's stated real target
//     (KMS/HSM, where key material never enters this process at all) closes —
//     encryption at rest is the buildable increment now, not a substitute for it.
//   - Single-process, same as before: concurrent writes from two processes can
//     still clobber. Not addressed by this change.
//
// AGENTRAIL_WALLET_MASTER_KEY is REQUIRED for any operation touching private key
// material (generate_wallet creating a new record, _privateKeyForSession). There
// is deliberately NO default and NO silent fallback to plaintext — a missing or
// malformed key refuses the operation outright rather than degrading quietly.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// EXISTING PLAINTEXT STORES (from before this revision) are NOT auto-migrated.
// Run build/migrate-wallet-store.mjs explicitly — a live-signing code path is
// deliberately the wrong place to silently rewrite key storage format.
//
// FURTHER LIMITATIONS, all deliberate for this phase and all real:
//   1. No key rotation beyond force_new (which re-keys the address, not just the
//      encryption). The master key itself has no rotation path — changing it
//      orphans every existing encrypted record.
//   2. Losing the store file loses the funds regardless of encryption. There is
//      no recovery path and no seed phrase — these are raw keypairs.
//   3. There is deliberately NO export path. `generate_wallet` never returns the
//      private key and no function here does either. That is a policy choice, not
//      an oversight: it keeps the key out of model context and out of transcripts.
//      The consequence is that a user cannot independently sweep these funds
//      without server cooperation — which is the custodial tradeoff again, stated
//      once more because it is the thing most likely to be forgotten.
// ============================================================================
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// cwd-independent, like mcp-core's ERRMAP read: an MCP server is launched by its
// client from an arbitrary working directory.
export const STORE_PATH = process.env.AGENTRAIL_WALLET_STORE
  ?? path.resolve(__dir, '.wallet-store.json');

const FILE_MODE = 0o600;   // owner read/write only. Honoured on POSIX; largely a
                           // no-op on Windows, where ACLs govern instead.

const STORE_VERSION = 2;
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;       // NIST-recommended GCM nonce length
const MASTER_KEY_ENV = 'AGENTRAIL_WALLET_MASTER_KEY';
const MASTER_KEY_HEX_LEN = 64; // 32 bytes

/**
 * Loads and validates the master key from env. Throws — does not return null and
 * does not fall back to anything — because every caller of this needs the key to
 * do real cryptography, and a silent fallback here is exactly the plaintext
 * regression this revision exists to close.
 */
function loadMasterKey() {
  const hex = process.env[MASTER_KEY_ENV];
  if (!hex) {
    throw new Error(`${MASTER_KEY_ENV} is not set. Private key operations refuse to run without it — there is no plaintext fallback. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" and set it in the environment this server (and any standalone script that signs) runs in. If you have an existing PLAINTEXT store from before this change, set the key first, then run build/migrate-wallet-store.mjs.`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${MASTER_KEY_ENV} is set but is not exactly 64 hex characters (32 bytes) — got ${hex.length} characters. Refusing rather than truncating or padding, since a wrong-length key would silently produce a key derived from something other than what you intended.`);
  }
  return Buffer.from(hex, 'hex');
}

/** AES-256-GCM encrypt. Returns a self-describing record — alg is stored per-record
 * so a future algorithm change doesn't need special-casing at read time. */
function encryptPrivateKey(privateKeyHex, masterKey) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { alg: ALGO, iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'),
    authTag: authTag.toString('hex') };
}

/** AES-256-GCM decrypt. GCM's auth tag means a corrupted or tampered ciphertext
 * throws here rather than silently returning garbage — fail loud, not quiet. */
function decryptPrivateKey(encRecord, masterKey) {
  if (!encRecord || encRecord.alg !== ALGO) {
    throw new Error(`Unsupported or missing encryption record (expected alg="${ALGO}"). If this wallet was created before encryption-at-rest, it needs migration: run build/migrate-wallet-store.mjs.`);
  }
  const decipher = createDecipheriv(ALGO, masterKey, Buffer.from(encRecord.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encRecord.authTag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encRecord.ciphertext, 'hex')), decipher.final(),
  ]); // decipher.final() THROWS if the auth tag doesn't verify — tamper/corruption/wrong-key all surface here
  return plaintext.toString('utf8');
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || typeof j.wallets !== 'object') {
      throw new Error('store file is present but not in the expected shape');
    }
    return j;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: STORE_VERSION, wallets: {} };
    // A corrupt store must NOT be silently replaced with an empty one — that would
    // orphan real funds. Fail loudly and leave the file alone for inspection.
    throw new Error(`wallet store at ${STORE_PATH} could not be read and will NOT be overwritten (that would orphan any funds it holds): ${e.message}`);
  }
}

/**
 * Atomic write: serialise to a temp file in the same directory, then rename over
 * the target. rename() is atomic within a filesystem, so a crash mid-write leaves
 * either the old store or the new one — never a truncated file. This matters more
 * here than in most stores: a truncated file is unrecoverable loss of funds.
 */
function writeStore(store) {
  const dir = path.dirname(STORE_PATH);
  const tmp = path.join(dir, `.wallet-store.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, STORE_PATH);
  try { fs.chmodSync(STORE_PATH, FILE_MODE); } catch { /* non-POSIX */ }
}

/**
 * Never leaves this module. Used by the signing path, not by any tool response.
 *
 * Throws (does not return null) for TWO distinct, deliberately different reasons:
 *   - no wallet exists for this session at all -> returns null (caller's normal
 *     "generate_wallet first" path)
 *   - a wallet EXISTS but is still in the old plaintext format, or the master key
 *     is missing/invalid -> THROWS, because silently returning null here would be
 *     indistinguishable from "no wallet exists" and would surface as a confusing
 *     downstream error instead of the real, actionable one.
 */
export function _privateKeyForSession(sessionId) {
  const store = readStore();
  const w = store.wallets[String(sessionId)];
  if (!w) return null;
  if (w.privateKey !== undefined || store.version === 1) {
    throw new Error(`The wallet for session_id="${sessionId}" is still in the OLD PLAINTEXT format (pre-encryption-at-rest). Refusing to sign with it. Run build/migrate-wallet-store.mjs to encrypt the existing store, then retry.`);
  }
  const masterKey = loadMasterKey();
  return decryptPrivateKey(w.encPrivateKey, masterKey);
}

/** Public view of one record — address and metadata only, never the key, and
 * never the encryption record either (iv/ciphertext/authTag stay internal). */
const publicView = (sessionId, w) => ({
  sessionId, address: w.address, createdAt: w.createdAt,
  label: w.label ?? null,
  encrypted: w.encPrivateKey !== undefined,   // false only for an unmigrated legacy record
});

/**
 * Create a purpose-only keypair for a session, or return the existing one.
 *
 * IDEMPOTENT BY DESIGN. Calling twice for the same session returns the FIRST
 * wallet with `created: false` rather than generating a second one. This is a
 * deliberate safety choice: a caller that deposits into wallet A, then calls again
 * and receives wallet B, would have stranded the deposit in a wallet it no longer
 * knows about. Silently rotating an address that may already hold funds is the
 * worst available behaviour, so it is refused by construction.
 */
export function generate_wallet({ session_id, label = null, force_new = false } = {}) {
  if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id must be a non-empty string. It is the key a generated wallet is stored under and the handle used to look it up later.' };
  }
  const sid = session_id.trim();
  const store = readStore();
  const existing = store.wallets[sid];

  if (existing && !force_new) {
    return { ok: true, created: false, ...publicView(sid, existing),
      note: 'A wallet already existed for this session_id and was returned unchanged. This call did NOT generate a new keypair — rotating an address that may already hold a deposit would strand those funds. Pass force_new:true only if you accept that the previous address (and anything in it) becomes unreachable through this session_id.'
        + (existing.privateKey !== undefined ? ' NOTE: this record is still in the old plaintext format — it can be listed but cannot sign until build/migrate-wallet-store.mjs has been run.' : ''),
      storage: STORE_DISCLOSURE };
  }

  // A new record requires a valid master key BEFORE any keypair is generated —
  // never generate key material this module cannot then safely store.
  const masterKey = loadMasterKey();

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const record = { address: account.address, encPrivateKey: encryptPrivateKey(privateKey, masterKey),
    createdAt: new Date().toISOString(), label };

  let replaced = null;
  if (existing && force_new) {
    replaced = { address: existing.address, createdAt: existing.createdAt };
    store.wallets[`${sid}__replaced_${existing.createdAt}`] = existing;  // never dropped
  }
  store.version = STORE_VERSION;
  store.wallets[sid] = record;
  writeStore(store);

  return { ok: true, created: true, ...publicView(sid, record),
    ...(replaced ? { replacedPrevious: replaced,
      replacedNote: 'The previous record was NOT deleted — it was re-keyed under a suffixed session id so any funds it holds remain reachable server-side. It is no longer returned by this session_id.' } : {}),
    privateKeyReturned: false,
    custody: CUSTODY_DISCLOSURE,
    storage: STORE_DISCLOSURE,
    nextStep: 'Deposit tUSDC (and SOMI for gas) to this address, then call get_wallet_balance to confirm the deposit landed before trading.',
    custodySigning: 'place_order, redeem, and withdraw all sign with THIS wallet\'s own key for this session_id — not a shared owner key. This is the actual signing wallet, not an inert deposit address.',
  };
}

/** List known sessions — addresses only. Useful for operators, never keys. */
export function list_wallets() {
  const store = readStore();
  const wallets = Object.entries(store.wallets).map(([sid, w]) => publicView(sid, w));
  return { ok: true, count: wallets.length, wallets,
    storePath: STORE_PATH, storage: STORE_DISCLOSURE };
}

export const CUSTODY_DISCLOSURE =
  'CUSTODIAL over this wallet. AgentRail generated and holds the private key server-side, so it CAN move these funds — nothing on-chain prevents it. This is a DIFFERENT model from the operator-delegation design in spec §3, where the operator key is scoped by OperatorPermissionsRegistry and architecturally cannot move funds. Do not describe this wallet as non-custodial. The protection here is exposure-limiting, not cryptographic against AgentRail itself: fund it only with what you intend to trade.';

export const STORE_DISCLOSURE =
  `Keys are stored ENCRYPTED AT REST (AES-256-GCM) as JSON on the server's local disk (path from AGENTRAIL_WALLET_STORE, default build/.wallet-store.json, gitignored, written atomically via temp+rename, mode 0600 where the OS honours it). The store file alone does not leak funds. The decryption key (${MASTER_KEY_ENV}) still lives in this process's environment and briefly in memory during signing — this is encryption at rest, NOT a KMS/HSM-backed signing path where key material never enters this process; that is the roadmap's stated further target, not yet built. No key rotation for the master key itself: changing it orphans existing records. No recovery path, no seed phrase: losing the store file loses the funds regardless of encryption. Single-process — concurrent writes from two processes could clobber.`;

export function _resetStoreForTests() {
  try { fs.unlinkSync(STORE_PATH); } catch { /* already absent */ }
  return { ok: true, storePath: STORE_PATH };
}

// Exposed for the migration script and for tests — not part of the tool surface.
export const _crypto = { loadMasterKey, encryptPrivateKey, decryptPrivateKey,
  readStore, writeStore, STORE_VERSION, ALGO };
