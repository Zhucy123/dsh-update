import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bootLogFailureReason,
  compareTags,
  harnessVersionFromTag,
  isSafeRepoRelPath,
  isWhitelistedPackageRel,
  latestEligibleTag,
  missingRequiredPaths,
  orphanPackageLibRels,
  packageDirsFromListing,
  peerConflictMessages,
  peerConflictsInManifest,
  removeOrphanLibsOnDisk,
  resolveRequiredPaths,
  revisionHasPath,
  scanProfilePeerConflicts,
  semverSatisfies,
  tagHealthMessages,
  DEFAULT_REQUIRED_PATHS,
} from '../lib/safety.js'
import { bootVerifyHelperSource, updateHelperSource } from '../lib/index.js'

const MENU = 'packages/client/ui-context-menu/package.json'

test('compareTags keeps alpha ordering and does not drop prereleases', () => {
  assert.ok(compareTags('dsh-v0.2.2-alpha.2', 'dsh-v0.2.2-alpha.10') < 0)
  assert.ok(compareTags('dsh-v0.2.2-alpha.2', 'dsh-v0.2.2') < 0)
  assert.ok(compareTags('dsh-v0.2.2-alpha.2', 'dsh-v0.2.1') > 0)
  assert.equal(compareTags('dsh-v0.2.2-alpha.2', 'dsh-v0.2.2-alpha.2'), 0)
  assert.ok(compareTags('not-a-tag', 'dsh-v0.0.1') < 0)
  assert.equal(
    latestEligibleTag(['dsh-v0.2.1', 'dsh-v0.2.2-alpha.2', 'dsh-v0.2.2-alpha.10', 'nightly']),
    'dsh-v0.2.2-alpha.10',
  )
  assert.equal(
    latestEligibleTag(['dsh-v0.2.2', 'dsh-v0.2.2-alpha.10']),
    'dsh-v0.2.2',
  )
})

test('harnessVersionFromTag strips the dsh-v prefix', () => {
  assert.equal(harnessVersionFromTag('dsh-v0.2.2-alpha.2'), '0.2.2-alpha.2')
  assert.equal(harnessVersionFromTag('dsh-v1.0.0'), '1.0.0')
  assert.equal(harnessVersionFromTag('v0.2.2'), undefined)
})

test('semverSatisfies: stable ranges do not accept alphas; exact and caret prerelease do', () => {
  assert.equal(semverSatisfies('0.2.2-alpha.2', '*'), true)
  assert.equal(semverSatisfies('0.2.2-alpha.2', 'workspace:*'), true)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '0.2.2-alpha.2'), true)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '0.2.1'), false)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '^0.2.0'), false)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '>=0.2.0'), false)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '^0.2.2-alpha.1'), true)
  assert.equal(semverSatisfies('0.2.2-alpha.2', '>=0.2.2-alpha.0 <0.3.0'), true)
  assert.equal(semverSatisfies('0.2.2', '^0.2.0'), true)
  assert.equal(semverSatisfies('1.2.3', '~1.2.0'), true)
  assert.equal(semverSatisfies('1.2.0', '~1.1.0'), false)
  assert.equal(semverSatisfies('1.2.3', '^1.0.0 || 9.9.9'), true)
  assert.equal(semverSatisfies('1.2.3', 'github:example/not-a-range'), false)
})

test('peer conflicts flag WorkBuddy-style pins and ignore unrelated peers', () => {
  const conflicts = peerConflictsInManifest({
    name: '@example/workbuddy',
    peerDependencies: {
      react: '^18.2.0',
      '@deepseek-ai/dsh-client-runtime': '0.2.1',
      'deepseek-harness': '^0.2.2-alpha.1',
    },
  }, '0.2.2-alpha.2')
  assert.deepEqual(conflicts.map((item) => item.name), ['@deepseek-ai/dsh-client-runtime'])
  const text = peerConflictMessages([{
    profile: 'web',
    plugin: '@example/workbuddy',
    dependency: '@deepseek-ai/dsh-client-runtime',
    range: '0.2.1',
    target: '0.2.2-alpha.2',
  }], 'dsh-v0.2.2-alpha.2')
  assert.match(text.zh, /WorkBuddy/)
  assert.match(text.en, /WorkBuddy/)
  assert.match(text.zh, /0\.2\.1/)
})

