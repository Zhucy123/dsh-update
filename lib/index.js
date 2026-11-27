/**
 * dsh-update — host half (Node).
 *
 * Registers five exact /api routes on `ctx.connection.fetch.register` (under
 * the host's unified trust fence and browser authentication):
 *   GET  /api/dsh-update/status — compare the local deepseek-harness checkout
 *         against the origin's dsh-v* tags (read-only: `git ls-remote`).
 *   GET  /api/dsh-update/ping   — lightweight liveness probe (pid / boot /
 *         inFlight) polled by the client during restarts without touching git.
 *   GET  /api/dsh-update/release-notes?tag=… — release body for a dsh-v* tag
 *         from the GitHub Releases API (direct first, mirror fallback).
 *   POST /api/dsh-update/run    — when a newer tag exists (alphas included):
 *         `git fetch --tags`, recompute the latest tag, refuse the checkout
 *         when required paths are missing, `git checkout`, delete orphan
 *         `lib/` under packages the new tree dropped, `pnpm install`,
 *         `pnpm run clean` (failure aborts), `pnpm run build`, then restart
 *         and treat “did not activate” / “Failed to load plugins” as a failed
 *         update that rolls back. Progress is JSON-lines over text/event-stream.
 *   POST /api/dsh-update/restart — relaunch this exact dsh invocation after a
 *         detached handoff (mechanism borrowed from dsh-market): a detached
 *         helper waits for the serving port to be released, starts the
 *         replacement, and this process exits. Disabled under a detected
 *         supervisor or config.allowRestart: false.
 *
 * Host `connection` admission is the single security authority for all five
 * routes (Host/Origin trust fence + browser authentication).
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import {
  TAG_PREFIX,
  sanitizeGitEnv,
  compareTags,
  parseTag,
  latestEligibleTag,
  DEFAULT_ORPHAN_LIB_ROOTS,
  missingRequiredPaths,
  tagHealthMessages,
  listPackageDirs,
  removeOrphanLibsOnDisk,
  scanProfilePeerConflicts,
  peerConflictMessages,
  resolveProfilesDir,
  resolveRequiredPaths,
  resolveOrphanLibRoots,
  resolvePeerConflictPolicy,
  resolveBootHealthWindowMs,
  bootLogFailureReason,
} from './safety.js'

const SAFETY_MODULE = fileURLToPath(new URL('./safety.js', import.meta.url))

export { compareTags, latestEligibleTag, bootLogFailureReason }

/** Stable cordis plugin name (also the browser bundle id). */
export const name = 'dsh-update'

/** Services required before the routes can mount.
 *  `connection` owns the shared `/api` Fetch route table: the host applies its
 *  trust fence (Host/Origin, DNS-rebinding) and browser authentication before
 *  any route handler runs, so registering there is what brings these
 *  process-control endpoints under DSH's admission check.
 *  `agents` counts in-flight conversations for the force-update notice. */
export const inject = ['connection', 'agents']

/** Route paths (exact matches under /api). */
export const UPDATE_PATHS = {
  status: '/api/dsh-update/status',
  // 轻量探活：重启期间客户端轮询它，起来后自己刷新页面（比 /status 快，不碰 git）。
  ping: '/api/dsh-update/ping',
  run: '/api/dsh-update/run',
  notes: '/api/dsh-update/release-notes',
  restart: '/api/dsh-update/restart',
}

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

/** Mirrors offered in the UI. Verified reachable against this repo (2026-11);
 *  dead ones (gh.llkk.cc / moeyy / ghproxy.cc / kkgithub / fastgit) are left
 *  out on purpose so the picker never hands the user a broken option. */
