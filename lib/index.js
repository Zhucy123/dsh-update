/**
 * dsh-update — host half (Node).
 *
 * Provides three exact /api routes for the browser half:
 *   GET  /api/dsh-update/status — compare the local deepseek-harness checkout
 *         against the origin's dsh-v* tags (read-only: `git ls-remote`).
 *   GET  /api/dsh-update/release-notes?tag=… — release body for a dsh-v* tag
 *         from the GitHub Releases API (direct first, mirror fallback).
 *   POST /api/dsh-update/run    — when a newer tag exists: `git fetch --tags`,
 *         `git checkout <newer-tag>`, `pnpm install`, `pnpm run clean`, then
 *         `pnpm run build`, streaming progress as JSON-lines over a text/plain
 *         response. Clean runs before build to purge stale gitignored lib/
 *         output left over from the previous version (see runUpdateStreaming).
 *   POST /api/dsh-update/restart — relaunch this exact dsh invocation after a
 *         detached handoff (mechanism borrowed from dsh-market): a detached
 *         helper waits for the serving port to be released, starts the
 *         replacement, and this process exits. Strict loopback + origin guard;
 *         disabled under a detected supervisor or config.allowRestart: false.
 *
 * Both are loopback-only control surfaces (mirroring the remote-web-ui update
 * fence): a LAN/phone origin must never trigger a real install on this
 * machine.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Stable cordis plugin name (also the browser bundle id). */
export const name = 'dsh-update'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** Route paths (exact matches under /api). */
export const UPDATE_PATHS = {
  status: '/api/dsh-update/status',
  run: '/api/dsh-update/run',
  notes: '/api/dsh-update/release-notes',
  restart: '/api/dsh-update/restart',
}

/** Prefix of the version tags the harness publishes (e.g. dsh-v0.1.0-rc.7). */
const TAG_PREFIX = 'dsh-v'

/** Hard cap on pnpm output streamed in one run (guards a runaway install). */
const RUN_TIMEOUT_MS = 20 * 60_000

/** Timeout for one git command (a hung `git fetch` must not block the run forever). */
const GIT_TIMEOUT_MS = 5 * 60_000

/** Timeout for one `git ls-remote` (status poll). */
const REMOTE_LS_TIMEOUT_MS = 30_000

/** How long a DIRECT GitHub call may take before we fall back to the mirror.
 *  When GitHub is reachable it answers in ~1-2s; if it needs longer it is
 *  effectively unusable, so switch to the proxy instead of making the user
 *  wait out the full timeout. */
const DIRECT_GIT_TIMEOUT_MS = 8_000

/** Direct fetch gets a shorter budget than the proxy so a hung direct
 *  connection falls back to the mirror within a reasonable time. */
const DIRECT_FETCH_TIMEOUT_MS = 90_000

/** GitHub mirror prefix used when direct access fails (gh-proxy.com style:
 *  prefix + the full https://github.com/owner/repo.git URL). Override with
 *  config.gitProxy or the DSH_UPDATE_GIT_PROXY env var; an empty string
 *  disables the fallback. */
const DEFAULT_GIT_PROXY = 'https://gh-proxy.com/'

/** How long to keep the last successful remote-tag lookup (the origin can be
 *  slow; without this every status poll blocks on `git ls-remote` for up to
 *  REMOTE_LS_TIMEOUT_MS). Errors are never cached, so a recovered network is
 *  picked up on the next check. */
const REMOTE_TAG_TTL_MS = 60_000

let remoteTagCache = { at: 0, value: undefined }

/** Release-note bodies are immutable, so successful lookups are cached long;
 *  rate-limit/outage failures are cached briefly so the panel does not hammer
 *  the API on every open. */
const RELEASE_NOTES_CACHE_MS = 60 * 60_000
const RELEASE_NOTES_ERROR_CACHE_MS = 5 * 60_000
const releaseNotesCache = new Map() // tag -> { at, error, value }

/** Effective GitHub mirror prefix; set once at apply() time. */
let gitProxy = DEFAULT_GIT_PROXY

function resolveGitProxy(config) {
  if (config && typeof config.gitProxy === 'string') return config.gitProxy
  if (process.env.DSH_UPDATE_GIT_PROXY !== undefined) return process.env.DSH_UPDATE_GIT_PROXY
  return DEFAULT_GIT_PROXY
}

/** In-flight guard: at most one update run may execute at a time (double
 *  clicks / two tabs must not start concurrent checkouts + builds). */
let activeRun = false

/** True while the Windows detached handoff is winding this process down: the
 *  host is still alive (it exits ~4s after answering) but the update has
 *  already been handed to the background helper. Without this flag the
 *  window is unprotected — `endRun()` clears activeRun, so another tab could
 *  start a second /run or /restart and fight the helper over the same
 *  checkout / port. */
let handingOff = false

/** Whether any update work is still in flight in this process (a live run or
 *  a pending detached handoff) — used by the concurrency guards. */
function updateInFlight() {
  return activeRun || handingOff
}

// ---------------------------------------------------------------------------
// Self-restart (mechanism borrowed from dsh-market's src/restart.ts):
// relaunch the exact dsh invocation that booted this host via a DETACHED
// helper that survives us, waits for the listening port to be released, then
// starts the replacement and logs a diagnosis if it does not come up.
// ---------------------------------------------------------------------------

/** The real Node executable (Android-safe argv0 preference), for spawning. */
function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/** Whether a bare `dsh` name must go through a shell (Windows .cmd shim). */
const winCmdShim = process.platform === 'win32'

/** The exact boot invocation the detached restart helper replays. */
function restartLaunch() {
  const entry = process.argv[1]
  if (entry !== undefined && entry !== '') {
    // Absolute paths are required: source launches pass a relative entry,
    // which the child resolves against its OWN cwd and dies with
    // MODULE_NOT_FOUND. cwd near the entry keeps execArgv imports (tsx/esm)
    // resolvable on source launches.
    // Launching node + the very same entry (with execArgv/args/cwd) is the most
    // faithful restart and does NOT depend on `dsh` being on PATH — important on
    // macOS/Linux where the bin often lives inside node_modules and is only
    // reachable through pnpm/npx/corepack.
    const abs = resolve(entry)
    return { file: nodeExecutable(), args: [...process.execArgv, abs, ...process.argv.slice(2)], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start.
  return { file: 'dsh', args: process.argv.slice(2), cwd: undefined, viaShell: winCmdShim }
}

/** The process supervisor running this host, when one can be identified.
 *  systemd only, and only when this process is the unit's OWN main process
 *  (ppid === 1): INVOCATION_ID alone is inherited by every descendant. */
function detectedSupervisor(env = process.env, ppid = process.ppid) {
  const set = (name) => (env[name] ?? '') !== ''
  if ((set('INVOCATION_ID') || set('JOURNAL_STREAM')) && ppid === 1) return 'systemd'
  return null
}

/** Self-restart is enabled by default, disabled by an explicit false or by a
 *  detected supervisor (which owns restarts). An explicit true wins. */
function restartAllowed(config, env = process.env, ppid = process.ppid) {
  if (config && config.allowRestart !== undefined) return !!config.allowRestart
  return detectedSupervisor(env, ppid) === null
}

/** The port this process serves, read off the request that asked to restart. */
function servingPort(request) {
  const host = request.headers.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** Whether a process-control request came directly from this host's loopback
 *  peer (stricter than isLoopbackRequest: also rejects proxied requests). */
function trustedRestartRequest(request) {
  const address = request.socket && request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Platform-correct spawn for the replacement host. On Windows the host is
 *  relaunched through PowerShell with a hidden window (so the server runs
 *  silently and its later console children do not pop their own visible
 *  windows). The replacement is NOT spawned with Node's `detached: true`:
 *  on Windows that flag sets DETACHED_PROCESS and breaks the
 *  PowerShell -> node handle inheritance, so the replacement node process
 *  never starts and the restart silently fails (Node.js issue #51018 —
 *  "spawning a pwsh child with `detached: true` does not work"). Process-group
 *  independence is already guaranteed by the caller: the helper (a detached
 *  `node -e`) owns the session, so its children live in that detached process
 *  group and survive any terminal that launched dsh being closed. This
 *  detached:false + PowerShell-Hidden combination is the one validated by
 *  dsh-market's pre-existing Windows restarts.
 *  POSIX keeps the plain detached spawn. */
function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') {
    // POSIX: Node's `detached: true` calls setsid() — the replacement becomes a
    // new session / process-group leader with no controlling terminal, so it
    // survives the helper and any terminal that launched dsh being closed, and
    // runs silently (stdio is redirected to the restart log files, never a TTY).
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true, windowsHide: false }
  }
  const quote = (part) => `'${String(part).replace(/'/g, "''")}'`
  const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file) ? `${launch.file}.cmd` : launch.file
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    // NOT detached: on Windows `detached: true` breaks the PowerShell -> node
    // handle chain (see Node.js #51018) and the replacement never starts. The
    // hidden window still keeps the server silent; process-group independence
    // is inherited from the detached helper that spawned this.
    detached: false,
    windowsHide: true,
  }
}

