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
import { bootVerifyHelperSource, updateHelperSource, sanitizeGitEnv } from '../lib/index.js'
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