const MIRROR_CHOICES = [
  { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

/** Local HTTP proxy port used when the user picks 「GitHub 官方」 through their
 *  own proxy client (Clash/V2Ray default 7890). Only applied to the git
 *  commands of this plugin; the repo config is never rewritten. */
const DEFAULT_LOCAL_PROXY_PORT = 7890

/** Normalise the client's network choice:
 *    source: 'auto' | 'github' | 'mirror'
 *    mirror: mirror id (see MIRROR_CHOICES) — only meaningful for 'mirror'
 *    proxyPort: 1-65535, or 0/null to use GitHub directly with no proxy
 *  Anything unrecognised falls back to 'auto' so a bad client payload can
 *  never disable the update path. */
function normalizeSource(raw) {
  const source = raw && typeof raw.source === 'string' ? raw.source : 'auto'
  if (source !== 'github' && source !== 'mirror') return { source: 'auto' }
  if (source === 'mirror') {
    const id = raw && typeof raw.mirror === 'string' ? raw.mirror : ''
    const found = MIRROR_CHOICES.find((m) => m.id === id)
    return { source: 'mirror', mirror: found === undefined ? MIRROR_CHOICES[0] : found }
  }
  const port = raw && Number.isInteger(raw.proxyPort) ? raw.proxyPort : 0
  const usable = port >= 1 && port <= 65535 ? port : 0
  return usable === 0 ? { source: 'github' } : { source: 'github', proxyPort: usable }
}

/** Parse `?source=&mirror=&proxyPort=` query parameters into a normalized choice (or undefined for default auto). */
function parseNetworkChoice(url) {
  try {
    const params = new URL(url ?? '', 'http://x').searchParams
    const source = params.get('source')
    if (source === null) return undefined
    const port = Number.parseInt(params.get('proxyPort') ?? '', 10)
    return normalizeSource({
      source,
      mirror: params.get('mirror') ?? '',
      proxyPort: Number.isInteger(port) ? port : undefined,
    })
  } catch {
    return undefined
  }
}

/** Deduplicated candidate mirror prefixes for auto fallback (last working mirror first, then gitProxy, then MIRROR_CHOICES). */
let lastWorkingMirrorPrefix = undefined

function autoMirrorPrefixes() {
  if (gitProxy === '') return []
  const candidates = [
    ...(lastWorkingMirrorPrefix ? [lastWorkingMirrorPrefix] : []),
    gitProxy,
    ...MIRROR_CHOICES.map((m) => m.prefix),
  ]
  const seen = new Set()
  const out = []
  for (const prefix of candidates) {
    if (typeof prefix !== 'string' || prefix === '') continue
    const norm = prefix.replace(/\/+$/, '')
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(prefix)
  }
  return out
}

function mirrorMetaForPrefix(prefix) {
  const norm = String(prefix ?? '').replace(/\/+$/, '')
  const found = MIRROR_CHOICES.find((m) => m.prefix.replace(/\/+$/, '') === norm)
  if (found !== undefined) return found
  let label = norm
  try { label = new URL(norm).host || norm } catch {}
  return { id: label, label, prefix }
}

/** git args that route one command through the user's local HTTP proxy. */
function localProxyArgs(choice) {
  if (!choice || choice.source !== 'github' || !choice.proxyPort) return []
  return ['-c', `http.proxy=http://127.0.0.1:${String(choice.proxyPort)}`]
}

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

/** 本进程的随机标识：重启后必然变化，客户端靠它区分「还是旧进程」和「新进程已就绪」。 */
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

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

/** Append `--no-open` once, unless the invocation already carries it.
 *  Same flag `dsh web` accepts by hand; it only suppresses the automatic
 *  browser handoff, not the server itself. */
function withNoOpen(args) {
  const list = Array.isArray(args) ? args : []
  if (list.includes('--no-open') || list.includes('--open')) return list
  return [...list, '--no-open']
}
/** Whether a bare `dsh` name must go through a shell (Windows .cmd shim). */
const winCmdShim = process.platform === 'win32'

/**
 * The exact boot invocation the detached restart helper replays.
 *
 * `dsh web` opens the default browser after startup unless `--no-open` is
 * passed (see @deepseek-ai/dsh-web-app/startup), and the replacement process
 * gets its args from this function — so a bare replay would pop a NEW tab on
 * every update/restart. The already-open page does its own refresh (the /ping
 * boot-id poll), so the relaunch is told not to open one.
 */
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
    return { file: nodeExecutable(), args: [...process.execArgv, abs, ...withNoOpen(process.argv.slice(2))], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start.
  return { file: 'dsh', args: withNoOpen(process.argv.slice(2)), cwd: undefined, viaShell: winCmdShim }
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
  const headers = request && request.headers
  const host = typeof headers?.get === 'function' ? headers.get('host') : headers?.host
  if (typeof host === 'string' && host !== '') {
    const match = /:(\d{1,5})$/u.exec(host)
    if (match !== null) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    }
  }
  if (typeof request?.url === 'string' && request.url !== '') {
    try {
      const parsed = new URL(request.url, 'http://localhost')
      if (parsed.port !== '') {
        const port = Number(parsed.port)
        if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
      }
    } catch { /* ignore malformed URL */ }
  }
  return null
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
    '  let settled = false, left = 2',
    '  const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); socks.forEach((s) => { try { s.destroy() } catch {} }); resolve(v) }',
    '  const t = setTimeout(() => finish(false), 500)',
    '  const socks = ["127.0.0.1", "::1"].map((host) => {',
    '    const s = net.connect({ host, port })',
    '    s.on("connect", () => finish(true))',
    '    s.on("error", () => { if (--left === 0) finish(false) })',
    '    return s',
    '  })',
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
    'main().catch((error) => note("fatal: " + (error && error.message ? error.message : String(error))))',
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
 *        logs: {out,err}, orphanLibRoots, bootHealthWindowMs, safetyModule }
 */
const SAFETY_HELPER_LINES = [
  'let safetyMod = null',
  'let inRollback = false',
  'let replacement = null',
  'let childExit = null',
  'async function loadSafety() {',
  '  if (safetyMod) return safetyMod',
  '  const { pathToFileURL } = require("node:url")',
  '  safetyMod = await import(pathToFileURL(safetyModule).href)',
  '  return safetyMod',
  '}',
  'function killChild(child) {',
  '  const pid = child && child.pid',
  '  if (!pid) return',
  '  try {',
  '    if (process.platform === "win32") {',
  '      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })',
  '    } else {',
  '      try { process.kill(-pid, "SIGTERM") } catch (e) { try { child.kill("SIGTERM") } catch (e2) {} }',
  '    }',
  '  } catch (e) {}',
  '}',
  'function startReplacement() {',
  '  childExit = null',
  '  try {',
  '    const out = fs.openSync(logOut, "a")',
  '    const err = fs.openSync(logErr, "a")',
  '    const child = spawn(file, args, { cwd, detached, windowsHide, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
  '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
  '    child.on("exit", (code) => { childExit = code })',
  '    child.unref()',
  '    replacement = child',
  '    return child',
  '  } catch (error) {',
  '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
  '    return null',
  '  }',
  '}',
  'function readBootLogs() {',
  '  let text = ""',
  '  try { text += fs.readFileSync(logOut, "utf8") } catch (e) {}',
  '  try { text += "\\n" + fs.readFileSync(logErr, "utf8") } catch (e) {}',
  '  return text',
  '}',
  'function fallbackBootReason(text) {',
  '  if (typeof text !== "string" || text === "") return undefined',
  '  for (const line of text.split(/\\r?\\n/)) {',
  '    if (line.includes("[dsh-update]")) continue',
  '    if (/did not activate/i.test(line) && !/\\b0 entries did not activate/i.test(line)) return "did not activate"',
  '    if (/failed to load plugins/i.test(line)) return "Failed to load plugins"',
  '    if (/HARNESS/i.test(line) && /plugin/i.test(line) && /fail/i.test(line)) return "HARNESS plugin load failure"',
  '  }',
  '  return undefined',
  '}',
  'async function watchBoot(ms) {',
  '  const until = Date.now() + (typeof ms === "number" ? ms : 0)',
  '  for (;;) {',
  '    if (childExit !== null && childExit !== 0) return "replacement exited with code " + String(childExit)',
  '    const text = readBootLogs()',
  '    const reason = safetyMod && typeof safetyMod.bootLogFailureReason === "function" ? safetyMod.bootLogFailureReason(text) : fallbackBootReason(text)',
  '    if (reason) return reason',
  '    if (Date.now() >= until) return undefined',
  '    await sleep(500)',
  '  }',
  '}',
  'async function observeBoot(child) {',
  '  if (!child) return "could not start replacement"',
  '  if (port) {',
  '    const upBy = Date.now() + 120000',
  '    while (Date.now() < upBy && !(await listening())) await sleep(500)',
  '    if (!(await listening())) return "replacement did not bind port " + String(port)',
  '  }',
  '  return watchBoot(bootHealthWindowMs)',
  '}',
  'async function cleanupLibs(fromRev, toRev) {',
  '  if (!safetyMod || !fromRev) return',
  '  const oldDirs = safetyMod.listPackageDirs(repoDir, fromRev)',
  '  const newDirs = safetyMod.listPackageDirs(repoDir, toRev || "HEAD")',
  '  if (!oldDirs || oldDirs.length === 0) { note("orphan lib cleanup skipped (could not list " + fromRev + ")"); return }',
  '  const cleaned = safetyMod.removeOrphanLibsOnDisk(repoDir, oldDirs, newDirs, orphanRoots)',
  '  if (cleaned.removed && cleaned.removed.length) note("removed orphan lib: " + cleaned.removed.join(", "))',
  '  if (cleaned.rejected && cleaned.rejected.length) note("rejected unsafe lib path: " + cleaned.rejected.join(", "))',
  '  if (cleaned.errors && cleaned.errors.length) throw new Error(cleaned.errors.join("; "))',
  '}',
  'async function rollback(reason) {',
  '  if (inRollback) { note("rollback already in progress: " + reason); return }',
  '  inRollback = true',
  '  note(reason)',
  '  killChild(replacement)',
  '  await sleep(800)',
  '  // 兜底：无论回滚成败，至少要有一个 dsh 在跑——上面已经 killChild() 杀了替换进程，',
  '  // 直接 return 会留下「没有服务」的死状态，比留着坏版本更难恢复。',
  '  const bailOut = (why) => { note(why); startReplacement(); note("started current tree after rollback abort") }',
  '  if (!rollbackRef) { bailOut("no rollback ref — cannot restore previous version"); return }',
  // 已经 apply 到工作树的本地改动会挡住 rollback 的 checkout（git 拒绝覆盖），
  // 先重新暂存一次，回滚完再 apply 回来——否则回滚失败、树停在新 tag 的半更新状态。
  '  let reStashed = false',
  // 判定必须先暂存什么，再决定 push：
  // `git diff --quiet` 只看「已跟踪且未暂存」，对「只有未跟踪文件」或「只有 staged 改动」
  // 会返回 0，但 `git stash push -u` 照样会把它们收进 stash —— 那种情况下若不同步置
  // reStashed，回滚后就永远不会 apply 回来，用户的文件会静默从工作树消失。
  // 所以统一用 `git status --porcelain`（与 host 的 rollbackRebuild 同一口径）。
  '  {',
  '    const probe = await runGit("rollback dirty check", ["status", "--porcelain"])',
  '    const dirty = probe.code === 0 && String(probe.out || "").trim() !== ""',
  '    if (dirty) {',
  '      const st = await runGit("rollback stash push", ["stash", "push", "-u", "-m", "dsh-update: rollback"])',
  '      if (st.code === 0) reStashed = true',
  '      else note("rollback stash push failed (will retry checkout anyway): " + st.err)',
  '    } else {',
  '      note("rollback: working tree clean, nothing to stash")',
  '    }',
  '  }',
  '  const co = await runGit("rollback checkout", ["checkout", rollbackRef])',
  '  if (co.code !== 0) { bailOut("rollback checkout failed: " + co.err); return }',
  '  try { await cleanupLibs(target, "HEAD") } catch (error) { note("rollback orphan lib cleanup failed: " + (error && error.message ? error.message : error)) }',
  '  let step = await runPnpm("rollback pnpm install", ["install"])',
  '  if (step.code !== 0) { bailOut("rollback pnpm install failed: " + String(step.err).slice(0, 800)); return }',
  '  step = await runPnpm("rollback pnpm run clean", ["run", "clean"])',
  '  if (step.code !== 0) { bailOut("rollback pnpm run clean failed: " + String(step.err).slice(0, 800)); return }',
  '  step = await runPnpm("rollback pnpm run build", ["run", "build"], 30 * 60_000)',
  '  if (step.code !== 0) { bailOut("rollback pnpm run build failed: " + String(step.err).slice(0, 800)); return }',
  // 把回滚前重新暂存的本地改动放回来（失败则保留 stash 条目，数据不丢）。
  '  if (reStashed) {',
  '    const ap = await runGit("rollback stash apply", ["stash", "apply"])',
  '    if (ap.code === 0) {',
  '      const dr = await runGit("rollback stash drop", ["stash", "drop"])',
  '      if (dr.code !== 0) note("rollback stash drop failed — entry kept, drop manually later")',
  '    } else {',
  '      note("rollback stash apply conflicted — entry kept (data safe); resetting conflicted tree")',
  '      await runGit("rollback clean conflicted tree", ["reset", "--hard", "HEAD"])',
  '    }',
  '  }',
  '  note(`rolled back to ${rollbackRef}`)',
  '  startReplacement()',
  '  note("restarted previous version after rollback")',
  '}',
]

export function updateHelperSource(ctx) {
  const {
    repoDir, target, rollbackRef, stashedSomething, autoRestart, port,
    pm, spawnReplacement, logs,
    orphanLibRoots = DEFAULT_ORPHAN_LIB_ROOTS,
    bootHealthWindowMs = 15_000,
    safetyModule = SAFETY_MODULE,
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
    `const orphanRoots = ${JSON.stringify(orphanLibRoots)}`,
    `const bootHealthWindowMs = ${JSON.stringify(bootHealthWindowMs)}`,
    `const safetyModule = ${JSON.stringify(safetyModule)}`,
    // 固定 git 输出语言为英文（冲突/空 stash 判定依赖英文 marker），
    // 与 host 端 GIT_ENV 保持一致；镜像/凭据交互一律不弹窗。
    'const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" }',
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-update] ${line}\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  let settled = false, left = 2',
    '  const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); socks.forEach((s) => { try { s.destroy() } catch {} }); resolve(v) }',
    '  const t = setTimeout(() => finish(false), 500)',
    '  const socks = ["127.0.0.1", "::1"].map((host) => {',
    '    const s = net.connect({ host, port })',
    '    s.on("connect", () => finish(true))',
    '    s.on("error", () => { if (--left === 0) finish(false) })',
    '    return s',
    '  })',
    '})',
    // One-shot command runner: kills a hung command after opts.timeoutMs,
    // resolves { code, err }; code -1 means it could not even start.
    'const run = (label, cmd, args, opts) => new Promise((resolve) => {',
    '  let child, delivered = false, errText = "", outText = ""',
    '  const done = (res) => { if (delivered) return; delivered = true; resolve(res) }',
    '  try {',
    '    child = spawn(cmd, args, { windowsHide: true, ...opts })',
    '  } catch (error) {',
    '    note(`${label} could not start: ${error && error.message ? error.message : error}`)',
    '    done({ code: -1, err: "" })',
    '    return',
    '  }',
    '  const timer = setTimeout(() => {',
    '    if (process.platform === "win32" && opts.shell && child.pid) {',
    '      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { try { child.kill("SIGKILL") } catch {} }) } catch { try { child.kill("SIGKILL") } catch {} }',
    '    } else { try { child.kill("SIGKILL") } catch {} }',
    '  }, opts.timeoutMs)',
    '  child.stdout.on("data", (d) => { outText += String(d) })',
    '  child.stderr.on("data", (d) => { errText += String(d) })',
    '  child.on("error", (error) => { clearTimeout(timer); note(`${label} spawn error: ${error && error.message ? error.message : error}`); done({ code: -1, err: errText }) })',
    '  child.on("close", (code) => { clearTimeout(timer); note(`${label} -> exit ${String(code)}`); done({ code, err: errText, out: outText }) })',
    '})',
    'const runGit = (label, args) => run(label, "git", ["-C", repoDir, ...args], { env: gitEnv, timeoutMs: 5 * 60_000 })',
    'const runPnpm = (label, args, timeoutMs) => run(label, pm.cmd, [...pm.args, ...args], { cwd: repoDir, shell: true, env: process.env, timeoutMs: timeoutMs || 20 * 60_000 })',
    // 失败不自伤：install / clean / build / 启动健康检查失败时回滚到更新前版本，
    // 并重新 install + clean + build，避免半更新树和残留 lib/。
    ...SAFETY_HELPER_LINES,
    'const main = async () => {',
    '  try { await loadSafety() } catch (error) { note("could not load safety module: " + (error && error.message ? error.message : error)) }',
    '  note(`update helper started (target ${target})`)',
    '  if (port) {',
    '    const until = Date.now() + 60_000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) { await rollback(`port ${port} still in use after 60s — aborting`); process.exit(1) }',
    '    note("port released — running install/build with no server locks")',
    '  } else {',
    '    note("port unknown — waiting for host exit before install")',
    '    await sleep(5500)',
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
    '      await runGit("clean conflicted tree", ["reset", "--hard", "HEAD"])',
    '    }',
    '  }',
    '  try { await cleanupLibs(rollbackRef, "HEAD") } catch (error) { await rollback("orphan lib cleanup failed: " + (error && error.message ? error.message : error)); process.exit(1) }',
    '  r = await runPnpm("pnpm run clean", ["run", "clean"])',
    '  if (r.code !== 0) { await rollback(`pnpm run clean failed${r.err !== "" ? ": " + String(r.err).slice(0, 800) : ""}`); process.exit(1) }',
    '  r = await runPnpm("pnpm run build", ["run", "build"], 30 * 60_000)',
    '  if (r.code !== 0) { await rollback(`pnpm run build failed${r.err !== "" ? ": " + String(r.err).slice(0, 800) : ""}`); process.exit(1) }',
    '  let verified = target',
    '  try {',
    '    const described = execFileSync("git", ["-C", repoDir, "describe", "--tags", "--always"], { encoding: "utf8", env: gitEnv, windowsHide: true }).trim()',
    '    if (described) verified = described',
    '  } catch {}',
    '  if (!autoRestart) { note(`build finished — boot not checked (${verified})`); return }',
    '  note("starting replacement dsh — watching boot logs …")',
    '  const child = startReplacement()',
    '  const reason = await observeBoot(child)',
    '  if (reason) { await rollback(`boot unhealthy: ${reason}`); process.exit(1) }',
    '  note("boot healthy")',
    '  note(`update applied — verified ${verified}`)',
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
    orphanLibRoots: opts.orphanLibRoots,
    bootHealthWindowMs: opts.bootHealthWindowMs,
    safetyModule: SAFETY_MODULE,
  })], {
    detached: true,
    stdio: 'ignore',
    // helper 会继承这份环境；污染的 GIT_CONFIG_* 会让它内部每条 git 失败，
    // 启动不健康时的自动回滚随之失效。
    env: sanitizeGitEnv(process.env),
    windowsHide: true,
  })
  helper.on('error', (error) => { try { appendFileSync(logErr, `[dsh-update] helper spawn error: ${String(error)}\n`) } catch {} })
  helper.unref()
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/**
 * After an in-process build, this helper outlives the host: it waits for the
 * port to go quiet, starts the new dsh, and treats plugin-load failures as a
 * failed update (checkout back to `rollbackRef`, reinstall, clean, rebuild).
 * Success is logged only after the boot window stays clean.
 */