/** Source for the detached helper that outlives this process and brings the
 *  replacement up: wait for the port to go quiet (checked by CONNECTING, so
 *  the probe never holds the port), start the replacement, then CHECK that
 *  something came up and write a diagnosis when it did not. */
function restartHelperSource(spawned, launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const windowsHide = ${JSON.stringify(spawned.windowsHide ?? false)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-update] ${line}\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, windowsHide, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    "  if (!port) { await sleep(3000); return }",
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`the replacement did not bind port ${port} within 20s — see the output log beside this one`)',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Source for the DETACHED background-update helper (Windows only). The host
 * process hands the update off here because it CANNOT run `pnpm install`
 * in-process: the running dsh service holds Windows file locks on old
 * node_modules packages (native .node modules in particular), so pnpm's
 * prune cannot delete them and the install fails (observed as
 * `[WARN] Failed to remove ...fs-ext@2.1.1` → auto-rollback). The fix is to
 * exit the host (releasing every lock), then let this helper — which
 * outlives the host — wait for the port to go quiet and run the whole
 * install → stash-apply → clean → build → restart sequence with no lock
 * contention. Every step is logged to tmpdir/dsh-update-apply-*.log for
 * diagnosis after the page has gone blank.
 *
 * ctx: { repoDir, target, rollbackRef, stashedSomething, autoRestart, port,
 *        pm, spawnReplacement: {file,args,cwd,viaShell,detached,windowsHide},
 *        logs: {out,err} }
 */
