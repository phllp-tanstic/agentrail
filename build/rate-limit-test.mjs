// ============================================================================
// RATE LIMITER TEST SUITE — offline, no network, no server, no stores.
//
//   node build/rate-limit-test.mjs
//
// Groups:
//   A. CONFIG        — defaults (5 / 600s), env override, garbage-env fallback.
//   B. FIXED WINDOW  — threshold blocking, truthful retryAfterSeconds, window
//                      reset, no carryover, per-IP isolation. Deterministic:
//                      injected clock, never a sleep.
//   C. IDENTITY      — AsyncLocalStorage scoping; resolveRequestClientIp trust
//                      model (XFF only from loopback peers, rightmost hop,
//                      IPv4-mapped normalization, spoof rejection).
//   D. THE GATE      — withCreateAccountRateLimit around a stub: enforces per
//                      identity, never calls the wrapped fn when blocked,
//                      passes through when no identity exists (stdio), and
//                      fails CLOSED if the limiter itself throws.
//   E. SINGLETON     — the module-default limiter the server wires, driven via
//                      env set before import + reset helper.
//   F. NO FALSE POSITIVES — normal single-session use (one create_account plus
//                      unlimited OTHER tool calls) never trips anything, and
//                      the limiter provably touches nothing but create_account.
// ============================================================================

// The singleton (Group E) reads env at import — set env BEFORE the import,
// same pattern as accounts-test.mjs's store redirect.
process.env.AGENTRAIL_RATE_CREATE_ACCOUNT_MAX = '3';   // distinct from the default on purpose
// window left UNSET — proves the default 600s applies alongside an override.

const {
  readRateLimitConfig, createFixedWindowLimiter,
  runWithRequestClientIp, getRequestClientIp, resolveRequestClientIp,
  withCreateAccountRateLimit, _resetCreateAccountRateLimiterForTests,
  DEFAULT_MAX_PER_WINDOW, DEFAULT_WINDOW_SECONDS,
} = await import('./rate-limit.mjs');

let pass = 0, fail = 0;
function check(n, desc, cond, detail = '') {
  if (cond) { pass++; console.log(` ${n}. [PASS] ${desc}`); }
  else { fail++; console.log(` ${n}. [FAIL] ${desc}`); }
  if (detail) console.log(`         ${detail}`);
}

console.log('=== A. CONFIG ===\n');

const dflt = readRateLimitConfig({});
check(1, 'defaults are max=5 per 600s with no env set',
  dflt.max === 5 && dflt.windowMs === 600000,
  `max=${dflt.max} windowMs=${dflt.windowMs}`);
check(2, 'DEFAULT_MAX_PER_WINDOW / DEFAULT_WINDOW_SECONDS match the spec (5 / 600s)',
  DEFAULT_MAX_PER_WINDOW === 5 && DEFAULT_WINDOW_SECONDS === 600);
const overridden = readRateLimitConfig({ AGENTRAIL_RATE_CREATE_ACCOUNT_MAX: '9',
  AGENTRAIL_RATE_CREATE_ACCOUNT_WINDOW_SECONDS: '30' });
check(3, 'env overrides are parsed (max 9, 30s window)',
  overridden.max === 9 && overridden.windowMs === 30000);
const garbage = readRateLimitConfig({ AGENTRAIL_RATE_CREATE_ACCOUNT_MAX: 'banana',
  AGENTRAIL_RATE_CREATE_ACCOUNT_WINDOW_SECONDS: '-5' });
check(4, 'garbage/negative env values fall back to the defaults, never disable the limiter',
  garbage.max === 5 && garbage.windowMs === 600000);
check(5, 'the imported singleton picked up the env override set above (max=3) AND kept the default window (600s)',
  readRateLimitConfig().max === 3 && readRateLimitConfig().windowMs === 600000);

console.log('\n=== B. FIXED WINDOW (injected clock — deterministic) ===\n');

let T = 1_000_000;
const clock = () => T;
const LIM = createFixedWindowLimiter({ max: 5, windowMs: 600000, now: clock });
const ip1 = '203.0.113.7';

const allowed = [0, 1, 2, 3, 4].map(() => LIM.check(ip1));
check(6, 'the first five create_account calls from one IP are all allowed', allowed.every((r) => r.ok === true));

const blocked = LIM.check(ip1);
check(7, 'the SIXTH call from the same IP is blocked',
  blocked.ok === false && blocked.refused === true && blocked.reason === 'rate_limited');
