import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  bootLogFailureReason,
  compareTags,
  harnessVersionFromTag,
  isNpmInstalledHarness,
  isSafeRepoRelPath,
  isWhitelistedPackageRel,
  latestEligibleTag,
  missingRequiredPaths,
  orphanPackageLibRels,
  packageDirsFromListing,
  peerConflictMessages,
  peerConflictsInManifest,
  redactSecrets,
  removeOrphanLibsOnDisk,
  resolveRequiredPaths,
  revisionHasPath,
  scanProfilePeerConflicts,
  semverSatisfies,
  tagHealthMessages,
  verifyHarnessRepo,
  DEFAULT_REQUIRED_PATHS,
} from '../lib/safety.js'
import {
  apply,
  UPDATE_PATHS,
  inject,
  bootVerifyHelperSource,
  updateHelperSource,
  restartHelperSource,
  spawnDetachedHelper,
  scheduleDetachedUpdate,
  scheduleBootVerify,
  detectedSupervisor,
  restartAllowed,
  resolveListeningPort,
  parseDetachedUpdateLog,
  sanitizeGitEnv,
  runUpdateStreaming,
  fetchJson,
  checkStatus,
  verifyMirrorTagSha,
  countUntaggedLocalCommits,
} from '../lib/index.js'
// 同一份判据也必须覆盖 safety.js 自己那份 GIT_ENV（它独立于 index.js）。
import { sanitizeGitEnv as sanitizeGitEnvFromSafety } from '../lib/safety.js'

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

test('profile scan reads enabled plugins only; installed-but-disabled is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  const profile = join(root, 'web')
  mkdirSync(join(profile, 'plugins', 'extra'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@example', 'workbuddy'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@example', 'disabled'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { '@example/workbuddy': '1.0.0', '@example/disabled': '1.0.0' },
    dsh: { profile: { bundles: ['@example/workbuddy', '@example/nested'] } },
  }))
  writeFileSync(join(profile, 'plugins', 'extra', 'package.json'), JSON.stringify({
    name: '@example/nested',
    peerDependencies: { dsh: '0.2.0' },
  }))
  writeFileSync(join(profile, 'node_modules', '@example', 'workbuddy', 'package.json'), JSON.stringify({
    name: '@example/workbuddy',
    peerDependencies: { '@deepseek-ai/deepseek-harness': '0.2.1' },
  }))
  writeFileSync(join(profile, 'node_modules', '@example', 'disabled', 'package.json'), JSON.stringify({
    name: '@example/disabled',
    peerDependencies: { '@deepseek-ai/deepseek-harness': '0.2.1' },
  }))
  const found = scanProfilePeerConflicts('dsh-v0.2.2-alpha.2', root)
  const plugins = found.map((item) => item.plugin).sort()
  assert.deepEqual(plugins, ['@example/nested', '@example/workbuddy'])
  assert.ok(!plugins.includes('@example/disabled'), 'installed-but-disabled plugin must not be reported')
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

/** 跑一条 git。环境必须过 sanitizeGitEnv：父进程可能残留不完整的
 *  GIT_CONFIG_COUNT/KEY/VALUE 注入，会让每条 git 命令直接失败。 */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...sanitizeGitEnv(process.env),
      GIT_AUTHOR_NAME: 'dsh-update-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'dsh-update-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

/** Windows 上建符号链接需要开发者模式或管理员权限；不可用时这条用例只能跳过，
 *  否则在没开权限的机器和 CI 上永远是红的（和产品代码无关）。 */
function canCreateSymlink() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-symlink-probe-'))
  try {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'x')
    symlinkSync(target, join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

test('revision check and orphan lib deletion use a real git tree', (t) => {
  if (!canCreateSymlink()) {
    t.skip('symlinks are not permitted on this machine (Windows without Developer Mode)')
    return
  }
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
// ---- 回归护栏：这两条曾经「修好了但没生效」，用测试钉死 ----

// done 的字段契约已由 buildDoneEvent 运行时测试覆盖（见文件末尾），
// 这里只保留一条「不能再出现裸 done 字面量」的结构性护栏。
test('successful done events are only produced by buildDoneEvent', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 逐行看：含 type:'done' 且 ok:true 的行，排除 skipped（无需更新不是一次更新）。
  const rows = source.split(/\r?\n/).filter((line) => /type:\s*'done'/.test(line) && /ok:\s*true/.test(line))
  const real = rows.filter((line) => !/skipped/.test(line))
  // 唯一允许的一条在 buildDoneEvent 里（成功路径统一从那里生成）。
  assert.equal(real.length, 1, `expected exactly one successful done literal, got ${real.length}: ${real.join(' | ')}`)
  assert.match(real[0], /from:\s*base\.from/, 'the single successful done must come from buildDoneEvent')
})

test('every child process call hides its console window on Windows', () => {
  // 漏一个就会在 Windows 上弹一个 cmd 窗口（标题是 git 的路径）。
  // 只在「独立成行的调用」上断言，避免跨行窗口把漏网的调用一并放行。
  const files = ['../lib/index.js', '../lib/safety.js']
  for (const rel of files) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8')
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!/(execFileSync|execFile|spawn)\(/.test(line)) continue
      if (/^\s*'/.test(line)) continue          // helper 源码字符串，运行时另测
      if (/^\s*(\*|\/\/)/.test(line)) continue  // 注释
      const window = source.split(/\r?\n/).slice(index, index + 60).join('\n')
      // 只要出现 windowsHide: true 就算过；显式 false 视为漏设。
      assert.match(window, /windowsHide:\s*true/, `${rel}:${index + 1} must set windowsHide: true`)
    }
  }
})

test('helper rollback decides stashing by status --porcelain, not diff --quiet', () => {
  // 回归护栏：`git diff --quiet` 对「仅未跟踪文件 / 仅 staged 改动」返回 0，
  // 但 `git stash push -u` 照样会把它们收进 stash。若判定用 diff --quiet，
  // 就会 push 了却不置 reStashed，回滚后永不 apply，用户文件静默从工作树消失。
  const source = updateHelperSource({
    repoDir: '/tmp/x',
    target: 'dsh-v1.0.0',
    rollbackRef: 'abc123',
    stashedSomething: true,
    autoRestart: true,
    port: null,
    pm: { cmd: 'pnpm', args: [] },
    spawnReplacement: { file: 'node', args: [], cwd: '/tmp/x', viaShell: false, detached: true, windowsHide: true },
    logs: { out: '/tmp/o.log', err: '/tmp/e.log' },
  })
  assert.doesNotMatch(source, /diff[\s\S]{0,40}--quiet/, 'rollback must not use diff --quiet to decide stashing')
  assert.match(source, /status[\s\S]{0,20}--porcelain/, 'rollback must probe with status --porcelain')
  // run() 必须收集 stdout，否则 status 的输出拿不到。
  assert.match(source, /outText \+= String\(d\)/, 'helper run() must collect stdout')
})

test('runUpdateStreaming resolves and closes the stream on a non-git directory', async () => {
  // 第一条真正跑运行时路径的测试：stub 一个 res，验证它一定会收尾
  // （写 done、end()），而不是留下挂起的流或未释放的 latch。
  const { runUpdateStreaming } = await import('../lib/index.js')
  const lines = []
  let ended = false
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk) { lines.push(String(chunk)) },
    end() { ended = true },
    on() {},
  }
  const notGit = mkdtempSync(join(tmpdir(), 'dsh-not-git-'))
  try {
    await runUpdateStreaming(notGit, res, {})
    assert.equal(ended, true, 'stream must be closed')
    const events = lines.map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    const done = events.find((e) => e.type === 'done')
    assert.ok(done !== undefined, 'a terminal done event must be written')
    assert.equal(done.ok, false)
    assert.match(done.error, /not a git checkout/)
  } finally {
    rmSync(notGit, { recursive: true, force: true })
  }
})

test('buildDoneEvent keeps autoRestart honest for both modes', async () => {
  // 直接测构造器：这是 build/detached 两条成功路径唯一的 done 来源。
  const { buildDoneEvent } = await import('../lib/index.js')
  const base = { from: 'dsh-v1.0.0', to: 'dsh-v1.1.0' }
  const off = buildDoneEvent(base, { kind: 'build', autoRestart: false })
  assert.equal(off.autoRestart, false)
  assert.equal(off.restartInMs, undefined, 'no restart window when restart is off')
  const on = buildDoneEvent(base, { kind: 'build', autoRestart: true, restartInMs: 2000 })
  assert.equal(on.autoRestart, true)
  assert.equal(on.restartInMs, 2000)
  assert.equal(on.pendingBootCheck, true)
  const detached = buildDoneEvent(base, {
    kind: 'detached', autoRestart: true, restartInMs: 0, restartWindowMs: 45 * 60_000,
  })
  assert.equal(detached.detached, true)
  // detached 不该带 pendingBootCheck：客户端应显示「已转入后台执行」，
  // 而不是「正在检查启动是否健康」（那个分支排在 detached 之前会抢先）。
  assert.equal(detached.pendingBootCheck, undefined)
  assert.equal(detached.restartWindowMs, 45 * 60_000)
  assert.equal(detached.autoRestart, true)
})