function updateHelperSource(ctx) {
  const {
    repoDir, target, rollbackRef, stashedSomething, autoRestart, port,
    pm, spawnReplacement, logs,
  } = ctx
  return [
    "const { spawn, execFileSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const repoDir = ${JSON.stringify(repoDir)}`,
    `const target = ${JSON.stringify(target)}`,
    `const rollbackRef = ${JSON.stringify(rollbackRef ?? '')}`,
    `const stashedSomething = ${JSON.stringify(!!stashedSomething)}`,
    `const autoRestart = ${JSON.stringify(!!autoRestart)}`,
    `const port = ${JSON.stringify(port ?? null)}`,
    `const pm = ${JSON.stringify(pm)}`,
    `const file = ${JSON.stringify(spawnReplacement.file)}`,
    `const args = ${JSON.stringify(spawnReplacement.args)}`,
    `const cwd = ${JSON.stringify(spawnReplacement.cwd)}`,
    `const viaShell = ${JSON.stringify(spawnReplacement.viaShell)}`,
    `const detached = ${JSON.stringify(spawnReplacement.detached)}`,
    `const windowsHide = ${JSON.stringify(spawnReplacement.windowsHide ?? false)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    // 固定 git 输出语言为英文（冲突/空 stash 判定依赖英文 marker），
    // 与 host 端 GIT_ENV 保持一致；镜像/凭据交互一律不弹窗。
    'const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" }',
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-update] ${line}\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    // One-shot command runner: kills a hung command after opts.timeoutMs,
    // resolves { code, err }; code -1 means it could not even start.
    'const run = (label, cmd, args, opts) => new Promise((resolve) => {',
    '  let child',
    '  try {',
    '    child = spawn(cmd, args, { ...opts })',
    '  } catch (error) {',
    '    note(`${label} could not start: ${error && error.message ? error.message : error}`)',
    '    resolve({ code: -1, err: "" })',
    '    return',
    '  }',
    '  let errText = ""',
    '  const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, opts.timeoutMs)',
    '  child.stdout.on("data", () => {})',
    '  child.stderr.on("data", (d) => { errText += String(d) })',
    '  child.on("error", (error) => { clearTimeout(timer); note(`${label} spawn error: ${error && error.message ? error.message : error}`); resolve({ code: -1, err: errText }) })',
    '  child.on("close", (code) => { clearTimeout(timer); note(`${label} -> exit ${String(code)}`); resolve({ code, err: errText }) })',
    '})',
    'const runGit = (label, args) => run(label, "git", ["-C", repoDir, ...args], { env: gitEnv, timeoutMs: 5 * 60_000 })',
    'const runPnpm = (label, args, timeoutMs) => run(label, pm.cmd, [...pm.args, ...args], { cwd: repoDir, shell: true, env: process.env, timeoutMs: timeoutMs || 20 * 60_000 })',
    // 失败不自伤：install/build 失败时把 checkout 回滚到更新前版本。
    // 用户改动始终安全保存在 git stash 中（本脚本失败时不 drop）。
    'const rollback = async (reason) => {',
    '  note(reason)',
    '  if (rollbackRef !== "") {',
    '    const r = await runGit("rollback checkout", ["checkout", rollbackRef])',
    '    note(r.code === 0 ? `rolled back to ${rollbackRef} — run pnpm install there before starting dsh` : `rollback checkout failed: ${r.err}`)',
    '  }',
    '}',
    'const main = async () => {',
    '  note(`update helper started (target ${target})`)',
    '  if (port) {',
    '    const until = Date.now() + 60_000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) { note(`port ${port} still in use after 60s — aborting`); process.exit(1) }',
    '    note("port released — running install/build with no server locks")',
    '  }',
    '  let r = await runPnpm("pnpm install", ["install"])',
    '  if (r.code !== 0) { await rollback(`pnpm install failed${r.err !== "" ? ": " + String(r.err).slice(0, 800) : ""}`); process.exit(1) }',
    '  if (stashedSomething) {',
    '    r = await runGit("stash apply", ["stash", "apply"])',
    '    if (r.code === 0) {',
    '      const d = await runGit("stash drop", ["stash", "drop"])',
    '      if (d.code !== 0) note("stash drop failed — entry kept (harmless, drop manually later)")',
    '      note("local changes restored onto the new version")',
    '    } else {',
    '      note("stash apply conflicted — entry kept (data safe); resetting conflicted tree")',
    '      await runGit("clean conflicted tree", ["checkout", "--", "."])',
    '    }',
    '  }',
    '  r = await runPnpm("pnpm run clean", ["run", "clean"])',
    '  if (r.code !== 0) note("pnpm run clean failed (warning only, build exit is final): " + String(r.err).slice(0, 400))',
    '  r = await runPnpm("pnpm run build", ["run", "build"], 30 * 60_000)',
    '  if (r.code !== 0) { await rollback(`pnpm run build failed${r.err !== "" ? ": " + String(r.err).slice(0, 800) : ""}`); process.exit(1) }',
    '  try {',
    '    const v = execFileSync("git", ["-C", repoDir, "describe", "--tags", "--always"], { encoding: "utf8", env: gitEnv }).trim()',
    '    note(`update applied — verified ${v}`)',
    '  } catch {}',
    '  if (!autoRestart) { note("update complete — auto-restart disabled, start dsh web manually"); return }',
    '  note("starting replacement dsh …")',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, windowsHide, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    '  if (port) {',
    '    const upBy = Date.now() + 20_000',
    '    while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '    if (!(await listening())) note(`the replacement did not bind port ${port} within 20s — see the output log beside this one`)',
    '  }',
    '}',
    'main().catch((error) => { note("fatal: " + (error && error.message ? error.message : String(error))); process.exit(1) })',
  ].join('\n')
}

/**
 * Windows-only update handoff: spawn the detached background-update helper
 * (see updateHelperSource) and return its identity + log paths. The caller is
 * expected to end the HTTP response, then exit this process shortly after so
 * the node_modules file locks are released; the helper detects the port going
 * quiet and takes over. Mirrors scheduleRestart's detached+unref mechanics.
 */
function scheduleDetachedUpdate(opts) {
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-update-apply-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-update-apply-${stamp}.err.log`)
  const helper = spawn(nodeExecutable(), ['-e', updateHelperSource({
    repoDir: opts.repoDir,
    target: opts.target,
    rollbackRef: opts.rollbackRef ?? '',
    stashedSomething: !!opts.stashedSomething,
    autoRestart: !!opts.autoRestart,
    port: opts.port ?? null,
    pm: pnpmCommand(),
    spawnReplacement: {
      file: spawned.file,
      args: spawned.args,
      cwd: launch.cwd,
      viaShell: spawned.viaShell,
      detached: spawned.detached,
      windowsHide: spawned.windowsHide ?? false,
    },
    logs: { out: logOut, err: logErr },
  })], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/** One-shot restart latch: a manual "Restart DSH" click or the automatic
 *  post-update restart must never double-schedule helpers — two helpers would
 *  both respawn dsh and fight over the port. */
let restartScheduled = false
/** Pending automatic restart timer (armed after a successful update). */
let autoRestartTimer = null

/** Delay between "update complete" and the automatic restart. Kept short
 *  (~2s) so the user sees the success card + 「即将自动重启 dsh」for a moment,
 *  then the page disconnects and the restart happens. */
const AUTO_RESTART_DELAY_MS = 2_000

/** Relaunch this exact dsh entry after a detached handoff, then stop this
 *  process. The helper outlives us (detached + unref), waits for our port to
 *  be released before starting the replacement, and logs under tmpdir.
 *  Returns null when a restart is already scheduled (manual click or pending
 *  automatic restart). */
function scheduleRestart(port = null) {
  if (restartScheduled) return null
  restartScheduled = true
  if (autoRestartTimer !== null) {
    clearTimeout(autoRestartTimer)
    autoRestartTimer = null
  }
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-update-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-update-restart-${stamp}.err.log`)
  try {
    const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    helper.unref()
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
    return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
  } catch (error) {
    // helper 拉起失败(如 EMFILE 等瞬时资源不足):必须解除 latch 并重新抛出,
    // 否则 restartScheduled 永远为 true——后续所有手动/自动重启都会被静默吞掉
    // (返回 null 只应答 already:true,但实际什么都不会发生),重启能力永久失效。
    restartScheduled = false
    throw error
  }
}

/** Plan an automatic restart after a successful update (server-driven, so it
 *  still happens even if the browser page has already gone blank). A manual
 *  restart cancels the pending timer and restarts immediately. */
function scheduleAutoRestart(port) {
  if (restartScheduled || autoRestartTimer !== null) return
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null
    try { scheduleRestart(port) } catch { /* helper spawn failed — nothing to do */ }
  }, AUTO_RESTART_DELAY_MS)
}

/** Walk up from `start` until a directory containing `.git` is found.
 *  Returns that repository root, or undefined when no ancestor is a git
 *  checkout. `.git` may be a directory (normal checkout) or a file (worktree /
 *  submodule), so existsSync is the right check. */
function findRepoRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Default repo: the harness checkout that contains the process working
 *  directory. `dsh web` is frequently launched from a subdirectory (e.g.
 *  apps/cli/src) rather than the repository root, so walk up from cwd instead
 *  of trusting it. An explicit DSH_UPDATE_REPO_DIR always wins. */
function defaultRepoDir() {
  const explicit = process.env.DSH_UPDATE_REPO_DIR
  if (explicit !== undefined && explicit !== '') return explicit
  return findRepoRoot(process.cwd()) ?? process.cwd()
}

/** Resolve the configured repo directory (config.repoDir wins over the env/cwd default). */
function resolveRepoDir(config) {
  return config?.repoDir ?? defaultRepoDir()
}

/** Environment for every git invocation: never prompt interactively for
 *  credentials (an updater must fail fast instead of hanging on a TTY prompt).
 *  Stored credential helpers still work; only interactive prompts are off.
 *  (Note: this alone does NOT stop Windows Git Credential Manager from
 *  popping a GUI login dialog when a remote answers 401 — mirror remotes
 *  additionally get `-c credential.helper=` so they fail fast instead.) */
const GIT_ENV = {
  ...(typeof process === 'object' ? process.env : {}),
  GIT_TERMINAL_PROMPT: '0',
  // 固定 git 输出语言为英文：冲突检测 / 空 stash 判定依赖英文 marker，
  // 非英文 locale（如 zh_CN）下 git 会把提示本地化导致解析失败。
  LC_ALL: 'C',
  LANG: 'C',
}

/** Run a git command synchronously, returning trimmed stdout (throws on failure).
 *  30s timeout guards against a hung git (e.g. a stuck rollback checkout) — an
 *  updater must fail fast, never block the host event loop forever. */
function gitSync(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENV,
    timeout: 30_000,
  }).trim()
}

/** Package-manager invocation, resolved once per process.
 *  Windows: `pnpm` through the shell (.cmd shim).
 *  POSIX (macOS/Linux): prefer `pnpm` from PATH; fall back to `corepack pnpm`
 *  (ships with Node 16.9+) — fresh macOS/Linux installs often have only
 *  corepack, no global pnpm. */
let pnpmInvocation = null
function pnpmCommand(platform = process.platform) {
  if (pnpmInvocation !== null) return pnpmInvocation
  if (platform === 'win32') {
    pnpmInvocation = { cmd: 'pnpm', args: [] }
    return pnpmInvocation
  }
  try {
    // 探测加 10s 超时:pnpm 存在但挂死(异常 nvm/别名 shim)时不能无限阻塞事件循环;
    // 探测失败/超时都落到 corepack 兜底。
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', env: process.env, timeout: 10_000 })
    pnpmInvocation = { cmd: 'pnpm', args: [] }
  } catch {
    pnpmInvocation = { cmd: 'corepack', args: ['pnpm'] }
  }
  return pnpmInvocation
}

/**
 * Split a child-process byte stream into trimmed, non-empty lines.
 *
 * Unlike per-chunk `chunk.toString('utf8')`, this decodes with a streaming
 * TextDecoder so a multi-byte character split across two chunks (common with
 * CJK output from git/pnpm) never garbles the progress log. `\r` counts as a
 * terminator too, so pnpm/git live progress (which rewrites one line with
 * carriage returns) still streams in real time. Each complete line is
 * delivered to onLine exactly once; anything left at stream end is flushed
 * by onEnd.
 */
function createLineEmitter(onLine) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  return {
    onData(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      let match
      while ((match = /[\r\n]/.exec(buffer)) !== null) {
        const index = match.index
        const line = buffer.slice(0, index).trim()
        let skip = 1
        if (buffer[index] === '\r' && buffer[index + 1] === '\n') skip = 2
        buffer = buffer.slice(index + skip)
        if (line !== '') onLine(line)
      }
    },
    onEnd() {
      buffer += decoder.decode()
      const line = buffer.trim()
      buffer = ''
      if (line !== '') onLine(line)
    },
  }
}

/** Parse `dsh-v0.1.0-rc.7` into comparable parts (undefined when not a tag). */
function parseTag(tag) {
  if (!tag.startsWith(TAG_PREFIX)) return undefined
  const body = tag.slice(TAG_PREFIX.length)
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(body)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two dsh-v* tags; returns >0 when a > b, 0 equal, <0 when a < b.
 * Non-tag inputs sort below every tag (defensive; callers filter anyway). */
export function compareTags(a, b) {
  const pa = parseTag(a)
  const pb = parseTag(b)
  if (pa === undefined && pb === undefined) return 0
  if (pa === undefined) return -1
  if (pb === undefined) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(pa.prerelease.length, pb.prerelease.length); index++) {
    const ra = pa.prerelease[index]
    const rb = pb.prerelease[index]
    if (ra === undefined) return -1
    if (rb === undefined) return 1
    if (ra === rb) continue
    const numericA = /^\d+$/.test(ra)
    const numericB = /^\d+$/.test(rb)
    if (numericA && numericB) return Number(ra) < Number(rb) ? -1 : 1
    if (numericA) return -1
    if (numericB) return 1
    return ra < rb ? -1 : 1
  }
  return 0
}

/** The locally checked-out version: the nearest dsh-v* tag, else a commit short hash. */
function localVersion(repoDir) {
  // 取不到 commit 时保持 undefined（而非 'unknown' 字符串）：调用方会把
  // localCommit 当作失败自动回滚的 checkout 目标，'unknown' 会导致
  // `git checkout unknown` 这种必然失败的回滚。
  let commit
  try {
    commit = gitSync(repoDir, ['rev-parse', '--short', 'HEAD'])
  } catch { /* keep undefined */ }
  try {
    const describe = gitSync(repoDir, ['describe', '--tags', '--abbrev=0'])
    if (parseTag(describe) !== undefined) return { tag: describe, commit }
    return { commit }
  } catch {
    return { commit }
  }
}

/** All locally-known dsh-v* tags (fetched by prior updates), newest first.
 *  These are the rollback targets offered by the UI: after a `git fetch
 *  --tags` every published version exists locally, so `git tag -l` is a
 *  complete offline listing. */
function localTags(repoDir) {
  try {
    const output = gitSync(repoDir, ['tag', '-l', `${TAG_PREFIX}*`])
    const tags = output.split(/\r?\n/).map((s) => s.trim()).filter((t) => t !== '' && parseTag(t) !== undefined)
    tags.sort((a, b) => compareTags(b, a))
    return tags
  } catch {
    return []
  }
}

/** The configured `origin` URL of the checkout, if any. */
function originUrl(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
    }).trim()
  } catch {
    return undefined
  }
}

/** Map a github.com URL to its mirror form, e.g.
 *  https://github.com/deepseek-ai/deepseek-harness.git
 *    -> https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git
 *  Returns undefined for non-GitHub origins (local paths, Gitee, self-hosted)
 *  or when no proxy prefix is configured (empty string disables it). */
function proxyUrlFor(gitUrl, proxyPrefix) {
  if (proxyPrefix === undefined || proxyPrefix === '') return undefined
  if (typeof gitUrl !== 'string' || gitUrl === '') return undefined
  const match = /github\.com[/:]([^/\s]+?\/[^/\s]+?)(?:\.git)?$/.exec(gitUrl)
  if (match === null) return undefined
  const repo = match[1].endsWith('.git') ? match[1] : `${match[1]}.git`
  return `${proxyPrefix.replace(/\/+$/, '')}/https://github.com/${repo}`
}

/** Run `git ls-remote --tags <remote>` and return the latest dsh-v* tag.
 *  `remote` may be a configured name or a URL. Returns { tag } or { error }. */
function lsRemoteTags(repoDir, remote, timeoutMs, noAuth = false) {
  try {
    const output = execFileSync('git', ['-C', repoDir, ...(noAuth ? ['-c', 'credential.helper='] : []), 'ls-remote', '--tags', remote], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
      timeout: timeoutMs,
    })
    const tags = new Set()
    for (const line of output.split(/\r?\n/)) {
      const match = /refs\/tags\/(dsh-v[^^\s]+)(?:\^\{\})?$/.exec(line.trim())
      if (match !== null) tags.add(match[1])
    }
    let latest
    for (const tag of tags) {
      if (latest === undefined || compareTags(tag, latest) > 0) latest = tag
    }
    return latest === undefined ? {} : { tag: latest }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: /timed out|ETIMEDOUT|ETIME/i.test(message) ? '网络超时' : message }
  }
}