test('profile scan reads profile, nested plugins, and direct dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  const profile = join(root, 'web')
  mkdirSync(join(profile, 'plugins', 'extra'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@example', 'workbuddy'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { '@example/workbuddy': '1.0.0' },
  }))
  writeFileSync(join(profile, 'plugins', 'extra', 'package.json'), JSON.stringify({
    name: '@example/nested',
    peerDependencies: { dsh: '0.2.0' },
  }))
  writeFileSync(join(profile, 'node_modules', '@example', 'workbuddy', 'package.json'), JSON.stringify({
    name: '@example/workbuddy',
    peerDependencies: { '@deepseek-ai/deepseek-harness': '0.2.1' },
  }))
  const found = scanProfilePeerConflicts('dsh-v0.2.2-alpha.2', root)
  const plugins = found.map((item) => item.plugin).sort()
  assert.deepEqual(plugins, ['@example/nested', '@example/workbuddy'])
  rmSync(root, { recursive: true, force: true })
})

test('requiredPaths default includes contextMenus and can be overridden', () => {
  assert.deepEqual(resolveRequiredPaths(undefined), DEFAULT_REQUIRED_PATHS)
  assert.ok(DEFAULT_REQUIRED_PATHS.some((item) => item.includes('ui-context-menu')))
  assert.deepEqual(resolveRequiredPaths({ requiredPaths: [] }), [])
  assert.deepEqual(resolveRequiredPaths(undefined, { DSH_UPDATE_REQUIRED_PATHS: 'a/b, c/d' }), ['a/b', 'c/d'])
  assert.equal(isSafeRepoRelPath(MENU), true)
  assert.equal(isSafeRepoRelPath('../etc/passwd'), false)
  assert.equal(isSafeRepoRelPath('/etc/passwd'), false)
  assert.equal(isSafeRepoRelPath('packages/../../lib'), false)
})

test('tag health message names contextMenus in Chinese and English', () => {
  const msg = tagHealthMessages('dsh-v0.2.2-alpha.2', [MENU])
  assert.match(msg.zh, /contextMenus/)
  assert.match(msg.zh, /Failed to load plugins/)
  assert.match(msg.en, /contextMenus/)
  assert.match(msg.en, /did not activate/)
  assert.match(msg.zh, /dsh-v0\.2\.2-alpha\.2/)
})

test('orphan lib paths stay inside the whitelist', () => {
  const rels = orphanPackageLibRels(
    ['packages/client/ui-context-menu', 'apps/cli', 'secret/pkg', 'packages/../../etc', 'packages'],
    ['apps/cli'],
    ['packages', 'apps'],
  )
  assert.deepEqual(rels, ['packages/client/ui-context-menu/lib'])
  assert.equal(isWhitelistedPackageRel('packages/client/ui-context-menu', ['packages']), true)
  assert.equal(isWhitelistedPackageRel('packages/../../etc', ['packages']), false)
  assert.deepEqual(
    packageDirsFromListing('packages/a/package.json\npackage.json\n../x/package.json\napps/b/package.json\n'),
    ['packages/a', 'apps/b'],
  )
})

test('boot log signals are detected and helper notes are ignored', () => {
  assert.equal(bootLogFailureReason(''), undefined)
  assert.equal(bootLogFailureReason('ready\n3 entries did not activate\n'), 'did not activate')
  assert.equal(bootLogFailureReason('0 entries did not activate'), undefined)
  assert.equal(bootLogFailureReason('Failed to load plugins: contextMenus'), 'Failed to load plugins')
  assert.equal(bootLogFailureReason('HARNESS plugin load failure while starting'), 'HARNESS plugin load failure')
  assert.equal(bootLogFailureReason('[dsh-update] boot unhealthy: did not activate\nboot healthy'), undefined)
  assert.equal(bootLogFailureReason('server listening on 3080'), undefined)
})

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dsh-update-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'dsh-update-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

