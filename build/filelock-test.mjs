// Offline test suite for filelock.mjs.
// Run: node build/filelock-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withFileLock } from './filelock.mjs';

let pass = 0, fail = 0;
function check(n, desc, cond, detail = '') {
  if (cond) { pass++; console.log(` ${n}. [PASS] ${desc}`); }
  else { fail++; console.log(` ${n}. [FAIL] ${desc}`); }
  if (detail) console.log(`         ${detail}`);
}

const STORE = path.join(os.tmpdir(), `filelock-test-${process.pid}.json`);
const LOCK = `${STORE}.lock`;
try { fs.unlinkSync(LOCK); } catch { /* fine */ }

console.log('=== BASIC ACQUIRE/RELEASE ===\n');

const r1 = withFileLock(STORE, () => 'ran');
check(1, 'withFileLock runs the function and returns its value', r1 === 'ran');
check(2, 'the lock file is removed after a successful run (not leaked)', !fs.existsSync(LOCK));

console.log('\n=== RE-ENTRANT SEQUENTIAL USE ===\n');

let counter = 0;
for (let i = 0; i < 5; i++) withFileLock(STORE, () => { counter++; });
check(3, 'the lock can be acquired and released repeatedly in sequence', counter === 5);
check(4, 'no lock file left behind after repeated sequential use', !fs.existsSync(LOCK));

console.log('\n=== EXCEPTION SAFETY ===\n');

let threw = null;
try {
  withFileLock(STORE, () => { throw new Error('boom'); });
} catch (e) { threw = e; }
check(5, 'an exception inside the locked function propagates out', threw !== null && threw.message === 'boom');
check(6, 'the lock is still released even though the function threw (finally block worked)', !fs.existsSync(LOCK));

console.log('\n=== STALE LOCK RECOVERY ===\n');

// Simulate a crashed process: write a lock file with a PID that does not
// exist (a very high, almost-certainly-unused PID) and an old timestamp.
fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: new Date(Date.now() - 60_000).toISOString() }));
const r2 = withFileLock(STORE, () => 'recovered');
check(7, 'a stale lock (dead PID, old timestamp) is detected and stolen rather than blocking forever',
  r2 === 'recovered');
check(8, 'the lock file is clean after stealing and releasing', !fs.existsSync(LOCK));

// A lock with a live PID (this process's own) but very old timestamp should
// NOT be stolen just for age if the PID is genuinely still running — the
// isLockStale check treats a live, findable process as evidence it's not
// abandoned, checked before falling back to the age heuristic.
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 60_000).toISOString() }));
let ownLockThrew = null;
try {
  // deadline is 5s; this should genuinely block/timeout since the "lock
  // holder" (this same process, per the PID) looks alive.
  withFileLock(STORE, () => 'should not get here');
} catch (e) { ownLockThrew = e; }
check(9, 'a lock recorded under a LIVE pid is NOT stolen just for being old — it genuinely blocks until timeout',
  ownLockThrew !== null && /Could not acquire/.test(ownLockThrew.message));
try { fs.unlinkSync(LOCK); } catch { /* cleanup */ }

console.log('\n=== THE ROOT CAUSE FIX, DETERMINISTICALLY: a fresh-but-not-yet-written lock must never be stolen ===\n');

// The real bug (found via live instrumentation on Windows, not guessed):
// isLockStale() treated an unparseable lock file as abandoned regardless of
// age, but there is an unavoidable, real gap between fs.openSync('wx')
// creating the lock file and the holder writing its own {pid,at} into it —
// during that gap the file exists but is EMPTY, which reads/parses
// identically to genuine corruption. A contender that hit EEXIST during that
// gap stole a live, legitimate lock within milliseconds of its creation.
//
// This reproduces it DETERMINISTICALLY rather than relying on natural OS
// scheduling timing (which only manifested in a small fraction of real runs)
// — using _testDelayBeforeWriteMs, a test-only hook that artificially widens
// that exact gap, mirroring the widened-window demonstration that confirmed
// the root cause.
const DET_STORE = path.join(os.tmpdir(), `filelock-deterministic-${process.pid}.json`);
try { fs.unlinkSync(DET_STORE); } catch { /* fine */ }
try { fs.unlinkSync(`${DET_STORE}.lock`); } catch { /* fine */ }