/** Latest dsh-v* tag reported by the origin (read-only), if reachable.
 *  Direct GitHub access is tried first with a short timeout; when it fails
 *  and the origin is a github.com URL, the configured mirror is tried as a
 *  fallback (the result is marked `via: 'proxy'` so the UI can say so).
 *  Successful results are cached for REMOTE_TAG_TTL_MS; failures never are. */
function remoteLatestTag(repoDir) {
  const now = Date.now()
  if (remoteTagCache.value !== undefined && now - remoteTagCache.at < REMOTE_TAG_TTL_MS) {
    return remoteTagCache.value
  }
  const origin = originUrl(repoDir) ?? 'origin'
  const proxy = proxyUrlFor(origin, gitProxy)
  let result = lsRemoteTags(repoDir, origin, DIRECT_GIT_TIMEOUT_MS)
  if (result.error !== undefined && proxy !== undefined) {
    const mirrored = lsRemoteTags(repoDir, proxy, REMOTE_LS_TIMEOUT_MS, true)
    if (mirrored.error === undefined) {
      result = { ...mirrored, via: 'proxy' }
    } else {
      result = { error: `直连失败：${result.error}；镜像失败：${mirrored.error}` }
    }
  }
  if (result.error === undefined) {
    remoteTagCache = { at: now, value: result }
  }
  return result
}

/** 'owner/repo' from a github.com URL, or undefined. */
function githubRepoSlug(gitUrl) {
  if (typeof gitUrl !== 'string' || gitUrl === '') return undefined
  const match = /github\.com[/:]([^/\s]+?\/[^/\s]+?)(?:\.git)?$/.exec(gitUrl)
  return match === null ? undefined : match[1].replace(/\.git$/, '')
}

