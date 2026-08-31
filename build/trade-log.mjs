// ============================================================================
// TRADE LOG — append-only, queryable record of everything AgentRail does on a
// user's behalf.
//
// WHY THIS EXISTS: it is the answer to "how do I trust an AI traded for me"
// (spec §2, §6 "minimal auditable trade log"). The trust claim is not "it worked"
// — it is "here is the complete record, INCLUDING the things that got refused and
// why". A log that only records successes is worse than no log, because it reads
// as a complete history while hiding every decision that mattered most.
//
// So a refusal is a first-class entry, not an error swallowed on the way out:
//   - a redeem BLOCKed by the guard is logged as prominently as one that paid out
//   - a slippage/risk/gate refusal is logged with the reason that produced it
//   - a PENDING fill is logged as PENDING, never collapsed into "did not fill"
//
// ---------------------------------------------------------------- DESIGN NOTES
//
// 1. APPEND-ONLY JSON LINES, one file per session. No database, no rewrite path,
//    no update-in-place. `fs.appendFileSync` opens with O_APPEND, so a line is
//    added or it is not — an existing entry is never modified by a later write.
//    Nothing in this module edits or deletes an entry, which is the property that
//    makes the file an audit trail rather than a cache.
//
// 2. LOGGING MUST NEVER BREAK THE ACTION IT RECORDS. Every write is wrapped: a
//    failed append returns an error object, it does not throw. This is deliberate
//    and it is the one place where the log is allowed to lose information.
//    The reasoning: by the time an order outcome is logged, the transaction has
//    ALREADY broadcast. Throwing there would report a failure for an order that
//    really filled, and would unwind the caller's risk accounting for a trade
//    that genuinely happened — corrupting real state to protect a record of it.
//    A dropped audit line is bad; a false report of a fill is worse. The failure
//    is surfaced in the tool response as `tradeLog.error` rather than hidden.
//
// 3. SESSION IDS ARE SANITISED BEFORE THEY BECOME FILENAMES. A session id is
//    caller-supplied, and a caller-supplied string used as a path is a directory
//    traversal ("../../etc/passwd"). Only [A-Za-z0-9._-] survives; everything
//    else becomes "_", leading dots are stripped, and the result is length-capped.
//    CONSEQUENCE, disclosed rather than hidden: sanitisation is not injective, so
//    "a/b" and "a_b" share one file. Every entry therefore carries the ORIGINAL
//    id in `sessionId`, so the file's contents stay unambiguous even when two
//    sessions collide into it.
//
// 4. ACTIONS AND OBSERVATIONS ARE MARKED DIFFERENTLY (`actor`). "AGENTRAIL" means
//    AgentRail did this. "OBSERVED" means AgentRail noticed an on-chain fact it
//    did not cause — a user's deposit is the real case. Conflating the two would
//    let a deposit read as a transfer AgentRail performed, which would be a false
//    claim about a money movement. AgentRail has no deposit tool by design.
//
// 5. SEQUENCE NUMBERS come from an in-memory counter, initialised once by reading
//    the file. LIMITATION, same class as risk.mjs's in-memory note: a SECOND
//    process appending to the same file restarts its own counter and would emit
//    duplicate `seq` values. `ts` and file order remain correct in that case, and
//    `get_trade_log` reports a `seqIntegrity` warning if it sees duplicates rather
//    than presenting a corrupted sequence as clean.
//
// 6. NO KEY MATERIAL, EVER. Entries carry addresses only. Nothing in this module
//    reads the wallet store's `privateKey` field.
//
// WHAT IS DELIBERATELY NOT LOGGED: `parse_intent` and `list_markets`. Both are
// read/validate calls that place nothing, and a caller may run parse_intent
// speculatively many times per real order — logging them would bury the actions
// this file exists to record. That is a judgement call, not an oversight: a
// parse_intent refusal IS a refusal, and if the demo wants "the agent declined
// before touching the chain" in the history, add a recordIntent() adapter here.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// cwd-independent, like mcp-core's ERRMAP and wallet.mjs's STORE_PATH: an MCP
// server is launched by its client from an arbitrary working directory.
export const TRADE_LOG_DIR = process.env.AGENTRAIL_TRADE_LOG_DIR
  ?? path.resolve(__dir, '.trade-log');