test('createProcessRunners streams a real git command and reports its exit code', async () => {
  // 抽取出来的子进程管线必须真的能跑：这是 runUpdateStreaming 里所有 git/pnpm
  // 调用的唯一通道，它坏了整条更新链路都停摆。
  const { createProcessRunners } = await import('../lib/index.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-runners-'))
  try {
    git(root, ['init'])
    const events = []
    const { runGit } = createProcessRunners({
      repoDir: root,
      write: (e) => events.push(e),
      fail: (msg) => { throw new Error('unexpected fail: ' + msg) },
      isSettled: () => false,
    })
    const code = await new Promise((resolve) => {
      runGit('Probing repo …', ['rev-parse', '--is-inside-work-tree'], (c) => resolve(c))
    })
    assert.equal(code, 0, 'git rev-parse should succeed in a fresh repo')
    // 第一条事件必须是 step（标签），说明 write 通道接对了。
    assert.equal(events[0].type, 'step')
    assert.match(events[0].text, /Probing repo/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('performRollback reports failure instead of throwing when it cannot restore', async () => {
  // 回滚路径是「失败不自伤」保证的最后一环：它本身绝不能抛异常，
  // 否则用户既没有回滚也没有提示。这里在真 git 仓库上跑一次注定失败的回滚。
  const { performRollback } = await import('../lib/index.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-rb-'))
  try {
    git(root, ['init'])
    const events = []
    let failure = null
    performRollback({
      error: 'build blew up',
      rollbackRef: 'deadbeefdeadbeef',   // 不存在的 commit：checkout 必然失败
      repoDir: root,
      target: 'dsh-v9.9.9',
      stashApplied: false,
      orphanLibRoots: [],
      write: (e) => events.push(e),
      finishFail: (err, rolledBack) => { failure = { err, rolledBack } },
      runGit: (label, args, cb) => cb(-1, 'not used'),
      runCommand: (label, args, cb) => cb(-1, 'not used'),
      isSettled: () => false,
    })
    assert.ok(failure !== null, 'a failing rollback must still report through finishFail')
    assert.equal(failure.rolledBack, false)
    assert.match(failure.err, /build blew up/, 'the original error must be preserved')
    assert.match(failure.err, /deadbeefdeadbeef/, 'the failed rollback target must be named')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sanitizeGitEnv strips every malformed GIT_CONFIG_* shape git rejects', () => {
  // git 对畸形注入的反应是「拒绝执行任何命令」，而插件/helper 都把 process.env
  // 整个传给 git——所以这里必须覆盖所有会让 git 起不来的形状，不只是 KEY 缺失。
  const base = { PATH: 'x' }
  const malformed = {
    'COUNT + VALUE but KEY missing': { GIT_CONFIG_COUNT: '2', GIT_CONFIG_VALUE_0: 'a', GIT_CONFIG_VALUE_1: 'b' },
    'COUNT not a number': { GIT_CONFIG_COUNT: 'abc' },
    'COUNT with trailing junk': { GIT_CONFIG_COUNT: '2x' },
    'COUNT negative': { GIT_CONFIG_COUNT: '-1' },
    'COUNT surrounded by spaces': { GIT_CONFIG_COUNT: ' 2 ' },
    'KEY present but VALUE missing': { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b' },
    'empty KEY': { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: '', GIT_CONFIG_VALUE_0: 'v' },
    'astronomically large COUNT': { GIT_CONFIG_COUNT: '999999999999999999999' },
    'malformed PARAMETERS': { GIT_CONFIG_PARAMETERS: 'not-encoded' },
    'KEY/VALUE without COUNT': { GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'v' },
    'KEY without a section dot': { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'foo', GIT_CONFIG_VALUE_0: 'v' },
    'KEY is only whitespace': { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: '   ', GIT_CONFIG_VALUE_0: 'v' },
    'lowercase keys (Windows env is case-insensitive)': { git_config_count: '2', git_config_value_0: 'a', git_config_value_1: 'b' },
  }
  assert.equal(sanitizeGitEnvFromSafety, sanitizeGitEnv)
  for (const [name, extra] of Object.entries(malformed)) {
    for (const fn of [sanitizeGitEnv, sanitizeGitEnvFromSafety]) {
      const clean = fn({ ...base, ...extra })
      const leaked = Object.keys(clean).filter((key) => /^GIT_CONFIG_/.test(key))
      assert.deepEqual(leaked, [], `${name}: leaked ${leaked.join(', ')}`)
      assert.equal(clean.PATH, 'x', `${name}: unrelated vars must survive`)
    }
  }

  // 完整合法的注入必须原样保留：那是用户/父进程有意设置的 git 配置。
  const intact = { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store' }
  assert.deepEqual(sanitizeGitEnv(intact), intact)
  assert.deepEqual(sanitizeGitEnvFromSafety(intact), intact)

  // 完全没有注入时零改动（最常见路径）。
  assert.equal(sanitizeGitEnv(base), base)
  assert.equal(sanitizeGitEnvFromSafety(base), base)
})

test('a git call survives a poisoned GIT_CONFIG_* environment', () => {
  // 光验「返回对象干净」不够——必须真的拿 sanized env 跑一条 git，
  // 证明修复对 git 本身有效（这是上面那组形状的最终裁决）。
  const root = mkdtempSync(join(tmpdir(), 'dsh-gitenv-'))
  try {
    git(root, ['init'])
    const poisoned = {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_VALUE_0: 'a',
      GIT_CONFIG_VALUE_1: 'b',
    }
    delete poisoned.GIT_CONFIG_KEY_0
    delete poisoned.GIT_CONFIG_KEY_1

    // 先确认这个环境确实是坏的：未经清理必须失败。
    assert.throws(
      () => execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
        env: poisoned,
        // 这条调用注定失败，把它的 stderr 静音，别污染测试输出。
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }),
      /GIT_CONFIG_KEY_0|unable to parse command-line config/,
      'the poisoned env should break git, otherwise this test proves nothing',
    )

    // 清理之后必须能跑。
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      env: { ...sanitizeGitEnv(poisoned), LC_ALL: 'C' },
      encoding: 'utf8',
    })
    assert.equal(out.trim(), 'true')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- Authenticated route registration (security regression) ----------------
// The plugin-directory review flagged that these process-control routes were
// mounted via bare `webServer.register` with only a hand-rolled loopback fence,
// so any web page open in the browser could call them. They must now live on
// the host-authenticated `connection.fetch` table.

function mockCtx() {
  const routes = new Map()
  const webServerRoutes = []
  let disposeCalls = 0
  const ctx = {
    get connection() {
      return {
        fetch: {
          register(route) {
            assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
            routes.set(route.path, route)
            return async () => { disposeCalls++ }
          },
        },
      }
    },
    get webServer() {
      return {
        register(route) {
          webServerRoutes.push(route)
          return () => {}
        },
      }
    },
    agents: {},
    effect(fn) {
      const dispose = fn()
      ctx._dispose = dispose
      return dispose
    },
  }
  return { ctx, routes, webServerRoutes, disposeCallsOf: () => disposeCalls }
}

test('inject declares connection so the host admission service is available', () => {
  assert.ok(inject.includes('connection'), 'inject must include connection')
})

test('apply mounts all routes on connection.fetch, never on bare webServer', async () => {
  const { ctx, routes, webServerRoutes } = mockCtx()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-routes-'))
  try {
    apply(ctx, { repoDir: dir })
    assert.equal(webServerRoutes.length, 0, 'no route may bypass connection auth via webServer.register')
    assert.deepEqual([...routes.keys()].sort(), [
      UPDATE_PATHS.status, UPDATE_PATHS.ping, UPDATE_PATHS.notes, UPDATE_PATHS.run, UPDATE_PATHS.restart,
    ].sort())
    assert.deepEqual(routes.get(UPDATE_PATHS.status).methods, ['GET'])
    assert.deepEqual(routes.get(UPDATE_PATHS.run).methods, ['POST'])
    assert.equal(routes.get(UPDATE_PATHS.run).requestBody, 'streaming')
    assert.equal(routes.get(UPDATE_PATHS.restart).requestBody, 'buffered')
    await ctx._dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetch handlers answer a normal GET with a JSON Response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-update-fetch-'))
  try {
    const { ctx, routes } = mockCtx()
    // Avoid a real git remote lookup: /ping needs no git at all.
    apply(ctx, { repoDir: root })
    const ping = routes.get(UPDATE_PATHS.ping).fetch
    const res = await ping(new Request('http://localhost' + UPDATE_PATHS.ping, { method: 'GET' }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.pid, 'number')
    await ctx._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the /run fetch route streams newline JSON and closes even for a failed update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-update-run-'))
  try {
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root })
    const run = routes.get(UPDATE_PATHS.run).fetch
    const res = await run(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const text = await res.text()
    const events = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(events.some((e) => e.type === 'step'), 'a progress line must stream before the result')
    const done = events.find((e) => e.type === 'done')
    assert.ok(done !== undefined, 'the stream must close with a done event')
    assert.equal(done.ok, false)
    await ctx._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package.json declares engines.dsh >=0.2.3-0 and no longer claims unauthenticated routes', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.dsh, '>=0.2.3-0')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  // The directory description's old warning must be gone after the fix.
  assert.ok(!/它的 HTTP 路由没有 DSH 的访问检查|no DSH access check/i.test(readme),
    'README must not still claim the routes are unauthenticated')
})

test('client labels the GitHub link as official release notes and keeps the update button clickable while running', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Old ambiguous label (it also appeared next to the in-panel release notes)
  // must be renamed so users can tell it apart from the streamed update log.
  assert.ok(!client.includes('"查看日志 ↗"'), 'old ambiguous “查看日志 ↗” label must be gone')
  assert.ok(client.includes('"查看官方发布说明 ↗"'), 'the GitHub link must be labelled as official release notes')
  // While an update runs the trigger must stay clickable so the progress
  // panel can be reopened: no hard disabled, no unconditional early return.
  assert.ok(!/disabled:\s*upPhase === "running"/.test(client),
    'the update trigger must not be disabled while running')
  assert.ok(!/if \(upPhase === "running"\) return;\s*\n\s*\/\/ 两个浮层互斥/.test(client),
    'openPanel must not bail out while running')
  assert.ok(client.includes('if (!keepView) void check(net)'),
    'reopening the panel during an update/confirmation must reuse the view, not re-check')
  assert.ok(client.includes('if (upPhase !== "running") runToken.current++'),
    'closing the panel mid-update must not invalidate the progress stream')
})

test('client persists the network source choice (incl. proxy port) across panel opens', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('const NET_KEY = "dsh-update:net"'), 'a dedicated localStorage key must exist')
  assert.ok(client.includes('useState(() => readNet())'),
    'net state must initialise from the persisted choice, not a hardcoded auto')
  assert.ok(/setNet\(next\);\s*\r?\n\s*writeNet\(next\)/.test(client),
    'changeNet must persist the new choice including its proxy port / mirror')
  // readNet must validate the stored shape so a stale/hand-edited value cannot
  // poison the source picker (a bad port must not be sent to /run).
  assert.ok(client.includes('Number.isInteger(p) && p >= 1 && p <= 65535'),
    'persisted proxy port must be validated on read')
})

test('rollback triggers the same auto-restart page refresh as an update', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The done handler used to gate armRestartWatch behind `if (trackUpdate)`,
  // which is false for a rollback (targetTag set) — so a rollback finished but
  // never polled /ping and never reloaded. It must be called for both paths.
  const doneBlock = client.slice(
    client.indexOf('} else if (evt.type === "done")'),
    client.indexOf('} else if (evt.type === "conflict")'),
  )
  assert.ok(/if \(evt\.autoRestart\) armRestartWatch\(evt\.restartWindowMs\)/.test(doneBlock),
    'the done handler must arm the restart watcher for rollback too, not only for updates')
  // Both the button terminal state and the restart watcher must be outside any
  // `if (trackUpdate)` guard, so a rollback (trackUpdate=false) reaches them.
  assert.ok(/setUpPct\(100\);[\s\S]*?setUpPhase\("done"\);[\s\S]*?if \(evt\.autoRestart\) armRestartWatch/.test(doneBlock),
    'button done state and armRestartWatch must both run for rollback too')
  // Rollback driven from the update panel must drive the sidebar button's
  // progress bar (not just the panel), using the rollback step parser.
  assert.ok(client.includes('const progressOf = targetTag ? rollbackProgressOf : updateProgressOf'),
    'rollback must use its own step parser to advance the button progress')
  assert.ok(/if \(trackProgress\) \{\s*\r?\n\s*const step = progressOf\(line\)/.test(client),
    'progress must be tracked for both update and rollback (no trackUpdate guard)')
  assert.ok(/setUpPhase\("running"\);\s*\r?\n\s*if \(!resume\) \{/.test(client),
    'the button must enter its running state for a rollback too')
})

test('rollback keeps its explicit target tag instead of recomputing to the latest', () => {
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const a = host.indexOf('const afterFetch = async () => {')
  const b = host.indexOf('// mirror 来源', a)
  const block = host.slice(a, b)
  // A rollback target is chosen by the user; recomputeTarget() would replace it
  // with the remote latest and could end the run as `skipped` doing nothing.
  assert.ok(/if \(isRollback\) \{[\s\S]*?Verifying tag[\s\S]*?return/.test(block),
    'rollback must verify its own target and return before recomputeTarget')
  assert.ok(block.indexOf('if (isRollback)') < block.indexOf('recomputeTarget()'),
    'the rollback branch must come before any recomputeTarget call')
  // The rollback branch must close with `return` before the recomputeTarget line.
  const rIf = block.indexOf('if (isRollback) {')
  const rReturn = block.indexOf('return', rIf)
  const recompute = block.indexOf('recomputeTarget()')
  assert.ok(rReturn !== -1 && rReturn < recompute,
    'rollback must return before reaching recomputeTarget')
})

test('client progress popover is minimal: no header, source picker or yellow warning', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Starting a task no longer closes the panel: it turns into the progress window
  // in place, header and close button included, so the user can keep watching and
  // can still hide the window without interrupting the run.
  assert.ok(/setUpHint\(targetTag \? tr\("准备回退"\)[\s\S]{0,400}setOpen\(true\);/.test(client),
    'starting a task must keep the panel open as the progress window')
  assert.ok(client.includes('const inProgress = view.kind === "updating"'),
    'an in-progress view must still be detected to hide the unrelated controls')
  assert.ok(!/inProgress \? null : h\("div", \{ style: headStyle \}/.test(client),
    'the progress popover must keep its header so the close button stays reachable')
  assert.ok(/inProgress \? null : sourceRow/.test(client),
    'the progress popover must hide the source picker')
  assert.ok(/inProgress \? null : autoRow/.test(client),
    'the progress popover must hide the auto-check row')
  // The big yellow warn box and its helper are gone.
  assert.ok(!client.includes('const warnBox'), 'the yellow warning box must be removed')
  assert.ok(!client.includes('willDetachUpdate'), 'detach-warning helper must be removed')
})

test('safety-gate interceptions reopen the panel so the user can confirm', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const a = client.indexOf('} else if (evt.type === "conflict" || evt.type === "tag-health" || evt.type === "peers")')
  const b = client.indexOf('}, { stash: !!stash, targetTag', a)
  const block = client.slice(a, b)
  // The panel is closed when a task starts. When a safety gate blocks the
  // checkout (peer conflict / missing paths / local changes), the user must see
  // the interception card — otherwise the button just sits at a stuck progress %.
  assert.ok(/setOpen\(true\)/.test(block),
    'an interception must reopen the panel so its confirm buttons are visible')
  assert.ok(/setUpPhase\("confirm"\)/.test(block),
    'the button must enter a distinct confirm state, not "error"/"update failed"')
  assert.ok(block.includes('measureAnchor()'),
    'the reopened panel must be re-anchored to the button')
  assert.ok(/evt\.type === "conflict"[\s\S]*?evt\.type === "tag-health"/.test(block),
    'all three interception kinds must still be distinguished')
  // The confirm state must have its own button label, not reuse the error text.
  const cIf = client.indexOf('} else if (upPhase === "confirm")')
  const cNext = client.indexOf('} else if (upPhase === "error")', cIf)
  const confirmBlock = client.slice(cIf, cNext)
  assert.ok(confirmBlock.includes('tr("需要你确认")'),
    'the confirm-state button must say “needs confirmation”, not “update failed, retry”')
  const codeOnly = confirmBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/tr\("更新失败，重试"\)/.test(codeOnly),
    'the confirm-state button must not assign the failure label')
})

test('when an update is available, the version list only offers older versions to roll back to', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The “available” view already has a top-level “start update” button; listing
  // newer tags with an “update to this version” button below duplicated it.
  const a = client.indexOf('} else if (view.kind === "available" && status !== undefined)')
  const b = client.indexOf('} else if (view.kind === "result"', a)
  const block = client.slice(a, b)
  assert.ok(/manualOptions = \(Array\.isArray\(status\.tags\) \? status\.tags : \[\]\)\s*\r?\n\s*\.filter\(\(t\) => t !== status\.localTag && compareTagTo\(t, status\.localTag\) < 0\)/.test(block),
    'available view must filter the version list to tags older than local only')
  assert.ok(block.includes('tr("或回退到历史版本")'),
    'the section must be labelled as rollback-only, avoiding duplication with “start update”')
  // The up-to-date view must also only offer older versions — offering an
  // “update to this version” there is self-contradictory.
  const result = client.slice(b, client.indexOf('} else if (view.kind === "updating"', b))
  assert.ok(/manualOptions = \(Array\.isArray\(status\.tags\) \? status\.tags : \[\]\)\s*\r?\n\s*\.filter\(\(t\) => t !== status\.localTag && compareTagTo\(t, status\.localTag\) < 0\)/.test(result),
    'up-to-date view must also filter to older versions only')
  assert.ok(result.includes('tr("或回退到历史版本")'),
    'the up-to-date view must label its version list as rollback-only')
  assert.ok(!/tr\("更新到此版本"\)/.test(result),
    'an up-to-date view must never offer “update to this version”')
})

test('auto-refresh uses a localStorage boot marker, independent of the SSE stream', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The build step replaces web assets and can sever the SSE before the done
  // event arrives, so a done-driven watcher alone never fires. A persisted
  // marker survives page reloads and lets a fresh page notice the new boot id.
  assert.ok(client.includes('const RELOAD_KEY = "dsh-update:pending-reload"'),
    'a dedicated persisted key must exist')
  assert.ok(client.includes('function watchPendingReload()'),
    'a loader that checks the marker on page load must exist')
  assert.ok(/boot !== lastBoot[\s\S]{0,900}window\.location\.reload\(\)/.test(client),
    'the watcher must reload once the boot id changes (after the staleness check)')
  assert.ok(client.includes('watchPendingReload();'),
    'the watcher must be started from apply() on page load')
  // The marker is written when a run starts and cleared on non-restart outcomes.
  assert.ok(/markPendingReload\(b\.boot, targetTag\)/.test(client),
    'a run must record the current boot as the baseline')
  assert.ok(client.includes('clearPendingReload()'),
    'failed/skipped/intercepted outcomes must clear the marker')
  // The marker has a bounded lifetime so a stale entry cannot cause a surprise reload.
  assert.ok(client.includes('RELOAD_MAX_MS'),
    'the marker must expire so it cannot trigger a stale reload')
  // It must be idempotent: only one polling loop at a time.
  assert.ok(client.includes('let reloadWatchActive = false'),
    'the watcher must be idempotent')
})

test('prerelease targets are matched by their stable version to avoid false peer conflicts', () => {
  // A range like >=0.1.7-rc.1 <0.3.0-0 clearly covers 0.2.3-alpha.1, but
  // node-semver says a prerelease satisfies no stable range. Checking the
  // stable core removes the flood of false positives on alpha rollbacks.
  assert.deepEqual(
    peerConflictsInManifest({ peerDependencies: { '@deepseek-ai/dsh-attachment': '>=0.1.7-rc.1 <0.3.0-0' } }, '0.2.3-alpha.1'),
    [],
    'a range that covers the stable core must not flag an alpha target',
  )
  // Genuine mismatches on the stable core must still be flagged.
  assert.equal(
    peerConflictsInManifest({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.4' } }, '0.2.3-alpha.1').length,
    1,
    'a real peer mismatch must still be reported',
  )
})

test('interception wording, cancel reset and resume progress behave correctly', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Rollback interception button says “roll back anyway”, not “update anyway”.
  assert.ok(/view\.targetTag \? tr\("仍要继续回退"\) : tr\("仍要继续更新"\)/.test(client),
    'the interception action must reflect update vs rollback')
  // Cancel (recheck) must reset the confirm state so the button looks normal again.
  assert.ok(/setUpPhase\(\(phase\) => \(phase === "done" \|\| phase === "confirm" \? "idle" : phase\)\)/.test(client),
    'cancelling an interception must return the button to idle')
  // Confirming must resume progress rather than restart from 6%.
  assert.ok(client.includes('const resume = !!(opts && opts.resume)'),
    'run must know it is resuming from an interception')
  assert.ok(/if \(!resume\) \{\s*\r?\n\s*setUpPct\(6\)/.test(client),
    'progress must not reset when continuing after an interception')
  assert.ok(client.includes('resume: true'),
    'the confirm handlers must pass the resume flag')
  // Conflict details are shown once, in a collapsed block (no duplicate list).
  assert.ok(client.includes('tr("查看冲突详情")'),
    'conflict details must be collapsed behind a summary')
})

test('a page loaded onto the new boot does not reload a second time', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Reported symptom: after a rollback the page went blank, the user refreshed
  // manually because the automatic reload felt too slow, and then it reloaded
  // once more on its own. The second reload came from the persisted marker: the
  // freshly loaded page saw a boot id different from the one recorded before the
  // restart and treated that as "the new process just took over".
  assert.ok(/let observed = false/.test(client),
    'the watcher must track whether it has already seen a boot id in this page')
  assert.ok(/function bootStartedAt\(boot\)/.test(client),
    'the boot id carries the host start time, which decides staleness precisely')
  assert.ok(/const stale = processStartedAt !== null && pageLoadedAt > 0[\s\S]{0,120}: observed;/.test(client),
    'a page whose load postdates the new process must not reload: it already runs it')
  assert.ok(/if \(stale\) window\.location\.reload\(\)/.test(client),
    'only a page that predates the new process may reload')
  assert.ok(!/let lastBoot = pending\.boot;/.test(client),
    'the marker boot must not be mutable watcher state')
})

test('the boot poll is fast enough that users do not refresh manually', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(/window\.setTimeout\(poll, 250\)/.test(client),
    'the marker watcher must start polling almost immediately')
  assert.ok(/poll, 600\);/.test(client),
    'the marker watcher must re-poll about twice a second')
  assert.ok(!/setTimeout\(poll, 1500\)/.test(client),
    'no poll interval may stay at the old 1.5 s')
  assert.ok(!client.includes('届时刷新网页即可恢复'),
    'the completion copy must promise the automatic reload instead of a manual one')
})

test('the running button shows progressive wording instead of a fake percentage', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The server only reports stages, never a total duration, so any percentage is
  // a guess. A guessed number that stalls is worse than no number at all.
  assert.ok(!/updateLabel = wide \? upStep \+ " " \+ upPct \+ "%"/.test(client),
    'the running label must not append a percentage')
  assert.ok(/updateLabel = wide \? \(upStep \|\|/.test(client),
    'the running label must be the stage wording alone')
  assert.ok(/ing: tr\("安装中"\)/.test(client),
    'each stage must carry a progressive-form label')
  assert.ok(/setUpStep\(step\.ing \|\| step\.text\)/.test(client),
    'progress tracking must switch the button to the progressive label')
  // The indeterminate sweep needs a keyframe animation, injected once.
  assert.ok(/@keyframes dshUpdateSweep/.test(client),
    'the indeterminate bar needs a sweep animation')
  assert.ok(/function ensureProgressAnim\(\)/.test(client) && /PROGRESS_ANIM_ID/.test(client),
    'the animation must be injected once and deduplicated by id')
  // Completion wording must say what finished, not a generic check mark.
  assert.ok(/upPhase === "done"\) \{\r?\n\s*updateLabel = wide \? \(targetTagNow \? tr\("回退完成"\) : tr\("更新完成"\)\)/.test(client),
    'completion must name the operation that just finished')
})

test('the progress window stays open and can be closed without killing the run', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Reopening the window must not restart the check while a task is running.
  assert.ok(/const keepView = upPhase === "running" \|\| upPhase === "conflict"|const keepView = upPhase === "running" \|\| upPhase === "confirm"/.test(client),
    'reopening during a run must not overwrite the progress view')
  // Closing must not invalidate the token mid-run, or every later event is dropped.
  assert.ok(/if \(upPhase !== "running"\) runToken\.current\+\+/.test(client),
    'closing the window during a run must keep the stream alive')
  assert.ok(/if \(open && upPhase !== "running"\) runToken\.current\+\+/.test(client),
    'an outside click during a run must keep the stream alive too')
  // The safety gate must still be able to surface its confirm card.
  assert.ok(/setUpPhase\("confirm"\)/.test(client),
    'a safety gate must be able to switch the window into the confirm state')
})

test('the panel warns about the blank screen in a prominent place', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A first-time user seeing a whole blank page concludes the install broke.
  // The warning has to be in the panel before the run, not only in the live log.
  assert.ok(/function BlindHint\(\{ h, T \}\)/.test(client),
    'the blank-screen hint must be its own component so it renders in every view')
  assert.ok(/h\(BlindHint, \{ h, T \}\)/.test(client),
    'the panel must actually render the hint')
  const hintIdx = client.indexOf('h(BlindHint, { h, T })')
  const bodyIdx = client.indexOf('display: "flex", flexDirection: "column", gap: 8, minWidth: 0', hintIdx)
  assert.ok(hintIdx > 0 && bodyIdx > hintIdx,
    'the hint must sit above the body, in the path the eye already travels')
  // Dark themes turn a blank page black, so the copy cannot say "white screen" only.
  assert.ok(client.includes('深色主题下是黑屏'),
    'the wording must cover dark themes, where the blank page is black')
  assert.ok(client.includes('浅色主题下是白屏'),
    'the wording must also cover light themes, where it really is white')
})

