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
import { apply, UPDATE_PATHS, inject, bootVerifyHelperSource, updateHelperSource, sanitizeGitEnv } from '../lib/index.js'
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
  for (const [name, extra] of Object.entries(malformed)) {
    const clean = sanitizeGitEnv({ ...base, ...extra })
    const leaked = Object.keys(clean).filter((key) => /^GIT_CONFIG_/.test(key))
    assert.deepEqual(leaked, [], `${name}: leaked ${leaked.join(', ')}`)
    assert.equal(clean.PATH, 'x', `${name}: unrelated vars must survive`)
  }

  // 完整合法的注入必须原样保留：那是用户/父进程有意设置的 git 配置。
  const intact = { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store' }
  assert.deepEqual(sanitizeGitEnv(intact), intact)

  // 完全没有注入时零改动（最常见路径）。
  assert.equal(sanitizeGitEnv(base), base)
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
  apply(ctx, { repoDir: mkdtempSync(join(tmpdir(), 'dsh-update-routes-')) })
  assert.equal(webServerRoutes.length, 0, 'no route may bypass connection auth via webServer.register')
  assert.deepEqual([...routes.keys()].sort(), [
    UPDATE_PATHS.status, UPDATE_PATHS.ping, UPDATE_PATHS.notes, UPDATE_PATHS.run, UPDATE_PATHS.restart,
  ].sort())
  assert.deepEqual(routes.get(UPDATE_PATHS.status).methods, ['GET'])
  assert.deepEqual(routes.get(UPDATE_PATHS.run).methods, ['POST'])
  assert.equal(routes.get(UPDATE_PATHS.run).requestBody, 'streaming')
  assert.equal(routes.get(UPDATE_PATHS.restart).requestBody, 'buffered')
  await ctx._dispose()
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