export function bootVerifyHelperSource(ctx) {
  const {
    repoDir, target, rollbackRef = '', port = null,
    pm, spawnReplacement, logs,
    orphanLibRoots = DEFAULT_ORPHAN_LIB_ROOTS,
    bootHealthWindowMs = 15_000,
    safetyModule = SAFETY_MODULE,
  } = ctx
  return [
    "const { spawn, execFileSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const repoDir = ${JSON.stringify(repoDir)}`,
    `const target = ${JSON.stringify(target)}`,
    `const rollbackRef = ${JSON.stringify(rollbackRef ?? '')}`,
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
    `const orphanRoots = ${JSON.stringify(orphanLibRoots)}`,
    `const bootHealthWindowMs = ${JSON.stringify(bootHealthWindowMs)}`,
    `const safetyModule = ${JSON.stringify(safetyModule)}`,
    'const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" }',
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-update] ${line}\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  let settled = false, left = 2',
    '  const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); socks.forEach((s) => { try { s.destroy() } catch {} }); resolve(v) }',
    '  const t = setTimeout(() => finish(false), 500)',
    '  const socks = ["127.0.0.1", "::1"].map((host) => {',
    '    const s = net.connect({ host, port })',
    '    s.on("connect", () => finish(true))',
    '    s.on("error", () => { if (--left === 0) finish(false) })',
    '    return s',
    '  })',
    '})',
    'const run = (label, cmd, args, opts) => new Promise((resolve) => {',
    '  let child, delivered = false, errText = "", outText = ""',
    '  const done = (res) => { if (delivered) return; delivered = true; resolve(res) }',
    '  try { child = spawn(cmd, args, { windowsHide: true, ...opts }) } catch (error) {',
    '    note(`${label} could not start: ${error && error.message ? error.message : error}`)',
    '    done({ code: -1, err: "" })',
    '    return',
    '  }',
    '  const timer = setTimeout(() => {',
    '    if (process.platform === "win32" && opts.shell && child.pid) {',
    '      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { try { child.kill("SIGKILL") } catch {} }) } catch { try { child.kill("SIGKILL") } catch {} }',
    '    } else { try { child.kill("SIGKILL") } catch {} }',
    '  }, opts.timeoutMs)',
    '  child.stdout.on("data", (d) => { outText += String(d) })',
    '  child.stderr.on("data", (d) => { errText += String(d) })',
    '  child.on("error", (error) => { clearTimeout(timer); note(`${label} spawn error: ${error && error.message ? error.message : error}`); done({ code: -1, err: errText }) })',
    '  child.on("close", (code) => { clearTimeout(timer); done({ code, err: errText, out: outText }) })',
    '})',
    'const runGit = (label, args) => run(label, "git", ["-C", repoDir, ...args], { env: gitEnv, timeoutMs: 5 * 60_000 })',
    'const runPnpm = (label, args, timeoutMs) => run(label, pm.cmd, [...pm.args, ...args], { cwd: repoDir, shell: true, env: process.env, timeoutMs: timeoutMs || 20 * 60_000 })',
    ...SAFETY_HELPER_LINES,
    'const main = async () => {',
    '  try { await loadSafety() } catch (error) { note("could not load safety module: " + (error && error.message ? error.message : error)) }',
    '  note(`boot verify started (target ${target})`)',
    '  if (port) {',
    '    const until = Date.now() + 60_000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) { note(`port ${port} still in use for 60s — aborting; the tree is already built on ${target}. Restart dsh manually, or run: git -C ${repoDir} checkout ${rollbackRef}`); process.exit(1) }',
    '    note("port released — starting replacement and watching boot logs")',
    '  } else {',
    '    note("port unknown — bind check skipped, watching boot logs only")',
    '    await sleep(5000)',
    '  }',
    '  const child = startReplacement()',
    '  const reason = await observeBoot(child)',
    '  if (reason) { await rollback(`boot unhealthy: ${reason}`); process.exit(1) }',
    '  note("boot healthy")',
    '  note(`update applied — verified ${target}`)',
    '}',
    'main().catch((error) => { note("fatal: " + (error && error.message ? error.message : String(error))); process.exit(1) })',
  ].join('\n')
}

/** Spawn the post-build boot check. Does not kill this process; the caller does. */
function scheduleBootVerify(opts) {
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-update-apply-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-update-apply-${stamp}.err.log`)
  const helper = spawn(nodeExecutable(), ['-e', bootVerifyHelperSource({
    repoDir: opts.repoDir,
    target: opts.target,
    rollbackRef: opts.rollbackRef ?? '',
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
    orphanLibRoots: opts.orphanLibRoots,
    bootHealthWindowMs: opts.bootHealthWindowMs,
    safetyModule: SAFETY_MODULE,
  })], {
    detached: true,
    stdio: 'ignore',
    // helper 会继承这份环境；污染的 GIT_CONFIG_* 会让它内部每条 git 失败，
    // 启动不健康时的自动回滚随之失效。
    env: sanitizeGitEnv(process.env),
    windowsHide: true,
  })
  helper.on('error', (error) => { try { appendFileSync(logErr, `[dsh-update] helper spawn error: ${String(error)}\n`) } catch {} })
  helper.unref()
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/** One-shot restart latch: a manual "Restart DSH" click must never
 *  double-schedule helpers — two helpers would both respawn dsh and fight
 *  over the port. Post-update restarts go through scheduleBootVerify instead,
 *  so a healthy boot (not merely build exit 0) is what counts as success. */
let restartScheduled = false

/** Relaunch this exact dsh entry after a detached handoff, then stop this
 *  process. The helper outlives us (detached + unref), waits for our port to
 *  be released before starting the replacement, and logs under tmpdir.
 *  Returns null when a restart is already scheduled. */
function scheduleRestart(port = null) {
  if (restartScheduled) return null
  restartScheduled = true
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-update-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-update-restart-${stamp}.err.log`)
  try {
    const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)], {
      detached: true,
      stdio: 'ignore',
      env: sanitizeGitEnv(process.env),
      windowsHide: true,
    })
    // 异步 spawn 失败（EMFILE/ENOENT）会以 'error' 事件抛出；不接就是未捕获异常。
    helper.on('error', (error) => { try { appendFileSync(logErr, `[dsh-update] restart helper spawn error: ${String(error)}\n`) } catch {} })
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

/** 剥离畸形 GIT_CONFIG_* 注入（实现在 safety.js，两份 GIT_ENV 共用同一判据）。 */
export { sanitizeGitEnv }

const GIT_ENV = {
  ...sanitizeGitEnv(typeof process === 'object' ? process.env : {}),
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
    windowsHide: true,
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
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', env: process.env, timeout: 10_000, windowsHide: true })
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
      windowsHide: true,
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
/** Async `git ls-remote` runner: resolves { stdout } or { error }, never rejects.
 *  必须异步：同步 execFileSync 会把整个 host 事件循环堵住（最长 8s 直连 + 30s 镜像），
 *  期间所有 agent 轮次、WebSocket 心跳和 /ping 全停。 */
function execFileAsync(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { ...opts, windowsHide: true }, (error, stdout) => {
      // 异步 execFile 超时时 code 是 null、killed 为 true、signal 为 SIGTERM，
      // message 里没有任何超时字样——和同步版 spawnSync ETIMEDOUT 完全不同。
      // 所以把这些信号一并带出去，交给调用方判断。
      if (error) {
        resolve({
          error,
          code: error.code,
          killed: error.killed === true,
          signal: error.signal,
        })
      } else resolve({ stdout: String(stdout) })
    })
  })
}

/** Run `git ls-remote --tags <remote>` and return the latest dsh-v* tag asynchronously.
 *  `remote` may be a configured name or a URL. Resolves { tag } or { error }. */
async function lsRemoteTags(repoDir, remote, timeoutMs, noAuth = false, extraArgs = []) {
  const result = await execFileAsync(
    'git',
    ['-C', repoDir, ...(noAuth ? ['-c', 'credential.helper='] : []), ...extraArgs, 'ls-remote', '--tags', remote],
    { encoding: 'utf8', env: GIT_ENV, timeout: timeoutMs },
  )
  if (result.error !== undefined) {
    const message = result.error instanceof Error ? result.error.message : String(result.error)
    // 同步版超时是 message 带 ETIMEDOUT；异步版是 code=null + killed + SIGTERM。
    const timedOut = /timed out|ETIMEDOUT|ETIME/i.test(message)
      || result.code === 'ETIMEDOUT'
      || result.killed === true
      || result.signal === 'SIGTERM'
      || result.signal === 'SIGKILL'
    return { error: timedOut ? '网络超时' : message }
  }
  const tags = new Set()
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const match = /refs\/tags\/(dsh-v[^^\s]+)(?:\^\{\})?$/.exec(line.trim())
    if (match !== null) tags.add(match[1])
  }
  // Alphas stay eligible: latest is the highest semver tag, prerelease included.
  const latest = latestEligibleTag([...tags])
  return latest === undefined ? {} : { tag: latest }
}

/** Latest dsh-v* tag reported by the origin (read-only), if reachable.
 *  Direct GitHub access is tried first with a short timeout; when it fails
 *  and the origin is a github.com URL, the configured mirror is tried as a
 *  fallback (the result is marked `via: 'proxy'` so the UI can say so).
 *  Successful results are cached for REMOTE_TAG_TTL_MS; failures never are. */
