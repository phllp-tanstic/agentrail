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
//     The protection is not cryptographic, it is exposure-limiting: the wallet is
//     purpose-only and holds only the deposit.
//
// Both are legitimate designs and the spec's product flow (§2) describes this one.
// But do not describe this as "non-custodial" — it is not.
//
// FURTHER LIMITATIONS, all deliberate for this phase and all real:
//   1. Keys are stored in PLAINTEXT JSON on local disk. No encryption, no KMS, no
//      HSM. A real deployment needs one of those; this is a hackathon-scope store.
//   2. Losing the store file loses the funds. There is no recovery path and no
//      seed phrase — these are raw keypairs.
//   3. Single-process. Writes are atomic against a crash (temp + rename) but NOT
//      against two processes writing concurrently, which could clobber. Same class
//      of disclosure as risk.mjs's in-memory note.
//   4. There is deliberately NO export path. `generate_wallet` never returns the
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

const __dir = path.dirname(fileURLToPath(import.meta.url));

// cwd-independent, like mcp-core's ERRMAP read: an MCP server is launched by its
// client from an arbitrary working directory.
export const STORE_PATH = process.env.AGENTRAIL_WALLET_STORE
  ?? path.resolve(__dir, '.wallet-store.json');

const FILE_MODE = 0o600;   // owner read/write only. Honoured on POSIX; largely a
                           // no-op on Windows, where ACLs govern instead.

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || typeof j.wallets !== 'object') {
      throw new Error('store file is present but not in the expected shape');
    }
    return j;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, wallets: {} };
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

/** Never leaves this module. Used by the signing path, not by any tool response. */
export function _privateKeyForSession(sessionId) {
  const w = readStore().wallets[String(sessionId)];
  return w?.privateKey ?? null;
}

/** Public view of one record — address and metadata only, never the key. */
const publicView = (sessionId, w) => ({
  sessionId, address: w.address, createdAt: w.createdAt,
  label: w.label ?? null,
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
      note: 'A wallet already existed for this session_id and was returned unchanged. This call did NOT generate a new keypair — rotating an address that may already hold a deposit would strand those funds. Pass force_new:true only if you accept that the previous address (and anything in it) becomes unreachable through this session_id.',
      storage: STORE_DISCLOSURE };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const record = { address: account.address, privateKey,
    createdAt: new Date().toISOString(), label };

  let replaced = null;
  if (existing && force_new) {
    replaced = { address: existing.address, createdAt: existing.createdAt };
    store.wallets[`${sid}__replaced_${existing.createdAt}`] = existing;  // never dropped
  }
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
  'CUSTODIAL over this wallet. AgentRail generated and holds the private key server-side, so it CAN move these funds — nothing on-chain prevents it. This is a DIFFERENT model from the operator-delegation design in spec §3, where the operator key is scoped by OperatorPermissionsRegistry and architecturally cannot move funds. Do not describe this wallet as non-custodial. The protection here is exposure-limiting, not cryptographic: fund it only with what you intend to trade.';

export const STORE_DISCLOSURE =
  'Keys are stored as PLAINTEXT JSON on the server\'s local disk (path from AGENTRAIL_WALLET_STORE, default build/.wallet-store.json, gitignored, written atomically via temp+rename, mode 0600 where the OS honours it). No encryption, no KMS, no seed phrase, no recovery path: losing the file loses the funds. Single-process — concurrent writes from two processes could clobber. A real deployment needs a managed key store; this is hackathon scope, disclosed rather than implied.';

export function _resetStoreForTests() {
  try { fs.unlinkSync(STORE_PATH); } catch { /* already absent */ }
  return { ok: true, storePath: STORE_PATH };
}