/** GET a URL as JSON with a hard timeout; resolves { json } or { error }. */
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-update' },
    })
    if (!response.ok) return { error: `HTTP ${String(response.status)}` }
    return { json: await response.json() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Release notes (markdown body) for a dsh-v* tag from the GitHub Releases
 *  API. Direct access first with a short timeout, mirror fallback afterwards
 *  (same policy as the version check). Results are cached: release bodies are
 *  immutable, and rate-limit failures must not be re-hit on every open. */
async function releaseNotesFor(repoDir, tag) {
  const cached = releaseNotesCache.get(tag)
  if (cached !== undefined) {
    const fresh = cached.error === undefined
      ? Date.now() - cached.at < RELEASE_NOTES_CACHE_MS
      : Date.now() - cached.at < RELEASE_NOTES_ERROR_CACHE_MS
    if (fresh) return cached.value
  }
  const slug = githubRepoSlug(originUrl(repoDir)) ?? 'deepseek-ai/deepseek-harness'
  const apiUrl = `https://api.github.com/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`
  let got = await fetchJson(apiUrl, DIRECT_GIT_TIMEOUT_MS)
  if (got.error !== undefined && gitProxy !== '') {
    got = await fetchJson(`${gitProxy.replace(/\/+$/, '')}/${apiUrl}`, REMOTE_LS_TIMEOUT_MS)
  }
  let value
  if (got.json !== undefined && typeof got.json.body === 'string') {
    value = {
      ok: true,
      tag,
      body: got.json.body,
      htmlUrl: typeof got.json.html_url === 'string' ? got.json.html_url : undefined,
    }
  } else {
    value = { ok: false, tag, error: got.error ?? 'no release notes for this tag' }
  }
  releaseNotesCache.set(tag, { at: Date.now(), error: value.ok ? undefined : value.error, value })
  return value
}

/** Result of the most recent Windows detached update, read back from the
 *  helper's log (tmpdir/dsh-update-apply-*.err.log) so the panel can show a
 *  post-boot confirmation ("上次后台更新已完成 / 未完成") even though the
 *  page disconnected during the handoff. Returns undefined when no detached
 *  update log exists yet (POSIX never writes one). The LAST terminal line
 *  wins: `update applied — verified <tag>` → ok; a failure marker after that
 *  (rollback / abort / fatal) downgrades to failed.
 *
 * 结果按 mtime 缓存 5 秒：/status 是开面板就打的请求，不该每次全量扫描
 * tmpdir（readdirSync + 逐个 statSync）——临时目录文件多时有可感知开销。 */
const LAST_DETACHED_TTL_MS = 5_000
let lastDetachedCache = { at: 0, value: undefined }

function lastDetachedUpdate() {
  const now = Date.now()
  if (now - lastDetachedCache.at < LAST_DETACHED_TTL_MS) return lastDetachedCache.value
  const value = readLastDetachedUpdate()
  lastDetachedCache = { at: now, value }
  return value
}

function readLastDetachedUpdate() {
  let newest = null
  let newestMtime = 0
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!/^dsh-update-apply-.*\.err\.log$/.test(name)) continue
      const full = join(tmpdir(), name)
      const stat = statSync(full)
      if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = full }
    }
  } catch { return undefined }
  if (newest === null) return undefined
  let content = ''
  try { content = readFileSync(newest, 'utf8') } catch { return undefined }
  const state = { ok: false, tag: undefined }
  for (const line of content.split(/\r?\n/)) {
    const applied = /^\[dsh-update\] update applied — verified (.+)$/.exec(line)
    if (applied !== null) { state.ok = true; state.tag = applied[1].trim(); continue }
    if (/^\[dsh-update\].*(pnpm install failed|pnpm run build failed|rollback checkout failed|rolled back|still in use after 60s|aborting|fatal:)/i.test(line)) {
      state.ok = false
      state.tag = undefined
    }
  }
  return { mode: 'detached', ok: state.ok, tag: state.tag, at: new Date(newestMtime).toISOString() }
}

/** Build the status: local vs remote version comparison.
 *  `config` (optional) lets the payload advertise whether a finished update
 *  will auto-restart dsh — the UI warns the user accordingly before starting. */
export function checkStatus(repoDir, config) {
  if (!existsSync(join(repoDir, '.git'))) {
    return { ok: false, repoDir, localCommit: '', outdated: false, error: `not a git checkout: ${repoDir}` }
  }
  const local = localVersion(repoDir)
  const remote = remoteLatestTag(repoDir)
  const status = {
    ok: remote.error === undefined,
    repoDir,
    localCommit: local.commit,
    outdated: false,
    restartScript: process.env.DSH_UPDATE_RESTART_SCRIPT ?? '',
    platform: process.platform,
    autoRestart: restartAllowed(config) && (config === undefined || config.autoRestart !== false),
    // 更新将走哪条路径：客户端据此显示「页面会断开、后台完成」还是「全程显示进度」，
    // 不能仅凭 navigator.userAgent 猜（服务端配置/平台才是真相）。
    detachedUpdate: process.platform === 'win32' && config !== undefined && config.windowsDetachedUpdate === true,
    tags: localTags(repoDir),
    // 最近一次 Windows 后台分离更新的结果（页面断开后用户看不到过程，
    // 面板据此给出「上次后台更新已完成/未完成」的确认）。
    lastUpdate: lastDetachedUpdate(),
  }
  if (local.tag !== undefined) status.localTag = local.tag
  if (remote.tag !== undefined) status.remoteTag = remote.tag
  if (remote.via === 'proxy') status.remoteVia = 'proxy'
  if (remote.error !== undefined) {
    status.error = remote.error
  } else if (status.localTag !== undefined && status.remoteTag !== undefined) {
    status.outdated = compareTags(status.remoteTag, status.localTag) > 0
  } else if (status.remoteTag !== undefined) {
    // No local tag at all — any remote tag is an upgrade path.
    status.outdated = true
  }
  return status
}

/**
 * Stream one run: `git fetch --tags`, then (when a newer tag exists)
 * `git checkout <tag>` + `pnpm install`. Each progress event is a JSON line
 * written to `res` — the browser half parses the stream.
 */
/** Parse git checkout stderr for the "local changes would be overwritten" case.
 *  Returns the list of conflicting paths, or undefined when the failure is
 *  something else (network, permission, ...). */
function parseCheckoutConflict(stderr) {
  if (typeof stderr !== 'string' || stderr === '') return undefined
  const marker = /would be overwritten by checkout:/i
  if (!marker.test(stderr)) return undefined
  const files = []
  const lines = stderr.split(/\r?\n/)
  let capture = false
  for (const line of lines) {
    if (marker.test(line)) { capture = true; continue }
    if (!capture) continue
    if (line.startsWith('\t')) { files.push(line.trim()); continue }
    if (line.trim() !== '' && !line.startsWith('\t')) break
  }
  return files.length > 0 ? files : undefined
}

/**
 * Stream one run: `git fetch --tags`, then (when a newer tag exists)
 * `git checkout <tag>` + `pnpm install` + `pnpm run clean` + `pnpm run build`.
 * Each progress event is a JSON line written to `res` — the browser half
 * parses the stream.
 *
 * `pnpm run clean` runs right before the build on purpose: build output under
 * `lib/` is gitignored, so a version switch can leave stale artifacts behind
 * (e.g. from a package removed upstream) that reference exports the new
 * sources no longer provide — bundling them fails with MISSING_EXPORT. Clean
 * removes that residue; it is idempotent and quick when there is nothing to
 * remove. A clean failure is only a warning — the build's own exit code is
 * the final gate.
 *
 * options.stash — before checkout, safely stash ALL local changes
 * (`git stash push -m "dsh-update: …"`); after install, `git stash apply`
 * and, when it succeeds, `git stash drop` — so local patches are rebuilt into
 * the new bundle. When the new release changed the same files, apply fails and
 * the stash entry is KEPT (never dropped, never lost); the working tree is
 * reset to the pristine checkout so the build still succeeds, and the result
 * `done` event carries stashApplied / stashKept so the UI can explain.
 * A checkout failure caused by local changes is surfaced as a `conflict`
 * event (with the conflicting file list) instead of a generic error.
 */
