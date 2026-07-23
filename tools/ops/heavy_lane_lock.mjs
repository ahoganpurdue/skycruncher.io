// Cross-session HEAVY-LANE advisory lock (multicode 2026-07-11).
// Two Claude sessions share ONE box and CANNOT see each other's processes; the CR2
// blind solve is load-sensitive (root-caused 2026-07-11 — starves under CPU contention
// and false-fails). Before ANY heavy lane (solve battery, gate battery, build, bulk
// download), a session ACQUIRES this lock; releases when done. Advisory, not enforced —
// both sessions must call it. Fail-closed: if a LIVE lease is held, do not start.
//
// LIVENESS = LEASE-TTL + HEARTBEAT (rewritten 2026-07-11, kills the false-STALE bug).
//   The old version recorded the acquiring CLI's pid, but that process exits the instant
//   it finishes writing the lock — so every later check saw a dead pid and declared the
//   lock STALE while the owner's battery was still running. A lock that reads STALE
//   exactly when work is in flight protects nothing. Fix: the lock carries an EXPIRY, not
//   a pid-to-watch. It stays HELD until the lease expires; long lanes call `heartbeat`
//   to push the expiry out. STALE now means LEASE-EXPIRED, never dead-pid.
//
//   node tools/ops/heavy_lane_lock.mjs status
//   node tools/ops/heavy_lane_lock.mjs acquire <account> <lane> [--ttl <min>] [--pid <n>] [--grace <sec>]
//     # exit 0 = got it, 3 = held by a live lease. Default TTL = 15 min.
//   node tools/ops/heavy_lane_lock.mjs heartbeat <account> [--ttl <min>]   # extend the lease
//   node tools/ops/heavy_lane_lock.mjs release <account>
//   node tools/ops/heavy_lane_lock.mjs selftest                            # in-process behaviour suite
//
// HEARTBEAT PATTERN for long lanes (batteries, population/download scripts): acquire once,
//   then call `heartbeat <account>` between phases (cheap, idempotent) so the lease never
//   lapses under a slow phase. A 15-min default TTL covers a warm CR2 e2e; heartbeat every
//   phase boundary (or every ~5 min in a loop) and release at the end.
//
// --pid is OPTIONAL and only for callers that DO own a durable process worth watching:
//   if given, a DEAD watched pid (after --grace, default 30s from acquire) SHORTENS the
//   lease to STALE early. Absence of --pid NEVER produces pid-based staleness — the lease
//   is the sole authority. (Passing the ephemeral CLI's own pid is exactly the old bug;
//   don't — pass a real long-running child pid or nothing.)
//
// ACCOUNT B (adopt at spawn): if `status` says STALE it now means the LEASE EXPIRED, not a
//   dead pid — so if your heavy lane is still running you must be HEARTBEATING it, or the
//   other session may (correctly) take the lock from under you. Heartbeat your long lanes.
//
// Atomic single-file write: every mutation writes a temp sibling then renames onto the
// lock (replace-existing on Windows and POSIX), so a concurrent reader never sees a
// half-written file. Windows-safe: no POSIX-only syscalls (pid check via process.kill(0)).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
// HEAVY_LANE_LOCK env override exists so `selftest` can run against a throwaway lock file
// without clobbering the real cross-session lock.
const LOCK = process.env.HEAVY_LANE_LOCK
    ? path.resolve(process.env.HEAVY_LANE_LOCK)
    : path.join(ROOT, 'test_results', 'heavy_lane.lock');

const DEFAULT_TTL_MIN = 15;
const DEFAULT_GRACE_SEC = 30;

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function read() {
    try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}
