/**
 * Pure helpers for the update safety gates (tag health, orphan lib cleanup,
 * peerDependency checks, boot-log failure detection). No plugin side effects.
 *
 * Alpha tags stay eligible: nothing here filters the prerelease channel.
 * `requiredPaths` refuses a checkout that would boot a broken web UI; it does
 * not block alphas that still ship those paths.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Prefix of the version tags the harness publishes (e.g. dsh-v0.2.2-alpha.2). */
export const TAG_PREFIX = 'dsh-v'

/** Paths that must exist in the target tag or the web UI can fail to boot. */
export const DEFAULT_REQUIRED_PATHS = ['packages/client/ui-context-menu/package.json']

/** Package roots whose disappeared `lib/` output may be deleted after checkout. */
export const DEFAULT_ORPHAN_LIB_ROOTS = ['packages', 'apps']

const GIT_ENV = {
  ...(typeof process === 'object' ? process.env : {}),
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  LANG: 'C',
}

/** Parse `dsh-v0.1.0-rc.7` into comparable parts (undefined when not a tag). */
export function parseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return undefined
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
 * Non-tag inputs sort below every tag (defensive; callers filter anyway).
 * Prerelease ordering follows semver (alpha.2 < alpha.10 < the release). */
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

/** Highest dsh-v* tag, including alphas. Non-tags are ignored. */
export function latestEligibleTag(tags) {
  let latest
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    if (parseTag(tag) === undefined) continue
    if (latest === undefined || compareTags(tag, latest) > 0) latest = tag
  }
  return latest
}

/** `dsh-v0.2.2-alpha.2` → `0.2.2-alpha.2` (the harness version peers pin against). */
export function harnessVersionFromTag(tag) {
  const parsed = parseTag(tag)
  if (parsed === undefined) return undefined
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length === 0 ? core : `${core}-${parsed.prerelease.join('.')}`
}