test('the auto-check toggle is geometrically symmetric', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Track 34x19, knob 13x13: an inset of 2 horizontally and 3 vertically keeps
  // the knob centred. The old values (left 17, top 2) left 4px on the right and
  // 4px at the bottom, which reads as a knob that is off-centre.
  assert.ok(/width: 34, height: 19/.test(client), 'the track keeps its size')
  assert.ok(/width: 13, height: 13/.test(client), 'the knob keeps its size')
  assert.ok(/left: enabled \? 19 : 2/.test(client),
    'an enabled knob must sit 2px from the right edge (34 - 13 - 2 = 19)')
  assert.ok(/top: 3, left: enabled \? 19/.test(client),
    'the knob must be vertically centred ((19 - 13) / 2 = 3)')
  assert.ok(!/left: enabled \? 17 : 2/.test(client),
    'the asymmetric 17px offset must be gone')
})

test('the auto-check row matches the typography of the rows above it', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Measured in the browser: 网络 and 端口 labels are 11px starting at x=24.7;
  // the auto-check label was 11.5px and started 2px further right, so the row
  // read as slightly out of line. Same size, same trailing margin as 网络.
  assert.ok(/fontSize: 11, color: T\.secondary, whiteSpace: "nowrap", marginRight: 2/.test(client),
    'the auto-check label must use the same 11px and trailing margin as its siblings')
  assert.ok(!/fontSize: 11\.5, color: T\.secondary, whiteSpace: "nowrap" \},/.test(client),
    'the old 11.5px auto-check label must be gone')
})

test('running-state visuals use a fixed blue, not the theme brand', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Measured in the running GUI: --dsw-alias-brand-primary resolves to #0f1115
  // here, so the old `color-mix(in srgb, T.brand 28%, transparent)` band came out
  // as color(srgb 0.06 0.07 0.08 / 0.28) — a grey-black blob on a light sidebar.
  // A progress indicator must read as active regardless of the theme.
  assert.ok(client.includes('const RUN_BLUE = "#4f8cff"'),
    'the running blue must be a fixed constant')
  assert.ok(client.includes('background: RUN_BLUE, animation: "dshUpdateSweep'),
    'the panel sweep band must use the fixed blue')
  assert.ok(client.includes('color-mix(in srgb, " + RUN_BLUE + " 16%'),
    'the panel sweep track must use the fixed blue')
  assert.ok(client.includes('color-mix(in srgb, " + RUN_BLUE + " 45%'),
    'the button sweep band must use the fixed blue, a step stronger than the track')
  assert.ok(/color: RUN_BLUE, cursor: "pointer", background: "color-mix\(in srgb, " \+ RUN_BLUE/.test(client),
    'the running button label must be blue too, not the theme brand')
  assert.ok(!/color-mix\(in srgb, " \+ T\.brand \+ " 28%/.test(client),
    'the old theme-brand band must be gone')
})