test('revision check and orphan lib deletion use a real git tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-'))
  const outside = join(tmpdir(), `dsh-outside-${Date.now()}.txt`)
  writeFileSync(outside, 'keep-me')
  git(root, ['init'])
  mkdirSync(join(root, 'packages/client/ui-context-menu'), { recursive: true })
  mkdirSync(join(root, 'secret/pkg'), { recursive: true })
  writeFileSync(join(root, MENU), '{"name":"ui-context-menu"}\n')
  writeFileSync(join(root, 'secret/pkg/package.json'), '{"name":"secret"}\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'with menu'])
  git(root, ['tag', 'dsh-v0.0.1'])
  git(root, ['rm', '-r', 'packages/client/ui-context-menu', 'secret/pkg'])
  git(root, ['commit', '-m', 'menu removed'])
  git(root, ['tag', 'dsh-v0.0.2-alpha.1'])

  assert.equal(revisionHasPath(root, 'dsh-v0.0.1', MENU), true)
  assert.equal(revisionHasPath(root, 'dsh-v0.0.2-alpha.1', MENU), false)
  const missing = missingRequiredPaths(root, 'dsh-v0.0.2-alpha.1', [MENU, '../etc/passwd'])
  assert.deepEqual(missing.missing, [MENU])
  assert.deepEqual(missing.invalid, ['../etc/passwd'])

  const staleLib = join(root, 'packages/client/ui-context-menu/lib')
  const secretLib = join(root, 'secret/pkg/lib')
  mkdirSync(staleLib, { recursive: true })
  mkdirSync(secretLib, { recursive: true })
  writeFileSync(join(staleLib, 'old.js'), 'inject("contextMenus")\n')
  writeFileSync(join(secretLib, 'keep.js'), 'stay\n')
  mkdirSync(join(root, 'packages/linked'), { recursive: true })
  symlinkSync(outside, join(root, 'packages/linked/lib'))

  const oldDirs = packageDirsFromListing(git(root, ['ls-tree', '-r', '--name-only', 'dsh-v0.0.1']))
  const newDirs = packageDirsFromListing(git(root, ['ls-tree', '-r', '--name-only', 'HEAD']))
  const cleaned = removeOrphanLibsOnDisk(
    root,
    [...oldDirs, 'packages/../../etc', 'packages/linked'],
    newDirs,
    ['packages', 'apps'],
  )
  assert.ok(cleaned.removed.includes('packages/client/ui-context-menu/lib'))
  assert.equal(existsSync(staleLib), false)
  assert.equal(existsSync(join(secretLib, 'keep.js')), true)
  assert.equal(readFileSync(outside, 'utf8'), 'keep-me')
  assert.equal(existsSync(join(root, 'packages/linked/lib')), false)
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { force: true })
})

test('detached helper sources are valid JavaScript', () => {
  const ctx = {
    repoDir: '/tmp/deepseek-harness',
    target: 'dsh-v0.2.2-alpha.2',
    rollbackRef: 'dsh-v0.2.1',
    stashedSomething: false,
    autoRestart: true,
    port: 3080,
    pm: { cmd: 'pnpm', args: [] },
    spawnReplacement: {
      file: 'node',
      args: ['apps/cli/src/index.js'],
      cwd: '/tmp/deepseek-harness',
      viaShell: false,
      detached: true,
      windowsHide: false,
    },
    logs: { out: '/tmp/dsh-update-apply.out.log', err: '/tmp/dsh-update-apply.err.log' },
    orphanLibRoots: ['packages', 'apps'],
    bootHealthWindowMs: 15000,
    safetyModule: '/tmp/dsh-update/lib/safety.js',
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helper-'))
  for (const [name, source] of [
    ['update', updateHelperSource(ctx)],
    ['boot', bootVerifyHelperSource(ctx)],
  ]) {
    assert.ok(source.length < 32000, `${name} helper is ${source.length} chars`)
    assert.match(source, /boot unhealthy/)
    assert.match(source, /pnpm run clean/)
    const file = join(dir, `${name}.cjs`)
    writeFileSync(file, source)
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  }
  rmSync(dir, { recursive: true, force: true })
})