/** Async: 见 lsRemoteTags 关于为什么不能用同步 execFileSync 的说明。 */
async function remoteLatestTag(repoDir, choice) {
  const now = Date.now()
  // 用户显式指定来源时不走缓存也不覆写 auto 缓存：换来源后必须立刻按新网络重查。
  const explicit = choice !== undefined && choice.source !== 'auto'
  if (!explicit && remoteTagCache.value !== undefined && now - remoteTagCache.at < REMOTE_TAG_TTL_MS) {
    return remoteTagCache.value
  }
  const origin = originUrl(repoDir) ?? 'origin'
  const proxyArgs = localProxyArgs(choice)
  if (choice !== undefined && choice.source === 'mirror') {
    // 只用镜像，不回退直连：用户选镜像就是网络到不了 GitHub。
    const mirrorUrl = proxyUrlFor(origin, choice.mirror.prefix)
    if (mirrorUrl === undefined) {
      return { error: '当前仓库 origin 不是 GitHub 地址，无法使用镜像' }
    }
    const mirrored = await lsRemoteTags(repoDir, mirrorUrl, REMOTE_LS_TIMEOUT_MS, true)
    return mirrored.error === undefined
      ? { ...mirrored, via: 'proxy', mirror: choice.mirror.id }
      : { error: `${choice.mirror.label} 镜像失败：${mirrored.error}` }
  }
  let result = await lsRemoteTags(repoDir, origin, DIRECT_GIT_TIMEOUT_MS, false, proxyArgs)
  if (result.error !== undefined && choice !== undefined && choice.source === 'github') {
    // 选了「GitHub 官方」就只走官方（带用户端口代理），不偷偷切镜像。
    // 端口不通时补一句可操作提示：本机没开代理软件是最常见原因。
    if (choice.proxyPort && /Failed to connect|Could not connect|Connection refused|proxy/i.test(result.error)) {
      return {
        error: `本机 127.0.0.1:${String(choice.proxyPort)} 上没有可用代理（git 连不上代理）。`
          + '把「代理端口」清空即可直连 GitHub；或在 Clash / V2Ray 里开启 HTTP 代理。',
      }
    }
    return result
  }
  if (result.error !== undefined) {
    const mirrorErrors = []
    for (const prefix of autoMirrorPrefixes()) {
      const mirrorUrl = proxyUrlFor(origin, prefix)
      if (mirrorUrl === undefined) continue
      const meta = mirrorMetaForPrefix(prefix)
      const mirrored = await lsRemoteTags(repoDir, mirrorUrl, REMOTE_LS_TIMEOUT_MS, true)
      if (mirrored.error === undefined) {
        lastWorkingMirrorPrefix = prefix
        result = { ...mirrored, via: 'proxy', mirror: meta.id }
        mirrorErrors.length = 0
        break
      }
      mirrorErrors.push(`${meta.label}: ${mirrored.error}`)
    }
    if (result.error !== undefined && mirrorErrors.length > 0) {
      result = { error: `直连失败：${result.error}；镜像失败：${mirrorErrors.join('；')}` }
    }
  }
  if (!explicit && result.error === undefined) {
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

const MAX_FETCH_JSON_BYTES = 2 * 1024 * 1024
const MAX_HTTP_HEADER_BYTES = 64 * 1024

function parseHttpResponseHead(headBuf) {
  const lines = headBuf.toString('latin1').split('\r\n')
  const statusMatch = /^HTTP\/1\.\d\s+(\d{3})\b/.exec(lines[0] ?? '')
  if (statusMatch === null) return null
  const headers = Object.create(null)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const val = line.slice(colon + 1).trim()
    headers[key] = headers[key] === undefined ? val : `${headers[key]}, ${val}`
  }
  return { statusCode: Number(statusMatch[1]), headers }
}

function finalizeJsonBuffer(buf, onResult) {
  try {
    onResult({ json: JSON.parse(buf.toString('utf8')) })
  } catch (error) {
    onResult({ error: error instanceof Error ? error.message : String(error) })
  }
}

function createHttp1JsonParser(onResult) {
  let headerDone = false
  let headerChunks = []
  let headerLen = 0
  let isChunked = false
  let contentLength
  const bodyChunks = []
  let bodyLen = 0
  let pending = Buffer.alloc(0)
  const decodedChunks = []
  let decodedLen = 0
  let chunkedDone = false

  const pushBody = (data) => {
    if (isChunked) {
      pending = pending.length === 0 ? data : Buffer.concat([pending, data])
      let pos = 0
      while (true) {
        const lineEnd = pending.indexOf('\r\n', pos)
        if (lineEnd === -1) {
          if (pending.length - pos > 1024) {
            onResult({ error: 'invalid chunk header' })
            return
          }
          pending = pending.subarray(pos)
          break
        }
        const sizeLine = pending.subarray(pos, lineEnd).toString('ascii')
        const semi = sizeLine.indexOf(';')
        const hex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim()
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          onResult({ error: 'invalid chunk size' })
          return
        }
        const size = Number.parseInt(hex, 16)
        if (!Number.isSafeInteger(size)) {
          onResult({ error: 'invalid chunk size' })
          return
        }
        if (size === 0) {
          const afterZero = lineEnd + 2
          const emptyTrailer = pending.length >= afterZero + 2 && pending[afterZero] === 13 && pending[afterZero + 1] === 10
          const withTrailer = !emptyTrailer && pending.indexOf('\r\n\r\n', lineEnd) !== -1
          if (!emptyTrailer && !withTrailer) {
            if (pending.length - pos > MAX_HTTP_HEADER_BYTES) {
              onResult({ error: 'chunk trailers too large' })
              return
            }
            pending = pending.subarray(pos)
            break
          }
          chunkedDone = true
          pending = Buffer.alloc(0)
          finalizeJsonBuffer(Buffer.concat(decodedChunks, decodedLen), onResult)
          return
        }
        if (decodedLen + size > MAX_FETCH_JSON_BYTES) {
          onResult({ error: 'response body too large' })
          return
        }
        const dataStart = lineEnd + 2
        const dataEnd = dataStart + size
        if (pending.length < dataEnd + 2) {
          pending = pending.subarray(pos)
          break
        }
        if (pending[dataEnd] !== 13 || pending[dataEnd + 1] !== 10) {
          onResult({ error: 'invalid chunk terminator' })
          return
        }
        decodedChunks.push(pending.subarray(dataStart, dataEnd))
        decodedLen += size
        pos = dataEnd + 2
      }
      return
    }
    bodyLen += data.length
    if (bodyLen > MAX_FETCH_JSON_BYTES) {
      onResult({ error: 'response body too large' })
      return
    }
    if (data.length > 0) bodyChunks.push(data)
    if (contentLength !== undefined && bodyLen >= contentLength) {
      finalizeJsonBuffer(Buffer.concat(bodyChunks, bodyLen).subarray(0, contentLength), onResult)
    }
  }

  return {
    push(chunk) {
      if (!headerDone) {
        headerChunks.push(chunk)
        headerLen += chunk.length
        const buf = headerChunks.length === 1 ? headerChunks[0] : Buffer.concat(headerChunks, headerLen)
        const sep = buf.indexOf('\r\n\r\n')
        if (sep === -1) {
          if (headerLen > MAX_HTTP_HEADER_BYTES) {
            onResult({ error: 'HTTP headers too large' })
            return
          }
          headerChunks = [buf]
          return
        }
        headerDone = true
        headerChunks = []
        const head = parseHttpResponseHead(buf.subarray(0, sep))
        if (head === null) {
          onResult({ error: 'invalid HTTP response' })
          return
        }
        if (head.statusCode < 200 || head.statusCode >= 300) {
          onResult({ error: `HTTP ${String(head.statusCode)}` })
          return
        }
        isChunked = /\bchunked\b/i.test(head.headers['transfer-encoding'] ?? '')
        if (!isChunked && head.headers['content-length'] !== undefined) {
          const clStr = head.headers['content-length'].trim()
          if (!/^\d+$/.test(clStr)) {
            onResult({ error: 'invalid Content-Length' })
            return
          }
          contentLength = Number(clStr)
          if (contentLength > MAX_FETCH_JSON_BYTES) {
            onResult({ error: 'response body too large' })
            return
          }
        }
        const rest = buf.subarray(sep + 4)
        if (rest.length > 0 || (!isChunked && contentLength === 0)) {
          pushBody(rest)
        }
        return
      }
      pushBody(chunk)
    },
    end() {
      if (!headerDone) {
        onResult({ error: 'empty or incomplete HTTP response' })
        return
      }
      if (isChunked) {
        if (!chunkedDone) onResult({ error: 'truncated chunked response' })
        return
      }
      if (contentLength !== undefined && bodyLen < contentLength) {
        onResult({ error: 'truncated response body' })
        return
      }
      finalizeJsonBuffer(Buffer.concat(bodyChunks, bodyLen), onResult)
    },
  }
}

/** GET a URL as JSON with a hard timeout (optionally via local HTTP proxy); resolves { json } or { error }. */
async function fetchJson(url, timeoutMs, proxyPort, tlsOpts) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
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

  let u
  try {
    u = new URL(url)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { error: `unsupported protocol: ${u.protocol}` }
  }

  return new Promise((resolve) => {
    let settled = false
    let connectReq = null
    let rawSocket = null
    let tlsSocket = null
    let httpReq = null
    let httpRes = null

    const cleanup = () => {
      clearTimeout(timer)
      if (connectReq !== null) { try { connectReq.destroy() } catch {} connectReq = null }
      if (tlsSocket !== null) { try { tlsSocket.destroy() } catch {} tlsSocket = null }
      if (rawSocket !== null) { try { rawSocket.destroy() } catch {} rawSocket = null }
      if (httpRes !== null) { try { httpRes.destroy() } catch {} httpRes = null }
      if (httpReq !== null) { try { httpReq.destroy() } catch {} httpReq = null }
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({ error: 'request timed out' })
    }, timeoutMs)

    if (u.protocol === 'https:') {
      const authority = `${u.hostname}:${u.port || 443}`
      connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
      })
      connectReq.on('error', (error) => {
        finish({ error: error instanceof Error ? error.message : String(error) })
      })
      connectReq.on('response', (res) => {
        res.resume()
        finish({ error: `Proxy CONNECT HTTP ${String(res.statusCode)}` })
      })
      connectReq.on('connect', (proxyRes, socket, head) => {
        connectReq = null
        rawSocket = socket
        socket.on('error', (error) => {
          finish({ error: error instanceof Error ? error.message : String(error) })
        })
        if (settled) {
          socket.destroy()
          return
        }
        if (proxyRes.statusCode !== 200) {
          finish({ error: `Proxy CONNECT HTTP ${String(proxyRes.statusCode)}` })
          return
        }
        if (head && head.length > 0) socket.unshift(head)

        const hostNoBrackets = u.hostname.replace(/^\[|\]$/g, '')
        const connectOpts = {
          socket,
          ...(isIP(hostNoBrackets) ? {} : { servername: u.hostname }),
          ...(tlsOpts || {}),
        }
        try {
          tlsSocket = tls.connect(connectOpts)
        } catch (error) {
          finish({ error: error instanceof Error ? error.message : String(error) })
          return
        }
        const parser = createHttp1JsonParser(finish)
        tlsSocket.on('error', (error) => {
          finish({ error: error instanceof Error ? error.message : String(error) })
        })
        tlsSocket.on('secureConnect', () => {
          if (settled) return
          const reqLines = [
            `GET ${u.pathname}${u.search} HTTP/1.1`,
            `Host: ${u.host}`,
            'Accept: application/vnd.github+json',
            'User-Agent: dsh-update',
            'Accept-Encoding: identity',
            'Connection: close',
            '',
            '',
          ].join('\r\n')
          tlsSocket.write(reqLines)
        })
        tlsSocket.on('data', (chunk) => {
          if (!settled) parser.push(chunk)
        })
        tlsSocket.on('end', () => {
          if (!settled) parser.end()
        })
        tlsSocket.on('close', () => {
          finish({ error: 'connection closed before response completed' })
        })
      })
      connectReq.end()
      return
    }

    httpReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: {
        host: u.host,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-update',
        'accept-encoding': 'identity',
        connection: 'close',
      },
    })
    httpReq.on('error', (error) => {
      finish({ error: error instanceof Error ? error.message : String(error) })
    })
    httpReq.on('response', (res) => {
      httpRes = res
      res.on('error', (error) => {
        finish({ error: error instanceof Error ? error.message : String(error) })
      })
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.resume()
        finish({ error: `HTTP ${String(status)}` })
        return
      }
      const chunks = []
      let total = 0
      res.on('data', (chunk) => {
        if (settled) return
        total += chunk.length
        if (total > MAX_FETCH_JSON_BYTES) {
          finish({ error: 'response body too large' })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        finalizeJsonBuffer(Buffer.concat(chunks, total), finish)
      })
      res.on('close', () => {
        finish({ error: 'connection closed before response completed' })
      })
    })
    httpReq.end()
  })
}

export { fetchJson }

/** Release notes (markdown body) for a dsh-v* tag from the GitHub Releases
 *  API. Honours explicit network choice; in auto mode, tries direct first
 *  with a short timeout and falls back across candidate mirrors. */