function parseSemver(input) {
  if (typeof input !== 'string') return undefined
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function semverTag(sem) {
  const core = `${sem.major}.${sem.minor}.${sem.patch}`
  const body = sem.prerelease.length === 0 ? core : `${core}-${sem.prerelease.join('.')}`
  return `${TAG_PREFIX}${body}`
}

/** >0 when a > b. Both arguments are full semver objects. */
function compareSemver(a, b) {
  return compareTags(semverTag(a), semverTag(b))
}

/**
 * Expand one range token into AND-comparators `{ op, sem }`.
 * Supports exact, ^, ~, comparison ops, `X` / `X.Y` / `X.Y.Z`, and `*`.
 * Returns undefined when the token is not a version range we understand.
 */
function expandRangeToken(token) {
  if (token === '*' || token === 'x' || token === 'X') {
    return [{ op: 'any', sem: { major: 0, minor: 0, patch: 0, prerelease: [] } }]
  }
  const wild = /^(>=|<=|>|<|\^|~|=|==)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(token)
  if (wild === null) return undefined
  const opRaw = wild[1] || ''
  const part = (value) => {
    if (value === undefined) return undefined
    if (value === 'x' || value === 'X' || value === '*') return 'x'
    return Number(value)
  }
  const major = part(wild[2])
  const minor = part(wild[3])
  const patch = part(wild[4])
  const prerelease = wild[5] === undefined ? [] : wild[5].split('.')
  if (major === 'x') return [{ op: 'any', sem: { major: 0, minor: 0, patch: 0, prerelease: [] } }]
  const hasWild = minor === 'x' || patch === 'x'
  const full = {
    major,
    minor: minor === undefined || minor === 'x' ? 0 : minor,
    patch: patch === undefined || patch === 'x' ? 0 : patch,
    prerelease: hasWild || minor === undefined || patch === undefined ? [] : prerelease,
  }
  if (hasWild || (opRaw === '' && (minor === undefined || patch === undefined))) {
    if (minor === undefined || minor === 'x') {
      return [
        { op: '>=', sem: { major, minor: 0, patch: 0, prerelease: [] } },
        { op: '<', sem: { major: major + 1, minor: 0, patch: 0, prerelease: [] } },
      ]
    }
    return [
      { op: '>=', sem: { major, minor: full.minor, patch: 0, prerelease: [] } },
      { op: '<', sem: { major, minor: full.minor + 1, patch: 0, prerelease: [] } },
    ]
  }
  if (opRaw === '^') {
    let upper
    if (full.major > 0) upper = { major: full.major + 1, minor: 0, patch: 0, prerelease: [] }
    else if (full.minor > 0) upper = { major: 0, minor: full.minor + 1, patch: 0, prerelease: [] }
    else upper = { major: 0, minor: 0, patch: full.patch + 1, prerelease: [] }
    return [{ op: '>=', sem: { ...full, prerelease } }, { op: '<', sem: upper }]
  }
  if (opRaw === '~') {
    return [
      { op: '>=', sem: { ...full, prerelease } },
      { op: '<', sem: { major: full.major, minor: full.minor + 1, patch: 0, prerelease: [] } },
    ]
  }
  const op = opRaw === '' || opRaw === '==' ? '=' : opRaw
  return [{ op, sem: { ...full, prerelease } }]
}

function satisfiesOp(version, op, sem) {
  if (op === 'any') return true
  const diff = compareSemver(version, sem)
  if (op === '=') return diff === 0
  if (op === '>') return diff > 0
  if (op === '>=') return diff >= 0
  if (op === '<') return diff < 0
  if (op === '<=') return diff <= 0
  return false
}

/** node-semver rule: a prerelease only matches a set that pins the same tuple. */
function prereleaseAllowed(version, comparators) {
  if (version.prerelease.length === 0) return true
  if (comparators.some((item) => item.op === 'any')) return true
  return comparators.some((item) => item.sem.prerelease.length > 0
    && item.sem.major === version.major
    && item.sem.minor === version.minor
    && item.sem.patch === version.patch)
}

function satisfiesComparatorSet(version, expr) {
  const tokens = expr.split(/\s+/).filter((part) => part !== '')
  if (tokens.length === 0) return false
  const comparators = []
  for (const token of tokens) {
    const expanded = expandRangeToken(token)
    if (expanded === undefined) return false
    comparators.push(...expanded)
  }
  if (!prereleaseAllowed(version, comparators)) return false
  return comparators.every((item) => satisfiesOp(version, item.op, item.sem))
}

/**
 * Whether `version` satisfies an npm-style range. `*`, `x`, and `workspace:*`
 * always match. Unknown ranges do not — callers treat that as a conflict.
 * Prerelease versions (alphas) do not satisfy a stable range such as `^0.2.0`.
 */
export function semverSatisfies(version, range) {
  const ver = parseSemver(version)
  if (ver === undefined) return false
  if (typeof range !== 'string') return false
  const raw = range.trim()
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X' || raw === 'latest') return true
  if (raw.startsWith('workspace:')) return true
  return raw.split(/\s*\|\|\s*/).some((part) => part.trim() !== '' && satisfiesComparatorSet(ver, part.trim()))
}

const HARNESS_PEER_NAME = /dsh|harness|deepseek/i

/** peerDependencies of one manifest that do not accept `targetVersion`. */
export function peerConflictsInManifest(manifest, targetVersion) {
  const peers = manifest && manifest.peerDependencies
  if (peers === null || typeof peers !== 'object') return []
  if (parseSemver(targetVersion) === undefined) return []
  const conflicts = []
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string' || !HARNESS_PEER_NAME.test(name)) continue
    if (!semverSatisfies(targetVersion, range)) conflicts.push({ name, range, target: targetVersion })
  }
  return conflicts
}