test('the new-version badge sits after the label instead of covering it', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Measured: the button is 114x32 with 0 10px padding and 8px gap, so the label's
  // right edge is 10px from the button's right edge. An absolutely positioned 7px
  // dot at `right: 6` occupied right-13..right-6 and therefore overlapped the last
  // glyph; vertically 6..13 it landed on the cap height of a 13px label, reading as
  // a speck of dirt rather than a notification.
  const wideIdx = client.indexOf('opts.badge) ? h("span"')
  assert.ok(wideIdx > 0, 'the badge must still be rendered')
  const block = client.slice(wideIdx, wideIdx + 900)
  // The wide-state style is the flex branch; the absolute one is the rail fallback.
  assert.ok(/style: wide \? \{/.test(block),
    'the badge must branch on wide vs rail layout')
  assert.ok(/flex: "0 0 auto", width: 7, height: 7/.test(block),
    'in the wide state the dot is a flex item, so it takes its own slot after the label')
  assert.ok(!/top: 6, right: 6,\r?\n\s*width: 7, height: 7/.test(block),
    'the wide state must not absolutely position the dot over the text any more')
  // The rail state has no label, so its corner placement stays.
  assert.ok(/position: "absolute", top: 5, right: 5/.test(block),
    'the collapsed rail keeps its corner dot, moved clear of the icon edge')
  // A tinted halo reads as a deliberate marker on any background.
  assert.ok(/color-mix\(in srgb, " \+ T\.danger \+ " 18%/.test(block),
    'the dot needs a tinted halo instead of relying on a hard white ring')
})


// ---- 新增运行时行为测试 -----------------------------------------------------

test('semverSatisfies covers caret/tilde/comparator shorthands, spaced operators, and hyphen ranges', () => {
  const cases = [
    // ^0 / ^0.0 / ^0.2 / ^1.2
    ['0.0.0', '^0', true],
    ['0.9.9', '^0', true],
    ['1.0.0', '^0', false],
    ['0.0.0', '^0.0', true],
    ['0.0.9', '^0.0', true],
    ['0.1.0', '^0.0', false],
    ['0.2.0', '^0.2', true],
    ['0.2.9', '^0.2', true],
    ['0.1.9', '^0.2', false],
    ['0.3.0', '^0.2', false],
    ['1.2.0', '^1.2', true],
    ['1.9.9', '^1.2', true],
    ['1.1.9', '^1.2', false],
    ['2.0.0', '^1.2', false],
    // ~1
    ['1.0.0', '~1', true],
    ['1.9.9', '~1', true],
    ['0.9.9', '~1', false],
    ['2.0.0', '~1', false],
    // <=1.2 / <=1 / >1.2 / >1 / <1.2 / >=1.2
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.9.9', '<=1', true],
    ['2.0.0', '<=1', false],
    ['1.2.9', '>1.2', false],
    ['1.3.0', '>1.2', true],
    ['1.9.9', '>1', false],
    ['2.0.0', '>1', true],
    ['1.1.9', '<1.2', true],
    ['1.2.0', '<1.2', false],
    ['1.1.9', '>=1.2', false],
    ['1.2.0', '>=1.2', true],
    ['1.2.5', '>=1.2', true],
    // 操作符带空格
    ['0.2.0', '>= 0.2.0', true],
    ['0.1.9', '>= 0.2.0', false],
    ['1.5.0', '^ 1.0.0', true],
    ['2.0.0', '^ 1.0.0', false],
    ['1.2.9', '<= 1.2', true],
    ['1.3.0', '<= 1.2', false],
    // 连字符范围
    ['0.0.9', '0.1.0 - 0.2.9', false],
    ['0.1.0', '0.1.0 - 0.2.9', true],
    ['0.2.9', '0.1.0 - 0.2.9', true],
    ['0.3.0', '0.1.0 - 0.2.9', false],
    ['0.9.9', '1.0.0 - 1', false],
    ['1.0.0', '1.0.0 - 1', true],
    ['1.9.9', '1.0.0 - 1', true],
    ['2.0.0', '1.0.0 - 1', false],
  ]
  for (const [version, range, expected] of cases) {
    assert.equal(semverSatisfies(version, range), expected, `${version} satisfies ${range}`)
  }
})

/** 创建带 origin 与 local 两个临时 git 仓库，方便离线实测 fetch / checkout / stash。 */
function setupOriginAndLocalRepos() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-git-pair-'))
  const originDir = join(base, 'origin')
  const localDir = join(base, 'local')
  mkdirSync(originDir, { recursive: true })
  git(originDir, ['init'])
  writeFileSync(
    join(originDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0', private: true, scripts: { clean: 'node -e ""', build: 'node -e ""' } }) + '\n',
  )
  writeFileSync(join(originDir, 'notes.txt'), 'v1\n')
  git(originDir, ['add', '.'])
  git(originDir, ['commit', '-m', 'release 0.1.0'])
  git(originDir, ['tag', 'dsh-v0.1.0'])

  git(base, ['clone', '-q', originDir, localDir])

  writeFileSync(
    join(originDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.2.0', private: true, scripts: { clean: 'node -e ""', build: 'node -e ""' } }) + '\n',
  )
  writeFileSync(join(originDir, 'notes.txt'), 'v2\n')
  git(originDir, ['add', '.'])
  git(originDir, ['commit', '-m', 'release 0.2.0'])
  git(originDir, ['tag', 'dsh-v0.2.0'])

  return { base, originDir, localDir }
}

/** 构造内存桩响应，同时按时间顺序记录每次 write / end。 */
function createStubRes() {
  const lines = []
  const timeline = []
  let ended = false
  return {
    lines,
    timeline,
    get ended() { return ended },
    res: {
      writeHead() {},
      flushHeaders() {},
      write(chunk) {
        const text = String(chunk)
        lines.push(text)
        for (const row of text.split('\n')) {
          if (row.trim() !== '') timeline.push({ kind: 'write', event: JSON.parse(row) })
        }
      },
      end() {
        ended = true
        timeline.push({ kind: 'end' })
      },
      on() {},
    },
  }
}

test('runUpdateStreaming with stash: true leaves existing stash@{0} untouched when working tree is clean', async () => {
  const { base, localDir } = setupOriginAndLocalRepos()
  const binDir = join(base, 'bin')
  mkdirSync(binDir, { recursive: true })
  // 前置轻量 pnpm shim，保证测试秒级完成且完全离线稳定。
  writeFileSync(join(binDir, 'pnpm.cmd'), '@echo off\r\nexit /b 0\r\n')
  const posixShim = join(binDir, 'pnpm')
  writeFileSync(posixShim, '#!/bin/sh\nexit 0\n')
  chmodSync(posixShim, 0o755)

  const prevPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}${delimiter}${prevPath}`
  try {
    // 预先造一条用户历史 stash，之后工作树回到干净状态。
    writeFileSync(join(localDir, 'notes.txt'), 'precious local edit\n')
    git(localDir, ['stash', 'push', '-m', 'user-precious-stash'])
    assert.equal(git(localDir, ['status', '--porcelain']).trim(), '')
    assert.match(git(localDir, ['stash', 'list']), /user-precious-stash/)

    const stub = createStubRes()
    await runUpdateStreaming(localDir, stub.res, {
      stash: true,
      autoRestart: false,
      windowsDetachedUpdate: false,
      requiredPaths: [],
      peerConflictPolicy: 'ignore',
      profilesDir: join(base, 'no-profiles'),
    })

    assert.equal(stub.ended, true)
    const events = stub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
    const done = events.find((e) => e.type === 'done')
    assert.ok(done !== undefined, 'stream must finish with a done event')
    assert.equal(done.ok, true, `unexpected failure: ${done.error}`)
    assert.equal(done.to, 'dsh-v0.2.0')
    assert.equal(done.stashApplied, undefined, 'clean tree must not apply user stash')
    assert.equal(done.stashKept, undefined)

    assert.equal(git(localDir, ['describe', '--tags', '--exact-match', 'HEAD']).trim(), 'dsh-v0.2.0')
    const stashes = git(localDir, ['stash', 'list']).trim().split(/\r?\n/).filter(Boolean)
    assert.equal(stashes.length, 1, 'existing stash entry count must stay 1')
    assert.match(stashes[0], /user-precious-stash/)
    assert.equal(git(localDir, ['status', '--porcelain']).trim(), '', 'working tree must remain clean')
  } finally {
    process.env.PATH = prevPath
    rmSync(base, { recursive: true, force: true })
  }
})

test('handleRun handles "null" JSON body safely without locking the latch, and returns 413 for >64KiB body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-run-robust-'))
  try {
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root })
    const runRoute = routes.get(UPDATE_PATHS.run).fetch

    // 1. body 为 "null"：返回 200 SSE 并正常收尾，不抛 TypeError，也不锁死后续请求。
    const resNull = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    }))
    assert.equal(resNull.status, 200)
    assert.match(resNull.headers.get('content-type'), /text\/event-stream/)
    const eventsNull = (await resNull.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    const doneNull = eventsNull.find((e) => e.type === 'done')
    assert.ok(doneNull !== undefined)
    assert.equal(doneNull.ok, false)

    // 紧接着再发一次 /run：不能返回 409。
    const resNext = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    assert.equal(resNext.status, 200, 'follow-up /run must not be blocked with 409')
    const eventsNext = (await resNext.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(eventsNext.some((e) => e.type === 'done'))

    // 2. 超大 body（> 65536 字节）：返回 413。
    const oversized = JSON.stringify({ pad: 'a'.repeat(70_000) })
    assert.ok(Buffer.byteLength(oversized, 'utf8') > 65536)
    const resBig = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    }))
    assert.equal(resBig.status, 413)
    const bigBody = await resBig.json()
    assert.equal(bigBody.ok, false)
    assert.match(bigBody.error, /too large/i)

    await ctx._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/status, /release-notes, servingPort URL port, and no-port helper sources behave safely at runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-runtime-'))
  const helperDir = mkdtempSync(join(tmpdir(), 'dsh-helper-noport-'))
  try {
    git(root, ['init'])
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }) + '\n')
    writeFileSync(join(root, 'a.txt'), '1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'init'])
    git(root, ['tag', 'dsh-v0.1.0'])
    git(root, ['remote', 'add', 'origin', 'https://example.com/a/b.git'])

    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root, autoRestart: false })

    // 1. /status 不包含 restartScript，且非 GitHub origin 在 mirror 模式下返回中文 error。
    const statusRoute = routes.get(UPDATE_PATHS.status).fetch
    const statusRes = await statusRoute(new Request(
      'http://localhost' + UPDATE_PATHS.status + '?source=mirror&mirror=gh-proxy',
      { method: 'GET' },
    ))
    assert.equal(statusRes.status, 200)
    const statusBody = await statusRes.json()
    assert.equal('restartScript' in statusBody, false, '/status must not expose restartScript')
    assert.equal(statusBody.ok, false)
    assert.match(statusBody.error, /不是 GitHub 地址|无法使用镜像/)

    // 2. 非 GitHub origin 在 mirror 模式下调用 /run 同样提前返回失败 done 事件。
    const runRoute = routes.get(UPDATE_PATHS.run).fetch
    const runMirrorRes = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'mirror', mirror: 'gh-proxy' }),
    }))
    assert.equal(runMirrorRes.status, 200)
    const runMirrorEvents = (await runMirrorRes.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    const runMirrorDone = runMirrorEvents.find((e) => e.type === 'done')
    assert.ok(runMirrorDone !== undefined)
    assert.equal(runMirrorDone.ok, false)
    assert.match(runMirrorDone.error, /不是 GitHub 地址|无法使用镜像/)

    // 3. /release-notes?tag=bad-tag 返回 400。
    const notesRoute = routes.get(UPDATE_PATHS.notes).fetch
    const notesRes = await notesRoute(new Request('http://localhost' + UPDATE_PATHS.notes + '?tag=bad-tag', { method: 'GET' }))
    assert.equal(notesRes.status, 400)
    const notesBody = await notesRes.json()
    assert.equal(notesBody.ok, false)
    assert.match(notesBody.error, /invalid tag/i)

    // 4. 带 URL 端口（无 Host header）能正常处理。
    const portReq = new Request('http://127.0.0.1:4321' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'mirror', mirror: 'gh-proxy' }),
    })
    assert.equal(portReq.headers.get('host'), null)
    const portRes = await runRoute(portReq)
    assert.equal(portRes.status, 200)
    const portEvents = (await portRes.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(portEvents.some((e) => e.type === 'done'))

    // 5. 无 port 情况下的 helper 源码包含 5000 / 5500 等待、::1 探测与 < 32000 字符限制且语法合法。
    const baseHelperCtx = {
      repoDir: '/tmp/deepseek-harness',
      target: 'dsh-v0.2.2-alpha.2',
      rollbackRef: 'dsh-v0.2.1',
      stashedSomething: false,
      autoRestart: true,
      port: null,
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
    const updSrc = updateHelperSource(baseHelperCtx)
    const bootSrc = bootVerifyHelperSource(baseHelperCtx)
    for (const [name, src, waitMs] of [
      ['update-noport', updSrc, '5500'],
      ['boot-noport', bootSrc, '5000'],
    ]) {
      assert.ok(src.length < 32000, `${name} helper must be < 32000 chars (got ${src.length})`)
      assert.ok(src.includes(waitMs), `${name} helper must wait ${waitMs}ms when port is null`)
      assert.ok(src.includes('::1'), `${name} helper must probe ::1 as well as 127.0.0.1`)
      const file = join(helperDir, `${name}.cjs`)
      writeFileSync(file, src)
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    }

    await ctx._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(helperDir, { recursive: true, force: true })
  }
})

test('runUpdateStreaming promise resolves only after res.end() following async git fetch', async () => {
  const { base, localDir } = setupOriginAndLocalRepos()
  try {
    const stub = createStubRes()
    await runUpdateStreaming(localDir, stub.res, {
      targetTag: 'dsh-v0.9.9',
      autoRestart: false,
      windowsDetachedUpdate: false,
    })
    stub.timeline.push({ kind: 'resolved' })

    assert.equal(stub.ended, true, 'res.end() must have run before promise resolves')
    const endIdx = stub.timeline.findIndex((x) => x.kind === 'end')
    const resolvedIdx = stub.timeline.findIndex((x) => x.kind === 'resolved')
    assert.ok(endIdx !== -1 && endIdx < resolvedIdx, 'res.end() must happen strictly before promise resolution')

    const steps = stub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
    assert.ok(steps.some((e) => e.type === 'step' && /Fetching tags/.test(e.text)), 'must have run async git fetch')
    assert.ok(steps.some((e) => e.type === 'step' && /Verifying tag dsh-v0\.9\.9/.test(e.text)), 'must continue into post-fetch verification')
    const done = steps.find((e) => e.type === 'done')
    assert.ok(done !== undefined && done.ok === false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('client.js loads in node:vm, bails out safely without React, and guards reload watcher', async () => {
  const clientCode = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  function loadClient(opts = {}) {
    let loaded = null
    const store = new Map(Object.entries(opts.storage ?? {}))
    const timers = []
    let reloaded = 0
    const sandbox = {
      console,
      Date,
      Math,
      JSON,
      Number,
      String,
      Array,
      Object,
      Set,
      Map,
      RegExp,
      Error,
      Promise,
      TextDecoder,
      encodeURIComponent,
      parseInt,
      fetch: opts.fetch ?? (async () => ({ ok: false, status: 500 })),
      navigator: { language: 'zh-CN' },
      document: { documentElement: { lang: 'zh-CN' } },
      window: {
        __ModuleLoader__: { load(def) { loaded = def } },
        localStorage: {
          getItem(k) { return store.has(k) ? store.get(k) : null },
          setItem(k, v) { store.set(k, String(v)) },
          removeItem(k) { store.delete(k) },
        },
        location: { reload() { reloaded++ } },
        performance: { timeOrigin: opts.timeOrigin ?? 10_000 },
        setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
        clearTimeout() {},
      },
    }
    sandbox.setTimeout = sandbox.window.setTimeout
    sandbox.clearTimeout = sandbox.window.clearTimeout
    runInNewContext(clientCode, sandbox, { filename: 'lib/client.js' })
    assert.ok(loaded !== null && typeof loaded.factory === 'function')
    const exports = loaded.factory(opts.requireImpl ?? (() => { throw new Error('missing module') }))
    return { exports, store, timers, getReloaded: () => reloaded }
  }

  // 1. 缺少 React 时 apply() 安全早退，不抛异常、不调用 slots.inject。
  const noReact = loadClient()
  assert.equal(noReact.exports.name, '@zhucy123/dsh-update')
  assert.deepEqual([...noReact.exports.inject], ['slots'])
  let injectCalled = false
  noReact.exports.apply({ slots: { inject() { injectCalled = true } } })
  assert.equal(injectCalled, false, 'apply() must bail out before slots.inject when React is missing')

  // 2. React 缺少 useState 或 ctx 缺少 slots 时同样安全早退。
  const partialReact = loadClient({ requireImpl: (id) => (id === 'react' ? {} : null) })
  partialReact.exports.apply({ slots: { inject() { injectCalled = true } } })
  assert.equal(injectCalled, false)

  // 3. 有 React + slots 且 localStorage 含损坏数据时，apply() 正常注册且清理坏标记不抛错。
  const reactStub = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    createElement: (...args) => args,
    Fragment: Symbol('Fragment'),
  }
  const corrupt = loadClient({
    requireImpl: (id) => (id === 'react' ? reactStub : null),
    storage: { 'dsh-update:pending-reload': '{not-valid-json' },
  })
  const registered = []
  corrupt.exports.apply({
    locale: { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    slots: {
      inject(slot, factory) { return factory() },
      register(meta, component) { registered.push({ meta, component }); return () => {} },
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.name, 'sidebar.footer.action')
  assert.equal(registered[0].meta.id, 'dsh-update')
  assert.equal(registered[0].meta.order, 1000)
  assert.equal(corrupt.store.has('dsh-update:pending-reload'), false, 'corrupt pending-reload marker must be cleared')

  // 4. 新进程时间戳晚于 pageLoadedAt 才刷新；早于 pageLoadedAt（用户已手动刷新）不二次刷新。
  const nowMs = Date.now()
  const oldBoot = `${(nowMs - 5000).toString(36)}-old`
  const newerBoot = `${(nowMs + 5000).toString(36)}-new`
  const staleCheck = loadClient({
    requireImpl: (id) => (id === 'react' ? reactStub : null),
    timeOrigin: nowMs,
    storage: { 'dsh-update:pending-reload': JSON.stringify({ boot: oldBoot, target: 'dsh-v0.2.0', at: nowMs }) },
    fetch: async () => ({ ok: true, json: async () => ({ boot: newerBoot }) }),
  })
  staleCheck.exports.apply({
    locale: { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    slots: { inject: () => {}, register: () => () => {} },
  })
  assert.equal(staleCheck.timers.length, 1)
  await staleCheck.timers[0].fn()
  assert.equal(staleCheck.getReloaded(), 1, 'page predating new process must reload')

  const freshPageBoot = `${(nowMs - 1000).toString(36)}-curr`
  const noDoubleReload = loadClient({
    requireImpl: (id) => (id === 'react' ? reactStub : null),
    timeOrigin: nowMs,
    storage: { 'dsh-update:pending-reload': JSON.stringify({ boot: oldBoot, target: 'dsh-v0.2.0', at: nowMs }) },
    fetch: async () => ({ ok: true, json: async () => ({ boot: freshPageBoot }) }),
  })
  noDoubleReload.exports.apply({
    locale: { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    slots: { inject: () => {}, register: () => () => {} },
  })
  await noDoubleReload.timers[0].fn()
  assert.equal(noDoubleReload.getReloaded(), 0, 'page already served by the new process must not reload again')
})

// ---- 本地 HTTP CONNECT 代理与 release-notes 缓存隔离测试 ----------------------

function derLen(len) {
  if (len < 128) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
}

function derInt(buf) {
  const b = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf
  return der(0x02, b)
}

function derUtcTime(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const s = String(d.getUTCFullYear()).slice(-2)
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())
    + 'Z'
  return der(0x17, Buffer.from(s, 'ascii'))
}

function createLoopbackTlsCert() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const sha256Rsa = der(0x30, der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])), Buffer.from([0x05, 0x00]))
  const cn = der(0x30, der(0x31, der(0x30, der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from('localhost')))))
  const now = new Date(Date.now() - 60_000)
  const later = new Date(Date.now() + 86_400_000)
  const sanExt = der(0x30, der(0x06, Buffer.from([0x55, 0x1d, 0x11])), der(0x04, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1])))))
  const tbs = der(
    0x30,
    der(0xa0, derInt(Buffer.from([2]))),
    derInt(randomBytes(8)),
    sha256Rsa,
    cn,
    der(0x30, derUtcTime(now), derUtcTime(later)),
    cn,
    spki,
    der(0xa3, der(0x30, sanExt)),
  )
  const sig = cryptoSign('sha256', tbs, privateKey)
  const certDer = der(0x30, tbs, sha256Rsa, der(0x03, Buffer.from([0]), sig))
  const cert = '-----BEGIN CERTIFICATE-----\n' + certDer.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  return { cert, key }
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      resolve(addr.port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

test('fetchJson tunnels HTTPS through local HTTP CONNECT proxy (normal & chunked) and forwards HTTP GET', async () => {
  const { cert, key } = createLoopbackTlsCert()
  const httpsServer = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/normal') {
      const payload = JSON.stringify({ tag_name: 'dsh-v1.0.0', body: 'normal notes', html_url: 'https://github.com/a/b/releases/tag/dsh-v1.0.0' })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
      res.end(payload)
      return
    }
    if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
      res.write('{"body":"chunk')
      res.write('-1 ')
      res.end('chunk-2","ok":true}')
      return
    }
    if (req.url === '/not-found') {
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': '2' })
      res.end('{}')
      return
    }
    if (req.url === '/bad-json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5' })
      res.end('{bad!')
      return
    }
    if (req.url === '/oversized') {
      const big = Buffer.alloc(2 * 1024 * 1024 + 64, 0x61)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(big.length) })
      res.end(big)
      return
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'application/json' })
      // intentionally leave open to verify timeoutMs
      return
    }
    res.writeHead(400)
    res.end()
  })

  const httpTarget = http.createServer((req, res) => {
    const payload = JSON.stringify({ via: 'http-proxy', path: req.url })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
    res.end(payload)
  })

  const connectTargets = []
  const proxyGetPaths = []
  const proxyServer = http.createServer((req, res) => {
    proxyGetPaths.push(req.url)
    const targetUrl = new URL(req.url)
    const upstream = http.request({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || 80),
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: req.headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })
    upstream.on('error', (err) => {
      res.writeHead(502)
      res.end(err.message)
    })
    req.pipe(upstream)
  })

  const openSockets = new Set()
  proxyServer.on('connect', (req, clientSocket, head) => {
    connectTargets.push(req.url)
    const idx = req.url.lastIndexOf(':')
    const host = req.url.slice(0, idx)
    const port = Number(req.url.slice(idx + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    openSockets.add(clientSocket)
    openSockets.add(upstream)
    const drop = () => {
      openSockets.delete(clientSocket)
      openSockets.delete(upstream)
    }
    clientSocket.on('close', drop)
    upstream.on('close', drop)
    clientSocket.on('error', () => upstream.destroy())
    upstream.on('error', () => clientSocket.destroy())
  })

  const httpsPort = await listenServer(httpsServer)
  const httpPort = await listenServer(httpTarget)
  const proxyPort = await listenServer(proxyServer)

  try {
    // 1. HTTPS CONNECT + normal Content-Length JSON (verified against self-signed CA)
    const normal = await fetchJson(`https://127.0.0.1:${httpsPort}/normal`, 3000, proxyPort, { ca: cert })
    assert.equal(normal.error, undefined)
    assert.equal(normal.json.body, 'normal notes')

    // 2. HTTPS CONNECT + Transfer-Encoding: chunked JSON (also exercising rejectUnauthorized: false)
    const chunked = await fetchJson(`https://127.0.0.1:${httpsPort}/chunked`, 3000, proxyPort, { rejectUnauthorized: false })
    assert.equal(chunked.error, undefined)
    assert.equal(chunked.json.body, 'chunk-1 chunk-2')
    assert.equal(chunked.json.ok, true)

    assert.deepEqual(connectTargets, [`127.0.0.1:${httpsPort}`, `127.0.0.1:${httpsPort}`])

    // 3. Non-2xx, invalid JSON, oversized body, and shared timeout
    const notFound = await fetchJson(`https://127.0.0.1:${httpsPort}/not-found`, 3000, proxyPort, { ca: cert })
    assert.equal(notFound.error, 'HTTP 404')

    const badJson = await fetchJson(`https://127.0.0.1:${httpsPort}/bad-json`, 3000, proxyPort, { ca: cert })
    assert.ok(typeof badJson.error === 'string' && badJson.error.length > 0)

    const oversized = await fetchJson(`https://127.0.0.1:${httpsPort}/oversized`, 3000, proxyPort, { ca: cert })
    assert.match(oversized.error, /too large/i)

    const timedOut = await fetchJson(`https://127.0.0.1:${httpsPort}/slow`, 150, proxyPort, { ca: cert })
    assert.match(timedOut.error, /timed out/i)

    // 4. http:// URL routed via proxy absolute-form GET
    const httpViaProxy = await fetchJson(`http://127.0.0.1:${httpPort}/hello?x=1`, 3000, proxyPort)
    assert.equal(httpViaProxy.error, undefined)
    assert.equal(httpViaProxy.json.via, 'http-proxy')
    assert.equal(httpViaProxy.json.path, '/hello?x=1')
    assert.deepEqual(proxyGetPaths, [`http://127.0.0.1:${httpPort}/hello?x=1`])
  } finally {
    for (const s of openSockets) s.destroy()
    await Promise.all([closeServer(proxyServer), closeServer(httpsServer), closeServer(httpTarget)])
  }
})