export const DEFAULT_SESSION_ID = process.env.AGENTRAIL_SESSION_ID ?? 'default';

const FILE_MODE = 0o600;      // honoured on POSIX; ACLs govern on Windows
const MAX_SESSION_FILENAME = 80;

/** Resolve a caller-supplied session id to { sessionId, fileSafe, sanitised }. */
export function resolveSession(sessionId) {
  const raw = (sessionId === null || sessionId === undefined || String(sessionId).trim() === '')
    ? DEFAULT_SESSION_ID : String(sessionId).trim();
  let safe = raw.replace(/[^A-Za-z0-9._-]/g, '_')
    // Separators are already gone, so a remaining ".." cannot traverse — a dot is
    // only "parent" as a whole path SEGMENT. Collapsed anyway so the safety of the
    // result is visible on inspection instead of needing that argument.
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '');
  if (safe.length > MAX_SESSION_FILENAME) safe = safe.slice(0, MAX_SESSION_FILENAME);
  // An id made entirely of forbidden characters sanitises to punctuation with no
  // meaning ("///" -> "___"). Name it rather than ship a filename nobody can read.
  if (!/[A-Za-z0-9]/.test(safe)) safe = 'unnamed';
  return { sessionId: raw, fileSafe: safe, sanitised: safe !== raw };
}

const filePathFor = (fileSafe) => path.join(TRADE_LOG_DIR, `${fileSafe}.jsonl`);

// seq counters, keyed by file-safe session name. See design note 5.
const _seq = new Map();
function nextSeq(fileSafe) {
  if (!_seq.has(fileSafe)) {
    let n = 0;
    try {
      const raw = fs.readFileSync(filePathFor(fileSafe), 'utf8');
      n = raw.split('\n').filter((l) => l.trim()).length;
    } catch { /* no file yet -> 0 */ }
    _seq.set(fileSafe, n);
  }
  const n = _seq.get(fileSafe) + 1;
  _seq.set(fileSafe, n);
  return n;
}

/**
 * Append one entry. Returns { ok:true, seq, file } or { ok:false, error } — it
 * NEVER throws, per design note 2.
 */