export function peerConflictMessages(conflicts, tag) {
  const lines = conflicts.slice(0, 40).map((item) => (
    `• ${item.profile} / ${item.plugin}: ${item.dependency}@${item.range} 不满足 ${item.target}`
  ))
  const body = lines.join('\n')
  return {
    zh: `目标 ${tag} 与已安装插件的 peerDependency 可能冲突（WorkBuddy 一类插件常把 harness / dsh 包钉在旧版本）。继续更新可能导致这些插件无法激活：\n${body}`,
    en: `Target ${tag} may conflict with installed plugins' peerDependencies (WorkBuddy-style pins on harness/dsh packages). Continuing can leave those plugins unable to activate:\n${body}`,
    conflicts: conflicts.slice(0, 40),
  }
}

function readJson(file) {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 1_000_000) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function walkPluginManifests(dir, depth, out) {
  if (depth < 0 || !existsSync(dir)) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name === '.git') continue
    const pkg = join(dir, ent.name, 'package.json')
    if (existsSync(pkg)) out.push(pkg)
    if (depth > 0) walkPluginManifests(join(dir, ent.name), depth - 1, out)
  }
}

/**
 * Scan each profile package.json, each direct dependency's package.json,
 * and plugins/package.json (two levels) for harness peer conflicts
 * with the target tag. Returns `{ profile, plugin, dependency, range, target }`.
 * Missing directories yield `[]` — alphas are not blocked just because no
 * profile is installed.
 */
export function scanProfilePeerConflicts(targetTag, profilesDir) {
  const version = harnessVersionFromTag(targetTag)
  if (version === undefined || typeof profilesDir !== 'string' || profilesDir === '') return []
  if (!existsSync(profilesDir)) return []
  let profiles
  try { profiles = readdirSync(profilesDir, { withFileTypes: true }) } catch { return [] }
  const conflicts = []
  for (const ent of profiles) {
    if (!ent.isDirectory()) continue
    if (conflicts.length >= 40) break
    const profileDir = join(profilesDir, ent.name)
    const seen = new Set()
    const files = []
    const profilePkg = join(profileDir, 'package.json')
    if (existsSync(profilePkg)) files.push(profilePkg)
    walkPluginManifests(join(profileDir, 'plugins'), 2, files)
    const profileJson = readJson(profilePkg)
    const depNames = Object.keys({
      ...(profileJson && profileJson.dependencies),
      ...(profileJson && profileJson.devDependencies),
      ...(profileJson && profileJson.optionalDependencies),
    })
    for (const dep of depNames) {
      const depPkg = join(profileDir, 'node_modules', dep, 'package.json')
      if (existsSync(depPkg)) files.push(depPkg)
    }
    for (const file of files) {
      if (seen.has(file) || conflicts.length >= 40) continue
      seen.add(file)
      const json = readJson(file)
      if (json === undefined) continue
      for (const item of peerConflictsInManifest(json, version)) {
        conflicts.push({
          profile: ent.name,
          plugin: typeof json.name === 'string' && json.name !== '' ? json.name : ent.name,
          dependency: item.name,
          range: item.range,
          target: item.target,
        })
        if (conflicts.length >= 40) break
      }
    }
  }
  return conflicts
}

export function resolveProfilesDir(config, env = process.env, home = homedir()) {
  if (config && typeof config.profilesDir === 'string' && config.profilesDir !== '') return config.profilesDir
  if (env && typeof env.DSH_UPDATE_PROFILES_DIR === 'string' && env.DSH_UPDATE_PROFILES_DIR !== '') {
    return env.DSH_UPDATE_PROFILES_DIR
  }
  return join(home, '.dsh', 'profiles')
}

export function resolveRequiredPaths(config, env = process.env) {
  if (config && Array.isArray(config.requiredPaths)) {
    return config.requiredPaths.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  }
  if (env && env.DSH_UPDATE_REQUIRED_PATHS !== undefined) {
    return String(env.DSH_UPDATE_REQUIRED_PATHS).split(',').map((item) => item.trim()).filter((item) => item !== '')
  }
  return [...DEFAULT_REQUIRED_PATHS]
}