test('fetchJson fails fast without leaking handles on 502 CONNECT rejection or closed proxy port', async () => {
  const rejectProxy = http.createServer((_req, res) => {
    res.writeHead(502)
    res.end()
  })
  rejectProxy.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  const rejectPort = await listenServer(rejectProxy)

  // Probe an ephemeral port then close it so nothing listens there.
  const tmpSrv = net.createServer()
  const closedPort = await listenServer(tmpSrv)
  await closeServer(tmpSrv)

  try {
    const r502 = await fetchJson('https://127.0.0.1:443/repos/a/b/releases/tags/dsh-v0.1.0', 2000, rejectPort)
    assert.equal(r502.error, 'Proxy CONNECT HTTP 502')

    const rClosed = await fetchJson('https://127.0.0.1:443/repos/a/b/releases/tags/dsh-v0.1.0', 2000, closedPort)
    assert.ok(typeof rClosed.error === 'string' && rClosed.error.length > 0)
  } finally {
    await closeServer(rejectProxy)
  }
})

test('/api/dsh-update/release-notes routes github+proxyPort through proxy and isolates error cache per proxyPort', async () => {
  const makeRejectProxy = (statusCode) => {
    let hits = 0
    const srv = http.createServer((_req, res) => {
      res.writeHead(statusCode)
      res.end()
    })
    srv.on('connect', (_req, socket) => {
      hits++
      socket.end(`HTTP/1.1 ${statusCode} Proxy Error\r\n\r\n`)
    })
    return { srv, hitsOf: () => hits }
  }

  const proxyA = makeRejectProxy(502)
  const proxyB = makeRejectProxy(503)
  const portA = await listenServer(proxyA.srv)
  const portB = await listenServer(proxyB.srv)

  const root = mkdtempSync(join(tmpdir(), 'dsh-notes-proxy-'))
  try {
    git(root, ['init'])
    git(root, ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'])
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root })
    const notesRoute = routes.get(UPDATE_PATHS.notes).fetch
    const tag = `dsh-v0.0.1-proxy${Date.now()}`

    // 1. First request with proxyPort=portA hits Proxy A and caches under github:<portA>.
    const resA1 = await notesRoute(new Request(
      `http://localhost${UPDATE_PATHS.notes}?tag=${tag}&source=github&proxyPort=${portA}`,
      { method: 'GET' },
    ))
    assert.equal(resA1.status, 200)
    const bodyA1 = await resA1.json()
    assert.equal(bodyA1.ok, false)
    assert.equal(bodyA1.error, 'Proxy CONNECT HTTP 502')
    assert.equal(proxyA.hitsOf(), 1)

    // 2. Request with different proxyPort=portB must NOT reuse portA's 5-min error cache.
    const resB = await notesRoute(new Request(
      `http://localhost${UPDATE_PATHS.notes}?tag=${tag}&source=github&proxyPort=${portB}`,
      { method: 'GET' },
    ))
    assert.equal(resB.status, 200)
    const bodyB = await resB.json()
    assert.equal(bodyB.ok, false)
    assert.equal(bodyB.error, 'Proxy CONNECT HTTP 503')
    assert.equal(proxyB.hitsOf(), 1)

    // 3. Second request with portA hits portA's own cache (no extra CONNECT hit).
    const resA2 = await notesRoute(new Request(
      `http://localhost${UPDATE_PATHS.notes}?tag=${tag}&source=github&proxyPort=${portA}`,
      { method: 'GET' },
    ))
    assert.equal(resA2.status, 200)
    const bodyA2 = await resA2.json()
    assert.equal(bodyA2.error, 'Proxy CONNECT HTTP 502')
    assert.equal(proxyA.hitsOf(), 1)

    await ctx._dispose()
  } finally {
    await Promise.all([closeServer(proxyA.srv), closeServer(proxyB.srv)])
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- Issues #2, #4, #5, #6, #9, #10 backend security & git fixes ------------

function withPnpmShim(binDir, fn) {
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'pnpm.cmd'), '@echo off\r\nexit /b 0\r\n')
  const posixShim = join(binDir, 'pnpm')
  writeFileSync(posixShim, '#!/bin/sh\nexit 0\n')
  chmodSync(posixShim, 0o755)
  const prevPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}${delimiter}${prevPath}`
  return Promise.resolve().then(fn).finally(() => {
    process.env.PATH = prevPath
  })
}

test('isNpmInstalledHarness and verifyHarnessRepo validate repo identity and reject npm/unrelated repos', () => {
  assert.equal(isNpmInstalledHarness('/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js'), true)
  assert.equal(isNpmInstalledHarness('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh-cli\\dist\\index.js'), true)
  assert.equal(isNpmInstalledHarness('/home/user/deepseek-harness/apps/cli/src/index.js'), false)
  assert.equal(isNpmInstalledHarness(''), false)

  const base = mkdtempSync(join(tmpdir(), 'dsh-verify-repo-'))
  try {
    const nonGit = join(base, 'non-git')
    mkdirSync(nonGit, { recursive: true })
    assert.deepEqual(verifyHarnessRepo(nonGit), {
      ok: false,
      code: 'not-git',
      error: `not a git checkout: ${nonGit}`,
    })
    const npmNonGit = verifyHarnessRepo(nonGit, { isNpmInstall: true })
    assert.equal(npmNonGit.ok, false)
    assert.equal(npmNonGit.code, 'npm-install')

    // Official root package.json names
    for (const pkgName of ['@deepseek-ai/dsh-root', 'deepseek-harness']) {
      const dir = join(base, pkgName.replace(/[^a-z0-9]/gi, '_'))
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName }))
      assert.equal(verifyHarnessRepo(dir).ok, true, `${pkgName} should pass`)
    }

    // apps/cli/package.json names
    for (const cliName of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-cli']) {
      const dir = join(base, 'cli-' + cliName.replace(/[^a-z0-9]/gi, '_'))
      mkdirSync(join(dir, '.git'), { recursive: true })
      mkdirSync(join(dir, 'apps', 'cli'), { recursive: true })
      writeFileSync(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: cliName }))
      assert.equal(verifyHarnessRepo(dir).ok, true, `cli ${cliName} should pass`)
    }

    // Fork origin URL
    const forkDir = join(base, 'fork-repo')
    mkdirSync(join(forkDir, '.git'), { recursive: true })
    writeFileSync(join(forkDir, 'package.json'), JSON.stringify({ name: 'custom-fork' }))
    assert.equal(verifyHarnessRepo(forkDir, { originUrl: 'https://github.com/someone/deepseek-harness.git' }).ok, true)
    assert.equal(verifyHarnessRepo(forkDir, { originUrl: 'git@github.com:someone/deepseek-harness' }).ok, true)

    // Unrelated git repo
    const otherDir = join(base, 'unrelated')
    mkdirSync(join(otherDir, '.git'), { recursive: true })
    writeFileSync(join(otherDir, 'package.json'), JSON.stringify({ name: 'my-other-app' }))
    const bad = verifyHarnessRepo(otherDir, { originUrl: 'https://github.com/someone/other-repo.git' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'not-harness-repo')

    const badNpm = verifyHarnessRepo(otherDir, { originUrl: 'https://github.com/someone/other-repo.git', isNpmInstall: true })
    assert.equal(badNpm.ok, false)
    assert.equal(badNpm.code, 'npm-install')
    assert.match(badNpm.error, /npm install -g @deepseek-ai\/dsh@latest/)

    // Explicit allowUnverifiedRepo bypass
    assert.equal(verifyHarnessRepo(otherDir, { allowUnverifiedRepo: true }).ok, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('unrelated git repository is rejected by /status and /run unless allowUnverifiedRepo is true', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-unrelated-runtime-'))
  const originDir = join(base, 'origin')
  const localDir = join(base, 'local')
  try {
    mkdirSync(originDir, { recursive: true })
    git(originDir, ['init'])
    writeFileSync(join(originDir, 'package.json'), JSON.stringify({ name: 'unrelated-project' }) + '\n')
    git(originDir, ['add', '.'])
    git(originDir, ['commit', '-m', 'init'])
    git(originDir, ['tag', 'dsh-v0.1.0'])
    git(base, ['clone', '-q', originDir, localDir])

    // Default: /status and /run reject unrelated git repo without fetching or checking out
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: localDir, autoRestart: false })
    const statusRes = await routes.get(UPDATE_PATHS.status).fetch(
      new Request('http://localhost' + UPDATE_PATHS.status, { method: 'GET' }),
    )
    const statusBody = await statusRes.json()
    assert.equal(statusBody.ok, false)
    assert.equal(statusBody.errorCode, 'not-harness-repo')

    const runRes = await routes.get(UPDATE_PATHS.run).fetch(
      new Request('http://localhost' + UPDATE_PATHS.run, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    const runEvents = (await runRes.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(runEvents.some((e) => e.type === 'step' && /Fetching tags/.test(e.text)), false)
    const done = runEvents.find((e) => e.type === 'done')
    assert.ok(done !== undefined && done.ok === false)
    assert.match(done.error, /not a deepseek-harness source repository/i)
    await ctx._dispose()

    // allowUnverifiedRepo: true skips repo identity check
    const allowed = await checkStatus(localDir, { repoDir: localDir, allowUnverifiedRepo: true })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.localTag, 'dsh-v0.1.0')

    // npm-installed argv1 rejects even inside an unrelated git repo when repoDir is not explicit
    const prevArgv1 = process.argv[1]
    const prevEnvRepo = process.env.DSH_UPDATE_REPO_DIR
    delete process.env.DSH_UPDATE_REPO_DIR
    process.argv[1] = '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js'
    try {
      const npmRejected = await checkStatus(localDir, undefined)
      assert.equal(npmRejected.ok, false)
      assert.equal(npmRejected.errorCode, 'npm-install')
    } finally {
      process.argv[1] = prevArgv1
      if (prevEnvRepo !== undefined) process.env.DSH_UPDATE_REPO_DIR = prevEnvRepo
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('verifyMirrorTagSha and mirror fetch validation block SHA mismatches and honor verifyMirrorSha', async () => {
  const { base, originDir, localDir } = setupOriginAndLocalRepos()
  try {
    const githubOrigin = 'https://github.com/deepseek-ai/deepseek-harness.git'
    const mirrorUrl = `https://gh-proxy.com/${githubOrigin}`
    git(localDir, ['remote', 'set-url', 'origin', githubOrigin])
    git(localDir, ['config', `url.${originDir}.insteadOf`, mirrorUrl])

    // Compute expected SHA of dsh-v0.2.0 in originDir
    const v2Sha = git(originDir, ['rev-parse', 'dsh-v0.2.0^{commit}']).trim()
    const v1Sha = git(localDir, ['rev-parse', 'HEAD']).trim()
    const mirrorNet = { source: 'mirror', mirror: { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' } }

    // 1. Mismatch -> immediately fail, HEAD must remain at v1
    const mismatchStub = createStubRes()
    await runUpdateStreaming(localDir, mismatchStub.res, {
      network: mirrorNet,
      autoRestart: false,
      windowsDetachedUpdate: false,
      requiredPaths: [],
      peerConflictPolicy: 'ignore',
      profilesDir: join(base, 'no-profiles'),
      mirrorShaFetcher: async () => ({ json: { sha: '0'.repeat(40) } }),
    })
    const mismatchEvents = mismatchStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
    const mismatchDone = mismatchEvents.find((e) => e.type === 'done')
    assert.ok(mismatchDone !== undefined && mismatchDone.ok === false)
    assert.match(mismatchDone.error, /不一致|篡改/)
    assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), v1Sha, 'HEAD must not change on SHA mismatch')

    // Unit check verifyMirrorTagSha statuses directly
    const directVerifyOk = await verifyMirrorTagSha(localDir, 'dsh-v0.2.0', 'deepseek-ai/deepseek-harness', {
      fetcher: async () => ({ json: { sha: v2Sha.toUpperCase() } }),
    })
    assert.equal(directVerifyOk.status, 'verified')
    const directVerifyFail = await verifyMirrorTagSha(localDir, 'dsh-v0.2.0', 'deepseek-ai/deepseek-harness', {
      fetcher: async () => ({ error: 'HTTP 503' }),
    })
    assert.equal(directVerifyFail.status, 'unverified')

    // 2. Official API fails + verifyMirrorSha: true -> strict fail without checkout
    const strictStub = createStubRes()
    await runUpdateStreaming(localDir, strictStub.res, {
      network: mirrorNet,
      verifyMirrorSha: true,
      autoRestart: false,
      windowsDetachedUpdate: false,
      requiredPaths: [],
      peerConflictPolicy: 'ignore',
      profilesDir: join(base, 'no-profiles'),
      mirrorShaFetcher: async () => ({ error: 'HTTP 503' }),
    })
    const strictEvents = strictStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
    const strictDone = strictEvents.find((e) => e.type === 'done')
    assert.ok(strictDone !== undefined && strictDone.ok === false)
    assert.match(strictDone.error, /verifyMirrorSha|无法从 GitHub 官方 API 核验/)
    assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), v1Sha)

    await withPnpmShim(join(base, 'bin'), async () => {
      // 3. Official API fails + default verifyMirrorSha: false -> warn notice & continue
      const warnStub = createStubRes()
      await runUpdateStreaming(localDir, warnStub.res, {
        network: mirrorNet,
        autoRestart: false,
        windowsDetachedUpdate: false,
        requiredPaths: [],
        peerConflictPolicy: 'ignore',
        profilesDir: join(base, 'no-profiles'),
        mirrorShaFetcher: async () => ({ error: 'network error' }),
      })
      const warnEvents = warnStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
      assert.ok(warnEvents.some((e) => e.type === 'notice' && /未能向 GitHub 官方 API 核验/.test(e.text)))
      const warnDone = warnEvents.find((e) => e.type === 'done')
      assert.ok(warnDone !== undefined && warnDone.ok === true, `expected ok:true, got ${warnDone?.error}`)
      assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), v2Sha)

      // 4. Rollback back to dsh-v0.1.0 with matching SHA -> verified notice & ok:true
      const matchStub = createStubRes()
      await runUpdateStreaming(localDir, matchStub.res, {
        network: mirrorNet,
        targetTag: 'dsh-v0.1.0',
        autoRestart: false,
        windowsDetachedUpdate: false,
        requiredPaths: [],
        peerConflictPolicy: 'ignore',
        profilesDir: join(base, 'no-profiles'),
        mirrorShaFetcher: async () => ({ json: { sha: v1Sha } }),
      })
      const matchEvents = matchStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
      assert.ok(matchEvents.some((e) => e.type === 'notice' && /核验.*一致/.test(e.text)))
      const matchDone = matchEvents.find((e) => e.type === 'done')
      assert.ok(matchDone !== undefined && matchDone.ok === true, `expected ok:true, got ${matchDone?.error}`)
      assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), v1Sha)
    })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('localVersion matches dsh-v* only and untagged local commits block checkout unless allowed', async () => {
  const { base, localDir } = setupOriginAndLocalRepos()
  try {
    // Unrelated tag on top of dsh-v0.1.0 must not shadow dsh-v0.1.0
    git(localDir, ['tag', 'other-v9.9.9'])
    const st1 = await checkStatus(localDir, { repoDir: localDir })
    assert.equal(st1.ok, true)
    assert.equal(st1.localTag, 'dsh-v0.1.0')
    assert.equal(st1.localAheadCommits, 0)

    // Add an untagged local commit
    writeFileSync(join(localDir, 'local-only.txt'), 'keep\n')
    git(localDir, ['add', 'local-only.txt'])
    git(localDir, ['commit', '-m', 'local untagged work'])
    const localHead = git(localDir, ['rev-parse', 'HEAD']).trim()
    assert.equal(countUntaggedLocalCommits(localDir), 1)

    const st2 = await checkStatus(localDir, { repoDir: localDir })
    assert.equal(st2.localAheadCommits, 1)

    // Default runUpdateStreaming refuses checkout
    const blockedStub = createStubRes()
    await runUpdateStreaming(localDir, blockedStub.res, {
      autoRestart: false,
      windowsDetachedUpdate: false,
      requiredPaths: [],
      peerConflictPolicy: 'ignore',
      profilesDir: join(base, 'no-profiles'),
    })
    const blockedDone = blockedStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event).find((e) => e.type === 'done')
    assert.ok(blockedDone !== undefined && blockedDone.ok === false)
    assert.match(blockedDone.error, /未包含在任何 dsh-v\* tag 中的本地提交/)
    assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), localHead)

    // allowLocalCommits: true proceeds
    await withPnpmShim(join(base, 'bin'), async () => {
      const okStub = createStubRes()
      await runUpdateStreaming(localDir, okStub.res, {
        allowLocalCommits: true,
        autoRestart: false,
        windowsDetachedUpdate: false,
        requiredPaths: [],
        peerConflictPolicy: 'ignore',
        profilesDir: join(base, 'no-profiles'),
      })
      const okDone = okStub.timeline.filter((x) => x.kind === 'write').map((x) => x.event).find((e) => e.type === 'done')
      assert.ok(okDone !== undefined && okDone.ok === true, `expected ok:true, got ${okDone?.error}`)
      assert.equal(git(localDir, ['describe', '--tags', '--exact-match', 'HEAD']).trim(), 'dsh-v0.2.0')
    })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('runUpdateStreaming restores pre-checkout stash when checkout fails after stash: true', async () => {
  const { base, originDir, localDir } = setupOriginAndLocalRepos()
  try {
    // Make dsh-v0.3.0 track file `blocked`, while localDir has a nested git repo at `blocked/`:
    // `git stash push -u` ignores the nested repo (stashing notes.txt) and `git checkout` aborts.
    writeFileSync(join(originDir, 'blocked'), 'from v0.3.0\n')
    git(originDir, ['add', 'blocked'])
    git(originDir, ['commit', '-m', 'release 0.3.0 with blocked'])
    git(originDir, ['tag', 'dsh-v0.3.0'])

    mkdirSync(join(localDir, 'blocked'), { recursive: true })
    git(join(localDir, 'blocked'), ['init'])
    writeFileSync(join(localDir, 'blocked', 'inner.txt'), 'nested repo file\n')
    writeFileSync(join(localDir, 'notes.txt'), 'precious uncommitted edit\n')

    const stub = createStubRes()
    await runUpdateStreaming(localDir, stub.res, {
      stash: true,
      autoRestart: false,
      windowsDetachedUpdate: false,
      requiredPaths: [],
      peerConflictPolicy: 'ignore',
      profilesDir: join(base, 'no-profiles'),
    })

    const events = stub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
    const done = events.find((e) => e.type === 'done')
    assert.ok(done !== undefined && done.ok === false, 'checkout failure must produce a failed done event')
    assert.match(done.error, /git checkout failed/)
    assert.ok(
      events.some((e) => e.type === 'step' && /Restoring your local changes after checkout failure/.test(e.text)),
      'must invoke post-checkout-failure stash restore',
    )

    // Pre-checkout uncommitted modification must be restored and stash stack must be empty
    assert.match(readFileSync(join(localDir, 'notes.txt'), 'utf8'), /^precious uncommitted edit\r?\n$/)
    assert.equal(git(localDir, ['stash', 'list']).trim(), '')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('handleRun returns 400 for invalid JSON or non-object JSON without locking the latch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-run-bad-json-'))
  try {
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root })
    const runRoute = routes.get(UPDATE_PATHS.run).fetch

    const badJsonRes = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    }))
    assert.equal(badJsonRes.status, 400)
    const badJsonBody = await badJsonRes.json()
    assert.equal(badJsonBody.ok, false)
    assert.equal(badJsonBody.error, 'invalid JSON body')

    const arrayRes = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2]',
    }))
    assert.equal(arrayRes.status, 400)
    const arrayBody = await arrayRes.json()
    assert.equal(arrayBody.ok, false)
    assert.equal(arrayBody.error, 'request body must be a JSON object')

    // Follow-up valid POST must return 200 (not 409)
    const okRes = await runRoute(new Request('http://localhost' + UPDATE_PATHS.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    assert.equal(okRes.status, 200)
    await okRes.text()
    await ctx._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('direct fetchJson enforces 2MB body limit on both Content-Length and chunked streams', async () => {
  const oversizedBytes = 2 * 1024 * 1024 + 128
  const server = http.createServer((req, res) => {
    if (req.url === '/cl-too-big') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(oversizedBytes) })
      res.end('a'.repeat(oversizedBytes))
      return
    }
    if (req.url === '/chunked-too-big') {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      for (let sent = 0; sent < oversizedBytes; sent += chunk.length) {
        res.write(chunk)
      }
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const port = await listenServer(server)
  try {
    const cl = await fetchJson(`http://127.0.0.1:${port}/cl-too-big`, 3000)
    assert.equal(cl.error, 'response body too large')

    const chunked = await fetchJson(`http://127.0.0.1:${port}/chunked-too-big`, 3000)
    assert.equal(chunked.error, 'response body too large')

    const ok = await fetchJson(`http://127.0.0.1:${port}/ok`, 3000)
    assert.deepEqual(ok, { json: { ok: true } })
  } finally {
    await closeServer(server)
  }
})

test('redactSecrets strips embedded URL credentials and inject does not require agents', async () => {
  assert.equal(
    redactSecrets('fatal: could not read from https://ghp_secret123@github.com/a/b.git and http://user:pass@proxy.local:8080/x'),
    'fatal: could not read from https://***@github.com/a/b.git and http://***@proxy.local:8080/x',
  )
  assert.equal(redactSecrets('plain message without secrets'), 'plain message without secrets')
  assert.equal(inject.includes('agents'), false, 'inject must not hard-require agents')

  const root = mkdtempSync(join(tmpdir(), 'dsh-no-agents-'))
  try {
    git(root, ['init'])
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }) + '\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'init'])
    git(root, ['tag', 'dsh-v0.1.0'])

    const routes = new Map()
    const ctxNoAgents = {
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return async () => {}
          },
        },
      },
      effect(fn) {
        ctxNoAgents._dispose = fn()
        return ctxNoAgents._dispose
      },
    }
    apply(ctxNoAgents, { repoDir: root, autoRestart: false })
    const statusRes = await routes.get(UPDATE_PATHS.status).fetch(
      new Request('http://localhost' + UPDATE_PATHS.status, { method: 'GET' }),
    )
    assert.equal(statusRes.status, 200)
    const statusBody = await statusRes.json()
    assert.equal(statusBody.busySessions, 0)
    assert.equal(statusBody.localTag, 'dsh-v0.1.0')
    await ctxNoAgents._dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- Issues #3, #7, #8, #10: helper lifecycle, supervisors, port & logs ----