export function logEvent({ session_id = null, kind, event, outcome, ok = true,
  actor = 'AGENTRAIL', summary, why = null, dryRun = false, ...rest } = {}) {
  const S = resolveSession(session_id);
  try {
    fs.mkdirSync(TRADE_LOG_DIR, { recursive: true });
    const entry = {
      seq: nextSeq(S.fileSafe),
      ts: new Date().toISOString(),
      sessionId: S.sessionId,
      ...(S.sanitised ? { sessionFile: S.fileSafe } : {}),
      kind, event, outcome, ok, actor,
      summary,
      ...(why ? { why } : {}),
      ...(dryRun ? { dryRun: true } : {}),
      ...rest,
    };
    fs.appendFileSync(filePathFor(S.fileSafe), `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
    return { ok: true, seq: entry.seq, file: filePathFor(S.fileSafe), sessionId: S.sessionId };
  } catch (e) {
    // See design note 2: report, never throw. The caller surfaces this as
    // tradeLog.error so a missing line is visible rather than silent.
    return { ok: false, error: `trade log append failed: ${e.message}`,
      note: 'The ACTION still happened — only its log line was lost. This is reported rather than thrown because throwing here would report a failure for an order that really broadcast.',
      sessionId: S.sessionId };
  }
}

// ============================================================================
// ADAPTERS — turn a tool result into one self-explanatory entry.
//
// These read the response shapes of mcp-core's tools, which couples this file to
// them. That coupling is deliberate: it keeps the audit vocabulary in ONE place
// instead of scattering summary strings through the execution paths, and it means
// a tool cannot quietly stop logging by forgetting a field.
// ============================================================================

const n6 = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(6)));
const shortId = (s) => (typeof s === 'string' && s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s ?? 'unknown');

/** place_order — every terminal outcome, success or refusal or throw. */
export function recordOrder({ session_id = null, input = {}, res = null, thrown = null }) {
  const marketId = input.market_id ?? res?.marketId ?? null;
  const asset = res?.asset ?? null;
  const win = res?.intervalSec ?? input.window_seconds ?? null;
  const target = input.targetDollarAmount ?? input.target_dollar_amount ?? null;
  const units = input.stake_units ?? input.stakeUnits ?? null;
  const sizeAsked = target !== null ? `$${target} of cash` : units !== null ? `${units} units` : 'default 1.0 unit';

  if (thrown) {
    return logEvent({ session_id, kind: 'ORDER', event: 'PLACE_ORDER', outcome: 'ERROR', ok: false,
      summary: `ERROR — place_order threw before producing a result: ${thrown}. Order for ${sizeAsked} of ${asset ?? 'unknown asset'} ${input.direction ?? 'YES'} on market ${shortId(marketId)}. Whether anything broadcast is UNKNOWN from this entry alone — check get_position for the market.`,
      why: thrown, marketId, asset, requested: { direction: input.direction ?? 'YES', size: sizeAsked, windowSeconds: win },
      unresolved: true });
  }

  const F = res?.fill ?? null;
  // Refused / failed, in every flavour place_order can produce.
  if (!res?.ok) {
    const refused = res?.refused === true;
    const reason = res?.reason ?? 'unknown';
    const broadcast = reason === 'reverted' || reason === 'send_error';
    return logEvent({ session_id, kind: 'ORDER', event: 'PLACE_ORDER',
      outcome: refused ? 'REFUSED' : broadcast ? (reason === 'reverted' ? 'REVERTED' : 'SEND_ERROR') : 'FAILED',
      ok: false,
      summary: `${refused ? 'REFUSED' : reason === 'reverted' ? 'REVERTED' : 'FAILED'} (${reason}) — ${broadcast ? 'a transaction was broadcast but moved no collateral' : 'NOTHING was broadcast'}. Requested ${sizeAsked} of ${asset ?? 'unknown asset'} ${input.direction ?? 'YES'} on market ${shortId(marketId)}${win ? ` (${win}s window)` : ''}.`,
      why: res?.detail ?? res?.reason ?? 'no detail given',
      reason, marketId, asset,
      requested: { direction: input.direction ?? 'YES', size: sizeAsked, windowSeconds: win },
      broadcastAttempted: broadcast,
      ...(res?.reservation ? { riskReservation: res.reservation.resolution } : {}),
      ...(res?.slippage ? { slippage: { observedPct: res.slippage.slippagePct,
        maxPct: res.slippage.maxSlippagePct, clamped: res.slippage.clamped } } : {}),
      ...(res?.tx && Object.keys(res.tx).length ? { tx: res.tx } : {}) });
  }

  // Placed. FILLED / PENDING / NOT_FILLED are kept distinct — collapsing PENDING
  // into a non-fill is the exact misreading place_order's three-state contract exists
  // to prevent, and a log that did it would be lying about an open position.
  const status = F?.fillStatus ?? 'UNKNOWN';
  const spent = F?.collateralSpent ?? null;
  const filledUnits = F?.filledUnits ?? null;
  const variance = res?.dollarSizing
    ? ` Target was $${res.dollarSizing.requestedUsd}, actual spend ${res.dollarSizing.actualCollateralSpentUsd} (variance ${res.dollarSizing.variancePct}%).`
    : '';
  const tail = status === 'FILLED'
    ? `bought ${filledUnits} units of ${asset} ${res.direction} for ${spent} tUSDC.${variance}`
    : status === 'PENDING'
      ? `order accepted and RESTING, unresolved at the 60s poll deadline — this is NOT a non-fill and it may still fill before expiry. ${spent} tUSDC of collateral is locked at our limit. Recheck with get_position.`
      : `window expired with the order UNFILLED. Collateral locked at our own limit price is refunded automatically — no cancel needed.`;

  return logEvent({ session_id, kind: 'ORDER', event: 'PLACE_ORDER', outcome: status, ok: true,
    summary: `${status} — ${tail} Market ${shortId(marketId)}${win ? `, ${win}s window` : ''}, requested ${sizeAsked}.`,
    marketId, asset, direction: res.direction,
    requested: { direction: res.direction, size: sizeAsked, windowSeconds: win },
    fill: { fillStatus: status, filled: F?.filled ?? null,
      filledUnits, collateralSpent: spent,
      confirmedBy: 'ERC6909 balance delta + collateral delta, NOT transaction status',
      latencySecondsObserved: F?.resolution?.latencySecondsObserved ?? null },
    ...(res?.dollarSizing ? { dollarSizing: { requestedUsd: res.dollarSizing.requestedUsd,
      actualUsd: res.dollarSizing.actualCollateralSpentUsd, variancePct: res.dollarSizing.variancePct } } : {}),
    ...(res?.slippage ? { slippage: { observedPct: res.slippage.slippagePct,
      maxPct: res.slippage.maxSlippagePct, clamped: res.slippage.clamped,
      ...(res.slippage.requestedMaxSlippagePct !== res.slippage.maxSlippagePct
        ? { requestedMaxPct: res.slippage.requestedMaxSlippagePct } : {}) } } : {}),
    ...(res?.reservation ? { riskReservation: res.reservation.resolution } : {}),
    tx: res?.tx ?? {}, expiry: res?.expiry ?? null, yesTokenId: res?.yesTokenId ?? null });
}

/**
 * redeem — ONE ENTRY PER LEG, because each leg is a separate decision about a
 * separate position. A BLOCK and a payout in the same call must not merge into a
 * single "redeem happened" line: the whole point is that the refusal is visible.
 */
export function recordRedeem({ session_id = null, res = null, dry_run = false, thrown = null }) {
  const out = [];
  if (thrown) {
    out.push(logEvent({ session_id, kind: 'REDEEM', event: 'REDEEM_SCAN', outcome: 'ERROR', ok: false,
      dryRun: dry_run,
      summary: `ERROR — redeem threw before producing a result: ${thrown}. No per-leg outcome is known from this entry.`,
      why: thrown, unresolved: true }));
    return out;
  }
  if (!res?.ok) {
    out.push(logEvent({ session_id, kind: 'REDEEM', event: 'REDEEM_SCAN', outcome: 'FAILED', ok: false,
      dryRun: dry_run,
      summary: `FAILED — redeem could not proceed: ${res?.reason ?? 'unknown'}. Nothing was redeemed and no position was burned.`,
      why: res?.reason ?? 'no reason given',
      discovery: res?.discovery?.method ?? null }));
    return out;
  }

  for (const e of res.blocked ?? []) {
    const simReverted = /simulation reverted/i.test(e.outcome ?? '');
    out.push(logEvent({ session_id, kind: 'REDEEM', event: 'REDEEM_LEG',
      outcome: simReverted ? 'SIM_REVERTED' : 'BLOCKED', ok: false, dryRun: dry_run,
      summary: `${simReverted ? 'SIM_REVERTED' : 'BLOCKED'} — the ${e.label} leg of market ${shortId(e.marketId)}${e.asset ? ` (${e.asset})` : ''} was NOT redeemed. ${e.units} units were left INTACT, not burned. This matters because a losing redeem does NOT revert: it burns the position and pays zero with a success receipt, so refusing here preserved value that a naive redeem would have destroyed.${simReverted ? ' Cause: the on-chain simulation reverted, so nothing was broadcast.' : ''}`,
      why: e.guard?.reason ?? e.outcome ?? 'guard blocked',
      marketId: e.marketId, asset: e.asset ?? null, leg: e.label, outcomeIdx: e.outcomeIdx,
      units: e.units, tokensPreserved: e.tokensPreserved ?? e.amount ?? null,
      guard: e.guard ?? null, broadcast: false }));
  }

  for (const e of res.redeemed ?? []) {
    const wouldBe = e.broadcast === false;
    const paid = e.payout?.nonZero === true;
    out.push(logEvent({ session_id, kind: 'REDEEM', event: 'REDEEM_LEG',
      outcome: wouldBe ? 'WOULD_REDEEM' : paid ? 'REDEEMED' : 'ZERO_PAYOUT',
      ok: true, dryRun: dry_run,
      summary: wouldBe
        ? `WOULD_REDEEM (dry run, nothing broadcast) — the ${e.label} leg of market ${shortId(e.marketId)} passed the redeem guard and would be redeemed for ${e.units} units.`
        : paid
          ? `REDEEMED — the ${e.label} leg of market ${shortId(e.marketId)}${e.asset ? ` (${e.asset})` : ''} paid ${e.payout.payoutUnits} tUSDC for ${e.units} units, confirmed by tUSDC balance delta (NOT transaction status — a losing redeem also returns success).`
          : `ZERO_PAYOUT — the ${e.label} leg of market ${shortId(e.marketId)} was broadcast and returned success but paid 0 tUSDC. The position is burned. This is the exact outcome the redeem guard exists to prevent, so an entry here means the guard allowed something it should not have — worth investigating.`,
      marketId: e.marketId, asset: e.asset ?? null, leg: e.label, outcomeIdx: e.outcomeIdx,
      units: e.units, guard: e.guard ?? null,
      broadcast: e.broadcast === true,
      ...(e.payout ? { payout: { payoutUnits: e.payout.payoutUnits, nonZero: e.payout.nonZero,
        confirmedBy: e.payout.confirmedBy } } : {}) }));
  }

  if (!(res.blocked ?? []).length && !(res.redeemed ?? []).length) {
    out.push(logEvent({ session_id, kind: 'REDEEM', event: 'REDEEM_SCAN', outcome: 'NOTHING_OWED',
      ok: true, dryRun: dry_run,
      summary: `NOTHING_OWED — scanned ${res.discovery?.finalizedSeen ?? '?'} finalized markets via listBinaryMarkets({status:"Finalized"}) and held no positions in any of them. Nothing was redeemed because nothing was owed, which is different from a refusal.`,
      discovery: res.discovery?.method ?? null,
      finalizedSeen: res.discovery?.finalizedSeen ?? null }));
  }
  return out;
}

/**
 * withdraw — one entry per attempt, success or refusal or throw. Modelled on
 * recordOrder's shape (single-transaction tool, unlike redeem's per-leg log):
 * a refused withdrawal (insufficient balance, invalid address, session gate)
 * is logged exactly as prominently as a completed one, for the same trust
 * reason every refusal in this file is first-class — "no way to get money
 * back out" was the single biggest gap in the roadmap, so its log line
 * carries the same weight as the transfer itself.
 */
export function recordWithdrawal({ session_id = null, input = {}, res = null, thrown = null }) {
  const asset = input.asset ?? res?.asset ?? 'unknown';
  const to = input.to_address ?? input.toAddress ?? res?.toAddress ?? null;
  const amountAsked = input.amount ?? 'max';

  if (thrown) {
    return logEvent({ session_id, kind: 'WITHDRAWAL', event: 'WITHDRAW', outcome: 'ERROR', ok: false,
      summary: `ERROR — withdraw threw before producing a result: ${thrown}. Requested ${amountAsked} ${asset} to ${shortId(to)}. Whether anything broadcast is UNKNOWN from this entry alone — check get_wallet_balance for the session's wallet.`,
      why: thrown, asset, toAddress: to, unresolved: true });
  }

  if (!res?.ok) {
    const refused = res?.refused === true;
    return logEvent({ session_id, kind: 'WITHDRAWAL', event: 'WITHDRAW',
      outcome: refused ? 'REFUSED' : 'FAILED', ok: false,
      summary: `${refused ? 'REFUSED' : 'FAILED'} (${res?.reason ?? 'unknown'}) — requested ${amountAsked} ${asset} to ${shortId(to)}. ${refused ? 'Nothing was broadcast.' : 'A transaction may have been attempted — check the chain before assuming nothing moved.'}`,
      why: res?.detail ?? res?.reason ?? 'no detail given',
      reason: res?.reason ?? null, asset, toAddress: to,
      ...(res?.tx && Object.keys(res.tx).length ? { tx: res.tx } : {}) });
  }

  return logEvent({ session_id, kind: 'WITHDRAWAL', event: 'WITHDRAW', outcome: 'SENT', ok: true,
    summary: `SENT — withdrew ${res.amountSent} ${asset} from the session's dedicated wallet to ${shortId(res.toAddress)}, confirmed by balance delta (tx ${shortId(res.tx?.hash)}).`,
    asset, amountSent: res.amountSent, toAddress: res.toAddress,
    fromAddress: res.fromAddress ?? null,
    confirmedBy: 'balance delta + transaction receipt status',
    tx: res.tx ?? {} });
}