export function resolveOrphanLibRoots(config) {
  if (config && Array.isArray(config.orphanLibRoots)) {
    return config.orphanLibRoots.filter((item) => typeof item === 'string' && /^[A-Za-z0-9._-]+$/.test(item))
  }
  return [...DEFAULT_ORPHAN_LIB_ROOTS]
}

export function resolvePeerConflictPolicy(config) {
  const value = config && config.peerConflictPolicy
  if (value === 'block' || value === 'ignore' || value === 'confirm') return value
  return 'confirm'
}

export function resolveBootHealthWindowMs(config) {
  const value = config && config.bootHealthWindowMs
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120_000) return value
  return 15_000
}

/** Relative path safe to join onto the repo and to pass to `git cat-file`. */
export function isSafeRepoRelPath(input) {
  if (typeof input !== 'string' || input === '' || input.length > 240) return false
  if (input.includes('\\') || input.includes('\0') || input.includes(':')) return false
  if (input.startsWith('/') || input.startsWith('~') || input.endsWith('/')) return false
  if (/^[a-zA-Z]:/.test(input)) return false
  const parts = input.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('..'))) return false
  return true
}

/** Git rev / tag we are willing to interpolate into `rev:path`. */
export function isSafeRev(rev) {
  return typeof rev === 'string'
    && rev !== ''
    && rev.length <= 200
    && !rev.startsWith('-')
    && /^[A-Za-z0-9._^/~-]+$/.test(rev)
    && !rev.includes('..')
}

/** True when `rev:relPath` exists in the repo (blob or tree). */
export function revisionHasPath(repoDir, rev, relPath) {
  if (!isSafeRepoRelPath(relPath) || !isSafeRev(rev)) return false
  try {
    execFileSync('git', ['-C', repoDir, 'cat-file', '-e', `${rev}:${relPath}`], {
      stdio: 'ignore',
      env: GIT_ENV,
      timeout: 30_000,
    })
    return true
  } catch {
    return false
  }
}

export function missingRequiredPaths(repoDir, rev, paths) {
  const missing = []
  const invalid = []
  const list = Array.isArray(paths) ? paths : []
  for (const item of list) {
    if (!isSafeRepoRelPath(item)) {
      invalid.push(String(item))
      continue
    }
    if (!revisionHasPath(repoDir, rev, item)) missing.push(item)
  }
  return { missing, invalid }
}

export function tagHealthMessages(tag, missing) {
  const list = missing.join(', ')
  const contextMenu = missing.some((item) => item.includes('ui-context-menu') || item.includes('contextMenus'))
  if (contextMenu) {
    return {
      zh: `已拒绝检出 ${tag}：目标 tag 中不存在 ${list}。该版本没有 contextMenus 服务（没有 packages/client/ui-context-menu，也就没有 provide("contextMenus")）。若磁盘上仍留着上一版 gitignore 的 lib/，旧产物还会注入 contextMenus，Web UI 会停在 “Failed to load plugins / N entries did not activate”。默认拒绝检出。只有在你明确接受 Web UI 损坏时才应覆盖。`,
      en: `Refusing to check out ${tag}: missing ${list}. This tag does not ship the contextMenus service (no packages/client/ui-context-menu, so nothing calls provide("contextMenus")). Stale gitignored lib/ from the previous checkout can still inject contextMenus, and the web UI then sticks on “Failed to load plugins / N entries did not activate”. Override only if you accept a broken web UI.`,
    }
  }
  return {
    zh: `已拒绝检出 ${tag}：目标 tag 缺少必要路径 ${list}。继续更新可能导致 Web UI 无法加载插件。`,
    en: `Refusing to check out ${tag}: required path(s) missing (${list}). Checking out would risk a broken web UI.`,
  }
}

/** Package directory (not the `lib` child) under an allowed root, no traversal. */
export function isWhitelistedPackageRel(rel, roots) {
  if (typeof rel !== 'string') return false
  const norm = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (norm === '' || norm.startsWith('/') || norm.includes('\0') || norm.includes(':')) return false
  if (/^[a-zA-Z]:/.test(norm)) return false
  const parts = norm.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('..'))) return false
  if (!Array.isArray(roots) || !roots.includes(parts[0])) return false
  if (parts.length < 2) return false
  return true
}