const detScript = `
import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve('./build/filelock.mjs')).href)};
import fs from 'node:fs';
const STORE = ${JSON.stringify(DET_STORE)};
const delayMs = Number(process.argv[2] ?? 0);
const startDelayMs = Number(process.argv[3] ?? 0);
if (startDelayMs > 0) {
  const s = Date.now(); while (Date.now() - s < startDelayMs) {} // synchronous stagger before even attempting
}
const result = withFileLock(STORE, () => {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { /* first writer */ }
  if (existing) return { created: false, owner: existing.owner };
  const record = { owner: process.pid, at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(record));
  return { created: true, owner: record.owner };
}, { _testDelayBeforeWriteMs: delayMs });
console.log(JSON.stringify(result));
`;
const detScriptPath = path.join(os.tmpdir(), `filelock-deterministic-script-${process.pid}.mjs`);
fs.writeFileSync(detScriptPath, detScript);

const { spawn } = await import('node:child_process');
// HOLDER: opens the lock immediately, then artificially waits 300ms BEFORE
// writing its content — guaranteeing a wide, deterministic window where the
// lock file exists but is empty.
// CONTENDER: starts 50ms later (guaranteed to be well inside the holder's
// 300ms window) with zero injected delay of its own — this is the exact
// timing shape that reproduced the bug via live instrumentation.
const detOutputs = await Promise.all([
  { args: [detScriptPath, '300', '0'] },   // holder
  { args: [detScriptPath, '0', '50'] },    // contender
].map(({ args }) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => resolve(out.trim()));
})));

const detResults = detOutputs.map((o) => { try { return JSON.parse(o); } catch { return null; } });
const detCreatedCount = detResults.filter((r) => r?.created === true).length;
check(10, 'DETERMINISTIC: with the open-to-write gap artificially widened to 300ms, exactly ONE caller reports created:true (this is the exact scenario that broke before the fix)',
  detCreatedCount === 1, `results: ${JSON.stringify(detResults)}`);

const detFinalOnDisk = JSON.parse(fs.readFileSync(DET_STORE, 'utf8'));
const detWinnerPid = detResults.find((r) => r?.created === true)?.owner;
check(11, 'the record on disk belongs to whichever process actually won — no silent overwrite',
  detFinalOnDisk.owner === detWinnerPid, `onDisk.owner=${detFinalOnDisk.owner} winner=${detWinnerPid}`);

try { fs.unlinkSync(DET_STORE); fs.unlinkSync(detScriptPath); } catch { /* cleanup best-effort */ }

console.log('\n=== SECONDARY: natural-timing cross-process race (no artificial delay, best-effort) ===\n');

// Same scenario without the artificial delay hook — real-world conditions,
// where the bug only manifested probabilistically (~4.5% of runs per the
// investigation). Kept as an additional, less deterministic sanity check;
// check 10/11 above are the real regression guard for this bug specifically.
const RACE_STORE = path.join(os.tmpdir(), `filelock-race-${process.pid}.json`);
try { fs.unlinkSync(RACE_STORE); } catch { /* fine */ }
try { fs.unlinkSync(`${RACE_STORE}.lock`); } catch { /* fine */ }

const raceScript = `
import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve('./build/filelock.mjs')).href)};
import fs from 'node:fs';
const STORE = ${JSON.stringify(RACE_STORE)};
const result = withFileLock(STORE, () => {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { /* first writer */ }
  if (existing) return { created: false, owner: existing.owner };
  const start = Date.now(); while (Date.now() - start < 50) {} // busy-wait 50ms
  const record = { owner: process.pid, at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(record));
  return { created: true, owner: record.owner };
});
console.log(JSON.stringify(result));
`;
const scriptPath = path.join(os.tmpdir(), `filelock-race-script-${process.pid}.mjs`);
fs.writeFileSync(scriptPath, raceScript);

const outputs = await Promise.all([0, 1].map(() => new Promise((resolve) => {
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => resolve(out.trim()));
})));

const results = outputs.map((o) => { try { return JSON.parse(o); } catch { return null; } });
const createdCount = results.filter((r) => r?.created === true).length;
check(12, 'natural-timing race: exactly ONE of two genuinely concurrent cross-process callers reports created:true',
  createdCount === 1, `results: ${JSON.stringify(results)}`);

const finalOnDisk = JSON.parse(fs.readFileSync(RACE_STORE, 'utf8'));
const winnerPid = results.find((r) => r?.created === true)?.owner;
check(13, 'the record actually on disk belongs to whichever process won — no silent overwrite by the loser',
  finalOnDisk.owner === winnerPid, `onDisk.owner=${finalOnDisk.owner} winner=${winnerPid}`);

try { fs.unlinkSync(RACE_STORE); fs.unlinkSync(scriptPath); } catch { /* cleanup best-effort */ }

console.log(`\n=== RESULT: ${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ''} ===`);
process.exit(fail ? 1 : 0);
