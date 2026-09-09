// ============================================================================
// CROSS-PROCESS FILE LOCK — closes a real, reproduced race found during
// independent custody review: two separate OS processes calling
// generate_wallet/create_account for the same NEW session_id, against the
// same store file, could both pass their "does this already exist" check
// before either had written, then both write — the second write silently
// wins, and the first caller's key/api_key is gone with zero preservation
// and zero warning. Confirmed by literally running two node processes at
// once against the same store; not a hypothetical.
//
// NOTE ON SCOPE: within ONE process, this race does NOT occur — JavaScript's
// single-threaded execution model, combined with these functions having zero
// `await` points in their read-modify-write critical sections, already
// serializes same-process calls correctly (verified empirically, not just
// assumed). This lock exists specifically for genuinely separate processes —
// two server instances, or a server running alongside a standalone script
// like migrate-wallet-store.mjs — sharing the same store file.
//
// MECHANISM: exclusive file creation (`wx` flag fails if the file already
// exists) as the lock primitive — this is atomic at the OS/filesystem level,
// which a "check then create" pattern in JS alone would not be. A stale lock
// (left behind by a crashed process that never reached its `finally`) is
// detected two ways: the recorded PID no longer exists (process.kill(pid, 0)
// throws ESRCH), or the lock is simply old enough (30s) that nothing this
// fast should still legitimately be holding it — these critical sections are
// synchronous, sub-millisecond file operations, not long-running work.
// ============================================================================
import fs from 'node:fs';

const LOCK_WAIT_MS = 5000;     // max total time to wait for a contended lock
const RETRY_BACKOFF_MS = 20;   // short synchronous backoff between attempts
const STALE_AFTER_MS = 30_000; // a lock older than this, with no evidence its
const GRACE_WINDOW_MS = 500;   // a lock file younger than this is NEVER considered
                                // stale regardless of content — the real, unavoidable
                                // gap between fs.openSync('wx') creating it and its
                                // holder's subsequent write of {pid,at} into it. Found
                                // via live instrumentation on Windows: without this,
                                // an unparseable-because-not-yet-written lock was
                                // stolen from its legitimate holder within milliseconds.
                                // 500ms is generous relative to the actual gap (expected
                                // sub-millisecond to low-millisecond in practice) while
                                // staying short next to LOCK_WAIT_MS's 5s budget.
                                // owner is even findable, is treated as abandoned

function sleepMsSync(ms) {
  // A true synchronous sleep — Atomics.wait on a throwaway SharedArrayBuffer
  // is the standard safe way to block briefly in Node. Same technique already
  // used in risk.mjs's persist() retry, kept consistent rather than
  // reinvented here.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLockStale(lockPath) {
  // GRACE WINDOW, checked via filesystem mtime BEFORE ever trying to read or
  // parse content — this is the actual root cause fix. There is an
  // unavoidable, real gap between fs.openSync(path,'wx') creating the lock
  // file and the holder's subsequent fs.writeSync of its own {pid, at} into
  // it. During that gap the file exists but is EMPTY, which read/parse as
  // unreadable — indistinguishable, by content alone, from a genuinely
  // corrupt/abandoned lock. The original version treated both the same way
  // ("can't parse it -> treat as abandoned -> steal it"), which was
  // confirmed via live instrumentation to steal a real, live lock within
  // milliseconds of its holder creating it, breaking mutual exclusion
  // entirely for the overlap window. A lock file younger than this grace
  // window is NEVER considered stale, regardless of what its content looks
  // like — it hasn't had a fair chance to be written yet.
  let stat;
  try { stat = fs.statSync(lockPath); }
  catch { return true; } // vanished between our EEXIST and now — nothing to steal, safe to just retry the open
  if (Date.now() - stat.mtimeMs < GRACE_WINDOW_MS) return false;

  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf8'); }
  catch { return true; } // vanished after our stat — same reasoning as above
  let info;
  try { info = JSON.parse(raw); }
  catch { return true; } // OLD (past the grace window) AND still unparseable — genuinely corrupt/abandoned now, not a timing artifact
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0); // signal 0: existence check only, does not actually kill
      return false; // a genuinely alive PID settles it — not stale, regardless of age. These
                     // critical sections are synchronous, sub-millisecond file operations; a
                     // real holder taking any meaningful time is already unusual, but "alive"
                     // is a stronger, more direct signal than an age heuristic and should win.
    } catch (e) {
      if (e.code === 'ESRCH') return true; // recorded process no longer exists — definitely stale
      // Any other error from kill() (e.g. EPERM on some platforms/permission
      // setups) is inconclusive about liveness — fall through to the age
      // heuristic below rather than guessing either way from an ambiguous signal.
    }
  }
  // Reached only when the PID check was inconclusive (not present, or an
  // ambiguous error) — age is the fallback signal in that case only.
  const ageMs = Date.now() - new Date(info.at ?? 0).getTime();
  return !Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS;
}

/**
 * Runs `fn` (synchronous, no `await` inside — this lock is held via a
 * blocking synchronous wait loop, not released back to the event loop) while
 * holding an exclusive cross-process lock keyed to `storePath`. Throws if the
 * lock cannot be acquired within LOCK_WAIT_MS — deliberately fails loud
 * rather than silently proceeding unlocked, which would defeat the point.
 */
export function withFileLock(storePath, fn, { _testDelayBeforeWriteMs = 0 } = {}) {
  const lockPath = `${storePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // atomic exclusive create — the actual lock primitive
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isLockStale(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch { /* another process may have already cleared it — fine, just retry */ }
        continue; // retry acquiring immediately, no backoff needed for this branch
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not acquire lock ${lockPath} within ${LOCK_WAIT_MS}ms — another process appears to be actively using ${storePath} right now. If you are certain nothing else is using it, remove ${lockPath} manually and retry.`);
      }
      sleepMsSync(RETRY_BACKOFF_MS);
    }
  }

  // TEST-ONLY: artificially widens the real, normally sub-millisecond gap
  // between creating the lock file and writing {pid,at} into it — the exact
  // window the GRACE_WINDOW_MS fix protects. Exists so the race this closes
  // can be reproduced DETERMINISTICALLY in a test, rather than relying on
  // natural OS scheduling timing that only manifested in a small fraction of
  // real runs. Zero by default; never used by any real caller.
  if (_testDelayBeforeWriteMs > 0) sleepMsSync(_testDelayBeforeWriteMs);

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already removed, e.g. by a stale-lock steal elsewhere */ }
  }
}