/** generate_wallet — creation, and the idempotent no-op, which is also a fact. */
export function recordWallet({ session_id = null, res = null, forceNew = false }) {
  if (!res?.ok) {
    return logEvent({ session_id, kind: 'WALLET', event: 'WALLET_CREATE', outcome: 'REFUSED', ok: false,
      summary: `REFUSED (${res?.reason ?? 'unknown'}) — no wallet was created.`,
      why: res?.detail ?? res?.reason ?? 'no detail given', reason: res?.reason ?? null });
  }
  if (res.created === false) {
    return logEvent({ session_id, kind: 'WALLET', event: 'WALLET_EXISTING', outcome: 'UNCHANGED', ok: true,
      summary: `UNCHANGED — a wallet already existed for this session and was returned as-is: ${res.address}. No new keypair was generated, deliberately: rotating an address that may already hold a deposit would strand those funds.`,
      address: res.address, createdAt: res.createdAt ?? null });
  }
  return logEvent({ session_id, kind: 'WALLET', event: 'WALLET_CREATED', outcome: 'CREATED', ok: true,
    summary: `CREATED — a purpose-only wallet ${res.address} was generated for this session. The private key is held SERVER-SIDE and was never returned to the caller. CUSTODY: this is a custodial model — AgentRail can move these funds. Fund it only with what is intended to be traded.${res.replacedPrevious ? ` force_new replaced a previous address ${res.replacedPrevious.address}, which was re-keyed server-side rather than deleted.` : ''}`,
    address: res.address, custodyModel: 'CUSTODIAL — AgentRail holds the private key',
    privateKeyReturned: false, forceNew: !!forceNew,
    ...(res.replacedPrevious ? { replacedPrevious: res.replacedPrevious.address } : {}),
    signingWiredUp: true,
    signingNote: 'place_order, redeem, and withdraw all sign with THIS wallet\'s own key for this session_id — not a shared owner key. Logged so the history reflects the actual custody model in effect at creation time.' });
}

