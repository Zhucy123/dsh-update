# Changelog

本插件遵循 [semver](https://semver.org/lang/zh-CN/) 与 DSH 的 `dsh-v*` 版本节奏无关——插件的功能/修复版本独立递增。

> **npm 包名**:`@zhucy123/dsh-update`(2026-09-02 发布时,裸名 `dsh-update` 已被第三方注册为 1.3KB 占位空壳包,故采用 scoped 名;插件 ID 与 `/api/dsh-update/*` 路由前缀仍为 `dsh-update`,下方 v1.2.0 条目中的历史命令仅作说明)。

## v1.8.0(当前)

本次更新(**手动更新到 alpha 仍然可用,但缺 contextMenus / 残留 lib/ / 插件加载失败不再把 Web UI 留在坏状态**):

- **不屏蔽 alpha 通道**:`dsh-v*` 比较仍包含 prerelease。有新版时除了「开始更新」到最新 tag,还可以在「指定版本(含 alpha)」里选任意本地 tag。回退列表同样保留 alpha
- **fetch 之后重算目标**:checkout 用的 tag 在 `git fetch --tags` 成功后重新取远程最新 tag(失败则用刚拉到的本地 tag),不再沿用打开面板时缓存的 `remoteTag`
- **检出前 requiredPaths**:默认必须能在目标 tag 里找到 `packages/client/ui-context-menu/package.json`。缺少则拒绝,中英文说明该 tag 没有 `contextMenus`、旧 `lib/` 会让页面停在 `Failed to load plugins` / `N entries did not activate`。面板提供「仍要检出」覆盖;`config.allowMissingRequiredPaths: true` 或 `requiredPaths: []` 可放宽。环境变量 `DSH_UPDATE_REQUIRED_PATHS`(逗号分隔)同样有效
- **残留 lib/ 只删白名单内的孤儿目录**:检出后,若某个包在旧树有 `package.json`、新树没有,且路径位于 `packages/` 或 `apps/`(可用 `orphanLibRoots` 改),删除该包下的 `lib/`。拒绝 `..`、绝对路径和指向仓库外的真实路径;符号链接只解除链接本身
- **`pnpm run clean` 失败即失败**:不再警告后继续 build。install / clean / build 失败都会 checkout 回更新前的 tag(或 commit),并重新 install、clean、build
- **启动健康检查**:自动重启开启时,构建成功后拉起新 dsh,在端口起来后再观察 `bootHealthWindowMs`(默认 15 秒)。日志出现 `did not activate`(不含 `0 entries did not activate`)、`Failed to load plugins` 或同一行里的 HARNESS + plugin + fail,就杀掉新进程、回到上一版本并重新构建。成功必须看到干净的启动窗口,而不是只看 build 退出码。自动重启关闭时面板会写明「未做启动检查」
- **插件 peer 提示**:更新前扫描 `~/.dsh/profiles/*/package.json`、直接依赖,以及 `plugins/` 下的 package.json。名称里带 dsh / harness / deepseek 的 peer 若罩不住目标版本(含 alpha 不满足稳定 range 的 WorkBuddy 式钉版本),默认 `confirm` 列出冲突后才继续。`peerConflictPolicy` 还可设为 `block` 或 `ignore`
- 新增 `node --test test/update-safety.test.mjs` 覆盖 tag 比较、semver/peer、requiredPaths、残留 lib/ 删除和启动日志判定

## v1.7.0

本次更新(**Windows 默认回到「进程内更新」——恢复页面全程可见进度的旧体验**):

- **`windowsDetachedUpdate` 默认值由 `true` 改为 `false`**:v1.6.3 为解决 Windows 上 `pnpm install` 删不掉被锁旧包的问题,把 install/build 默认移交 detached 后台进程,代价是**交接后页面断开、进度看不全、需要刷新**。现在恢复默认走**进程内**路径:整个更新(fetch → stash → checkout → install → clean → build → 重启)都在同一个进程里跑,面板持续输出实时进度、不会中途断开——就是 v1.6.2 之前的使用体验
- **后台分离模式改为按需开启**:若确实撞上文件锁(`pnpm install` 因 `[WARN] Failed to remove ...` 失败并回滚),在 profile 的 `cordis.patch.yml` 给该 bundle 加 `config: { windowsDetachedUpdate: true }` 即可切回后台模式。失败时插件仍按「失败不自伤」自动回滚,工作树不会停在半更新状态
- **客户端提示不再靠 UA 猜**:面板此前用 `navigator.userAgent` 判断 Windows 并显示「页面会断开、更新转入后台」警告——在默认(进程内)模式下这是**误导性**提示。现在服务端 `/status` 新增 `detachedUpdate` 字段(由平台 + config 真实判定),客户端据此显示对应文案;进程内模式下改为明确提示「进度会一直显示在本面板上,不会中途断开」
- **修正两处中英文分支写反**:`available` 视图里的两段 Windows detached 说明(`autoRestart` 开 / 关两种情形),`en ? … : …` 三元里英文分支写的却是中文(反之亦然),英文界面下会显示中文
- 保留 v1.6.3 的后台分离实现与 v1.6.4 的配套修复(交接卡片标题、隐藏重启按钮防双进程抢端口、交接空窗期并发保护)——显式开启该模式时依然生效
- 行为无其它变化;`link:` 安装改源码即生效,重启一次 `dsh web` 后新默认值可用

## v1.6.4

本次更新(**v1.6.3「Windows 后台分离更新」的配套修复 + 健壮性加固**):

- **后台交接卡片标题不再自相矛盾**:done 携带 `detached` 时标题此前仍按 `ok:true` 渲染成「**更新完成**」,与卡片正文「更新已转入后台执行」互相打架,容易让用户误以为已更新成功。现在 detached 单独渲染标题「更新已转入后台执行」
- **后台交接时隐藏「重启DSH / 立即重启」按钮**:交接后 update helper 已在等端口释放并自行拉起新 dsh;此时用户点重启会走 `/restart` 再生成一个 restart helper,两个 helper 各自拉起 dsh 并抢同一个端口(`restartScheduled` latch 只约束 `/restart` 路由,管不到 update helper)。detached 卡片现在只保留「重新检查」
- **更新说明支持 Markdown 语法**:GitHub Releases API 的 `body` 返回的是 Markdown 源码,此前只识别 `<h3>…</h3>`,用 `### 小标题` 写法会原样显示成「### xxx」。现在同时支持 `#`~`######`、`* / -` 与 `1.` 列表,并剥离 `[文字](链接)` 只留文字(不再露出裸 Markdown)
- **断网 / 远程检查失败时仍可回退**:「版本回退」入口此前要求 `status.error === undefined`,GitHub 不可达(直连与镜像均失败)时整块回退 UI 被隐藏——而回退完全离线(用本地 `git tag -l`),恰恰是断网时最需要。现在只要有可选历史 tag 就显示;没有时明确说明「本地尚未拉取到其它 dsh-v* tag」,而非默默不显示
- **react-dom 未注入时不再点不动**:`ReactDOM` 为 null 时此前无条件 `createPortal`,点按钮直接抛 TypeError、面板永远打不开且无任何提示;现在降级为就地渲染,面板照常可用
- **后台交接的 4 秒空窗期并发保护生效**:`endRun()` 会清掉 `activeRun`,而本进程还要活 4 秒才退出,这期间另一个标签页可再次触发 `/run` 或 `/restart`。新增 `handingOff` 标志,`/run` 与 `/restart` 统一用 `updateInFlight()`(activeRun ‖ handingOff)判定,空窗期继续返回 409
- **`/status` 不再每次全量扫描临时目录**:「上次后台更新」结果(`lastDetachedUpdate`)按 mtime 缓存 5 秒,避免开面板时反复 `readdirSync` + 逐个 `statSync` 整个 tmpdir
- **失败自动回滚不再指向 `unknown`**:`localVersion()` 取不到 commit 时原本返回字符串 `'unknown'`,而它被当作回滚 checkout 目标,会产生 `git checkout unknown` 这种必然失败的回滚;改为返回 undefined
- 修正一处过期注释(自动重启倒计时早已是 2 秒,注释仍写 8 秒);README 版本徽章与「版本历史」章节同步到当前版本(v1.6.3 发布时漏改,仍显示 1.6.2)
- 行为无其它变化;`link:` 安装改源码即生效,重启一次 `dsh web` 后 host 端改动生效

## v1.6.3

本次更新(**修复 Windows 上更新时因服务占用文件锁而失败回滚的根因问题**):

- **Windows 改为「后台分离更新」模式**:此前整个更新流程(git fetch/stash/checkout → `pnpm install` → `pnpm run build`)都在运行中的 dsh 进程内执行——Windows 上运行中的服务占用旧 `node_modules` 包文件句柄(尤其原生 `.node` 模块),`pnpm install` 删不掉被锁旧包(典型报错 `[WARN] Failed to remove ...\fs-ext@2.1.1`),install 未完成 → 插件按「失败不自伤」自动回滚,更新永远失败
- **修复方案**:git 步骤(fetch/stash/checkout)不动 `node_modules`,仍留在进程内完成(保持原有冲突检测/自动暂存交互);checkout 成功后,install → stash apply/drop → clean → build → 自动重启 整体移交 **detached 后台进程**(`scheduleDetachedUpdate` + `updateHelperSource`):主进程应答 `done{detached}` 后 4 秒退出、释放全部文件锁,helper 等端口释放后无锁执行 install/build,成功后按原命令拉起新 dsh、失败则自动 `git checkout` 回滚并写日志——全程进度写入 `%TEMP%\dsh-update-apply-*.log` 便于页面断开后排障
- **客户端配套**:done 携带 `detached` 时渲染专用卡片(「更新已转入后台执行」,不再误显示绿色「更新成功」);更新前/更新中提示在 Windows 客户端额外说明「页面会断开、后台完成并自动重启」;后台日志路径展示在结果卡片上
- **提醒链路完整覆盖**(页面断开前后):① 点「开始更新」前 Windows 客户端追加后台模式说明;② 更新中(updating 视图)高亮横幅「git 步骤完成后本页面会断开…」;③ 交接瞬间服务端追加 notice;④ done 卡片;⑤ 交接后本进程 **4 秒**后才退出(原 1.5 秒),给用户读完提示的窗口;⑥ **页面恢复后确认**:`/status` 新增 `lastUpdate` 字段,解析最新 `dsh-update-apply-*.err.log` 给出「✓ 上次后台更新已完成:版本 X(时间)」或「⚠ 上次后台更新未完成/已回滚」,用户刷新后打开面板即可确认后台更新结果
- **可配置**:`config.windowsDetachedUpdate: false` 可关闭后台分离模式,回到旧的进程内 install/build 路径(Windows 上大概率因文件锁再次失败,仅供排查)
- POSIX(macOS/Linux)流程不变——POSIX 允许 unlink 被打开的文件,进程内 install 无锁冲突
- 行为无其它变化;`link:` 安装改源码即生效,重启一次 `dsh web` 后新流程可用

## v1.6.2

本次更新(**修复 scoped 包名发布后插件无法加载的 bug**):

- **插件注册 ID 与安装包名对齐**:v1.6.1 起以 scoped 名 `@zhucy123/dsh-update` 发布(裸名 `dsh-update` 已被第三方占用),但插件内部两处加载标识仍指向旧的裸名,导致 DSH 框架按 scoped 包名加载时找不到匹配的注册插件——表现为侧边栏「⭯ 更新DSH」按钮消失、控制台报 ID 不匹配。本次将这两处统一改为 scoped 包名:
  - `cordis.patch.yml` 的 loader 入口 `name:`:`dsh-update` → `@zhucy123/dsh-update`(Cordis 补丁层按包名在 profile 的 `node_modules` 解析插件,必须与安装名一致)
  - `lib/client.js` 的浏览器注册 `load({ id })` 与 `PLUGIN_ID`:`dsh-update` → `@zhucy123/dsh-update`(`window.__ModuleLoader__` 按包名注册客户端 bundle,ID 必须匹配)
- 插件的**内部标识不变**(`lib/index.js` 的 host 插件 id `dsh-update`、侧边栏插槽 id、`/api/dsh-update/*` 路由前缀)——DSH 解耦「安装包名」与「插件内部 id」,scoped 名只影响安装/加载,安装后对用户无感知差异
- 行为无其它变化;`link:` 安装改源码即生效,完全重启一次 `dsh web` 后侧边栏按钮恢复

## v1.6.1

本次更新(Windows 自动重启修复 + 对抗性审查加固):

- **修复 Windows 自动重启静默失败**:更新结束后「自动重启 dsh」被触发,但替换进程从未启动,页面变空白且服务不再运行,只能手动重启(现象:helper 诊断「the replacement did not bind port 3080 within 20s」,out 日志为 0 字节)。根因是 Windows 分支用 Node `spawn(detached: true)` 包裹 PowerShell 拉起替换进程——Windows 上 `detached: true` 设 `DETACHED_PROCESS`,破坏 PowerShell → node 的句柄/控制台继承(Node.js issue #51018),替换 node 进程不会真正启动
- **Windows 重启改回 `detached: false`**:与 dsh-market 在 Windows 上久经验证的重启配置对齐(`-WindowStyle Hidden` 仍保证服务全程静默、无可见控制台;进程组独立性由 helper 自身的 detached 会话继承而来,关闭任何窗口不影响服务;`windowsHide: true` 保持窗口不弹)。POSIX 分支不变(仍 `detached: true` + setsid)
- **修复客户端 `useLocale` 无限重渲染**:订阅依赖数组误含 `tick`,导致语言运行时就绪后每次重渲染都重跑 effect 再自增 `tick`——无限提交循环、CPU 空转。改为仅依赖 `localeFace`(与 source-code-mgmt 同款模式),语言切换仍实时订阅生效
- **修复重启 latch 泄漏**:`scheduleRestart` 拉起 helper 失败(如 EMFILE)时解除 `restartScheduled` latch 并抛错,`/restart` 明确应答 500——此前失败后 latch 永远为 true,后续手动/自动重启全被静默吞掉、重启能力永久失效
- **暂存纳入未跟踪文件**:自动暂存改用 `git stash push -u`。此前未跟踪文件不在暂存内,若新版本占用同一路径,checkout 持续报「untracked working tree files would be overwritten」,「自动暂存并继续更新」陷入死循环;现在未跟踪文件一并暂存并在成功后原样恢复(gitignore 文件不受影响)
- **stash drop / 清理工作树失败提示**:这两步失败不再静默继续,面板会给出明确提示(不影响本次更新成败判定)
- **POSIX pnpm 探测加 10s 超时**:`pnpm --version` 探测异常挂死(损坏的 nvm/别名 shim)时不再无限阻塞事件循环,超时/失败自动落回 `corepack pnpm` 兜底
- 行为无其它变化;`link:` 安装改源码即生效,重启一次 dsh 后自动重启机制恢复可用

## v1.6.0

本次更新(macOS / Linux 兼容适配 + 第一性原理 / 对抗式加固):

**跨平台(macOS / Linux)**
- **重启入口不再依赖 `dsh` 在 PATH**:`restartLaunch` 只要有 `argv[1]` 就用 node + 原入口 + `execArgv`/参数/工作目录重新拉起——macOS/Linux 上 dsh 常装在 node_modules、只能经 pnpm/corepack 访问,此前裸 `dsh` 兜底会失败
- **POSIX 重启进程脱离终端**:`respawnInvocation` 的 POSIX 分支用 `detached: true`(Node 内部 `setsid`)让替换进程成为独立会话/进程组、无控制终端——关闭启动它的终端/窗口不影响服务,输出走 tmpdir 日志,全程静默(与 v1.5.2 的 Windows 语义对齐)
- **pnpm 解析兼容 POSIX**:优先 `pnpm`,缺失时自动回退 `corepack pnpm`(Node 16.9+ 自带),覆盖 macOS/Linux 全新环境只有 corepack、没有全局 pnpm 的场景
- **git / pnpm 缺失时快速失败**:spawn 异步失败(二进制不存在/不在 PATH)时立即以明确错误结束,不再挂到超时才报「timed out」;并加 `delivered` 防重 guard,避免 close/error 双回调

**第一性原理加固(失败不自伤)**
- **失败自动回滚**:已 `git checkout` 到新版本后,若 `pnpm install` / `pnpm run build` 失败,自动 `git checkout` 回更新/回退前的版本(优先原 tag,本地无 tag 时回原 commit),避免工作树与产物停留在半更新状态;回滚失败会在错误里给出手动恢复命令
- **超时 SIGKILL 兜底**:git/pnpm 挂死时,`SIGTERM` 后 3 秒补 `SIGKILL`,避免进程残留
- **`gitSync` 30s 超时**:同步 git 调用(如回滚 checkout)不再可能永久阻塞事件循环
- **客户端自动重启失败兜底**:done 携带 `autoRestart` 时,若 `restartInMs` + 10 秒后页面仍存活(自动重启未生效),自动提示「重启失败,请手动重启」并提供「立即重启」按钮——不再卡在倒计时 1 秒

**对抗式加固(健壮性 / 安全性)**
- **浏览器断开不再拖垮 host**:`res.write` 包 try/catch + `res.on('error')` 兜底——更新中页面变白/F5(连接断开)不再抛未捕获异常导致 dsh 进程崩溃
- **git 输出强制英文**:`GIT_ENV` 加 `LC_ALL:C` + `LANG:C`——冲突检测 / 空 stash 判定不再受 zh_CN 等非英文 locale 本地化输出影响
- **回滚目标兜底**:`from ?? status.localCommit`,本地不在 tag 上时也能自动回滚
- **回退目标白名单**:`targetTag` 必须匹配 `dsh-v*` 发布 tag,拒绝任意 ref(分支/commit),防异常调用把 checkout 引向任意引用

## v1.5.2

本次更新:

- **Windows 自动重启静默化**:重启替换进程由 `detached: false` 改为 `detached: true` + `windowsHide: true`(CREATE_NO_WINDOW)——不再弹出可见控制台窗口,服务以无窗口、独立进程组方式静默运行;关闭任何窗口都不影响服务(此前关掉外显的 bat/cmd 窗口会连服务一起退出)
- 保留 PowerShell 包装层,使服务后续 spawn 的 git/pnpm 继承隐藏控制台而不各自弹窗

## v1.5.1

本次更新:

- **修复深色主题下按钮白底白字看不见**:「回退到此版本」等主按钮的文字色硬编码为纯白 `#fff`,而深色主题下 DSH 的品牌色 `--dsw-alias-brand-primary` 本身解析为近白色(`rgb(249,250,251)`)——白底 + 白字导致文字完全不可见,需要选中才能看清
  - 「回退到此版本」按钮改为**透明背景 + 琥珀色描边/文字**(与「版本回退」警告面板同色系),深色主题下清晰可读
  - 「开始更新」「自动暂存并继续更新/回退」「重启DSH/立即重启」等同款按钮的文字色改用平台对比令牌 `var(--dsw-alias-label-primary-foreground, #fff)`:深色下自动变深色文字、浅色主题外观不变,与 DSH 自身主按钮行为一致

## v1.5.0

本次更新:

- **版本回退**:更新后悔了?在「已是最新」结果视图新增「版本回退」面板——下拉列出**所有历史版本**(本地已有的 `dsh-v*` tag,按版本号从新到旧,默认选中最新历史版),点「回退到此版本」即执行回退:重新 fetch 确认 → `git rev-parse --verify` 核验目标 tag 存在 → checkout → install → clean → build,流程与更新完全一致、进度同样实时流式显示;成功后自动重启 dsh(约 2 秒后,与更新相同;系统不允许重启时按原逻辑不自动重启)。回退期间若本地有未提交改动会走与更新相同的冲突处理(自动暂存后继续)
- 状态接口 `/api/dsh-update/status` 新增 `tags` 字段(本地历史版本列表,新→旧),供回退面板使用
- 回退复用更新同一执行管线(`runUpdateStreaming` + `options.targetTag`),无重复代码,安全边界(loopback-only / 并发保护 / 自动重启 latch)与更新完全一致

## v1.4.1

本次更新:

- **更新完成自动重启 dsh**:更新成功且系统允许重启时(受 supervisor 托管 / `allowRestart: false` 约束),服务端在 `done` 后约 **2 秒**自动触发重启——即使页面已经变空白/断线也会发生,无需手动点按钮。完成卡片显示品牌色「更新完成,即将自动重启 dsh(N 秒后)…」**真实倒计时**(每秒递减),页面短暂变空白后刷新一次即可恢复。自动重启有一次性 latch 保护:与手动重启共用,绝不会双开 helper 抢占端口;`done` 事件新增 `autoRestart` / `restartInMs` 字段
- **更新前提醒(确认无进行中工作)**:检测到新版本时,警示框改为「⚠ 更新完成后会自动重启 dsh,请确认没有进行中的工作或对话」——明示更新成功会自动重启、会中断进行中的下载/对话/任务,不着急可关闭面板稍后再更;`allowRestart: false` 或系统托管时按旧文案提示「本次更新不会自动重启」,不会误导
- **更新进度自动滚动**:更新中的日志区不再停留在最顶部,随输出实时自动滚到底部(你向上滚动阅读时会暂停跟随,滚回底部后恢复)
- 状态接口 `/api/dsh-update/status` 新增 `autoRestart` 字段,供界面决定是否展示自动重启提醒

## v1.4.0

本次更新:

- **一键重启 dsh(借鉴 dsh-market)**:更新完成卡片新增「重启DSH」按钮——服务端用 detached helper 按**原始启动命令**(node + 入口 + 参数 + 工作目录)重新拉起 dsh:helper 脱离当前进程存活、等待 3080 端口真正释放后再启动新进程,并在 tmpdir 记录输出日志、20 秒内检测新进程是否接管端口,失败会留诊断。当前进程应答后 500ms 退出。安全边界沿用 dsh-market:仅接受**直连环回 + Origin 匹配**的请求(拒绝代理转发),supervisor(systemd)托管或 `config.allowRestart: false` 时禁用
- **更新内容按界面语言显示(借鉴 source-code-mgmt)**:接管 DSH 的语言设置(`ctx.locale` LocaleRuntime,实时订阅切换;未捕获时回退浏览器语言)。Release 说明中英文段(`---` 分隔)按当前语言显示:中文界面显示中文段,英文界面显示英文段,切换语言即时更新
- 新增路由 `POST /api/dsh-update/restart`(loopback-only,严格校验)

## v1.3.5

本次更新:

- **显示本次更新内容**:检测到新版本时,面板展示该版本(remoteTag)的 GitHub Releases 更新说明(新增功能 / 体验优化 / 问题修复等分类)。内容走 GitHub Releases API(直连优先、镜像回退、缓存 1 小时),拉取失败时降级为「查看 GitHub Releases →」链接;语言版本只显示中文段(英文段在 `---` 之后,自动截断)
- 新增路由 `GET /api/dsh-update/release-notes?tag=…`(loopback-only)

## v1.3.4

本次更新:

- **修复更新进度不显示**:DSH web 默认对响应启用 gzip(`compression: gzip`),`compression` 中间件会把流式的小段 JSON 行**攒在 zlib 缓冲区里直到流结束**才发出——整个更新过程面板看不到任何进度。现在更新流的响应改用 `text/event-stream`(DSH webserver 明确豁免压缩的类型)+ `cache-control: no-cache, no-transform`,并立即 `flushHeaders`,每步输出实时到达
- **打开即有反馈**:点击「开始更新」后立即显示「正在检查版本并准备更新…」,不再有空白等待(版本检查可能因网络耗时数秒)
- **日志不丢失**:完成 / 冲突 / 失败卡片上都带「查看本次更新日志」折叠区,即使输出一次性到达也能回看完整过程

## v1.3.3

本次更新:

- **GitHub 镜像自动切换**:所有访问 GitHub 的操作(版本对比 `ls-remote`、更新时的 `git fetch`)**先直连**,直连超时/失败且 origin 是 github.com 时,自动改用 `gh-proxy.com` 镜像重试——直连 8 秒内无响应即切换(ls-remote),fetch 直连 90 秒超时后切换;镜像地址只用于当次命令,**不改动仓库的 remote 配置**。镜像请求成功时,面板远程版本旁会标注「(经镜像 gh-proxy.com)」
- **镜像可配置**:`config.gitProxy`(profile 的 cordis.patch.yml)或环境变量 `DSH_UPDATE_GIT_PROXY` 可换镜像前缀,设为空字符串可关闭镜像回退

## v1.3.2

本次更新:

- **并发保护**:同一时间只允许一个更新任务执行。重复点击 / 多标签页同时触发时,后到的请求返回 409,面板提示「已有更新正在执行中」,避免两个 checkout+build 并发互相踩踏
- **构建后核验**:build 成功后服务端重新读取 git 状态,`done` 事件携带 `verifiedTag` / `verifiedCommit`,完成面板显示「✓ 已确认当前版本为 X,与本次更新目标一致」——不会再有「显示更新完成却仍以为有更新」的困惑
- **远程检查缓存**:`git ls-remote` 结果缓存 60 秒(失败不缓存),GitHub 慢的时候反复打开面板不再每次都阻塞 30 秒;面板显示的是打开/点「重新检查」那一刻的实时状态,旧面板(含多标签页)不会自动刷新,请以「重新检查」为准

## v1.3.1

本次更新:

- **仓库目录自动定位**:修复「检查异常:not a git checkout」——`dsh web` 可能从子目录(如 `apps/cli/src`)启动,而旧逻辑把 `process.cwd()` 直接当仓库根。现在默认从 cwd 向上逐级查找含 `.git` 的目录;`config.repoDir` / `DSH_UPDATE_REPO_DIR` 仍可覆盖

## v1.3.0

本次更新:

- **构建前自动执行 `pnpm run clean`**:修复「更新后 build 报 MISSING_EXPORT / 重启打不开」——版本切换后旧版本的 `lib/` 构建产物(git 忽略、checkout 不清除)可能引用新源码中已移除/改名的导出,残留的包目录(如被上游删除的包)会被 tsdown 当作 workspace 包继续打包而失败。现在 `pnpm install` 之后、`pnpm run build` 之前自动 clean(幂等),clean 失败仅警告、仍以 build 结果为准
- **流式输出 UTF-8 安全**:git/pnpm 输出改用流式 TextDecoder 按行切分,跨 chunk 的多字节字符(如中文)不再乱码
- **git 命令超时**:单条 git 命令 5 分钟超时(防止 fetch 挂死),pnpm 仍为 20 分钟

## v1.2.0

本次更新:

- **改为 Profile Bundle 分发,安装即激活**:`package.json` 的 `dsh.bundle` 从裸字符串改为对象形态 `{ "patch": "./cordis.patch.yml" }`,并新增 `cordis.patch.yml`(insert `dsh-update` 行)。现在 `dsh plugin --profile web add dsh-update` 一步装完即被自动加入 `dsh.profile.bundles` 并注册进 Cordis loader 树,**不再需要手动编辑 `cordis.patch.yml` 激活**;README 中「安装 ≠ 激活」说明与激活配置章节已删除。功能行为零变化

## v1.1.0(历史)

本次更新:

- **更新前先确认**:检测到新版本时不再自动执行更新,改为展示本地/远程版本 + 页面变空白提示 +「开始更新」按钮,点击后才执行;不需要更新可直接关闭面板
- **页面变空白提前提示**:更新开始与构建阶段都会明确提示「整个页面可能突然变成空白,属正常现象——页面变空白基本意味着更新已完成,只差重启生效;请按 F5 刷新页面,并建议手动重启 dsh 服务」
- **移除完成后的重启指引**:完成面板不再显示重启引导 /「复制重启命令」按钮,由用户自行重启 dsh web;`DSH_UPDATE_RESTART_SCRIPT` 环境变量不再被 UI 使用(host 端 status 仍透传该值,保留仅为兼容)

## v1.0.0(历史)

首发版本:版本对比 + 一键更新 + 流式进度 + 完成重启引导。