function writeAtomic(rec) {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    const tmp = `${LOCK}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, LOCK); // atomic replace on Win (MoveFileEx) + POSIX
}

// Decide whether a lock record is still a live lease. Returns { held, reason }.
// Lease is the sole authority; a watched --pid can only SHORTEN it (dead pid + grace).
function evaluate(l, now = Date.now()) {
    if (!l) return { held: false, reason: 'no lock (FREE)' };
    if (!l.expires_at) return { held: false, reason: 'legacy lock without a lease — treated as stale' };
    const exp = Date.parse(l.expires_at);
    if (!(now < exp)) return { held: false, reason: `lease expired at ${l.expires_at}` };
    // Lease still valid. Only a watched pid can cut it short early.
    if (l.pid != null && !pidAlive(l.pid)) {
        const tsMs = Date.parse(l.ts);
        const graceMs = typeof l.grace_ms === 'number' ? l.grace_ms : DEFAULT_GRACE_SEC * 1000;
        if (now - tsMs >= graceMs) {
            return { held: false, reason: `watched pid ${l.pid} is dead (past ${Math.round(graceMs / 1000)}s grace); lease would have run to ${l.expires_at}` };
        }
    }
    return { held: true, reason: `lease valid until ${l.expires_at}` };
}

function cmdStatus() {
    const l = read();
    if (!l) { console.log('FREE'); return 0; }
    const ev = evaluate(l);
    const pidNote = l.pid != null ? `pid=${l.pid}` : 'pid=none';
    if (ev.held) {
        console.log(`HELD by ${l.account} lane="${l.lane}" until ${l.expires_at} (${pidNote}) since ${l.ts}`);
    } else {
        console.log(`STALE (${ev.reason}) — last held by ${l.account} lane="${l.lane}" (${pidNote}) since ${l.ts}`);
    }
    return 0;
}

function cmdAcquire(account, lane, opts) {
    if (!account || !lane) { console.error('usage: acquire <account> <lane> [--ttl <min>] [--pid <n>] [--grace <sec>]'); return 2; }
    const l = read();
    const ev = evaluate(l);
    if (l && ev.held && l.account !== account) {
        console.error(`HELD by ${l.account} lane="${l.lane}" until ${l.expires_at} — do NOT start a heavy lane. (If theirs is really done they should release/let it expire.)`);
        return 3;
    }
    const now = Date.now();
    const ttlMs = Math.max(0, opts.ttlMin) * 60000;
    const rec = {
        account, lane,
        pid: opts.pid ?? null,
        ts: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
        ttl_ms: ttlMs,
        grace_ms: opts.graceMs,
    };
    writeAtomic(rec);
    const watch = opts.pid != null ? `, watching pid ${opts.pid}` : '';
    const took = l && !ev.held && l.account !== account ? ` (took over stale lock from ${l.account})` : '';
    console.log(`ACQUIRED ${account} lane="${lane}" (lease ${opts.ttlMin}min, until ${rec.expires_at}${watch})${took}`);
    return 0;
}

function cmdHeartbeat(account, opts) {
    const l = read();
    if (!l) { console.error('nothing to heartbeat — lock is FREE'); return 3; }
    if (account && l.account !== account) { console.error(`refusing: lock held by ${l.account}, not ${account}`); return 3; }
    const now = Date.now();
    const ttlMs = opts.ttlProvided ? Math.max(0, opts.ttlMin) * 60000 : (typeof l.ttl_ms === 'number' ? l.ttl_ms : DEFAULT_TTL_MIN * 60000);
    const rec = { ...l, expires_at: new Date(now + ttlMs).toISOString(), ttl_ms: ttlMs };
    writeAtomic(rec);
    console.log(`HEARTBEAT ${l.account} lane="${l.lane}" extended until ${rec.expires_at}`);
    return 0;
}

function cmdRelease(account) {
    const l = read();
    if (l && account && l.account !== account) { console.error(`refusing: lock held by ${l.account}, not ${account}`); return 3; }
    try { fs.unlinkSync(LOCK); } catch {}
    console.log('RELEASED');
    return 0;
}

// ---- self-test: spawn this same script against a throwaway lock, assert behaviour ----
function selftest() {
    const tmpLock = path.join(os.tmpdir(), `heavy_lane_selftest_${process.pid}_${Date.now()}.lock`);
    const env = { ...process.env, HEAVY_LANE_LOCK: tmpLock };
    const run = (...args) => {
        const r = spawnSync(process.execPath, [THIS_FILE, ...args], { env, encoding: 'utf8' });
        return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
    };
    const clean = () => { try { fs.unlinkSync(tmpLock); } catch {} };
    const lockExpiry = () => JSON.parse(fs.readFileSync(tmpLock, 'utf8')).expires_at;
    const sleep = (ms) => { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); };
    // a pid that is guaranteed dead: spawnSync returns after the child has exited
    const deadPid = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' }).pid;

    let pass = 0, fail = 0;
    const check = (name, cond, detail = '') => {
        if (cond) { pass++; console.log(`  ok   ${name}`); }
        else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
    };

    // 1. acquire -> status HELD even though the acquirer already exited (lease-based)
    clean();
    let r = run('acquire', 'A', 'battery', '--ttl', '15');
    check('acquire A returns 0', r.code === 0, r.out);
    r = run('status');
    check('status HELD after acquirer exited', r.code === 0 && /^HELD by A/.test(r.out), r.out);

    // 2. double-acquire (different account) refused while HELD
    r = run('acquire', 'B', 'download');
    check('double-acquire B refused while HELD (exit 3)', r.code === 3 && /HELD by A/.test(r.out), r.out);

    // 3. release clears -> FREE
    r = run('release', 'A');
    check('release A returns 0', r.code === 0 && /RELEASED/.test(r.out), r.out);
    r = run('status');
    check('status FREE after release', r.code === 0 && r.out === 'FREE', r.out);

    // 4. expiry -> STALE, and a different account may then take over
    clean();
    run('acquire', 'A', 'battery', '--ttl', '0'); // 0-min lease = already expired
    sleep(20);
    r = run('status');
    check('expired lease reads STALE', /^STALE/.test(r.out) && /lease expired/.test(r.out), r.out);
    r = run('acquire', 'B', 'download');
    check('B takes over an expired lock (exit 0)', r.code === 0 && /took over stale lock/.test(r.out), r.out);

    // 5. heartbeat extends the lease
    clean();
    run('acquire', 'A', 'battery', '--ttl', '1');
    const before = Date.parse(lockExpiry());
    sleep(10);
    r = run('heartbeat', 'A', '--ttl', '15');
    const after = Date.parse(lockExpiry());
    check('heartbeat returns 0', r.code === 0 && /HEARTBEAT A/.test(r.out), r.out);
    check('heartbeat pushed expiry later', after > before, `before=${before} after=${after}`);
    r = run('heartbeat', 'B');
    check('heartbeat by wrong account refused (exit 3)', r.code === 3, r.out);
    run('release', 'A');

    // 6. --pid dead + grace elapsed -> STALE even though the lease is still valid
    clean();
    run('acquire', 'A', 'battery', '--ttl', '15', '--pid', String(deadPid), '--grace', '0');
    r = run('status');
    check('watched dead pid + grace reads STALE (lease still valid)', /^STALE/.test(r.out) && /is dead/.test(r.out), r.out);

    // 7. control: NO --pid never goes pid-stale (lease is sole authority)
    clean();
    run('acquire', 'A', 'battery', '--ttl', '15'); // no --pid; acquirer already exited
    r = run('status');
    check('no --pid never produces pid-based STALE', /^HELD by A/.test(r.out), r.out);

    clean();
    console.log(`\nselftest: ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

// ---- arg parsing: positionals + optional --pid/--ttl/--grace flags anywhere ----
const raw = process.argv.slice(2);
const positionals = [];
const flags = {};
for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--pid') flags.pid = raw[++i];
    else if (a === '--ttl') flags.ttl = raw[++i];
    else if (a === '--grace') flags.grace = raw[++i];
    else positionals.push(a);
}
const [cmd, account, lane] = positionals;
const opts = {
    pid: flags.pid != null ? parseInt(flags.pid, 10) : null,
    ttlMin: flags.ttl != null ? parseFloat(flags.ttl) : DEFAULT_TTL_MIN,
    ttlProvided: flags.ttl != null,
    graceMs: (flags.grace != null ? parseFloat(flags.grace) : DEFAULT_GRACE_SEC) * 1000,
};

let exitCode;
switch (cmd) {
    case 'status': exitCode = cmdStatus(); break;
    case 'acquire': exitCode = cmdAcquire(account, lane, opts); break;
    case 'heartbeat': exitCode = cmdHeartbeat(account, opts); break;
    case 'release': exitCode = cmdRelease(account); break;
    case 'selftest': exitCode = selftest(); break;
    default:
        console.error('commands: status | acquire <account> <lane> [--ttl <min>] [--pid <n>] [--grace <sec>] | heartbeat <account> [--ttl <min>] | release <account> | selftest');
        exitCode = 2;
}
process.exit(exitCode);