export function isSafeLibRel(rel, roots) {
  if (typeof rel !== 'string' || !rel.endsWith('/lib')) return false
  return isWhitelistedPackageRel(rel.slice(0, -'/lib'.length), roots)
}

/** Package dirs whose package.json existed before and does not exist now. */
export function orphanPackageLibRels(oldDirs, newDirs, roots) {
  const next = new Set(Array.isArray(newDirs) ? newDirs : [])
  const allow = Array.isArray(roots) ? roots : []
  const out = []
  if (!Array.isArray(oldDirs)) return out
  for (const dir of oldDirs) {
    if (typeof dir !== 'string' || next.has(dir)) continue
    if (!isWhitelistedPackageRel(dir, allow)) continue
    out.push(`${dir}/lib`)
  }
  return out
}

export function packageDirsFromListing(text) {
  if (typeof text !== 'string' || text === '') return []
  const dirs = []
  for (const line of text.split(/\r?\n/)) {
    const path = line.trim().replace(/\\/g, '/')
    if (!path.endsWith('/package.json')) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (dir === '' || dir.includes('..') || dir.startsWith('/')) continue
    dirs.push(dir)
  }
  return dirs
}

export function listPackageDirs(repoDir, rev) {
  if (!isSafeRev(rev)) return []
  try {
    const output = execFileSync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', rev], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
      timeout: 60_000,
    })
    return packageDirsFromListing(output)
  } catch {
    return []
  }
}

function isLexicalInside(root, abs) {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Delete `<package>/lib` for packages present in `oldDirs` but not `newDirs`,
 * and only under `roots` (default packages/ and apps/). Symlinks are unlinked,
 * never followed. Paths that escape the repo are rejected and left untouched.
 */
export function removeOrphanLibsOnDisk(repoDir, oldDirs, newDirs, roots) {
  const removed = []
  const rejected = []
  const errors = []
  const root = resolve(repoDir)
  let realRoot = root
  try { realRoot = realpathSync(root) } catch { /* keep lexical root */ }
  for (const rel of orphanPackageLibRels(oldDirs, newDirs, roots)) {
    if (!isSafeLibRel(rel, roots)) {
      rejected.push(rel)
      continue
    }
    const abs = resolve(root, rel)
    if (!isLexicalInside(root, abs)) {
      rejected.push(rel)
      continue
    }
    if (!existsSync(abs)) continue
    let stat
    try { stat = lstatSync(abs) } catch (error) {
      errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (stat.isSymbolicLink()) {
      try {
        rmSync(abs, { recursive: false, force: true })
        removed.push(rel)
      } catch (error) {
        errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (!stat.isDirectory()) {
      rejected.push(rel)
      continue
    }
    let real
    try { real = realpathSync(abs) } catch (error) {
      errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!isLexicalInside(realRoot, real)) {
      rejected.push(rel)
      continue
    }
    try {
      rmSync(abs, { recursive: true, force: true })
      removed.push(rel)
    } catch (error) {
      errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { removed, rejected, errors }
}

/**
 * Boot-log signals that mean the new web UI did not come up healthy.
 * Matches the harness failure mode: plugins stuck on a missing service.
 */
export function bootLogFailureReason(text) {
  if (typeof text !== 'string' || text === '') return undefined
  for (const line of text.split(/\r?\n/)) {
    // Helper notes share the log file. Only the harness process output counts.
    if (line.includes('[dsh-update]')) continue
    // "0 entries did not activate" is a clean boot summary; any other hit is a failure.
    if (/did not activate/i.test(line) && !/\b0 entries did not activate/i.test(line)) return 'did not activate'
    if (/failed to load plugins/i.test(line)) return 'Failed to load plugins'
    if (/HARNESS/i.test(line) && /plugin/i.test(line) && /fail/i.test(line)) return 'HARNESS plugin load failure'
  }
  return undefined
}