async function releaseNotesFor(repoDir, tag, choice) {
  const sourceKey = choice === undefined || choice.source === 'auto'
    ? 'auto'
    : choice.source === 'mirror'
      ? `mirror:${choice.mirror.id}`
      : choice.proxyPort
        ? `github:${String(choice.proxyPort)}`
        : 'github'
  const cacheKey = `${tag}|${sourceKey}`
  const cached = releaseNotesCache.get(cacheKey)
  if (cached !== undefined) {
    const fresh = cached.error === undefined
      ? Date.now() - cached.at < RELEASE_NOTES_CACHE_MS
      : Date.now() - cached.at < RELEASE_NOTES_ERROR_CACHE_MS
    if (fresh) return cached.value
  }
  const slug = githubRepoSlug(originUrl(repoDir)) ?? 'deepseek-ai/deepseek-harness'
  const apiUrl = `https://api.github.com/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`
  let got
  if (choice !== undefined && choice.source === 'mirror') {
    got = await fetchJson(`${choice.mirror.prefix.replace(/\/+$/, '')}/${apiUrl}`, REMOTE_LS_TIMEOUT_MS)
  } else if (choice !== undefined && choice.source === 'github') {
    got = await fetchJson(apiUrl, DIRECT_GIT_TIMEOUT_MS, choice.proxyPort)
  } else {
    got = await fetchJson(apiUrl, DIRECT_GIT_TIMEOUT_MS)
    if (got.error !== undefined) {
      for (const prefix of autoMirrorPrefixes()) {
        const attempted = await fetchJson(`${prefix.replace(/\/+$/, '')}/${apiUrl}`, REMOTE_LS_TIMEOUT_MS)
        got = attempted
        if (attempted.error === undefined) {
          lastWorkingMirrorPrefix = prefix
          break
        }
      }
    }
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
  releaseNotesCache.set(cacheKey, { at: Date.now(), error: value.ok ? undefined : value.error, value })
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
  // A later failure line wins over an earlier success line (boot check runs
  // after build). `build finished — boot not checked` is a successful build
  // that could not watch the web process (auto-restart off).
  const state = { ok: false, tag: undefined, bootChecked: false, reason: undefined }
  for (const line of content.split(/\r?\n/)) {
    const applied = /^\[dsh-update\] update applied — verified (.+)$/.exec(line)
    if (applied !== null) {
      state.ok = true
      state.tag = applied[1].trim()
      state.bootChecked = true
      state.reason = undefined
      continue
    }
    const unchecked = /^\[dsh-update\] build finished — boot not checked \((.+)\)$/.exec(line)
    if (unchecked !== null) {
      state.ok = true
      state.tag = unchecked[1].trim()
      state.bootChecked = false
      state.reason = undefined
      continue
    }
    const unhealthy = /^\[dsh-update\] boot unhealthy: (.+)$/.exec(line)
    if (unhealthy !== null) {
      state.ok = false
      state.tag = undefined
      state.bootChecked = true
      state.reason = unhealthy[1].trim()
      continue
    }
    if (/^\[dsh-update\].*(pnpm install failed|pnpm run clean failed|pnpm run build failed|rollback checkout failed|rolled back|still in use after 60s|aborting|fatal:|did not activate|Failed to load plugins)/i.test(line)) {
      state.ok = false
      state.tag = undefined
      state.bootChecked = true
    }
  }
  return {
    mode: 'detached',
    ok: state.ok,
    tag: state.tag,
    at: new Date(newestMtime).toISOString(),
    bootChecked: state.bootChecked,
    reason: state.reason,
  }
}

/** 兜底复位运行锁：只在异常路径用。正常路径由 endRun/finishFail 负责。
 *  重置后必须让「交接中」也一起放开，否则 /run 会永久 409。 */
function releaseRunLatch() {
  activeRun = false
  handingOff = false
}
/** Number of Agents currently inside a turn (approval/answer waits included).
 *  Best-effort: any failure (service unavailable, shape change) counts as 0 so
 *  a probe problem can never block an update the user asked for. */
let agentsFace = undefined
function countRunningAgents() {
  try {
    const face = agentsFace
    if (face === undefined || typeof face.list !== 'function') return 0
    return face.list().filter((agent) => agent.status === 'running').length
  } catch {
    return 0
  }
}
/**
 * 构造更新流程用的两个子进程执行器（git / pnpm）。
 *
 * 它们是纯管线——负责 spawn、按行切分输出、超时兜底与错误归一——不含任何
 * 更新流程的状态判断。从 runUpdateStreaming 里抽出来，是因为主函数已经接近
 * 700 行、嵌套 16 层，这些管道逻辑混在里面让「状态机在哪」变得很难看清。
 *
 * @param ctx.repoDir - 执行 git 的仓库目录。
 * @param ctx.write - 往事件流写一条 step / line 事件的函数。
 * @param ctx.fail - 终止本轮更新的回调（超时时调用）。
 * @param ctx.isSettled - 读当前是否已经收尾；已收尾就不再投递结果。
 * @returns runGit / runCommand 两个执行器。
 */
export function createProcessRunners(ctx) {
  const { repoDir, write, fail, isSettled } = ctx

  // Generic git runner: streams both pipes as `line` events; delivers
  // (exitCode, stderrText) to onDone. stderr is accumulated verbatim so we can
  // detect checkout conflicts and stash outcomes. A hung command is killed
  // after timeoutMs (default GIT_TIMEOUT_MS) instead of blocking forever.
  const runGit = (label, args, onDone, timeoutMs = GIT_TIMEOUT_MS) => {
    write({ type: 'step', text: label })
    let procError = ''
    let stderrBuf = ''
    let delivered = false
    const deliver = (code, err) => {
      if (delivered) return
      delivered = true
      try {
        onDone(code, err)
      } catch (error) {
        if (!isSettled()) fail(error instanceof Error ? error.message : String(error))
      }
    }
    let proc
    try {
      proc = spawn('git', ['-C', repoDir, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: GIT_ENV,
        // Windows: 不设这个，每条 git 都会弹一个 cmd 窗口（标题就是 git 的路径）。
        windowsHide: true,
      })
    } catch (error) {
      // 同步 spawn 失败（极少见）：快速失败，不挂到超时。
      deliver(-1, error instanceof Error ? error.message : String(error))
      return
    }
    const stdoutLines = createLineEmitter((text) => write({ type: 'line', text }))
    const stderrLines = createLineEmitter((text) => write({ type: 'line', text }))
    const killTimer = setTimeout(() => {
      if (!isSettled()) {
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
      if (!isSettled()) deliver(-1, `git 无法启动：${procError}`)
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      stdoutLines.onEnd()
      stderrLines.onEnd()
      if (isSettled() || delivered) return
      deliver(code, procError !== '' ? procError : stderrBuf.trim())
    })
  }

  const runCommand = (label, args, onDone) => {
    write({ type: 'step', text: label })
    const pm = pnpmCommand()
    let procError = ''
    let delivered = false
    const deliver = (code, err) => {
      if (delivered) return
      delivered = true
      try {
        onDone(code, err)
      } catch (error) {
        if (!isSettled()) fail(error instanceof Error ? error.message : String(error))
      }
    }
    let proc
    try {
      proc = spawn(pm.cmd, [...pm.args, ...args], {
        cwd: repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        // install/clean/build 不跑 git，但同样不该继承污染的 GIT_CONFIG_*。
        env: sanitizeGitEnv(process.env),
        windowsHide: true,
      })
    } catch (error) {
      deliver(-1, error instanceof Error ? error.message : String(error))
      return
    }
    const killTimer = setTimeout(() => {
      if (!isSettled()) {
        if (process.platform === 'win32' && proc.pid) {
          try {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
              .on('error', () => { try { proc.kill('SIGKILL') } catch {} })
          } catch {
            try { proc.kill('SIGKILL') } catch {}
          }
        } else {
          try { proc.kill('SIGTERM') } catch {}
          // SIGTERM 可能被忽略（挂死进程），3 秒后 SIGKILL 兜底，避免残留。
          setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
        }
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
      if (!isSettled()) deliver(-1, `pnpm 无法启动：${procError}`)
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      stdoutLines.onEnd()
      stderrLines.onEnd()
      if (isSettled() || delivered) return
      deliver(code, procError)
    })
  }

  return { runGit, runCommand }
}

/**
 * 更新失败后的完整回滚：重新暂存本地改动 → checkout 回原版本 → 清理残留 lib/
 * → install / clean / build → 把本地改动 apply 回来。
 *
 * 从 runUpdateStreaming 里抽出来（原 94 行），因为「失败怎么收场」和「正常怎么更新」
 * 是两件事，混在一个 700 行函数里时最容易漏掉恢复路径。
 *
 * @param ctx.error - 触发回滚的原始错误，会拼进最终提示。
 * @param ctx.rollbackRef - 回滚目标（更新前的确切 commit）。
 * @param ctx.repoDir - 仓库目录。
 * @param ctx.target - 失败的目标版本，用于清理只存在于该版本的 lib/。
 * @param ctx.stashApplied - 本地改动是否已经 apply 到工作树（决定要不要重新暂存）。
 * @param ctx.orphanLibRoots - 允许清理的 lib/ 白名单根。
 * @param ctx.write / ctx.finishFail / ctx.runGit / ctx.runCommand - 事件与命令通道。
 * @param ctx.isSettled - 本轮是否已收尾；已收尾就不再继续链式步骤。
 */
export function performRollback(ctx) {
  const { error, rollbackRef, repoDir, target, stashApplied, orphanLibRoots,
    write, finishFail, runGit, runCommand, isSettled } = ctx

  write({ type: 'step', text: `更新失败，正在回滚到 ${rollbackRef}（checkout + install + clean + build）…` })
  const manual = `git checkout ${rollbackRef} && pnpm install && pnpm run clean && pnpm run build`
  // stash apply + drop 之后用户的本地改动只在工作树上；直接 checkout 会被 git 拒绝
  // （Your local changes would be overwritten），回滚就会失败、树停在新 tag 的半更新状态。
  // 所以回滚前先把这些改动重新暂存一次，checkout 完再 apply 回来。
  let reStashed = false
  if (stashApplied) {
    try {
      // 用 status --porcelain 先判断有没有东西可暂存：git stash push 在无改动时
      // 也是 exit 0，而它的 "No local changes to save" 走 stderr（gitSync 只收 stdout），
      // 直接靠输出判定不可靠——误判会让结尾 apply 一条不相干的旧 stash。
      const dirty = gitSync(repoDir, ['status', '--porcelain'])
      if (dirty !== '') {
        gitSync(repoDir, ['stash', 'push', '-u', '-m', 'dsh-update: rollback'])
        reStashed = true
      }
    } catch (stashFailure) {
      const message = stashFailure instanceof Error ? stashFailure.message : String(stashFailure)
      // 暂存不了也不能硬 checkout（会覆盖用户改动），直接如实报告并把命令给出。
      finishFail(`${error}（回滚前无法暂存本地改动：${message}——请手动执行 git stash -u 后再 ${manual}）`, false)
      return
    }
  }
  let checkoutError
  try {
    gitSync(repoDir, ['checkout', rollbackRef])
  } catch (checkoutFailure) {
    checkoutError = checkoutFailure instanceof Error ? checkoutFailure.message : String(checkoutFailure)
  }
  if (checkoutError !== undefined) {
    finishFail(`${error}（自动回滚到 ${rollbackRef} 失败：${checkoutError}——请手动执行 ${manual}；本地改动已保存在 git stash）`, false)
    return
  }
  try {
    const failedDirs = target !== undefined ? listPackageDirs(repoDir, target) : []
    const restoredDirs = listPackageDirs(repoDir, 'HEAD')
    const cleaned = removeOrphanLibsOnDisk(
      repoDir,
      failedDirs,
      restoredDirs,
      Array.isArray(orphanLibRoots) ? orphanLibRoots : DEFAULT_ORPHAN_LIB_ROOTS,
    )
    if (cleaned.removed.length > 0) {
      write({ type: 'notice', text: '回滚时已删除仅存在于失败版本中的 lib/：' + cleaned.removed.join(', ') })
    }
  } catch (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    write({ type: 'notice', text: `回滚时清理残留 lib/ 出错：${message}` })
  }
  const chain = (label, args, next) => {
    runCommand(label, args, (code, err) => {
      if (isSettled()) return
      if (code !== 0) {
        finishFail(
          `${error}（已 checkout 回 ${rollbackRef}，但 ${label} 失败：${err !== '' ? err : 'exit ' + String(code)}。`
          + `请手动执行 ${manual}`
          + (reStashed ? '；你的本地改动安全保存在 git stash 中，处理完执行 git stash apply 恢复' : '')
          + '）',
          false,
        )
        return
      }
      next()
    })
  }
  // 回滚链跑完后把之前重新暂存的本地改动 apply 回来（成功才 drop）。
  const restoreStash = (suffix) => {
    if (!reStashed) {
      finishFail(`${error}（已自动回滚到 ${rollbackRef}，并重新 install / clean / build）${suffix}`, true)
      return
    }
    runGit('Rolling back: restoring your local changes (git stash apply) …', ['stash', 'apply'], (code, err) => {
      if (code === 0) {
        runGit('Rolling back: removing applied stash entry …', ['stash', 'drop'], () => {
          finishFail(`${error}（已自动回滚到 ${rollbackRef}，并重新 install / clean / build；本地改动已恢复）${suffix}`, true)
        })
        return
      }
      finishFail(
        `${error}（已自动回滚到 ${rollbackRef}；本地改动与新版本冲突，安全保存在 git stash 中未丢失，`
        + `请在该仓库手动执行 git stash apply 处理${err !== '' ? '：' + err : ''}）`,
        true,
      )
    })
  }
  chain('Rolling back: pnpm install …', ['install'], () => {
    chain('Rolling back: pnpm run clean …', ['run', 'clean'], () => {
      chain('Rolling back: pnpm run build …', ['run', 'build'], () => {
        restoreStash('')
      })
    })
  })
}

/** 构造一条成功的 `done` 事件。
 *  客户端对它的字段有一组隐式契约（autoRestart / restartInMs / pendingBootCheck /
 *  restartWindowMs 决定是否轮询 /ping 并自动刷新），散在两个分支里手写极易漏字段
 *  ——历史上 detached 分支就曾把 autoRestart 写死成 true。集中到一处生成。
 * @param base - { from, to, rollback?, verifiedTag?, verifiedCommit?, stashApplied?, stashKept? }
 * @param mode - { kind: 'build' | 'detached' | 'plain', autoRestart, logErr?, restartInMs? }
 * @returns 完整的 done 事件对象。
 */
export function buildDoneEvent(base, mode) {
  const done = { type: 'done', ok: true, from: base.from, to: base.to }
  if (base.rollback) done.rollback = true
  if (base.verifiedTag !== undefined) done.verifiedTag = base.verifiedTag
  if (base.verifiedCommit !== undefined) done.verifiedCommit = base.verifiedCommit
  if (base.stashApplied) done.stashApplied = true
  if (base.stashKept) done.stashKept = true
  if (mode.kind === 'detached') done.detached = true
  if (mode.logErr !== undefined) done.logErr = mode.logErr
  // autoRestart 必须反映真实配置：helper 在 false 时不会拉起新进程。
  done.autoRestart = mode.autoRestart === true
  if (done.autoRestart) {
    // pendingBootCheck 只对「本进程内 build 完、再交给 helper 验启动」这条路径有意义。
    // detached 是「整个 install/build 都在后台」，客户端应先看到「已转入后台执行」；
    // 两者都置位会让客户端的 pendingBootCheck 分支抢先，文案错成「正在检查启动是否健康」。
    if (mode.kind === 'build') done.pendingBootCheck = true
    done.bootChecked = false
    if (mode.restartInMs !== undefined) done.restartInMs = mode.restartInMs
    if (mode.restartWindowMs !== undefined) done.restartWindowMs = mode.restartWindowMs
  } else {
    done.bootChecked = false
  }
  return done
}
/** Build the status: local vs remote version comparison.
 *  `config` (optional) lets the payload advertise whether a finished update
 *  will auto-restart dsh — the UI warns the user accordingly before starting. */
/** Async status check. 会走网络（git ls-remote），绝不能同步阻塞事件循环。 */
export async function checkStatus(repoDir, config, choice) {
  if (!existsSync(join(repoDir, '.git'))) {
    return { ok: false, repoDir, localCommit: '', outdated: false, error: `not a git checkout: ${repoDir}` }
  }
  const local = localVersion(repoDir)
  const remote = await remoteLatestTag(repoDir, choice)
  const status = {
    ok: remote.error === undefined,
    repoDir,
    localCommit: local.commit,
    outdated: false,
    platform: process.platform,
    autoRestart: restartAllowed(config) && (config === undefined || config.autoRestart !== false),
    // 更新将走哪条路径：客户端据此显示「页面会断开、后台完成」还是「全程显示进度」，
    // 不能仅凭 navigator.userAgent 猜（服务端配置/平台才是真相）。
    detachedUpdate: process.platform === 'win32' && config !== undefined && config.windowsDetachedUpdate === true,
    tags: localTags(repoDir),
    // 最近一次后台更新 / 启动健康检查的结果（页面断开后用户看不到过程，
    // 面板据此给出「上次更新已完成 / 已回滚」的确认）。
    lastUpdate: lastDetachedUpdate(),
    requiredPaths: resolveRequiredPaths(config),
    peerConflictPolicy: resolvePeerConflictPolicy(config),
    peerConflicts: [],
    // 网络来源选择器：镜像清单 + 本次实际用的来源/端口（UI 据此回显）。
    // 进行中的对话数（Agent status === 'running'）：更新会重启 dsh，正在跑的对话会被打断。
    // 拿不到 agents 服务时按 0 处理，绝不因为探测失败就挡住更新。
    busySessions: countRunningAgents(),
    mirrors: MIRROR_CHOICES.map((m) => ({ id: m.id, label: m.label })),
    defaultProxyPort: DEFAULT_LOCAL_PROXY_PORT,
    source: choice === undefined ? 'auto' : choice.source,
    ...(choice !== undefined && choice.source === 'mirror' ? { mirror: choice.mirror.id } : {}),
    ...(choice !== undefined && choice.proxyPort ? { proxyPort: choice.proxyPort } : {}),
  }
  if (local.tag !== undefined) status.localTag = local.tag
  if (remote.tag !== undefined) status.remoteTag = remote.tag
  if (remote.via === 'proxy') status.remoteVia = 'proxy'
  if (status.remoteTag !== undefined) {
    try {
      status.peerConflicts = scanProfilePeerConflicts(status.remoteTag, resolveProfilesDir(config))
    } catch {
      status.peerConflicts = []
    }
  }
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
 * sources no longer provide — bundling them fails with MISSING_EXPORT, or the
 * web UI sticks on "Failed to load plugins / N entries did not activate" when
 * an old lib/ still injects a service the new tag no longer provides
 * (contextMenus). Clean failure fails the update. Orphan `lib/` directories
 * under packages that disappeared from the tree are removed first (whitelist
 * only). Before checkout, required paths must exist in the target tag.
 * After a successful build with auto-restart, a boot-log check must stay
 * clean or the previous tag is restored. Alpha tags stay selectable.
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
export async function runUpdateStreaming(repoDir, res, options = {}) {
  // Reject a second run while one is already executing (double click / two
  // tabs must not start concurrent checkouts + builds).
  if (updateInFlight()) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, code: 'run-in-progress', message: '已有更新正在执行中，请等待其完成后再试。' }))
    return
  }
  return new Promise((resolve) => {
    activeRun = true
    handingOff = false
    const autoStash = !!(options && options.stash)
    let stashedSomething = false
    let stashApplied = false
    let stashKept = false
    let settled = false
    let checkedOut = false   // 已切到目标版本（此后失败需自动回滚）
    let rolledBack = false   // 是否已自动回滚
    let rollingBack = false  // 回滚命令自己失败时不要再套一层回滚
    let rollbackReason = ''
    let status = undefined
    let from = undefined     // 更新/回退前的版本（失败自动回滚目标）；checkStatus 后赋值
    let target = undefined   // 检出目标；fetch 之后可能按最新 tag 重算
    const write = (payload) => {
      if (settled) return
      try {
        res.write(`${JSON.stringify(payload)}\n`)
      } catch { /* 响应已关闭/浏览器断开：忽略，不再写入 */ }
    }
    const finishFail = (error, didRollback) => {
      if (settled) return
      activeRun = false
      rolledBack = !!didRollback
      write({ type: 'done', ok: false, error, rolledBack })
      settled = true
      try { res.end() } catch { /* 连接已断开 */ }
      resolve()
    }
    // 已切到新版本之后的失败：checkout 回原 tag/commit，并重新 install + clean + build，
    // 避免工作树、node_modules 和被删掉的 lib/ 停在半更新状态。
    // 具体步骤在 runCommand 定义之后赋值（回滚要复用同一套命令流）。
    let rollbackRebuild = (error, rollbackRef) => {
      finishFail(`${error}（需要回滚到 ${rollbackRef}，但回滚流程尚未就绪）`, false)
    }
    const fail = (error) => {
      if (settled) return
      if (rollingBack) {
        finishFail(`${rollbackReason}（回滚过程中又失败：${error}）`, false)
        return
      }
      // 回滚目标必须是「更新前的确切 commit」，不能是最近 tag：
      // git describe --abbrev=0 返回的是最近的祖先 tag，HEAD 之后若还有本地提交，
      // checkout 回那个 tag 会把这几个提交从工作树上丢掉。localCommit 才是真 HEAD。
      const rollbackRef = status?.localCommit ?? from ?? ''
      // checkedOut 为 false 时不读 target 的比较结果之外的分支；target 此时可能仍是 undefined。
      if (!checkedOut || rollbackRef === undefined || rollbackRef === '' || rollbackRef === target) {
        finishFail(error, false)
        return
      }
      rollingBack = true
      rollbackReason = error
      try {
        rollbackRebuild(error, rollbackRef)
      } catch (rbError) {
        finishFail(`${error}（回滚流程异常：${rbError instanceof Error ? rbError.message : String(rbError)}）`, false)
      }
    }
    const endRun = (payload) => {
      if (settled) return
      activeRun = false
      write(payload)
      settled = true
      try { res.end() } catch { /* 连接已断开 */ }
      // handingOff 不能在这里清：交接后本进程还要活几秒，期间 /run 必须继续 409。
      // 但万一宿主拦了 SIGTERM 没退出，latch 会永久为 true、重启能力失效——
      // 兜底：交接后 90 秒仍在跑就复位，让用户还能手动重启。
      if (handingOff) {
        const timer = setTimeout(() => { handingOff = false; restartScheduled = false }, 90_000)
        if (typeof timer.unref === 'function') timer.unref()
      }
      resolve()
    }

    const start = async () => {
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
      // 强制更新：把「有 N 个对话正在进行」写进日志，事后能对上为什么页面断过。
      if (options.force === true) {
        const busy = countRunningAgents()
        if (busy > 0) write({ type: 'notice', text: `用户选择强制更新：当前有 ${String(busy)} 个对话正在进行，重启会中断它们。` })
      }

      // 显式更新不沿用 60 秒 remoteTag 缓存，避免用 fetch 前的旧目标。
      remoteTagCache = { at: 0, value: undefined }
      status = await checkStatus(repoDir, undefined, options.network)
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
  target = isRollback ? options.targetTag : status.remoteTag
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
    ? `回退开始：将把 deepseek-harness 回退到 ${target}。构建阶段会替换网页资源文件，整个页面可能突然变成空白——属正常现象；回退成功后会自动重启 dsh，新进程接管后本页会自动刷新，无需手动操作。`
    : '更新开始：构建阶段会替换网页资源文件，整个页面可能突然变成空白——页面变空白基本意味着更新已完成，只差重启生效；配置了自动重启时，新进程接管后本页会自动刷新，无需按 F5；未配置自动重启时，请在构建结束后手动重启 dsh 服务。' })

  // 子进程管线独立成模块级工厂（见 createProcessRunners）：主函数只留状态机。
  const { runGit, runCommand } = createProcessRunners({
    repoDir,
    write,
    fail,
    isSettled: () => settled,
  })

  rollbackRebuild = (error, rollbackRef) => performRollback({
    error,
    rollbackRef,
    repoDir,
    target,
    stashApplied,
    orphanLibRoots: options.orphanLibRoots,
    write,
    finishFail,
    runGit,
    runCommand,
    isSettled: () => settled,
  })

  const build = () => {
    // 构建是页面变空白高发阶段：替换网页 bundle 时页面可能突然整页变空白/长时间无输出。
    write({ type: 'notice', text: isRollback
      ? `即将执行 pnpm run build（回退到 ${target}，替换网页资源文件）：此时整个页面可能突然变成空白或长时间无输出，属正常现象，回退成功会自动重启 dsh，新进程接管后本页会自动刷新，无需按 F5。`
      : '即将执行 pnpm run build（替换网页资源文件）：此时整个页面可能突然变成空白或长时间无输出，属正常现象，页面变空白基本意味着更新已完成——配置了自动重启时，新进程接管后本页会自动刷新，无需按 F5；未配置自动重启时，请在构建结束后手动重启 dsh 服务。' })
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
      const doneBase = {
        from: status.localTag,
        to: target,
        rollback: isRollback,
        verifiedTag: verified.tag,
        verifiedCommit: verified.commit,
        stashApplied,
        stashKept,
      }
      if (options.autoRestart) {
        // 构建成功还不算更新成功：退出本进程释放端口，由 helper 拉起新 dsh 并
        // 检查启动日志。出现 did not activate / Failed to load plugins 则回滚。
        let handoff
        try {
          handoff = scheduleBootVerify({
            repoDir,
            target,
            rollbackRef: status.localCommit ?? from ?? '',
            port: options.port ?? null,
            orphanLibRoots: options.orphanLibRoots,
            bootHealthWindowMs: options.bootHealthWindowMs,
          })
        } catch (error) {
          fail(`构建已完成，但无法启动健康检查：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        handingOff = true
        endRun(buildDoneEvent(doneBase, {
          kind: 'build',
          autoRestart: true,
          logErr: handoff.logErr,
          restartInMs: 2000,
        }))
        setTimeout(() => { try { process.kill(process.pid, 'SIGTERM') } catch {} }, 2000)
      } else {
        // 不自动重启：客户端据此显示「请手动重启」，不会去等一个不会来的新进程。
        endRun(buildDoneEvent(doneBase, { kind: 'build', autoRestart: false }))
      }
    })
  }

  // 版本切换后，旧版本残留的 lib/（gitignore，git checkout 不会删）可能继续注入
  // 新 tag 已经删除的服务（contextMenus）。pnpm run clean 失败必须中止并回滚，
  // 不能带着脏 lib/ 继续 build。
  const cleanThenBuild = () => {
    runCommand('Running pnpm run clean (stale build output) …', ['run', 'clean'], (ccode, cerr) => {
      if (settled) return
      if (ccode !== 0) {
        fail(cerr !== '' ? `pnpm run clean failed: ${cerr}` : `pnpm run clean failed (exit ${String(ccode)})`)
        return
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
            runGit('Cleaning conflicted working tree …', ['reset', '--hard', 'HEAD'], (ccode2, cerr2) => {
              if (settled) return
              if (ccode2 !== 0) {
                write({ type: 'notice', text: `清理冲突工作树未完全成功（${cerr2 !== '' ? cerr2 : 'exit ' + String(ccode2)}），将继续尝试构建；若构建失败，请手动执行 git reset --hard HEAD 处理后再重试。` })
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
    // 以检出前的 HEAD 为准（不一定等于 tag：本地可能还有提交），
    // 这样「旧树有、新树没有」的包不会漏掉。
    const previousPackageDirs = listPackageDirs(repoDir, 'HEAD')
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
      const orphanRoots = Array.isArray(options.orphanLibRoots) ? options.orphanLibRoots : DEFAULT_ORPHAN_LIB_ROOTS
      const cleaned = previousPackageDirs.length === 0
        ? { removed: [], rejected: [], errors: [], skipped: 'could not list previous tree' }
        : removeOrphanLibsOnDisk(repoDir, previousPackageDirs, listPackageDirs(repoDir, 'HEAD'), orphanRoots)
      if (cleaned.skipped !== undefined) {
        write({ type: 'notice', text: `未能对比旧版本目录树（${cleaned.skipped}），将依赖 pnpm run clean 清掉过期产物。` })
      } else if (cleaned.removed.length > 0) {
        write({ type: 'notice', text: '已删除旧版本残留、且新版本中已不存在的 lib/：' + cleaned.removed.join(', ') })
      }
      if (cleaned.rejected.length > 0) {
        write({ type: 'notice', text: '已跳过不安全的 lib 路径（未删除）：' + cleaned.rejected.join(', ') })
      }
      if (cleaned.errors.length > 0) {
        fail('清理残留 lib/ 失败：' + cleaned.errors.join('; '))
        return
      }
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
      ? 'Windows 后台分离更新：运行中的 dsh 服务占用 node_modules 文件句柄，进程内 install 无法删除被锁旧包（这正是此前更新失败回滚的原因）。安装与构建已移交独立后台进程——本进程即将退出释放句柄，全部完成后会自动重启 dsh。页面断开属正常现象，请勿关闭本窗口，新进程接管后本页会自动刷新，无需手动操作。'
      : 'Windows 后台分离更新：运行中的 dsh 服务占用 node_modules 文件句柄，进程内 install 无法删除被锁旧包（这正是此前更新失败回滚的原因）。安装与构建已移交独立后台进程——本进程即将退出释放句柄；本次未配置自动重启，完成后请手动启动 dsh 服务。页面断开属正常现象。' })
    let handoff
    try {
      handoff = scheduleDetachedUpdate({
        repoDir,
        target,
        rollbackRef: status.localCommit ?? from ?? '',
        stashedSomething,
        autoRestart: !!options.autoRestart,
        port: options.port ?? null,
        orphanLibRoots: options.orphanLibRoots,
        bootHealthWindowMs: options.bootHealthWindowMs,
      })
    } catch (error) {
      fail(`无法启动后台更新进程：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // autoRestart 跟随真实配置（helper 在 false 时不会拉起新进程）；
    // detached 的 install+build 远超 90 秒默认轮询窗口，要放宽。
    const done = buildDoneEvent(
      { from: status.localTag, to: target, rollback: isRollback },
      {
        kind: 'detached',
        autoRestart: !!options.autoRestart,
        logErr: handoff.logErr,
        restartInMs: 0,
        restartWindowMs: 45 * 60_000,
      },
    )
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
  // 网络来源：mirror 只用镜像；github 只走官方（可带本地代理端口）；auto 直连失败再回退镜像。
  const net = options.network
  const proxyArgs = localProxyArgs(net)
  const mirrorUrl = net !== undefined && net.source === 'mirror'
    ? proxyUrlFor(origin, net.mirror.prefix)
    : undefined
  if (net !== undefined && net.source === 'mirror' && mirrorUrl === undefined) {
    fail('当前仓库 origin 不是 GitHub 地址，无法使用镜像')
    return
  }
  const beginStashOrCheckout = () => {
    if (settled) return
    if (autoStash) {
      // 1.5. Safely park ALL local changes so the checkout can never be blocked
      // by "would be overwritten" errors. `-u` 额外纳入未跟踪文件:若不加 `-u`,
      // 新版本新增/占用某个路径、而本地恰好有同路径未跟踪文件时,checkout 会持续
      // 报 "untracked working tree files would be overwritten"——而 stash 又不含未跟踪
      // 文件,「自动暂存并继续更新」会陷入死循环(每次点击都再次冲突)。`-u` 一并暂存
      // 未跟踪文件,更新成功后经 stash apply 原样恢复;gitignore 文件不受影响。
      // 先用 status --porcelain 检查工作树是否有改动：git stash push -u 无改动时
      // 把 "No local changes to save" 写到 stdout，runGit 的 serr 只有 stderr。
      let dirty
      try {
        dirty = gitSync(repoDir, ['status', '--porcelain'])
      } catch (statusErr) {
        fail(`git status failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`)
        return
      }
      if (dirty === '') {
        stashedSomething = false
        checkout()
        return
      }
      runGit('Stashing local changes (safe & recoverable) …', ['stash', 'push', '-u', '-m', `dsh-update: pre-update ${target}`], (scode, serr) => {
        if (settled) return
        const nothingToStash = /no local changes to save/i.test(serr || '')
        if (scode !== 0 && !nothingToStash) {
          fail(serr !== '' ? `git stash failed: ${serr}` : `git stash failed (exit ${String(scode)})`)
          return
        }
        stashedSomething = scode === 0 && !nothingToStash
        checkout()
      })
    } else {
      checkout()
    }
  }
  // 检出前的两道闸门：requiredPaths（默认拒绝）与插件 peer 冲突（默认需确认）。
  // Alpha tag 不会因为带 prerelease 被挡下，只在缺关键路径或 peer 冲突时停。
  const proceedAfterVerify = () => {
    if (settled) return
    const paths = Array.isArray(options.requiredPaths) ? options.requiredPaths : resolveRequiredPaths(undefined)
    const allowMissing = options.allowMissingRequiredPaths === true
    if (paths.length > 0) {
      write({ type: 'step', text: `正在核对 ${target} 是否包含 Web UI 必需路径…` })
      const found = missingRequiredPaths(repoDir, target, paths)
      const bad = [...found.invalid, ...found.missing]
      if (bad.length > 0 && !allowMissing) {
        const msg = tagHealthMessages(target, bad)
        endRun({
          type: 'tag-health',
          missing: found.missing,
          invalid: found.invalid,
          from: status.localTag,
          to: target,
          message: msg.zh,
          messageEn: msg.en,
        })
        return
      }
      if (bad.length > 0) {
        write({ type: 'notice', text: `已按显式覆盖跳过 requiredPaths 检查（缺失：${bad.join(', ')}）。Web UI 可能无法加载插件。 / Override accepted; the web UI may fail to load plugins.` })
      }
    }
    const policy = options.peerConflictPolicy === 'block' || options.peerConflictPolicy === 'ignore' || options.peerConflictPolicy === 'confirm'
      ? options.peerConflictPolicy
      : 'confirm'
    let conflicts = []
    try {
      conflicts = scanProfilePeerConflicts(target, options.profilesDir || resolveProfilesDir(undefined))
    } catch (error) {
      write({ type: 'notice', text: '扫描插件 peerDependency 失败（将继续更新）：' + (error instanceof Error ? error.message : String(error)) })
    }
    if (conflicts.length > 0) {
      const msg = peerConflictMessages(conflicts, target)
      if (policy === 'block') {
        fail(`${msg.zh}\n${msg.en}`)
        return
      }
      if (policy === 'confirm' && options.confirmPeerConflicts !== true) {
        endRun({
          type: 'peers',
          conflicts: msg.conflicts,
          from: status.localTag,
          to: target,
          message: msg.zh,
          messageEn: msg.en,
        })
        return
      }
      write({ type: 'notice', text: msg.zh })
    }
    beginStashOrCheckout()
  }
  const recomputeTarget = async () => {
    remoteTagCache = { at: 0, value: undefined }
    const remote = await remoteLatestTag(repoDir, options.network)
    const latest = remote.tag ?? latestEligibleTag(localTags(repoDir))
    if (latest === undefined) {
      fail('fetch 之后仍未找到 dsh-v* tag / no dsh-v* tag after fetch')
      return false
    }
    if (from !== undefined && compareTags(latest, from) <= 0) {
      endRun({ type: 'done', ok: true, skipped: true, from: status.localTag, to: latest, recomputed: true })
      return false
    }
    if (latest !== target) {
      write({ type: 'notice', text: `fetch 完成后重新计算最新版本：${target ?? '(无)'} → ${latest}（不再使用 fetch 前缓存的 remoteTag）。Alpha 版本仍可作为目标。` })
      target = latest
    }
    return true
  }
  // afterFetch 是 async：调用点必须接住 rejection，否则内部抛错会变成
  // unhandled rejection，fail() 不被调用，UI 永远停在「更新中」。
  const runAfterFetch = () => {
    void afterFetch().catch((error) => {
      if (settled) return
      fail(`fetch 后收尾失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const afterFetch = async () => {
    if (settled) return
    // 「fetch 后重算目标 / 已是最新就 skipped」只对更新有意义：回退的目标是用户
    // 显式选的历史 tag，绝不能被远程最新版覆盖，也不能因为「远程 <= 当前」被当成
    // skipped 直接结束（否则回退什么都没做，却报 ok:true）。
    if (isRollback) {
      runGit(`Verifying tag ${target} …`, ['rev-parse', '--verify', `${target}^{commit}`], (vcode) => {
        if (settled) return
        if (vcode !== 0) {
          fail(`未找到版本 ${target}（本地与远程均无此 tag）`)
          return
        }
        proceedAfterVerify()
      })
      return
    }
    const ok = await recomputeTarget()
    // await 期间可能被外部 settle（409 / 用户关页面）：必须复查，否则会继续往下走。
    if (settled || !ok) return
    proceedAfterVerify()
  }
  // mirror 来源：直接用镜像 fetch，不必先浪费一次直连超时。
  const firstFetchArgs = net !== undefined && net.source === 'mirror'
    ? ['-c', 'credential.helper=', 'fetch', '--tags', mirrorUrl]
    : [...proxyArgs, 'fetch', '--tags', origin]
  const fallbacks = net === undefined || net.source === 'auto'
    ? autoMirrorPrefixes()
      .map((prefix) => ({ prefix, url: proxyUrlFor(origin, prefix), meta: mirrorMetaForPrefix(prefix) }))
      .filter((item) => item.url !== undefined)
    : []
  const tryMirrorFetch = (idx) => {
    if (settled) return
    const item = fallbacks[idx]
    write({ type: 'notice', text: `GitHub 直连失败，正在通过 ${item.meta.label} 镜像重试 …` })
    runGit(`Fetching tags via ${item.meta.label} mirror … (target ${target})`, ['-c', 'credential.helper=', 'fetch', '--tags', item.url], (pcode, perr) => {
      if (settled) return
      if (pcode === 0) {
        lastWorkingMirrorPrefix = item.prefix
        runAfterFetch()
        return
      }
      if (idx + 1 < fallbacks.length) {
        tryMirrorFetch(idx + 1)
        return
      }
      fail(perr !== '' ? `git fetch failed（直连与镜像均失败）: ${perr}` : `git fetch failed（直连与镜像均失败，exit ${String(pcode)}）`)
    }, GIT_TIMEOUT_MS)
  }
  runGit(`Fetching tags from ${net !== undefined && net.source === 'mirror' ? net.mirror.label + ' mirror' : 'origin'} … (target ${target})`, firstFetchArgs, (code, err) => {
    if (settled) return
    if (code !== 0) {
      if (fallbacks.length > 0) {
        tryMirrorFetch(0)
        return
      }
      fail(err !== '' ? `git fetch failed: ${err}` : `git fetch failed (exit ${String(code)})`)
      return
    }
    runAfterFetch()
  }, DIRECT_FETCH_TIMEOUT_MS)
    }
    void start().catch((error) => {
      if (!settled) {
        finishFail(error instanceof Error ? error.message : String(error), false)
      } else {
        resolve()
      }
    })
  })
}
/**
 * Adapt the node:http-style `res` interface used throughout this plugin's
 * handlers (including the long-lived SSE in {@link runUpdateStreaming}) onto a
 * WHATWG `Response`, so the routes can be mounted on DSH's shared `/api`
 * Fetch route table instead of the bare `webServer`.
 *
 * Why: registering on `ctx.connection.fetch.register` puts the host's trust
 * fence (Host/Origin, DNS-rebinding) and browser authentication in front of
 * every route — an anonymous web page can no longer drive a real update.
 * `runUpdateStreaming` still sees the same `writeHead/write/end/flushHeaders/on`
 * surface it has always used, so its rollback/stash/SSE logic is untouched.
 *
 * A Response snapshots its status and headers at construction, but our handlers
 * call `writeHead` asynchronously. So `run()` starts the handler, waits for its
 * first `writeHead`, and only then builds the Response around a stream that
 * replays buffered chunks and forwards later ones. The stream stays open until
 * `end()` (i.e. the handler/pipeline settles), which is what keeps SSE alive.
 */
function fetchResponseFromRes() {
  let controller
  let ended = false
  const pending = []
  let headResolve
  const headReady = new Promise((resolve) => { headResolve = resolve })
  let status = 200
  const headers = {}
  let headWritten = false

  const push = (chunk) => {
    if (ended) return
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    if (controller) {
      try { controller.enqueue(bytes) } catch { ended = true }
    } else {
      pending.push(bytes)
    }
  }

  const res = {
    writeHead(code, h) {
      status = code
      if (h && typeof h === 'object') {
        for (const [name, value] of Object.entries(h)) headers[name] = String(value)
      }
      if (!headWritten) { headWritten = true; headResolve() }
      return res
    },
    flushHeaders() { if (!headWritten) { headWritten = true; headResolve() } },
    write(chunk) { push(chunk); return !ended },
    end(chunk) {
      if (ended) return
      if (chunk !== undefined) push(chunk)
      ended = true
      if (controller) { try { controller.close() } catch { /* already closed */ } }
    },
    // runUpdateStreaming registers res.on('error', …) as a disconnect guard;
    // cancellation closes the controller, after which write() silently no-ops.
    on() { return res },
  }

  /** Start the handler; resolve with its Response once headers are written. */
  const run = async (handlerPromise) => {
    // Surface handler rejections as a final JSON line, never as an unhandled rejection.
    Promise.resolve(handlerPromise).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error)
      res.write(`${JSON.stringify({ type: 'done', ok: false, error: detail })}\n`)
      res.end()
    }).finally(() => {
      // A handler that returns without writing a head still answers (200/no body).
      if (!headWritten) res.writeHead(200)
    })
    await headReady
    const body = new ReadableStream({
      start(ctrl) {
        controller = ctrl
        for (const bytes of pending) {
          try { ctrl.enqueue(bytes) } catch { ended = true; break }
        }
        pending.length = 0
        if (ended) { try { ctrl.close() } catch { /* closed */ } }
      },
      cancel() { ended = true },
    })
    return new Response(body, { status, headers })
  }
  return { res, run }
}

/**
 * Wrap one existing `(req, res)` route handler as a DSH exact Fetch handler.
 * The host has already applied `connection`'s trust fence and browser
 * authentication before this runs. The adapter gives the handler the small
 * slice of node:http `IncomingMessage` it actually uses (`method`, `url`,
 * `headers`, async-iterable body); there is deliberately no `socket`, so the
 * plugin's old hand-rolled loopback fence is removed from the handlers below —
 * the host admission is now the single authority.
 */
function asFetchRoute(handler) {
  return async (request) => {
    const { res, run } = fetchResponseFromRes()
    const headers = {}
    for (const [name, value] of request.headers.entries()) headers[name] = value
    const req = {
      method: request.method,
      url: request.url,
      headers,
      async *[Symbol.asyncIterator]() {
        if (request.body === null) return
        const reader = request.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            yield Buffer.from(value)
          }
        } finally { reader.releaseLock() }
      },
    }
    return run(handler(req, res))
  }
}

/**
 * Mount the /api/dsh-update route family on DSH's shared, authenticated Fetch
 * route table. The host applies `connection`'s trust fence and browser
 * authentication before a request ever reaches these handlers.
 * @param {object} ctx - host plugin context carrying connection / webServer / agents.
 * @param {object} [config] - optional { repoDir } override (defaults to the cwd).
 */
export function apply(ctx, config) {
  const repoDir = resolveRepoDir(config)
  gitProxy = resolveGitProxy(config)
  // 进行中对话探测用；拿不到就保持 undefined（countRunningAgents 按 0 处理）。
  try { agentsFace = ctx.agents } catch { agentsFace = undefined }
  const handleStatus = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    // ?source=auto|github|mirror&mirror=<id>&proxyPort=<n> —— 用户在浮层里换来源后
    // 立刻按新网络重查，不再吃上一次的缓存。
    const choice = parseNetworkChoice(req.url)
    let body
    try {
      body = JSON.stringify(await checkStatus(repoDir, config, choice))
    } catch (error) {
      // async 化后异常不会像同步那样被路由层看到：必须自己回一个明确的 JSON，
      // 否则请求会挂住、客户端一直转圈。
      body = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
    res.end(body)
  }

  /** 极轻量探活：不读 git、不扫 profile，重启轮询专用。 */
  const handlePing = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    // 会回带 pid / boot / inFlight；鉴权由宿主 connection 统一负责。
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, boot: BOOT_ID, pid: process.pid, inFlight: updateInFlight() }))
  }

  const handleNotes = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    let tag
    try {
      tag = new URL(req.url ?? '', 'http://x').searchParams.get('tag')
    } catch { /* invalid URL → 400 below */ }
    if (typeof tag !== 'string' || parseTag(tag) === undefined) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'missing or invalid tag' }))
      return
    }
    const result = await releaseNotesFor(repoDir, tag, parseNetworkChoice(req.url))
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer' })
    res.end(JSON.stringify(result))
  }

  const handleRestart = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    // 鉴权由宿主 connection 统一负责（Host/Origin 信任栅栏 + 浏览器登录态）。
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
    const MAX_RUN_BODY_BYTES = 65536
    let options = {}
    try {
      const chunks = []
      let totalBytes = 0
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buf.byteLength
        if (totalBytes > MAX_RUN_BODY_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }))
          return
        }
        chunks.push(buf)
      }
      const rawBody = Buffer.concat(chunks).toString('utf8').trim()
      if (rawBody !== '') {
        const parsed = JSON.parse(rawBody)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          options = parsed
        }
      }
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
    // 客户端只能带上 stash / targetTag / 两枚确认开关 / 网络来源。路径、策略、扫描目录以 config 为准。
    // await 覆盖完整回调流水线：runUpdateStreaming 内部包装了完整生命周期的 Promise，
    // 确保任何阶段抛错都能被 .catch() 接住、关闭 SSE 流并复位 activeRun latch。
    await runUpdateStreaming(repoDir, res, {
      stash: options.stash === true,
      network: normalizeSource(options),
      // 前端已做「有进行中的对话」二次确认；force 只表示用户选择了强制更新。
      force: options.force === true,
      targetTag: typeof options.targetTag === 'string' ? options.targetTag : undefined,
      confirmPeerConflicts: options.confirmPeerConflicts === true,
      port: servingPort(req),
      autoRestart,
      windowsDetachedUpdate,
      requiredPaths: resolveRequiredPaths(config),
      peerConflictPolicy: resolvePeerConflictPolicy(config),
      orphanLibRoots: resolveOrphanLibRoots(config),
      profilesDir: resolveProfilesDir(config),
      bootHealthWindowMs: resolveBootHealthWindowMs(config),
      allowMissingRequiredPaths: (config !== undefined && config.allowMissingRequiredPaths === true) || options.allowMissingRequiredPaths === true,
    }).catch((error) => {
      // 兜底：内部若仍漏了某条抛错路径，这里保证流被关掉、latch 被复位。
      try {
        const detail = error instanceof Error ? error.message : String(error)
        res.write(`${JSON.stringify({ type: 'done', ok: false, error: `更新流程异常中断：${detail}` })}\n`)
      } catch { /* 响应已关闭 */ }
      try { res.end() } catch { /* 已结束 */ }
      releaseRunLatch()
    })
  }

  // Register on the shared, authenticated /api route table. The host's
  // `connection` carrier applies its trust fence and browser authentication
  // before any of these handlers run — a web page the user has open in their
  // browser can no longer call them (the flaw the plugin-directory review
  // flagged). `requestBody` mirrors each handler's body usage.
  ctx.effect(() => {
    const disposers = [
      ctx.connection.fetch.register({
        path: UPDATE_PATHS.status, methods: ['GET'], requestBody: 'buffered', fetch: asFetchRoute(handleStatus),
      }),
      ctx.connection.fetch.register({
        path: UPDATE_PATHS.ping, methods: ['GET'], requestBody: 'buffered', fetch: asFetchRoute(handlePing),
      }),
      ctx.connection.fetch.register({
        path: UPDATE_PATHS.notes, methods: ['GET'], requestBody: 'buffered', fetch: asFetchRoute(handleNotes),
      }),
      ctx.connection.fetch.register({
        path: UPDATE_PATHS.run, methods: ['POST'], requestBody: 'streaming', fetch: asFetchRoute(handleRun),
      }),
      ctx.connection.fetch.register({
        path: UPDATE_PATHS.restart, methods: ['POST'], requestBody: 'buffered', fetch: asFetchRoute(handleRestart),
      }),
    ]
    return async () => { for (const dispose of disposers) await dispose() }
  }, 'dsh-update: authenticated routes')
}

export default { name, inject, apply }