export function runUpdateStreaming(repoDir, res, options = {}) {
  // Reject a second run while one is already executing (double click / two
  // tabs must not start concurrent checkouts + builds).
  if (updateInFlight()) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, code: 'run-in-progress', message: '已有更新正在执行中，请等待其完成后再试。' }))
    return
  }
  activeRun = true
  handingOff = false
  const autoStash = !!(options && options.stash)
  let stashedSomething = false
  let stashApplied = false
  let stashKept = false
  let settled = false
  let checkedOut = false   // 已切到目标版本（此后失败需自动回滚）
  let rolledBack = false   // 是否已自动回滚
  let from = undefined     // 更新/回退前的版本（失败自动回滚目标）；checkStatus 后赋值
  const write = (payload) => {
    if (settled) return
    try {
      res.write(`${JSON.stringify(payload)}\n`)
    } catch { /* 响应已关闭/浏览器断开：忽略，不再写入 */ }
  }
  const fail = (error) => {
    if (settled) return
    activeRun = false
    // 第一性原理「失败不自伤」：已切到新版本但后续步骤（install/build）失败时，
    // 自动回滚到更新/回退前的版本，避免工作树与产物停留在半更新状态。
    // 回滚目标优先用原 tag（from）；本地不在 tag 上时退回原 commit。
    let finalError = error
    const rollbackRef = from ?? status.localCommit
    if (checkedOut && rollbackRef !== undefined && rollbackRef !== target) {
      try {
        gitSync(repoDir, ['checkout', rollbackRef])
        rolledBack = true
        finalError = `${error}（已自动回滚到 ${rollbackRef}）`
      } catch (rollbackError) {
        const msg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        finalError = `${error}（自动回滚到 ${rollbackRef} 失败：${msg}——请手动执行 git checkout ${rollbackRef} 恢复）`
      }
    }
    write({ type: 'done', ok: false, error: finalError, rolledBack })
    settled = true
    res.end()
  }
  const endRun = (payload) => {
    if (settled) return
    activeRun = false
    write(payload)
    settled = true
    res.end()
  }

  res.writeHead(200, {
    // text/event-stream is exempt from the DSH webserver's gzip middleware
    // (compression would buffer small streamed writes and the browser would
    // see zero progress until the whole run finished). no-transform is a
    // second belt-and-suspenders signal to any compression proxy.
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  // 浏览器可能在构建中途关闭页面 / F5（页面变空白 = 连接断开）。
  // 若不监听 error，断开后的 res.write 可能抛出未捕获异常导致 host 崩溃。
  res.on('error', () => { /* 连接已断开，忽略 */ })
  // Send something immediately so the panel shows activity even while the
  // (synchronous) initial version check is talking to a slow remote.
  write({ type: 'step', text: '正在检查版本并准备更新…' })

  const status = checkStatus(repoDir)
  if (!status.ok) {
    fail(status.error ?? 'unknown failure')
    return
  }
  // 回退模式：用户显式要求切到某个（通常是更旧的）tag；跳过「已是最新」的提前返回。
  const isRollback = !!(options && options.targetTag)
  from = status.localTag // 更新/回退前的版本，用于失败自动回滚
  if (!isRollback && !status.outdated) {
    endRun({ type: 'done', ok: true, skipped: true, from: status.localTag, to: status.remoteTag })
    return
  }
  const target = isRollback ? options.targetTag : status.remoteTag
  if (target === undefined) {
    fail(isRollback ? `未找到版本 ${String(options.targetTag)}` : 'no newer dsh-v* tag found on the origin')
    return
  }
  // 回退目标必须是 dsh-v* 发布 tag：拒绝任意 ref（分支/commit/其他 tag），
  // 防止（本机 loopback 上的）异常调用把 checkout 引向任意引用。
  if (isRollback && parseTag(target) === undefined) {
    fail(`回退目标必须是 dsh-v* 发布版本，拒绝：${target}`)
    return
  }

  // 从一开始就提醒：构建阶段会替换网页资源文件，页面可能突然整个变空白——页面变空白基本意味着已完成。
  write({ type: 'notice', text: isRollback
    ? `回退开始：将把 deepseek-harness 回退到 ${target}。构建阶段会替换网页资源文件，整个页面可能突然变成空白——属正常现象；回退成功后会自动重启 dsh，页面恢复后请刷新网页。`
    : '更新开始：构建阶段会替换网页资源文件，整个页面可能突然变成空白——页面变空白基本意味着更新已完成，只差重启生效；请按 F5 刷新页面，然后建议手动重启 dsh 服务。如果页面始终没有变空白，会正常显示「更新完成」，同样建议手动重启。' })

  // Generic git runner: streams both pipes as `line` events; delivers
  // (exitCode, stderrText) to onDone. stderr is accumulated verbatim so we can
  // detect checkout conflicts and stash outcomes. A hung command is killed
  // after timeoutMs (default GIT_TIMEOUT_MS) instead of blocking forever.
  const runGit = (label, args, onDone, timeoutMs = GIT_TIMEOUT_MS) => {
    write({ type: 'step', text: label })
    let proc
    try {
      proc = spawn('git', ['-C', repoDir, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: GIT_ENV,
      })
    } catch (error) {
      // 同步 spawn 失败（极少见）：快速失败，不挂到超时。
      onDone(-1, error instanceof Error ? error.message : String(error))
      return
    }
    let procError = ''
    let stderrBuf = ''
    let delivered = false
    const deliver = (code, err) => {
      if (delivered) return
      delivered = true
      onDone(code, err)
    }
    const stdoutLines = createLineEmitter((text) => write({ type: 'line', text }))
    const stderrLines = createLineEmitter((text) => write({ type: 'line', text }))
    const killTimer = setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGTERM') } catch {}
        // SIGTERM 可能被忽略（挂死进程），3 秒后 SIGKILL 兜底，避免残留。
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
        fail(label + ' timed out')
      }
    }, timeoutMs)
    proc.stdout?.on('data', (chunk) => { stdoutLines.onData(chunk) })
    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8')
      stderrLines.onData(chunk)
    })
    proc.on('error', (error) => {
      // git 不存在 / 不在 PATH 时 spawn 异步失败（macOS/Linux 常见：未装 git）。
      // close 可能不再触发——立即以明确错误结束，避免挂到超时。
      procError = error.message
      clearTimeout(killTimer)
      if (!settled) deliver(-1, `git 无法启动：${procError}`)
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      stdoutLines.onEnd()
      stderrLines.onEnd()
      if (settled || delivered) return
      deliver(code, procError !== '' ? procError : stderrBuf.trim())
    })
  }

  const runCommand = (label, args, onDone) => {
    write({ type: 'step', text: label })
    const pm = pnpmCommand()
    let proc
    try {
      proc = spawn(pm.cmd, [...pm.args, ...args], {
        cwd: repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
    } catch (error) {
      onDone(-1, error instanceof Error ? error.message : String(error))
      return
    }
    let procError = ''
    let delivered = false
    const deliver = (code, err) => {
      if (delivered) return
      delivered = true
      onDone(code, err)
    }
    const killTimer = setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGTERM') } catch {}
        // SIGTERM 可能被忽略（挂死进程），3 秒后 SIGKILL 兜底，避免残留。
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
        fail(label + ' timed out')
      }
    }, RUN_TIMEOUT_MS)
    const stdoutLines = createLineEmitter((text) => write({ type: 'line', text }))
    const stderrLines = createLineEmitter((text) => write({ type: 'line', text }))
    proc.stdout?.on('data', (chunk) => { stdoutLines.onData(chunk) })
    proc.stderr?.on('data', (chunk) => { stderrLines.onData(chunk) })
    proc.on('error', (error) => {
      // pnpm / corepack 不存在或不在 PATH（macOS/Linux 常见）：立即失败，
      // 避免挂到 20 分钟超时。
      procError = error.message
      clearTimeout(killTimer)
      if (!settled) deliver(-1, `pnpm 无法启动：${procError}`)
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      stdoutLines.onEnd()
      stderrLines.onEnd()
      if (settled || delivered) return
      deliver(code, procError)
    })
  }

  const build = () => {
    // 构建是页面变空白高发阶段：替换网页 bundle 时页面可能突然整页变空白/长时间无输出。
    write({ type: 'notice', text: isRollback
      ? `即将执行 pnpm run build（回退到 ${target}，替换网页资源文件）：此时整个页面可能突然变成空白或长时间无输出，属正常现象，回退成功后会自动重启 dsh——页面恢复后请刷新网页。`
      : '即将执行 pnpm run build（替换网页资源文件）：此时整个页面可能突然变成空白或长时间无输出，属正常现象，页面变空白基本意味着更新已完成——请按 F5 刷新页面，并建议手动重启 dsh 服务。' })
    runCommand('Running pnpm run build …', ['run', 'build'], (code2, err2) => {
      if (settled) return
      if (code2 !== 0 || err2 !== '') {
        fail(err2 !== '' ? `pnpm run build failed: ${err2}` : `pnpm run build failed (exit ${String(code2)})`)
        return
      }
      // Verify the checkout post-build: report the tag/commit the update
      // actually landed on, so the panel can show a confirmed final version
      // instead of only the pre-update snapshot.
      const verified = localVersion(repoDir)
      const done = { type: 'done', ok: true, from: status.localTag, to: target }
      if (isRollback) done.rollback = true
      if (verified.tag !== undefined) done.verifiedTag = verified.tag
      if (verified.commit !== undefined) done.verifiedCommit = verified.commit
      if (stashApplied) done.stashApplied = true
      if (stashKept) done.stashKept = true
      if (options.autoRestart) {
        // 更新成功 → 自动重启：done 事件带标记让客户端展示「即将自动重启」，
        // 真正的重启由服务端定时器驱动——即使页面已经变白/断开也会发生，
        // 用户只需在页面恢复后刷新一次。
        done.autoRestart = true
        done.restartInMs = AUTO_RESTART_DELAY_MS
        endRun(done)
        scheduleAutoRestart(options.port ?? null)
      } else {
        endRun(done)
      }
    })
  }

  // 版本切换后，旧版本残留的 lib/ 构建产物（.gitignore 忽略、git checkout 不会清除）
  // 可能引用新源码中已不存在/已改名的导出，直接 pnpm run build 会报 MISSING_EXPORT。
  // 因此构建前先执行 pnpm run clean（幂等：无残留时秒退），把过期产物清掉再构建。
  // clean 本身失败时仅警告并继续尝试构建——build 的退出码才是最终判定。
  const cleanThenBuild = () => {
    runCommand('Running pnpm run clean (stale build output) …', ['run', 'clean'], (ccode, cerr) => {
      if (settled) return
      if (ccode !== 0) {
        write({ type: 'notice', text: `pnpm run clean 未完全成功（${cerr !== '' ? cerr : 'exit ' + String(ccode)}），将继续尝试构建；若构建仍失败，请手动执行 pnpm run clean 后重试。` })
      }
      build()
    })
  }

  const installThenBuild = () => {
    runCommand('Running pnpm install …', ['install'], (code, err) => {
      if (settled) return
      if (code !== 0 || err !== '') {
        fail(err !== '' ? `pnpm install failed: ${err}` : `pnpm install failed (exit ${String(code)})`)
        return
      }
      if (autoStash && stashedSomething) {
        // Restore the user's local changes BEFORE build so the rebuilt bundle
        // still contains their patches when the new release didn't touch them.
        runGit('Restoring your local changes (git stash apply) …', ['stash', 'apply'], (acode, aerr) => {
          if (settled) return
          if (acode !== 0) {
            // New release changed the same files → keep the stash entry (data is
            // never lost), reset the tree to the pristine checkout, build clean.
            write({ type: 'notice', text: '本地修改与新版本存在冲突，未能自动恢复；改动仍安全保存在 git stash 中（未丢失），本次将构建全新版本。更新后可在仓库目录手动执行 git stash apply 处理。' })
            stashKept = true
            runGit('Cleaning conflicted working tree …', ['checkout', '--', '.'], (ccode2, cerr2) => {
              if (settled) return
              if (ccode2 !== 0) {
                write({ type: 'notice', text: `清理冲突工作树未完全成功（${cerr2 !== '' ? cerr2 : 'exit ' + String(ccode2)}），将继续尝试构建；若构建失败，请手动执行 git checkout -- . 处理后再重试。` })
              }
              cleanThenBuild()
            })
            return
          }
          stashApplied = true
          runGit('Removing applied stash entry …', ['stash', 'drop'], (dc, derr) => {
            if (settled) return
            if (dc !== 0) {
              write({ type: 'notice', text: `git stash drop 未成功（${derr !== '' ? derr : 'exit ' + String(dc)}）——stash 条目仍在，不影响本次更新，可稍后手动 git stash drop 清理。` })
            }
            cleanThenBuild()
          })
        })
      } else {
        cleanThenBuild()
      }
    })
  }

  const checkout = () => {
    runGit(`Checking out ${target} …`, ['checkout', target], (ccode, cerr) => {
      if (settled) return
      if (ccode !== 0) {
        const files = parseCheckoutConflict(cerr)
        if (files !== undefined) {
          endRun({ type: 'conflict', files, from: status.localTag, to: target, detail: cerr, autoStash })
          return
        }
        fail(cerr !== '' ? `git checkout failed: ${cerr}` : `git checkout failed (exit ${String(ccode)})`)
        return
      }
      checkedOut = true // 已切到目标版本：后续 install/build 失败将自动回滚
      // Windows：install/build 必须在运行中的服务退出后执行——运行中的 dsh 占用
      // node_modules 文件句柄，进程内 pnpm install 删不掉被锁旧包必然失败
      // （曾报 [WARN] Failed to remove ...fs-ext@2.1.1 → 自动回滚）。
      // git 步骤（fetch/stash/checkout）不动 node_modules，可留在进程内完成；
      // 之后的 install/build 移交 detached 后台进程（config.windowsDetachedUpdate
      // 可设 false 强制走旧的进程内路径）。
      if (process.platform === 'win32' && options.windowsDetachedUpdate !== false) {
        handOffToUpdate()
      } else {
        installThenBuild()
      }
    })
  }

  // Windows 后台分离更新：把 install/stash-apply/clean/build/重启 移交 detached
  // helper（本进程退出以释放 node_modules 文件锁，helper 等端口释放后接管）。
  // 本函数只负责交接：写提示 → 调度 helper → 应答 done(detached) → 安排本进程退出。
  const handOffToUpdate = () => {
    write({ type: 'step', text: 'Handing off to a detached background update process …' })
    write({ type: 'notice', text: options.autoRestart
      ? 'Windows 后台分离更新：运行中的 dsh 服务占用 node_modules 文件句柄，进程内 install 无法删除被锁旧包（这正是此前更新失败回滚的原因）。安装与构建已移交独立后台进程——本进程即将退出释放句柄，全部完成后会自动重启 dsh。页面断开属正常现象，请勿关闭本窗口，稍后刷新网页即可。'
      : 'Windows 后台分离更新：运行中的 dsh 服务占用 node_modules 文件句柄，进程内 install 无法删除被锁旧包（这正是此前更新失败回滚的原因）。安装与构建已移交独立后台进程——本进程即将退出释放句柄；本次未配置自动重启，完成后请手动启动 dsh 服务。页面断开属正常现象。' })
    let handoff
    try {
      handoff = scheduleDetachedUpdate({
        repoDir,
        target,
        rollbackRef: from ?? status.localCommit ?? '',
        stashedSomething,
        autoRestart: !!options.autoRestart,
        port: options.port ?? null,
      })
    } catch (error) {
      fail(`无法启动后台更新进程：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const done = { type: 'done', ok: true, detached: true, from: status.localTag, to: target, logErr: handoff.logErr }
    if (isRollback) done.rollback = true
    // 交接完成即置位：endRun() 会清掉 activeRun，但本进程还要活 4 秒，
    // 这 4 秒里 /run 必须继续返回 409（updateInFlight 覆盖 handingOff）。
    handingOff = true
    endRun(done)
    // 等响应冲刷完成、并给用户几秒读完「已转入后台」卡片，再退出本进程释放
    // 所有 node_modules 文件句柄；helper 检测到端口释放后开始 install/build。
    setTimeout(() => { try { process.kill(process.pid, 'SIGTERM') } catch {} }, 4000)
  }

  // 1. git fetch --tags (keeps local tags in sync with the origin).
  // 直连 GitHub 优先（短超时），失败且 origin 是 github.com 时自动改用
  // gh-proxy.com 镜像重试；镜像地址只用于本次 fetch，不改动仓库配置。
  // 成败只看退出码：git fetch 成功时也会把 "From <url>"、ref 更新等进度
  // 信息写到 stderr（stdout 反而是空的）。若把「stderr 非空」当失败，每次
  // 成功的直连/镜像 fetch 都会被误判为失败并一路 fallback/中止。
  const origin = originUrl(repoDir) ?? 'origin'
  const proxy = proxyUrlFor(origin, gitProxy)
  const proceedAfterVerify = () => {
    if (settled) return
    if (autoStash) {
      // 1.5. Safely park ALL local changes so the checkout can never be blocked
      // by "would be overwritten" errors. `-u` 额外纳入未跟踪文件:若不加 `-u`,
      // 新版本新增/占用某个路径、而本地恰好有同路径未跟踪文件时,checkout 会持续
      // 报 "untracked working tree files would be overwritten"——而 stash 又不含未跟踪
      // 文件,「自动暂存并继续更新」会陷入死循环(每次点击都再次冲突)。`-u` 一并暂存
      // 未跟踪文件,更新成功后经 stash apply 原样恢复;gitignore 文件不受影响。
      runGit('Stashing local changes (safe & recoverable) …', ['stash', 'push', '-u', '-m', `dsh-update: pre-update ${target}`], (scode, serr) => {
        if (settled) return
        const nothingToStash = /no local changes to save/i.test(serr || '')
        if (scode !== 0 && !nothingToStash) {
          fail(serr !== '' ? `git stash failed: ${serr}` : `git stash failed (exit ${String(scode)})`)
          return
        }
        stashedSomething = !nothingToStash
        checkout()
      })
    } else {
      checkout()
    }
  }
  const afterFetch = () => {
    if (settled) return
    if (isRollback) {
      // 回退目标必须真的存在：本地 tag 列表来自历史 fetch，拉取后仍校验一次，
      // 给出明确错误而非 checkout 的“unknown revision”。
      runGit(`Verifying tag ${target} …`, ['rev-parse', '--verify', `${target}^{commit}`], (vcode) => {
        if (settled) return
        if (vcode !== 0) {
          fail(`未找到版本 ${target}（本地与远程均无此 tag）`)
          return
        }
        proceedAfterVerify()
      })
    } else {
      proceedAfterVerify()
    }
  }
  runGit(`Fetching tags from origin … (target ${target})`, ['fetch', '--tags', origin], (code, err) => {
    if (settled) return
    if (code !== 0) {
      if (proxy !== undefined) {
        write({ type: 'notice', text: 'GitHub 直连失败，正在通过 gh-proxy.com 镜像重试 …' })
        runGit(`Fetching tags via mirror … (target ${target})`, ['-c', 'credential.helper=', 'fetch', '--tags', proxy], (pcode, perr) => {
          if (settled) return
          if (pcode !== 0) {
            fail(perr !== '' ? `git fetch failed（直连与镜像均失败）: ${perr}` : `git fetch failed（直连与镜像均失败，exit ${String(pcode)}）`)
            return
          }
          afterFetch()
        }, GIT_TIMEOUT_MS)
        return
      }
      fail(err !== '' ? `git fetch failed: ${err}` : `git fetch failed (exit ${String(code)})`)
      return
    }
    afterFetch()
  }, DIRECT_FETCH_TIMEOUT_MS)
}
/** Loopback-only fence: only same-machine browsers may trigger an install. */
function isLoopbackRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false
  } catch {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Mount the /api/dsh-update route family.
 * @param {object} ctx - host plugin context carrying webServer.
 * @param {object} [config] - optional { repoDir } override (defaults to the cwd).
 */
export function apply(ctx, config) {
  const repoDir = resolveRepoDir(config)
  gitProxy = resolveGitProxy(config)
  const handleStatus = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'forbidden' }))
      return
    }
    const body = JSON.stringify(checkStatus(repoDir, config))
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
    res.end(body)
  }

  const handleNotes = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'forbidden' }))
      return
    }
    let tag
    try {
      tag = new URL(req.url ?? '', 'http://x').searchParams.get('tag')
    } catch { /* invalid URL → 400 below */ }
    if (typeof tag !== 'string' || tag === '' || !tag.startsWith(TAG_PREFIX)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'missing or invalid tag' }))
      return
    }
    const result = await releaseNotesFor(repoDir, tag)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer' })
    res.end(JSON.stringify(result))
  }

  const handleRestart = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!trustedRestartRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'forbidden' }))
      return
    }
    if (!restartAllowed(config)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'restart-disabled', message: '重启已被禁用（supervisor 托管或 allowRestart: false）' }))
      return
    }
    if (updateInFlight()) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'run-in-progress', message: '更新正在执行中，请等待其完成后再重启。' }))
      return
    }
    // 先应答，再让 helper 接手：500ms 后本进程退出，helper 等端口释放后按原命令拉起新进程。
    // scheduleRestart 在已安排过重启（例如自动重启定时器刚触发）时返回 null，此时仅应答不再重复调度。
    // 若 helper 本身拉起失败（scheduleRestart 抛错），明确应答 500，而不是让请求挂起/静默吞掉。
    let result
    try {
      result = scheduleRestart(servingPort(req))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `无法启动重启进程：${error instanceof Error ? error.message : String(error)}` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(JSON.stringify({ ok: true, ...(result ?? { already: true }) }))
  }

  const handleRun = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'forbidden' }))
      return
    }
    let options = {}
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8').trim()
      if (rawBody !== '') options = JSON.parse(rawBody)
    } catch { /* body parse failures fall back to non-stash */ }
    // 自动重启：默认开启（config.autoRestart !== false），且受 restartAllowed 约束
    // （supervisor 托管或 allowRestart:false 时自动重启同样禁用）。
    const autoRestart = restartAllowed(config) && (config === undefined || config.autoRestart !== false)
    // Windows 后台分离更新：**默认关闭**（需 config.windowsDetachedUpdate: true 显式开启）。
    // 开启时 git 步骤后把 install/build 移交 detached 进程（本进程退出释放 node_modules
    // 文件锁）；关闭时回到进程内 install/build 路径——面板全程显示实时进度、不会中途断开，
    // 但 Windows 上若运行中的 dsh 持有旧包句柄，`pnpm install` 可能删不掉被锁包而失败，
    // 此时插件按「失败不自伤」自动回滚到更新前版本（树不会被留在半更新状态）。
    const windowsDetachedUpdate = config !== undefined && config.windowsDetachedUpdate === true
    runUpdateStreaming(repoDir, res, { ...options, port: servingPort(req), autoRestart, windowsDetachedUpdate })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: UPDATE_PATHS.status, handler: handleStatus }),
      ctx.webServer.register({ kind: 'exact', path: UPDATE_PATHS.run, handler: handleRun }),
      ctx.webServer.register({ kind: 'exact', path: UPDATE_PATHS.notes, handler: handleNotes }),
      ctx.webServer.register({ kind: 'exact', path: UPDATE_PATHS.restart, handler: handleRestart }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-update: routes')
}

export default { name, inject, apply }