check(8, 'the block reports the limit and window it enforced',
  blocked.limit === 5 && blocked.windowSeconds === 600);
check(9, 'retryAfterSeconds is truthful (within (0, window] and matches the remaining time)',
  blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 600
  && blocked.retryAfterSeconds === 600);

T += 30_000;
const stillBlocked = LIM.check(ip1);
check(10, 'still blocked mid-window, and the blocked attempt did NOT extend the window',
  stillBlocked.ok === false && stillBlocked.retryAfterSeconds === 600 - 30);

T = 1_000_000 + 600_000;   // exactly the window boundary
check(11, 'a fresh window (boundary reached) allows the caller again', LIM.check(ip1).ok === true);
check(12, 'the new window does not carry the old count over — 5 more allowed, 6th blocked again',
  [0, 1, 2, 3].every(() => LIM.check(ip1).ok === true) && LIM.check(ip1).ok === false);

const ip2 = '198.51.100.9';
check(13, 'a DIFFERENT IP is unaffected by the first IP exhaustion — and its own 6th is blocked',
  [0, 1, 2, 3, 4].every(() => LIM.check(ip2).ok === true) && LIM.check(ip2).reason === 'rate_limited');

// Memory hygiene with a tiny cap: expired entries swept, live ones evicted oldest-first.
const SMALL = createFixedWindowLimiter({ max: 5, windowMs: 600000, maxEntries: 4, now: clock });
T = 2_000_000;
['a', 'b', 'c', 'd'].forEach((k) => SMALL.check(k));
let hygieneOk = true, hygieneDetail = '';
try { SMALL.check('e'); } catch (e) { hygieneOk = false; hygieneDetail = e.message; }
check(14, 'the maxEntries cap evicts instead of growing without bound — no throw at capacity',
  hygieneOk && SMALL._size() <= 4, hygieneDetail);

console.log('\n=== C. IDENTITY PLUMBING ===\n');

check(15, 'outside any request scope, identity is null (stdio / direct-core semantics)',
  getRequestClientIp() === null);

const alsScope = await runWithRequestClientIp('203.0.113.7', async () => {
  const inside = getRequestClientIp();
  await new Promise((r) => setTimeout(r, 5));   // context must survive an await (SDK chain)
  const afterAwait = getRequestClientIp();
  const nested = await runWithRequestClientIp('10.0.0.1', () => getRequestClientIp());
  return { inside, afterAwait, nested };
});
check(16, 'runWithRequestClientIp scopes the identity, survives awaits, and nests correctly',
  alsScope.inside === '203.0.113.7' && alsScope.afterAwait === '203.0.113.7'
  && alsScope.nested === '10.0.0.1');
check(17, 'the scope ends after runWithRequestClientIp returns', getRequestClientIp() === null);

const fakeReq = (remoteAddress, xff) => ({
  socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
});
check(18, 'loopback peer + X-Forwarded-For → the RIGHTMOST hop is used (one trusted proxy: Caddy)',
  resolveRequestClientIp(fakeReq('127.0.0.1', '203.0.113.7, 198.51.100.9')) === '198.51.100.9');
check(19, 'loopback peer with NO XFF → the socket peer itself is the identity',
  resolveRequestClientIp(fakeReq('127.0.0.1')) === '127.0.0.1');
check(20, 'a NON-loopback peer gets its XFF IGNORED — a direct client cannot spoof fresh identities to evade the limit',
  resolveRequestClientIp(fakeReq('203.0.113.7', '1.2.3.4, 5.6.7.8')) === '203.0.113.7');
check(21, 'IPv4-mapped ::ffff: spellings normalize to the same identity as plain IPv4',
  resolveRequestClientIp(fakeReq('::ffff:127.0.0.1', '203.0.113.7')) === '203.0.113.7'
  && resolveRequestClientIp(fakeReq('::ffff:203.0.113.7')) === '203.0.113.7');
check(22, 'a request with no socket at all resolves to a stable "unknown" identity, never undefined',
  resolveRequestClientIp({}) === 'unknown' && resolveRequestClientIp(null) === 'unknown');

console.log('\n=== D. THE GATE (withCreateAccountRateLimit around a stub) ===\n');

_resetCreateAccountRateLimiterForTests();
let stubCalls = 0;
const stub = async (args) => { stubCalls += 1; return { ok: true, saw: args?.session_id ?? null }; };
// Fresh max-5 limiter (NOT the env-configured singleton — Group E covers that).
const lim5 = createFixedWindowLimiter({ max: 5, windowMs: 600000 });
const gated = withCreateAccountRateLimit(stub, lim5);

