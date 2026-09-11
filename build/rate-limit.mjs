// ============================================================================
// PER-IP RATE LIMITER — applied to exactly ONE tool: create_account.
//
// WHY ONLY create_account: every other write-capable tool (generate_wallet,
// place_order, redeem, withdraw) sits behind requireApiKey — an attacker can
// hammer them all day and gets nothing but auth failures. create_account is
// the bootstrap: it has NO credential to check, because its entire job is to
// MINT the credential. That makes it the one unauthenticated write path to
// disk (the accounts store), and therefore the one tool a public endpoint
// must throttle: unthrottled, anyone on the internet can fill the store with
// garbage accounts (and, worse, the refusal on an EXISTING session_id is a
// free "does this session_id exist" oracle, disclosed at creation time by
// design — rate limiting at least makes harvesting expensive).
//
// WHY FIXED WINDOW, not token bucket: the requirement is "small" and
// auditable. A fixed window is one Map, one counter per key, and a boundary
// you can reason about in your head; a bucket's continuous refill is
// impossible to eyeball from a test log. The known fixed-window artifact —
// up to 2x the limit across a window boundary — is harmless here: the worst
// case is ~10 account rows per 10 minutes, not a safety property.
//
// WHERE THE IP COMES FROM — the honest constraint: the MCP tool layer sees
// arguments, not sockets. Client identity is captured at the HTTP layer
// (mcp-server.mjs resolves it from the request and carries it into the tool
// call via AsyncLocalStorage), which is exactly where it is knowable.
//
//   - The socket peer is the source of truth.
//   - X-Forwarded-For is honored ONLY when the socket peer is loopback —
//     i.e. our own Caddy, the sole thing that can talk to 127.0.0.1:8787.
//     A DIRECT client's XFF header is ignored, so a remote caller cannot
//     spoof fresh identities to evade the limit (the classic XFF bypass).
//   - With one trusted proxy, the RIGHTMOST XFF hop is the real client:
//     Caddy appends the peer it saw, so a client-supplied fake hop lands
//     left of the truth.
//   - stdio transports and direct core calls (tests, CLI) have no IP at
//     all: they run with no identity and BYPASS the limiter. There is no
//     "per-IP" anything to enforce on a local operator console, and a
//     limiter keyed on "localhost" would be one shared bucket for every
//     local caller, including the test harness.
//
// IN-MEMORY, DELIBERATELY: the limit's job is to make abuse expensive, not
// to be forensic state. A restart clearing it is acceptable; persisting it
// would put attacker-controlled data on disk next to the stores it guards.
// Single-process scope mirrors the risk ledger's documented single-instance
// assumption (see risk.mjs) — a second server instance would get its own
// window, which for this deployment (one instance, one box) is moot.
//
// FAIL-CLOSED: if the limiter itself throws, create_account is REFUSED, not
// waved through — the limiter guards the only unauthenticated write, so its
// failure mode must not be "open". The in-memory path is three Map
// operations; this branch exists so that future edits cannot silently turn
// a limiter bug into an open door.
//
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
export const DEFAULT_MAX_PER_WINDOW = 5;
export const DEFAULT_WINDOW_SECONDS = 600;   // 10 minutes
// Memory hygiene: at most this many concurrent tracked identities. Realistic
// per-10-min client counts are orders of magnitude below this; the cap exists
// so pathological address churn cannot grow the Map without bound.
export const DEFAULT_MAX_ENTRIES = 10000;

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Pure config reader — exported so tests can assert default/override/garbage
 * handling without touching process.env. */
export function readRateLimitConfig(env = process.env) {
  return {
    max: parsePositiveInt(env.AGENTRAIL_RATE_CREATE_ACCOUNT_MAX, DEFAULT_MAX_PER_WINDOW),
    windowMs: parsePositiveInt(env.AGENTRAIL_RATE_CREATE_ACCOUNT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS) * 1000,
    maxEntries: DEFAULT_MAX_ENTRIES,
  };
}

// ---------------------------------------------------------------------------
// FIXED-WINDOW LIMITER
//
// check(key) is the whole API:
//   { ok: true }                                        — allowed (count incremented)
//   { ok:false, refused:true, reason:'rate_limited',
//     limit, windowSeconds, retryAfterSeconds }          — blocked (state untouched)
//
// Blocked attempts do NOT extend the window — retryAfterSeconds is therefore
// always truthful, and a blocked caller cannot push their own window out.
// `now` is injectable for deterministic offline tests.
// ---------------------------------------------------------------------------
export function createFixedWindowLimiter({ max = DEFAULT_MAX_PER_WINDOW,
  windowMs = DEFAULT_WINDOW_SECONDS * 1000, maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now() } = {}) {
  const hits = new Map();   // identity -> { windowStart, count }

  return {
    check(key) {
      const id = String(key);
      const t = now();

      // Eviction sweep first: expired windows are dead weight; if the map is
      // still full of LIVE windows after the sweep, drop the OLDEST. Eviction
      // relaxes the limit for one identity under pathological load — the
      // documented trade (memory bound over strictness) — and only triggers
      // orders of magnitude beyond any realistic client count.
      if (hits.size >= maxEntries && !hits.has(id)) {
        for (const [k, v] of hits) if (t >= v.windowStart + windowMs) hits.delete(k);
        if (hits.size >= maxEntries) {
          let oldestKey = null, oldestStart = Infinity;
          for (const [k, v] of hits) if (v.windowStart < oldestStart) { oldestStart = v.windowStart; oldestKey = k; }
          if (oldestKey !== null) hits.delete(oldestKey);
        }
      }

      const w = hits.get(id);
      if (!w || t >= w.windowStart + windowMs) {
        hits.set(id, { windowStart: t, count: 1 });
        return { ok: true };
      }
      if (w.count >= max) {
        return { ok: false, refused: true, reason: 'rate_limited',
          limit: max, windowSeconds: Math.round(windowMs / 1000),
          retryAfterSeconds: Math.max(1, Math.ceil((w.windowStart + windowMs - t) / 1000)) };
      }
      w.count += 1;
      return { ok: true };
    },
    _resetForTests() { hits.clear(); },
    _size() { return hits.size; },
  };
}

