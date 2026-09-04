// ============================================================================
// ACCOUNT / API-KEY STORE — real per-user authentication, separate from the
// wallet key store on purpose.
//
// WHY SEPARATE FROM wallet.mjs: the wallet store holds secrets that must be
// DECRYPTABLE later (to sign a transaction) — that's an encryption problem,
// AES-256-GCM, a master key. This store holds a secret that only ever needs
// to be CHECKED, never recovered — that's a hashing problem, not an
// encryption problem, and conflating the two schemas would blur a real
// distinction: losing the wallet master key is catastrophic (funds
// unreachable); losing this store's hash is not (accounts can be recreated,
// nothing of value lives here beyond the ability to authenticate).
//
// WHY THIS EXISTS AT ALL: before this, session_id was a bare, client-supplied
// string — no proof of ownership, nothing stopping one caller from using
// another's session_id and touching their wallet. session_id and the auth
// secret are DELIBERATELY DIFFERENT VALUES: session_id appears constantly in
// logs, error messages, trade-log filenames — anything that public would be
// a terrible choice for a secret. api_key is generated separately, shown
// exactly once, and never appears in any log or stored response again.
//
// STORAGE: salted SHA-256 hash, verified via crypto.timingSafeEqual (not
// ===, which leaks comparison timing). No master key, no encryption, nothing
// to rotate at the infrastructure level — genuinely simpler than the wallet
// store, because this problem is simpler.
//
// NO RECOVERY PATH, DELIBERATELY: create_account refuses if an account
// already exists rather than reissuing a key, and there is no "forgot my
// key" flow. rotate_api_key requires proving the CURRENT key. A recovery
// path that doesn't require proof of ownership is an account-takeover path
// by definition — this mirrors generate_wallet's own refusal-over-silent-
// reissue design in wallet.mjs, same reasoning, different secret.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));

export const ACCOUNTS_STORE_PATH = process.env.AGENTRAIL_ACCOUNTS_STORE
  ?? path.resolve(__dir, '.accounts-store.json');

const FILE_MODE = 0o600;
const STORE_VERSION = 1;
const KEY_PREFIX = 'ar_sk_';       // human/scanner-recognizable prefix, same idea as stripe's sk_/pk_
const KEY_RANDOM_BYTES = 32;       // 256 bits of entropy
const SALT_BYTES = 16;

function readStore() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_STORE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || typeof j.accounts !== 'object') {
      throw new Error('store file is present but not in the expected shape');
    }
    return j;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: STORE_VERSION, accounts: {} };
    // A corrupt store must NOT be silently replaced — that would orphan every
    // existing account and force every session to re-authenticate blind.
    throw new Error(`accounts store at ${ACCOUNTS_STORE_PATH} could not be read and will NOT be overwritten: ${e.message}`);
  }
}