test('detectedSupervisor and restartAllowed recognize all 6 supervisors and reject inherited shells', () => {
  const noMarker = { platform: 'linux', pid: 500, hasContainerMarker: false }
  // 1. systemd (system unit requires ppid === 1)
  assert.equal(detectedSupervisor({ INVOCATION_ID: 'abc' }, 1, noMarker), 'systemd')
  assert.equal(detectedSupervisor({ JOURNAL_STREAM: '8:1234' }, 1, noMarker), 'systemd')
  // 2. systemd-user
  assert.equal(detectedSupervisor({ NOTIFY_SOCKET: '/run/user/1000/systemd/notify' }, 42, noMarker), 'systemd-user')
  assert.equal(detectedSupervisor({ INVOCATION_ID: 'abc', MANAGERPID: '42' }, 42, noMarker), 'systemd-user')
  // 3. pm2
  assert.equal(detectedSupervisor({ pm_id: '0' }, 42, noMarker), 'pm2')
  // 4. supervisord
  assert.equal(detectedSupervisor({ SUPERVISOR_ENABLED: '1' }, 42, noMarker), 'supervisord')
  assert.equal(detectedSupervisor({ SUPERVISOR_PROCESS_NAME: 'dsh' }, 42, noMarker), 'supervisord')
  // 5. launchd (macOS, ppid === 1, non-zero XPC_SERVICE_NAME, no terminal/SSH)
  assert.equal(detectedSupervisor({ XPC_SERVICE_NAME: 'com.example.dsh' }, 1, { platform: 'darwin', pid: 500, hasContainerMarker: false }), 'launchd')
  // 6. container (non-win32 pid === 1 or ppid === 1 with container markers)
  assert.equal(detectedSupervisor({}, 0, { platform: 'linux', pid: 1, hasContainerMarker: false }), 'container')
  assert.equal(detectedSupervisor({ container: 'podman' }, 1, noMarker), 'container')
  assert.equal(detectedSupervisor({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 1, noMarker), 'container')
  assert.equal(detectedSupervisor({}, 1, { platform: 'linux', pid: 500, hasContainerMarker: true }), 'container')

  // Negative cases: ordinary shells or non-matching platforms/ppids
  assert.equal(detectedSupervisor({ INVOCATION_ID: 'abc' }, 1234, noMarker), null)
  assert.equal(detectedSupervisor({ INVOCATION_ID: 'abc', MANAGERPID: '42' }, 999, noMarker), null)
  assert.equal(detectedSupervisor({ XPC_SERVICE_NAME: '0' }, 1, { platform: 'darwin', pid: 500, hasContainerMarker: false }), null)
  assert.equal(detectedSupervisor({ XPC_SERVICE_NAME: 'com.apple.Terminal', TERM_PROGRAM: 'Apple_Terminal' }, 1, { platform: 'darwin', pid: 500, hasContainerMarker: false }), null)
  assert.equal(detectedSupervisor({ XPC_SERVICE_NAME: 'com.example.dsh', SSH_TTY: '/dev/ttys001' }, 1, { platform: 'darwin', pid: 500, hasContainerMarker: false }), null)
  assert.equal(detectedSupervisor({ XPC_SERVICE_NAME: 'com.example.dsh' }, 1, noMarker), null)
  assert.equal(detectedSupervisor({}, 0, { platform: 'win32', pid: 1, hasContainerMarker: false }), null)
  assert.equal(detectedSupervisor({ container: 'docker' }, 1, { platform: 'win32', pid: 500, hasContainerMarker: false }), null)

  // restartAllowed precedence: explicit config.allowRestart wins over supervisor detection
  assert.equal(restartAllowed({ allowRestart: true }, { pm_id: '0' }, 42, noMarker), true)
  assert.equal(restartAllowed({ allowRestart: false }, {}, 42, noMarker), false)
  assert.equal(restartAllowed(undefined, { pm_id: '0' }, 42, noMarker), false)
  assert.equal(restartAllowed(undefined, {}, 42, noMarker), true)
})

test('resolveListeningPort honors priority order and filters invalid ports', () => {
  const reqHost = { headers: { host: '127.0.0.1:6100' }, url: 'http://localhost:6101/api/dsh-update/restart' }
  const fullCtx = {
    webServer: { port: 4100, server: { address: () => ({ port: 4101 }) } },
    connection: { port: 4102 },
  }
  const argv = ['node', 'dsh.js', '--port', '5100']

  assert.equal(resolveListeningPort(reqHost, fullCtx, { port: 3100 }, argv), 3100)
  assert.equal(resolveListeningPort(reqHost, fullCtx, { port: '3101' }, argv), 3101)
  assert.equal(resolveListeningPort(reqHost, fullCtx, { port: 0 }, argv), 4100)
  assert.equal(resolveListeningPort(reqHost, { webServer: { server: { address: () => ({ port: 4101 }) } }, connection: { port: 4102 } }, undefined, argv), 4101)
  assert.equal(resolveListeningPort(reqHost, { connection: { port: 4102 } }, undefined, argv), 4102)
  assert.equal(resolveListeningPort(reqHost, {}, undefined, ['node', 'dsh.js', '--port=5101']), 5101)
  assert.equal(resolveListeningPort(reqHost, {}, undefined, ['node', 'dsh.js', '-p', '5102']), 5102)
  assert.equal(resolveListeningPort(reqHost, {}, undefined, ['node', 'dsh.js', '--port', '99999']), 6100)
  assert.equal(resolveListeningPort({ headers: {}, url: 'http://localhost:6101/x' }, {}, undefined, []), 6101)
  assert.equal(resolveListeningPort({ headers: { host: 'localhost' }, url: '/x' }, { webServer: { port: -1 } }, { port: '70000' }, ['--port', 'abc']), null)
})

test('parseDetachedUpdateLog extracts aborting and failure reasons without losing root cause', () => {
  const iso = '2026-11-28T13:00:00.000Z'
  const aborted = parseDetachedUpdateLog([
    '[dsh-update] boot verify started (target dsh-v0.2.0)',
    '[dsh-update] aborting: port 3080 still in use after 60s (host pid 1234 still alive); built dsh-v0.2.0 kept on disk — restart dsh manually',
  ].join('\n'), iso)
  assert.equal(aborted.ok, false)
  assert.equal(aborted.tag, undefined)
  assert.equal(aborted.bootChecked, true)
  assert.equal(aborted.at, iso)
  assert.equal(aborted.reason, 'port 3080 still in use after 60s (host pid 1234 still alive); built dsh-v0.2.0 kept on disk — restart dsh manually')

  const buildFailedThenRolledBack = parseDetachedUpdateLog([
    '[dsh-update] build finished — boot not checked (dsh-v0.2.0)',
    '[dsh-update] pnpm run build failed: TS2304 cannot find name Foo',
    '[dsh-update] rolled back to dsh-v0.1.0',
  ].join('\n'), iso)
  assert.equal(buildFailedThenRolledBack.ok, false)
  assert.equal(buildFailedThenRolledBack.tag, undefined)
  assert.equal(buildFailedThenRolledBack.bootChecked, true)
  assert.equal(buildFailedThenRolledBack.reason, 'TS2304 cannot find name Foo')

  const longErr = 'X'.repeat(300)
  const truncated = parseDetachedUpdateLog(`[dsh-update] pnpm install failed: ${longErr}`, iso)
  assert.equal(truncated.ok, false)
  assert.ok(truncated.reason.length <= 200)
  assert.ok(truncated.reason.endsWith('...'))
})

test('helper sources with hostPid pass syntax check and guard 60s port timeout with isPidAlive', () => {
  const ctx = {
    repoDir: '/tmp/deepseek-harness',
    target: 'dsh-v0.2.2-alpha.2',
    rollbackRef: 'dsh-v0.2.1',
    stashedSomething: false,
    autoRestart: true,
    port: 3080,
    hostPid: 12345,
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helper-hostpid-'))
  try {
    for (const [name, source] of [
      ['update', updateHelperSource(ctx)],
      ['boot', bootVerifyHelperSource(ctx)],
    ]) {
      assert.ok(source.length < 32000, `${name} helper is ${source.length} chars`)
      assert.match(source, /const hostPid = 12345/)
      assert.match(source, /const isPidAlive =/)
      assert.match(source, /hostPid && isPidAlive\(hostPid\)/)
      assert.match(source, /await rollback\(/)
      assert.match(source, /fs\.unlinkSync\(__filename\)/)
      const file = join(dir, `${name}.cjs`)
      writeFileSync(file, source)
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('async spawn failure on /restart returns 500, resets latch, leaves no .cjs files, and does not kill host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-restart-enoent-'))
  const logDir = join(root, 'logs')
  mkdirSync(logDir, { recursive: true })
  const missingNode = join(root, 'does-not-exist-node')
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)

  const beforeCjs = new Set(
    (await import('node:fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('dsh-update-helper-')),
  )
  try {
    const { ctx, routes } = mockCtx()
    apply(ctx, { repoDir: root, allowRestart: true, _helperNodePath: missingNode, _helperLogDir: logDir })
    const restartRoute = routes.get(UPDATE_PATHS.restart).fetch

    const res1 = await restartRoute(new Request('http://localhost:3080' + UPDATE_PATHS.restart, { method: 'POST' }))
    assert.equal(res1.status, 500)
    const body1 = await res1.json()
    assert.equal(body1.ok, false)
    assert.match(body1.error, /无法启动重启进程/)

    // Second request must ALSO attempt spawn and return 500 (not 200 { already: true })
    const res2 = await restartRoute(new Request('http://localhost:3080' + UPDATE_PATHS.restart, { method: 'POST' }))
    assert.equal(res2.status, 500)
    const body2 = await res2.json()
    assert.equal(body2.ok, false)

    await new Promise((r) => setTimeout(r, 600))
    assert.equal(sigtermCount, 0, 'failed spawn must never schedule SIGTERM on host')

    const afterCjs = (await import('node:fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('dsh-update-helper-') && !beforeCjs.has(f))
    assert.deepEqual(afterCjs, [], 'failed spawn must clean up temporary .cjs helper scripts')

    // scheduleDetachedUpdate and scheduleBootVerify must also reject & clean up on async ENOENT
    const baseOpts = {
      repoDir: root,
      target: 'dsh-v0.2.0',
      rollbackRef: 'dsh-v0.1.0',
      port: 3080,
      nodePath: missingNode,
      logDir,
    }
    await assert.rejects(() => scheduleDetachedUpdate(baseOpts))
    await assert.rejects(() => scheduleBootVerify(baseOpts))

    const afterAllCjs = (await import('node:fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('dsh-update-helper-') && !beforeCjs.has(f))
    assert.deepEqual(afterAllCjs, [], 'scheduleDetachedUpdate/scheduleBootVerify must clean up .cjs on failure')

    await ctx._dispose()
  } finally {
    process.removeListener('SIGTERM', onSigterm)
    rmSync(root, { recursive: true, force: true })
  }
})

test('spawnDetachedHelper executes a temp .cjs file (never -e) and helper self-deletes on exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helper-run-'))
  try {
    const marker = join(dir, 'ran.txt')
    const logOut = join(dir, 'out.log')
    const logErr = join(dir, 'err.log')
    const seenArgs = []
    const { spawn: realSpawn } = await import('node:child_process')
    const source = [
      "const fs = require('node:fs')",
      `const marker = ${JSON.stringify(marker)}`,
      'const main = async () => {',
      '  fs.writeFileSync(marker, __filename, "utf8")',
      '}',
      'main().finally(() => { try { fs.unlinkSync(__filename) } catch {} })',
    ].join('\n')

    const info = await spawnDetachedHelper({
      kind: 'test',
      source,
      logOut,
      logErr,
      spawnImpl(file, args, opts) {
        seenArgs.push({ file, args, opts })
        return realSpawn(file, args, opts)
      },
    })

    assert.equal(seenArgs.length, 1)
    assert.ok(!seenArgs[0].args.includes('-e'), 'must not pass -e inline script')
    assert.equal(seenArgs[0].args[0], info.scriptFile)
    assert.match(info.scriptFile, /dsh-update-helper-test-.*-[0-9a-f]{6}\.cjs$/)
    assert.equal(seenArgs[0].opts.detached, true)
    assert.equal(seenArgs[0].opts.windowsHide, true)

    // Wait for the child to write the marker and self-delete scriptFile
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (!existsSync(marker) || existsSync(info.scriptFile))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(existsSync(marker), true, 'helper .cjs script must execute')
    assert.equal(readFileSync(marker, 'utf8'), info.scriptFile)
    assert.equal(existsSync(info.scriptFile), false, 'helper .cjs script must self-delete on exit')

    // Also verify restartHelperSource ends with self-deletion and passes node --check
    const restartSrc = restartHelperSource(
      { file: process.execPath, args: ['-v'], viaShell: false, detached: false, windowsHide: true },
      { cwd: dir },
      { out: logOut, err: logErr },
      null,
    )
    assert.match(restartSrc, /fs\.unlinkSync\(__filename\)/)
    const restartCheck = join(dir, 'restart-check.cjs')
    writeFileSync(restartCheck, restartSrc)
    execFileSync(process.execPath, ['--check', restartCheck], { stdio: 'pipe' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runUpdateStreaming rolls back and does not kill host when scheduleBootVerify fails asynchronously', async () => {
  const { base, localDir } = setupOriginAndLocalRepos()
  const logDir = join(base, 'logs')
  mkdirSync(logDir, { recursive: true })
  const missingNode = join(base, 'missing-node-bin')
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)

  try {
    const v1Sha = git(localDir, ['rev-parse', 'dsh-v0.1.0^{commit}']).trim()
    await withPnpmShim(join(base, 'bin'), async () => {
      const stub = createStubRes()
      await runUpdateStreaming(localDir, stub.res, {
        autoRestart: true,
        windowsDetachedUpdate: false,
        requiredPaths: [],
        peerConflictPolicy: 'ignore',
        profilesDir: join(base, 'no-profiles'),
        _helperNodePath: missingNode,
        _helperLogDir: logDir,
      })
      const events = stub.timeline.filter((x) => x.kind === 'write').map((x) => x.event)
      const done = events.find((e) => e.type === 'done')
      assert.ok(done !== undefined)
      assert.equal(done.ok, false)
      assert.equal(done.rolledBack, true)
      assert.match(done.error, /无法启动健康检查/)
      assert.equal(git(localDir, ['rev-parse', 'HEAD']).trim(), v1Sha, 'failed boot-verify spawn must trigger rollback to v1')
    })
    assert.equal(sigtermCount, 0)
  } finally {
    process.removeListener('SIGTERM', onSigterm)
    rmSync(base, { recursive: true, force: true })
  }
})

test('client UpdateTrigger/UpdatePanel render npm-install, not-harness-repo, and fork repoSlug release URLs', async () => {
  const clientCode = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  function createReactHarness() {
    const Fragment = Symbol('Fragment')
    const instances = new Map()
    let currentHooks = null
    let hookIndex = 0
    const react = {
      Fragment,
      useState(init) {
        const idx = hookIndex++
        if (!(idx in currentHooks)) {
          currentHooks[idx] = { value: typeof init === 'function' ? init() : init }
        }
        const slot = currentHooks[idx]
        return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
      },
      useEffect() {},
      useRef(init) {
        const idx = hookIndex++
        if (!(idx in currentHooks)) {
          currentHooks[idx] = { current: init }
        }
        return currentHooks[idx]
      },
      useCallback(fn) { return fn },
      createElement(type, props, ...children) {
        const flat = []
        const push = (c) => {
          if (Array.isArray(c)) c.forEach(push)
          else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c)
        }
        children.forEach(push)
        return { type, props: props || {}, children: flat }
      },
    }
    function render(node, path = 'root') {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        if (!instances.has(path)) instances.set(path, [])
        const prevHooks = currentHooks
        const prevIdx = hookIndex
        currentHooks = instances.get(path)
        hookIndex = 0
        let out
        try {
          out = node.type({ ...node.props, children: node.children })
        } finally {
          currentHooks = prevHooks
          hookIndex = prevIdx
        }
        return render(out, path + '.fn')
      }
      return {
        type: node.type,
        props: node.props,
        children: node.children.map((c, i) => render(c, `${path}.${i}`)),
      }
    }
    function collect(node, pred, acc = []) {
      if (!node || typeof node !== 'object') return acc
      if (pred(node)) acc.push(node)
      if (Array.isArray(node.children)) {
        for (const c of node.children) collect(c, pred, acc)
      }
      return acc
    }
    function textOf(node) {
      if (node === null || node === undefined) return ''
      if (typeof node !== 'object') return String(node)
      return (node.children || []).map(textOf).join('')
    }
    return { react, render, collect, textOf }
  }

  async function renderAfterCheck({ lang = 'zh-CN', statusPayload, notesPayload = { ok: false } }) {
    const harness = createReactHarness()
    const opened = []
    let loaded = null
    const store = new Map()
    const sandbox = {
      console, Date, Math, JSON, Number, String, Array, Object, Set, Map, RegExp, Error, Promise, TextDecoder,
      encodeURIComponent, parseInt,
      fetch: async (url) => {
        if (String(url).startsWith('/api/dsh-update/status')) {
          return { ok: true, status: 200, json: async () => statusPayload }
        }
        if (String(url).startsWith('/api/dsh-update/release-notes')) {
          return { ok: true, status: 200, json: async () => notesPayload }
        }
        return { ok: false, status: 404, json: async () => ({}) }
      },
      navigator: { language: lang },
      document: { documentElement: { lang } },
      window: {
        __ModuleLoader__: { load(def) { loaded = def } },
        localStorage: {
          getItem(k) { return store.has(k) ? store.get(k) : null },
          setItem(k, v) { store.set(k, String(v)) },
          removeItem(k) { store.delete(k) },
        },
        open(url, target, features) { opened.push({ url, target, features }) },
        setTimeout() { return 1 },
        clearTimeout() {},
        setInterval() { return 1 },
        clearInterval() {},
        addEventListener() {},
        removeEventListener() {},
      },
    }
    sandbox.setTimeout = sandbox.window.setTimeout
    sandbox.clearTimeout = sandbox.window.clearTimeout
    runInNewContext(clientCode, sandbox, { filename: 'lib/client.js' })
    const exports = loaded.factory((id) => (id === 'react' ? harness.react : null))
    let TriggerComponent = null
    exports.apply({
      locale: { getLocale: () => ({ active: lang }), subscribe: () => () => {} },
      slots: {
        inject(_slot, factory) { return factory() },
        register(_meta, component) { TriggerComponent = component; return () => {} },
      },
    })
    assert.equal(typeof TriggerComponent, 'function')

    // Click the trigger button to open the panel and await /status + /release-notes
    const initialTree = harness.render(harness.react.createElement(TriggerComponent, { wide: true }))
    const triggerBtn = harness.collect(initialTree, (n) => n.type === 'button')[0]
    triggerBtn.props.onClick()
    await new Promise((r) => setTimeout(r, 15))
    const tree = harness.render(harness.react.createElement(TriggerComponent, { wide: true }))
    return { tree, harness, opened }
  }

  // 1. npm-install errorCode renders upgrade guidance in zh and en
  const npmZh = await renderAfterCheck({
    lang: 'zh-CN',
    statusPayload: {
      ok: false, errorCode: 'npm-install', repoDir: '/tmp/app',
      error: 'not a git checkout (installed via npm): /tmp/app', localCommit: '', outdated: false,
    },
  })
  const npmZhText = npmZh.harness.textOf(npmZh.tree)
  assert.match(npmZhText, /@deepseek-ai\/dsh/)
  assert.match(npmZhText, /npm install -g @deepseek-ai\/dsh@latest/)
  assert.match(npmZhText, /源码仓库/)

  const npmEn = await renderAfterCheck({
    lang: 'en-US',
    statusPayload: {
      ok: false, errorCode: 'npm-install', repoDir: '/tmp/app',
      error: 'not a git checkout (installed via npm): /tmp/app', localCommit: '', outdated: false,
    },
  })
  const npmEnText = npmEn.harness.textOf(npmEn.tree)
  assert.match(npmEnText, /npm install -g @deepseek-ai\/dsh@latest/)
  assert.match(npmEnText, /source checkout/)

  // 2. not-harness-repo errorCode renders refusal message with repoDir
  const notHarness = await renderAfterCheck({
    lang: 'zh-CN',
    statusPayload: {
      ok: false, errorCode: 'not-harness-repo', repoDir: '/tmp/other-project',
      error: 'target directory is not a deepseek-harness source repository: /tmp/other-project', localCommit: '', outdated: false,
    },
  })
  const notHarnessText = notHarness.harness.textOf(notHarness.tree)
  assert.match(notHarnessText, /deepseek-harness 源码仓库/)
  assert.match(notHarnessText, /\/tmp\/other-project/)

  // 3. Fork repoSlug drives both error-fallback <a> href and official release-notes button URL
  const fork = await renderAfterCheck({
    lang: 'zh-CN',
    statusPayload: {
      ok: true, outdated: true, localTag: 'dsh-v0.1.0', remoteTag: 'dsh-v0.2.0',
      repoSlug: 'alice/deepseek-harness', tags: ['dsh-v0.1.0'],
    },
    notesPayload: { ok: false },
  })
  const forkLinks = fork.harness.collect(fork.tree, (n) => n.type === 'a')
  assert.ok(forkLinks.some((a) => a.props.href === 'https://github.com/alice/deepseek-harness/releases'))
  const notesBtn = fork.harness.collect(
    fork.tree,
    (n) => n.type === 'button' && n.props.title === 'https://github.com/alice/deepseek-harness/releases/tag/dsh-v0.2.0',
  )[0]
  assert.ok(notesBtn, 'release notes button must use fork repoSlug URL')
  notesBtn.props.onClick()
  assert.deepEqual(fork.opened, [{
    url: 'https://github.com/alice/deepseek-harness/releases/tag/dsh-v0.2.0',
    target: '_blank',
    features: 'noopener,noreferrer',
  }])

  // 4. Malformed repoSlug falls back safely to deepseek-ai/deepseek-harness
  const badSlug = await renderAfterCheck({
    lang: 'zh-CN',
    statusPayload: {
      ok: true, outdated: true, localTag: 'dsh-v0.1.0', remoteTag: 'dsh-v0.2.0',
      repoSlug: 'https://evil.example/x/y', tags: ['dsh-v0.1.0'],
    },
    notesPayload: { ok: false },
  })
  const badLinks = badSlug.harness.collect(badSlug.tree, (n) => n.type === 'a')
  assert.ok(badLinks.some((a) => a.props.href === 'https://github.com/deepseek-ai/deepseek-harness/releases'))
  assert.ok(badSlug.harness.collect(
    badSlug.tree,
    (n) => n.type === 'button' && n.props.title === 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0',
  ).length === 1)
})