/**
 * Deposits. AgentRail has NO deposit tool by design — in production the user
 * deposits from their own wallet — so a deposit can only be OBSERVED, never
 * performed. This compares the balances read by get_wallet_balance against the
 * last balance this log recorded for the same address, and writes an entry only
 * when something actually changed.
 *
 * A DECREASE is logged too, flagged as usually explained by an order's collateral
 * spend. Logging only increases would leave visible gaps in a record that claims
 * to be complete.
 *
 * COST, stated because it is not free: finding the previous balance scans every
 * session file. That is fine at this scale (tens of entries) and is O(files x
 * entries) per call; a real deployment would index the last-known balance instead.
 */
export function recordBalanceObservation({ session_id = null, address, tUSDC, SOMI, readyToTrade, known }) {
  const prev = _lastBalanceFor(address);
  const fmt = (a, b) => `${a} -> ${b} (${Number(b) - Number(a) >= 0 ? '+' : ''}${n6(Number(b) - Number(a))})`;

  if (!prev) {
    return logEvent({ session_id, kind: 'WALLET', event: 'BALANCE_FIRST_OBSERVED', outcome: 'BASELINE',
      ok: true, actor: 'OBSERVED',
      summary: `BASELINE — first on-chain balance reading for ${address}: ${tUSDC} tUSDC, ${SOMI} SOMI, readyToTrade=${readyToTrade}. No change is reported because there is no earlier reading to compare against; this entry is the baseline later deltas are measured from.`,
      address, balances: { tUSDC, SOMI }, readyToTrade, knownToStore: !!known });
  }
  const dU = Number(tUSDC) - Number(prev.tUSDC), dS = Number(SOMI) - Number(prev.SOMI);
  if (dU === 0 && dS === 0) return { ok: true, skipped: true, reason: 'no balance change since the last observation — nothing to log' };

  const up = dU > 0 || dS > 0;
  return logEvent({ session_id, kind: 'WALLET',
    event: up ? 'DEPOSIT_OBSERVED' : 'BALANCE_DECREASE_OBSERVED',
    outcome: up ? 'DEPOSIT' : 'DECREASE', ok: true, actor: 'OBSERVED',
    summary: `${up ? 'DEPOSIT OBSERVED' : 'BALANCE DECREASE OBSERVED'} — ${address}: tUSDC ${fmt(prev.tUSDC, tUSDC)}, SOMI ${fmt(prev.SOMI, SOMI)}. readyToTrade=${readyToTrade}. ${up ? 'AgentRail did NOT perform this transfer and has no tool that could — a deposit comes from the user\'s own wallet. This entry records an on-chain fact that was noticed, not an action that was taken.' : 'A decrease is usually an order spending collateral or paying gas — read this alongside the ORDER entries around the same timestamp rather than as a transfer out.'}`,
    address, balances: { tUSDC, SOMI },
    previousBalances: { tUSDC: prev.tUSDC, SOMI: prev.SOMI },
    delta: { tUSDC: n6(dU), SOMI: n6(dS) },
    readyToTrade, knownToStore: !!known,
    performedByAgentRail: false });
}