// The module-level limiter the deployed server actually uses. Config is read
// from process.env at import time — tests that need a specific config either
// use the factory directly or set env before the dynamic import.
const createAccountLimiter = createFixedWindowLimiter(readRateLimitConfig());

/** Check the caller's per-IP budget for create_account. */
export function checkCreateAccountLimit(key) { return createAccountLimiter.check(key); }

/** Test-only: clear all tracked identities. */
export function _resetCreateAccountRateLimiterForTests() { createAccountLimiter._resetForTests(); }

// ---------------------------------------------------------------------------
// REQUEST IDENTITY — captured at the HTTP layer, consumed at the tool layer.
// AsyncLocalStorage is the only way to hand the IP to the tool handler without
// threading a request object through every MCP SDK layer (which the thin-
// registration design of mcp-server.mjs forbids).
// ---------------------------------------------------------------------------
const requestClientIp = new AsyncLocalStorage();

/** Scope `fn` (and its whole async tree, including awaited tool handlers) to a
 * client identity. mcp-server.mjs calls this around transport.handleRequest. */
export function runWithRequestClientIp(clientIp, fn) {
  return requestClientIp.run(clientIp ?? null, fn);
}

/** The identity of the request currently being served — null when there is
 * none (stdio transport, direct core calls). */
export function getRequestClientIp() {
  const store = requestClientIp.getStore();
  return store === undefined ? null : store;
}

function normalizeIp(ip) {
  // Node reports IPv4 peers on a dual-stack socket as '::ffff:a.b.c.d' —
  // normalize so both spellings land in the same bucket.
  return typeof ip === 'string' && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Resolve the per-IP identity for one HTTP request. See the module header for
 * the trust model: socket peer first; X-Forwarded-For only from loopback
 * peers (our Caddy), rightmost hop, length-capped so a hostile header cannot
 * bloat the Map keys.
 */
export function resolveRequestClientIp(req) {
  const peer = normalizeIp(req?.socket?.remoteAddress ?? '');
  if (!peer) return 'unknown';
  if (peer === '127.0.0.1' || peer === '::1') {
    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const hop = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (hop) return normalizeIp(hop).slice(0, 128);
    }
  }
  return peer;
}

function rateLimitedRefusal(verdict, err = null) {
  const cfg = readRateLimitConfig();
  const win = verdict?.windowSeconds ?? Math.round(cfg.windowMs / 1000);
  const lim = verdict?.limit ?? cfg.max;
  return {
    ok: false,
    refused: true,
    reason: err ? 'rate_limiter_error' : 'rate_limited',
    detail: err
      ? `The create_account rate limiter failed internally (${err?.message ?? err}), so the call was REFUSED — fail-closed, because this tool is the one unauthenticated write path. Retry shortly; if it persists, this is a server bug to report, not a limit to wait out.`
      : `Too many create_account calls from this address: the limit is ${lim} per ${win >= 60 ? `${win / 60} minutes` : `${win} seconds`}. Retry in ~${verdict.retryAfterSeconds}s when the window resets. Existing accounts and every authenticated tool are unaffected.`,
    limit: lim,
    windowSeconds: win,
    retryAfterSeconds: err ? null : verdict.retryAfterSeconds,
  };
}

/**
 * THE WIRING POINT — and deliberately the only one. Wrap create_account's
 * implementation with this in mcp-server.mjs and NOTHING ELSE: every other
 * tool is credential-gated and needs no limiter (module header, ¶1).
 *
 *   wrap(withCreateAccountRateLimit(core.create_account))
 *
 * No identity (stdio, direct core calls, tests) → passthrough, by design.
 */
export function withCreateAccountRateLimit(fn, limiter = createAccountLimiter) {
  return async (args) => {
    const ip = getRequestClientIp();
    if (ip === null) return fn(args);
    let verdict = null;
    try { verdict = limiter.check(ip); }
    catch (e) { return rateLimitedRefusal(null, e); }   // fail-closed
    if (!verdict.ok) return rateLimitedRefusal(verdict);
    return fn(args);
  };
}