function writeStore(store) {
  const dir = path.dirname(ACCOUNTS_STORE_PATH);
  const tmp = path.join(dir, `.accounts-store.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, ACCOUNTS_STORE_PATH);
  try { fs.chmodSync(ACCOUNTS_STORE_PATH, FILE_MODE); } catch { /* non-POSIX */ }
}

const generateApiKey = () => KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString('hex');
const hashApiKey = (apiKey, saltHex) =>
  createHash('sha256').update(Buffer.from(saltHex, 'hex')).update(String(apiKey), 'utf8').digest('hex');

/**
 * Create an account for a session. Returns the API key ONCE — it is never
 * stored in recoverable form and this response is the only time it exists
 * outside the caller's own hands.
 *
 * IDEMPOTENT-BY-REFUSAL, not idempotent-by-reissue: calling twice for the
 * same session_id REFUSES on the second call rather than silently returning
 * a new key. Silently reissuing would mean anyone who merely knows a
 * session_id (not a secret — it's logged everywhere) could mint themselves
 * a fresh working key for someone else's account.
 */
export function create_account({ session_id, label = null } = {}) {
  if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
    return { ok: false, refused: true, reason: 'session_id_required',
      detail: 'session_id must be a non-empty string — the identifier this account is created under.' };
  }
  const sid = session_id.trim();
  const store = readStore();
  if (store.accounts[sid]) {
    return { ok: false, refused: true, reason: 'account_already_exists',
      detail: `An account already exists for session_id="${sid}", created ${store.accounts[sid].createdAt}. The API key is never recoverable after creation and is not reissued here — if it is lost, use rotate_api_key, which requires proving the CURRENT key. There is deliberately no "forgot my key" path: recovering a lost secret without proof of ownership would defeat the point of having one.` };
  }
  const apiKey = generateApiKey();
  const salt = randomBytes(SALT_BYTES).toString('hex');
  store.version = STORE_VERSION;
  store.accounts[sid] = { salt, hash: hashApiKey(apiKey, salt),
    createdAt: new Date().toISOString(), label, rotatedAt: null };
  writeStore(store);
  return { ok: true, created: true, sessionId: sid, apiKey,
    warning: 'THIS IS THE ONLY TIME THIS KEY IS SHOWN. AgentRail stores only a salted hash and cannot recover or redisplay it — save it now. Every write-capable tool (generate_wallet, place_order, get_position, redeem, withdraw, and get_wallet_balance-by-session_id) requires it from now on.',
    nextStep: 'Call generate_wallet with this session_id and api_key to create your dedicated trading wallet.' };
}

/** Rotation REQUIRES the current key — never allow rotation without proof of
 * ownership, or it becomes an account-takeover path for anyone who knows
 * (or guesses) a session_id. */
export function rotate_api_key({ session_id, current_api_key } = {}) {
  if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
    return { ok: false, refused: true, reason: 'session_id_required' };
  }
  if (!current_api_key) {
    return { ok: false, refused: true, reason: 'current_api_key_required',
      detail: 'Rotation requires the CURRENT api_key as proof of ownership. There is no rotation path that skips this.' };
  }
  const sid = session_id.trim();
  const store = readStore();
  const acct = store.accounts[sid];
  if (!acct) {
    return { ok: false, refused: true, reason: 'account_not_found',
      detail: `No account exists for session_id="${sid}". Call create_account first.` };
  }
  const provided = Buffer.from(hashApiKey(current_api_key, acct.salt), 'hex');
  const stored = Buffer.from(acct.hash, 'hex');
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    return { ok: false, refused: true, reason: 'invalid_current_api_key',
      detail: 'The provided current_api_key does not match this account. Rotation refused.' };
  }
  const apiKey = generateApiKey();
  const salt = randomBytes(SALT_BYTES).toString('hex');
  store.accounts[sid] = { ...acct, salt, hash: hashApiKey(apiKey, salt),
    rotatedAt: new Date().toISOString() };
  writeStore(store);
  return { ok: true, sessionId: sid, apiKey,
    warning: 'THIS IS THE ONLY TIME THIS NEW KEY IS SHOWN. The previous key no longer works — it was invalidated by this rotation, not merely superseded.' };
}

/**
 * Internal verification, used by mcp-core.mjs's write-path entry points.
 * NOT an MCP tool — never exposed directly, since it exists purely to gate
 * other operations. Constant-time comparison; never leaks WHY a check failed
 * beyond a machine-readable reason code (no timing or content difference
 * between "no such account" and "wrong key" beyond the reason string itself,
 * which callers can choose whether to surface).
 */
export function _verifyApiKey(session_id, api_key) {
  if (!session_id || !api_key) return { ok: false, reason: 'missing_credentials' };
  const sid = String(session_id).trim();
  const store = readStore();
  const acct = store.accounts[sid];
  if (!acct) return { ok: false, reason: 'account_not_found' };
  let providedHash;
  try { providedHash = hashApiKey(api_key, acct.salt); }
  catch { return { ok: false, reason: 'malformed_api_key' }; }
  const a = Buffer.from(providedHash, 'hex'), b = Buffer.from(acct.hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'invalid_api_key' };
  return { ok: true };
}

/** Test-only / internal — does an account exist at all (no key check). */
export function _accountExists(session_id) {
  const store = readStore();
  return !!store.accounts[String(session_id).trim()];
}

/** Metadata only — session ids, creation/rotation times, labels. Never key
 * material, never even a hash. Safe to expose for operator visibility. */
export function list_accounts() {
  const store = readStore();
  const accounts = Object.entries(store.accounts).map(([sid, a]) => ({
    sessionId: sid, createdAt: a.createdAt, rotatedAt: a.rotatedAt ?? null, label: a.label ?? null }));
  return { ok: true, count: accounts.length, accounts, storePath: ACCOUNTS_STORE_PATH };
}

/**
 * Throwing gate, for use at the very top of a write-capable exported tool —
 * mirrors wallet.mjs's loadMasterKey() throwing pattern, so a missing/wrong
 * key stops execution immediately with one clear reason, rather than a
 * {ok:false} object threaded through several more lines before anyone checks
 * it. Every write tool (place_order, redeem, withdraw, generate_wallet) calls
 * this as its first line, before touching session_id-scoped state at all.
 */
export function requireApiKey(session_id, api_key) {
  const v = _verifyApiKey(session_id, api_key);
  if (v.ok) return;
  const messages = {
    missing_credentials: `Both session_id and api_key are required. ${!session_id ? 'session_id is missing.' : 'api_key is missing — call create_account first if this session has none yet.'}`,
    account_not_found: `No account exists for session_id="${session_id}". Call create_account first.`,
    malformed_api_key: 'api_key is not a usable value.',
    invalid_api_key: `api_key does not match session_id="${session_id}". If it was lost, use rotate_api_key with the CURRENT key — there is no recovery path that skips proof of ownership.`,
  };
  throw new Error(messages[v.reason] ?? `Authentication failed (${v.reason}).`);
}

/** Test-only: clear the whole store. Not an MCP tool. */
export function _resetAccountsStoreForTests() {
  try { fs.unlinkSync(ACCOUNTS_STORE_PATH); } catch { /* already absent */ }
  return { ok: true, storePath: ACCOUNTS_STORE_PATH };
}