/** Most recent recorded balances for an address, across every session file. */
function _lastBalanceFor(address) {
  const want = String(address).toLowerCase();
  let best = null;
  for (const f of _listFiles()) {
    for (const e of _readFile(f).entries) {
      if (e.kind !== 'WALLET' || !e.balances || String(e.address).toLowerCase() !== want) continue;
      if (!best || e.ts >= best.ts) best = { ts: e.ts, tUSDC: e.balances.tUSDC, SOMI: e.balances.SOMI };
    }
  }
  return best;
}

// ============================================================================
// READ SIDE
// ============================================================================
function _listFiles() {
  try {
    return fs.readdirSync(TRADE_LOG_DIR).filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(TRADE_LOG_DIR, f));
  } catch { return []; }
}

/** Parse one file. A malformed line is COUNTED, not thrown on and not hidden. */
function _readFile(file) {
  const entries = []; let malformed = 0;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { entries, malformed }; }
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { entries.push(JSON.parse(l)); } catch { malformed++; }
  }
  return { entries, malformed };
}

/**
 * TOOL — get_trade_log. The queryable history.
 *
 * Chronological (oldest first, like any log). `limit` keeps the MOST RECENT n and
 * says how many were elided, so a truncated view is never mistaken for the whole
 * history — the same discipline as reporting a refusal.
 */