const five = [];
for (let i = 0; i < 5; i++) {
  five.push(await runWithRequestClientIp('192.0.2.50', () => gated({ session_id: `user_${i}` })));
}
check(23, 'five create_account calls under one identity pass through to the real implementation',
  five.every((r) => r.ok === true) && stubCalls === 5);

const sixth = await runWithRequestClientIp('192.0.2.50', () => gated({ session_id: 'user_5' }));
check(24, 'the sixth is refused with a full, self-explanatory refusal — and the real implementation is NEVER called',
  sixth.ok === false && sixth.refused === true && sixth.reason === 'rate_limited'
  && sixth.retryAfterSeconds > 0 && stubCalls === 5,
  `limit=${sixth.limit} window=${sixth.windowSeconds}s retryAfter=${sixth.retryAfterSeconds}s`);
check(25, 'the refusal does not leak any api_key-shaped value', !/ar_sk_/.test(JSON.stringify(sixth)));

const otherIp = await runWithRequestClientIp('192.0.2.51', () => gated({ session_id: 'user_other' }));
check(26, 'a different IP sails through while the first is blocked', otherIp.ok === true && stubCalls === 6);

const unkeyed = [];
for (let i = 0; i < 20; i++) unkeyed.push(await gated({ session_id: `stdio_${i}` }));
check(27, 'with NO identity (stdio / direct core calls) the gate passes through — documented bypass, not an accident',
  unkeyed.every((r) => r.ok === true) && stubCalls === 26);

// A second wrapper over the SAME exhausted limiter — exhaustion lives in the
// limiter instance, not in any one wrapper.
const plain = withCreateAccountRateLimit(stub, lim5);
const plainResult = await runWithRequestClientIp('192.0.2.50', () => plain({ session_id: 'x' }));
check(28, 'exhaustion lives in the limiter, not the wrapper — the same limiter still blocks a second wrapper',
  plainResult.ok === false && plainResult.reason === 'rate_limited');

const explodingLimiter = { check: () => { throw new Error('simulated limiter crash'); } };
const failClosed = withCreateAccountRateLimit(stub, explodingLimiter);
const fc = await runWithRequestClientIp('192.0.2.99', () => failClosed({ session_id: 'fc' }));
check(29, 'if the limiter itself throws, the call is REFUSED (fail-closed), not waved through',
  fc.ok === false && fc.refused === true && fc.reason === 'rate_limiter_error' && stubCalls === 26);

console.log('\n=== E. MODULE SINGLETON (env-configured, reset helper) ===\n');

_resetCreateAccountRateLimiterForTests();
const singleton = withCreateAccountRateLimit(stub);
const sResults = [];
for (let i = 0; i < 4; i++) {
  sResults.push(await runWithRequestClientIp('100.64.0.1', () => singleton({ session_id: `s_${i}` })));
}
check(30, 'the singleton enforces the env-set max (3, from import-time env): 3 allowed, 4th refused',
  sResults[0].ok === true && sResults[1].ok === true && sResults[2].ok === true
  && sResults[3].ok === false && sResults[3].limit === 3 && sResults[3].windowSeconds === 600);

_resetCreateAccountRateLimiterForTests();
const afterReset = await runWithRequestClientIp('100.64.0.1', () => singleton({ session_id: 's_fresh' }));
check(31, '_resetCreateAccountRateLimiterForTests clears all identities — the 4th call now succeeds',
  afterReset.ok === true);

console.log('\n=== F. NO FALSE POSITIVES ON NORMAL SINGLE-SESSION USE ===\n');

_resetCreateAccountRateLimiterForTests();
let otherToolCalls = 0;
const otherTool = async () => { otherToolCalls += 1; return { ok: true }; };
const flow = [];
flow.push(await runWithRequestClientIp('198.51.100.1', () => singleton({ session_id: 'one_real_user' })));
for (let i = 0; i < 50; i++) flow.push(await otherTool());   // NOT wrapped — like every other tool
flow.push(await runWithRequestClientIp('198.51.100.1', () => singleton({ session_id: 'one_real_user' })));
check(32, 'one real session: create_account → 50 OTHER tool calls → more calls — nothing trips',
  flow.every((r) => r.ok === true) && otherToolCalls === 50,
  'the limiter is wired to create_account ONLY; every other tool is requireApiKey-gated and untouched by it');

console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