export function get_trade_log({ session_id = null, limit = 50, kind = null,
  outcome = null, refusals_only = false, include_dry_runs = true } = {}) {
  const S = resolveSession(session_id);
  const file = filePathFor(S.fileSafe);
  const sessionsKnown = _listFiles().map((f) => path.basename(f, '.jsonl'));

  if (!fs.existsSync(file)) {
    return { ok: true, tool: 'get_trade_log', sessionId: S.sessionId, file,
      exists: false, total: 0, returned: 0, entries: [],
      note: `No trade log exists for session "${S.sessionId}" yet. This means nothing has been recorded under that id — NOT that actions happened and went unlogged. Sessions with a log: ${sessionsKnown.length ? sessionsKnown.join(', ') : '(none)'}.`,
      sessionsKnown, logDir: TRADE_LOG_DIR };
  }

  const { entries: all, malformed } = _readFile(file);

  let rows = all;
  if (kind) rows = rows.filter((e) => String(e.kind).toUpperCase() === String(kind).toUpperCase());
  if (outcome) rows = rows.filter((e) => String(e.outcome).toUpperCase() === String(outcome).toUpperCase());
  if (refusals_only) rows = rows.filter((e) => e.ok === false);
  if (!include_dry_runs) rows = rows.filter((e) => e.dryRun !== true);

  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 50;
  const shown = rows.slice(-lim);

  // Counts over the WHOLE file, not the filtered slice — a caller asking for
  // refusals still needs to know the denominator.
  const tally = (fn) => all.reduce((a, e) => { const k = fn(e); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const seqs = all.map((e) => e.seq);
  const dupSeq = seqs.length !== new Set(seqs).size;

  return { ok: true, tool: 'get_trade_log',
    sessionId: S.sessionId, file, exists: true,
    total: all.length, matched: rows.length, returned: shown.length,
    elided: rows.length - shown.length,
    ...(rows.length > shown.length ? { elidedNote: `${rows.length - shown.length} older matching entries were not returned because limit=${lim}. This is a TRUNCATED view — raise limit to see the full history.` } : {}),
    filters: { kind: kind ?? null, outcome: outcome ?? null, refusals_only: !!refusals_only,
      include_dry_runs: !!include_dry_runs, limit: lim },
    summary: {
      byKind: tally((e) => e.kind ?? 'UNKNOWN'),
      byOutcome: tally((e) => e.outcome ?? 'UNKNOWN'),
      refusedOrFailed: all.filter((e) => e.ok === false).length,
      observationsNotActions: all.filter((e) => e.actor === 'OBSERVED').length,
      dryRuns: all.filter((e) => e.dryRun === true).length,
      firstEntry: all[0]?.ts ?? null, lastEntry: all[all.length - 1]?.ts ?? null,
    },
    integrity: {
      appendOnly: 'Entries are appended and never rewritten by this tool or any other in AgentRail. Nothing here edits or deletes a line.',
      malformedLines: malformed,
      ...(malformed ? { malformedNote: `${malformed} line(s) could not be parsed and were skipped. They are still in the file — reported rather than hidden, because a silently dropped line is exactly what an audit log must not do.` } : {}),
      ...(dupSeq ? { seqIntegrity: 'DUPLICATE seq values are present, which means more than one process appended to this file (each keeps its own in-memory counter). Timestamps and file order are still correct; treat seq as non-unique here.' } : { seqIntegrity: 'OK — seq values are unique' }),
      keyMaterial: 'No entry contains private key material. Wallet entries record addresses only.',
    },
    entries: shown,
    ordering: 'Chronological, oldest first. With a limit, the MOST RECENT matching entries are returned.',
    sessionsKnown, logDir: TRADE_LOG_DIR };
}

export function _resetTradeLogForTests() {
  _seq.clear();
  try { for (const f of _listFiles()) fs.unlinkSync(f); } catch { /* nothing to clear */ }
  return { ok: true, logDir: TRADE_LOG_DIR };
}
