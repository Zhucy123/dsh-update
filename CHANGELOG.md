# Changelog

本插件遵循 [semver](https://semver.org/lang/zh-CN/) 与 DSH 的 `dsh-v*` 版本节奏无关——插件的功能/修复版本独立递增。

> **npm 包名**:`@zhucy123/dsh-update`(2026-09-02 发布时,裸名 `dsh-update` 已被第三方注册为 1.3KB 占位空壳包,故采用 scoped 名;插件 ID 与 `/api/dsh-update/*` 路由前缀仍为 `dsh-update`,下方 v1.2.0 条目中的历史命令仅作说明)。

## v2.0.0(当前)

> **为什么从 1.9.0 抬到 2.0.0**:这一轮的改动不再是「加个功能」而是把插件的外壳重做了一遍——侧栏按钮从图标到布局全部重画、浮层从遮罩改成贴按钮的 Portal 小窗、界面语言从「中英双语硬编码」改成 187 条字典驱动的中英日三语、host 端把 699 行的更新状态机拆成三块并把所有版本检查改成异步、新增 `sanitizeGitEnv()` 隔离子进程环境。按键位、面板行为、语言支持、运行时行为都变了，按 semver 该走主版本。**1.9.0 从未发布**,所以 2.0.0 直接取代它。

### 文案与报错

- 面板原本直接抛 `not a git checkout: <dir>` 这种英文原文。现在两处展示（结果页与回退浮层）都换成一句中文说明「这个目录不是 git 仓库，无法检查更新」，并把目录附在末尾；三语字典同步补了对应文案

### 按钮宽度与进度条底槽

- **按钮不再撑满整行**：独占一行时按钮原本是 `flex: 1 1 auto`，会被拉伸到整行宽度——鼠标悬停的底色和进度条底槽因此变成一条通栏色带，跟旁边按内容收缩的 Remote 按钮不一致。「独占一行」应该是行的属性（`row` 的 `0 0 100%`），不是按钮的；按钮统一改成 `flex: 0 1 auto`，宽度只跟文案走（实测 264px → 98px，与 Remote 的 93px 相当）
- **执行态的按钮补了一层轨道底色**：此前只有填充块本身有颜色，未填充的那 48% 完全透明，标着「52%」看起来却像一条占满的短药丸，视觉上等于 100%。现在按钮在 `running` 态有一层 `color-mix(品牌色 12%)` 的底槽，填充与未填充能看出比例
- **顺带修掉一个 hover 副作用**：`mkBtn` 的 `onMouseLeave` 原本硬写 `background: transparent`，鼠标划过按钮后轨道底色会被抹掉，又变回短药丸。现在改为恢复该状态自身的背景色（`baseBg`）

### 行尾策略与提交卫生

- **新增 `.gitattributes`**:`* text=auto eol=crlf` + 二进制类型显式声明。仓库内一律以 LF 存储、工作树检出 CRLF,优先级高于系统级 `core.autocrlf=true`,从此 `git add` 不再打印 `LF will be replaced by CRLF` 警告
- **修掉一个被误判成二进制的测试文件**:`test/update-safety.test.mjs` 里混入了 4 个游离的裸 CR 字节(第 279-282 行残留的 `\r\r\n`),git 的二进制探测因此把整个文件判为 binary(`i/-text`),`.gitattributes` 的 eol 规则对它完全失效——只加属性文件治不好,必须先清掉这些脏字节。清理后文件内容逐字节等价(仅少 4 个 CR),`node --check` 与全部测试通过
- **整树重新检出**:11 个跟踪文件逐字节验证为纯 CRLF,0 裸 LF、0 裸 CR

### 本轮之前已合入、首次随 2.0.0 发布的内容

本次更新(**侧栏底部改为独占一行的「检查更新」**):

- **判定再补 3 类残留形状**（复审第五轮指出，均一行改动）:① `GIT_CONFIG_KEY_n` 不含点（`foo`）或纯空白——git 报 `key does not contain a section`,合法 git key 必须是 `section.name`,已加校验;② Windows 环境变量名不区分大小写,小写 `git_config_count` 写法 git 也照吃,正则加 `/i` 且取值改为大小写不敏感查找;③ 测试里 `assert.throws` 的 git stderr 噪声已静音
### 第四轮核验修复：环境注入的完整闭环

发现一类能让整个更新流程瘫痪、但报错完全看不出根因的环境问题：父进程残留一组**不完整**的 `GIT_CONFIG_COUNT/KEY/VALUE` 注入（某些 CLI 会设置却不留 KEY），git 遇到这种组合会对**任何**命令报 `error: missing config key GIT_CONFIG_KEY_0` 并拒绝执行。

- **`sanitizeGitEnv()` 下沉到 `lib/safety.js`**:此前只挂在 `lib/index.js` 的 `GIT_ENV` 上,而 `safety.js` 有自第二份未清理的 `GIT_ENV`(`revisionHasPath` / `listPackageDirs` 用)。后果实测:健康 tag 被误判成「缺少必需路径」→ 报「此版本会损坏 Web UI」→ 更新在闸门处中止,失败点只是往后挪了一步。现在两份 `GIT_ENV` 共用同一判据
- **判定从严**:原来只挡「COUNT>0 但 KEY 缺失」。实测补全另外 5 类同样让 git 全挂的形状:COUNT 非数字 / 带尾随字符 / 负数 / 前后空格、KEY 在但 VALUE 缺、KEY 为空;以及 `GIT_CONFIG_PARAMETERS` 畸形、有 KEY/VALUE 却无 COUNT。任一不自洽即整组剥离,完整合法的注入原样保留
- **超大 COUNT 不再卡死 host**:原来按 `count` 循环清理,`GIT_CONFIG_COUNT=1e9` 会在模块加载时同步冻结进程(实测 3e6 已 264ms)。改为按实际存在的键删、并把 count 上限设为 256;`parseInt` 换成严格 `/^\d+$/`
- **helper 进程不再继承污染环境**:三处 `spawn(helper, { env: process.env })` 改为 `sanitizeGitEnv(process.env)`。这条最关键——helper 内部的 `gitEnv = {...process.env}` 与 `runPnpm` 都继承它,污染时启动不健康的 `rollback()`(status/stash/checkout)全失败,「失败不自伤」的自动回滚随之失效
- **`createProcessRunners.runCommand` 补 `env`**:它此前没有 env 字段、默认继承 host 的污染环境
- **`pendingBootCheck` 只给 build 路径**:detached 也置位会让客户端显示「正在检查启动是否健康」而不是「已转入更新后台执行」(客户端该分支排在 detached 之前)
- **测试**:`sanitizeGitEnv` 从「只验返回对象形状」升级为 10 类畸形形状的表格断言,并新增 `a git call survives a poisoned GIT_CONFIG_* environment`——先断言污染环境下 git 确实失败(否则测试证明不了什么),再断言清理后真能跑通

### 复杂度与测试收尾（第三轮 🟡）
- **`performRollback` 的越界引用修复**:抽取时把 `orphanLibRoots` 加进了 ctx 解构,却漏改体内那处 `options.orphanLibRoots`——`options` 在模块级作用域不存在,一回滚就 `ReferenceError`。已改为用 ctx 传入值,并新增行为测试 `performRollback reports failure instead of throwing when it cannot restore`(在真实 git 仓库上跑一次注定失败的回滚,断言不抛异常且如实报告)

- **`runUpdateStreaming` 拆分**:699 行 → 518 行。抽出三个模块级单元,每个都是「与主状态机无关的独立关注点」:
  - `createProcessRunners()` — 107 行 git/pnpm 子进程管线(spawn、按行切分、超时兜底、错误归一),纯管道无状态判断
  - `performRollback()` — 94 行失败回滚(checkout → 清理 lib/ → install/clean/build → stash 复原),「失败怎么收场」与「正常怎么更新」分离
  - `buildDoneEvent()` — 成功 done 的唯一生成点,收拢客户端依赖的隐式字段契约
  目的不是数字好看,而是让「状态机在哪」看得见——此前三个阶段(正常流程 / 回滚 / 事件契约)混在一个函数里,detached 分支把 `autoRestart` 写死就是这种混编的产物
- **新增 3 条运行时测试**(此前全是源码正则 + 纯函数):
  - `runUpdateStreaming resolves and closes the stream on a non-git directory` — stub 一个 `res` 真跑,断言一定写 done 且 `end()`
  - `buildDoneEvent keeps autoRestart honest for both modes` — 直接验证构造器在 build/detached/关闭三种模式下的字段
  - `createProcessRunners streams a real git command and reports its exit code` — 在真实临时 git 仓库里跑一条命令穿过抽取后的管线
- **测试断言升级**:删掉三条「全文找字符串」的弱断言(done 字面量 ×2、restart window ×1),换成「成功 done 只能由 `buildDoneEvent` 产生」的结构性护栏 + 上面的运行时测试

### 第三轮终审修复

- **🔴 helper 回滚会静默移走「仅未跟踪 / 仅已暂存」的本地改动**:判定改 `git diff --quiet` 时,它只看「已跟踪且未暂存」——只有未跟踪文件、或只有 staged 改动时都返回 exit 0,而 `git stash push -u` 照样会把它们收进 stash。后果是 push 了却不置 `reStashed`,回滚后永不 apply,用户的文件静默从工作树消失(数据仍在 stash 但无任何提示)。实测两个场景均复现。现在 helper 的 `run()` 也收集 stdout,判定统一改用 `git status --porcelain`(与 host 的 `rollbackRebuild` 同一口径)
- **🟡 `armRestartWatch` 的基准判定修正**:`before === undefined`(初始 /ping 失败)时原来把首次见到的 boot 直接当基准——若重启已开始,那可能已是新进程,之后永不变化导致**永不刷新**。改为「连续两次看到同一 boot」才算稳定基准
- **🟡 `rbBlocked` 清空路径补全**:`changeNet`(换源)与 `closeRollback`(关窗)此前未清,会残留上一次的拦截说明
- **🟡 清理死变量**:bootVerify helper 里的 `stashRestored` 初始化后从未被读取(R3 真正生效的是 `rollback()` 的无条件 stash),连同其 `stashApplied` 传参一并移除
- **测试修正**:删掉一条与 309 行同名但更弱的 `windowsHide` 测试;`a restarting done also carries a restart window` 从「全文找字符串」升级为「检查 detached 分支块内四个字段齐全 + 客户端两处调用都传 `evt.restartWindowMs`」;新增 `helper rollback decides stashing by status --porcelain, not diff --quiet` 把本轮 🔴 钉死

### 剩余 🟡 收尾

- **回退被阻止时显示具体原因（C2）**:`conflict`/`tag-health`/`peers` 三种「必须人工介入」的拦截原来是退回浮层 + 一句「打开检查更新面板查看详情」——但那边同样处理不了回退冲突，用户无路可走。现在 `describeRollbackBlocked()` 把冲突文件清单 / 不兼容的插件条目 / 版本健康问题**直接摊开在回退浮层里**,并给出该做什么(commit/stash、换版本、先升级插件)
- **回滚链中途失败的提示补全（B1）**:`reStashed` 的判定改为先用 `git status --porcelain` 看有没有东西可暂存——`git stash push` 在干净树也返回 exit 0,而它的 "No local changes to save" 走 stderr(host 的 `gitSync` 只收 stdout),靠输出文本判定会误判成「暂存成功」,结尾就会 apply 一条不相干的旧 stash。helper 侧 `run()` 丢弃 stdout,改用 `git diff --quiet` 的退出码判断
- **修掉自己引入的 `en` 未定义引用**:`describeRollbackBlocked(evt, en)` 里的 `en` 在 `UpdateTrigger` 作用域已不存在(早前删掉了),会抛 ReferenceError 让整个插件从侧栏消失。改为 `lang() === "en"`,并全文件扫描确认无其它游离 `en` 引用

### 复审修复（Hy4 第二轮）

- **R1 (🔴) async 化的 Promise 不再游离**:`runUpdateStreaming` 是 async 但调用点用 `void`，内部抛错会变成 unhandled rejection 并让 `activeRun` 永久 true(之后所有 `/run`、`/restart` 永远 409)。现在路由层 `.catch` 兜底写 `done ok:false` 并 `releaseRunLatch()`;`afterFetch` 被 `runGit` 回调丢弃 Promise 的问题同批修掉(`runAfterFetch`),并在每个 `await` 之后复查 `settled`
- **R2 (🔴) detached done 不再写死 `autoRestart: true`**:helper 在 `autoRestart:false` 时根本不拉起新进程,写死会让客户端白等 90 秒且看不到错误。现在跟随真实配置,true 时补 `restartInMs`/`pendingBootCheck`/`restartWindowMs`(45 分钟,覆盖 detached 的 install+build),`armRestartWatch` 支持自定义窗口
- **R3 (🔴) bootVerify 的 rollback 接上了「本地改动已 apply」**:`stashApplied` 经 `scheduleBootVerify` 传进 helper 初始化 `stashRestored`;`rollback()` 改为**无条件**尝试 `stash push -u`(干净树 no-op 且因 `No local changes` 不计入 reStashed);所有早退路径补 `bailOut()` 兜底拉起进程,避免 rollback 杀掉替换进程后留下「没有服务」的死状态
- **R4 (🔴) `done` 态可从按钮复位**:`closePanel`/`recheck` 只在面板内,而 `trackUpdate` 路径会先 `setOpen(false)`,导致关闭自动重启的用户永久卡在禁用的绿勾上。现在按钮在 `done`/`error` 时点击即回 `idle` 并重查,且 `done` 不再 disable
- **R5 (🔴) `rollbackProgressOf` 补上取最大 pct**:上一轮只改了 `updateProgressOf`,`Restoring your local changes` 仍会停在 stash 的 28% 而非 restore 的 92%
- **R6 (🔴) 异步超时的中文映射恢复**:`execFile` 异步超时的 error 是 `code:null + killed:true + signal:SIGTERM`,message 里没有超时字样,原来只匹配 message 的 `/ETIMEDOUT/` 永远不命中。现在 `execFileAsync` 带出 `code/killed/signal`,`lsRemoteTags` 据此判超时
- **🟡 skipped 不再显示成「更新完成」**:`done.skipped` 走 result 视图显示「已是最新」,不再让按钮变成「完成,请手动重启」
- **🟡 `handleStatus` 防挂起**:`await checkStatus` 补 try/catch,异常时回明确的 JSON 而不是让请求挂住
- **🟡 回环判定放开 127/8**:从只认 `127.0.0.1` 放宽到整段 `127.x`,IPv6 侧含 `::ffff:127.x`
- **测试护栏升级**:新增 `detached done never hardcodes autoRestart`、`a restarting done also carries a restart window`;`windowsHide` 断言从「子串存在」改为「必须 `windowsHide: true`」(显式 false 视为漏设);symlink 用例改为能力探测后 `skip`,Windows 无开发者模式时不再永远红

### 代码审查修复（Hy4 全面 review 后）

- **🔴 `done` 事件补上 `autoRestart`**:服务端从未写过这个字段，客户端 7 处依赖它判断「会不会自动重启」——导致轮询 `/ping`、真实倒计时、重启失败兜底整条防白屏链路都是死代码,成功卡片反而显示「点击重启DSH立即生效」。现在 `build()` 自动重启分支写 `true`、不重启分支写 `false`、后台分离分支写 `true`
- **🔴 回滚前重新暂存本地改动**:`stash apply` + `drop` 之后用户改动只在工作树,裸 `git checkout <原版本>` 会被 git 拒绝 → 回滚失败、树停在半更新状态,而且提示的手工命令同样失败。现在回滚前 `stash push -u`、回滚后 `apply` 回来(helper 内同样处理)
- **🔴 `checkStatus` 异步化**:原来是同步 `execFileSync`,直连 8s + 镜像 30s 超时会把整个 host 事件循环堵死约 38 秒——期间所有 agent 轮次、WebSocket 心跳、`/ping` 全停。改为 `execFile` + Promise,`lsRemoteTags` / `remoteLatestTag` / `checkStatus` / `recomputeTarget` 逐层 async
- **🔴 端口等不到时先回滚**:后台 helper 超时曾直接 `process.exit(1)`,把树留在「已 checkout 新 tag、install/build 一步没跑」的半更新状态。现在先走完整回滚链再退出
- **🟡 网络来源对 `/run` 生效**:`run` 的 `useCallback` 依赖数组补 `net`,host 端 `checkStatus` 也接收 `options.network`。之前选镜像/代理只对 `/status` 生效,点「开始更新」仍走默认链路
- **🟡 状态机不再死锁**:`upPhase === "done"` 曾是无法回退的终态且按钮 disabled(非自动重启场景永久卡成禁用绿勾);现在 `closePanel` / `recheck` 会把它收回 `idle`。同时给更新流与回退流加终态标记,服务端中途崩溃导致流「正常结束」时客户端自己收尾报错,不再永远停在进度条
- **🟡 `safety.js` 补 `windowsHide`**:该文件 `execFileSync` 有 2 处、`windowsHide` 出现 0 次,而它们在默认更新路径上被调用(`revisionHasPath` / `listPackageDirs`)——Windows 上仍会闪 cmd 窗口
- **🟡 5 处硬编码中文改走 `tr()`**:冲突视图「重新检查」、`aria-label`「关闭」、侧栏「回退版本」、收起态「完成」「重试」在日/英界面下曾是中文
- **🟡 回滚目标改用原始 commit**:`git describe --abbrev=0` 返回最近的祖先 tag,HEAD 之后若有本地提交,回滚会丢掉它们。现在 `status.localCommit` 优先
- **🟡 进度推断修正**:只对 `step`/`notice` 事件推进度(原始 pnpm 输出里 `clean-css` 之类包名会命中 `/clean/` 让 install 跳到 64%),且取命中项里 pct 最大者(`Restoring your local changes` 曾永远停在 stash 的 26%)
- **🟡 latch 与 helper 兜底**:`endRun` 在交接后挂 90 秒兜底 timer 复位 `handingOff`/`restartScheduled`(宿主若拦了 SIGTERM 不退出,latch 会永久卡死);三个 helper 的 `spawn` 补 `.on('error')`;`restartHelperSource` 的 `main()` 补 `.catch`(原来异常连日志都没有)
- **🟡 安全强度对齐**:`isLoopbackRequest` 补 `socket.remoteAddress` 与代理头判定(原来只查客户端可伪造的 Host 头),`/ping` 补 loopback 校验(它会回带 pid/boot)
- **测试护栏**:新增两条源码级不变量测试——每个成功 `done` 必须带 `autoRestart`、`lib/**/*.js` 里每个 `spawn`/`execFile` 必须带 `windowsHide`,把这两类「修了但没生效」钉死

- **语言切换真正实时生效**:原来只认 `ctx.locale` 一条路，抓不到就永久停在浏览器语言（用户改设置毫无反应）。现在三级取源（`ctx.locale` → `<html lang>` → 浏览器语言）、`locale` 捕获改为递增间隔重试 12 次、`useLocale()` 额外用 `MutationObserver` 盯 `<html lang>`；同时给 `UpdatePanel` / `BusyDialog` / `AutoCheckRow` / `SourcePicker` 都补上 `useLocale()` 订阅（之前只有外层按钮会重渲染，面板内部停在旧语言）
- **点击外部自动收起浮层**:新增 `pointerdown` 捕获监听（用 pointerdown 而非 click，DSH 模态会吞掉 click），浮层根元素带 `data-dsh-update-pop` 标记用于判定内外。打开设置/插件面板时小窗不会再赖在屏幕上
- **兄弟按钮高度不一致时独占一行**:`UpdateTrigger` 用 `ResizeObserver`（parent + 每个兄弟按钮）加 `MutationObserver`（插槽增删）实时测量，兄弟按钮与自己高度差 >4px 时切到 `flex: 0 0 100%` 独占一行，等高时回到 `0 1 auto` 并排。实测 Remote 42px / 我 32px → 各自一行；把 Remote 改 32px → 并排；改回 → 又独占
- **界面语言改为跟随 DSH 设置,支持中文 / English / 日本語**:新增 185 条三语文案字典与 `tr()` 取词函数,取代原来的 `en ? ... : ...` 硬编码;DSH 语言设为**其它任何语言**(韩法德俄西葡等)时统一回落**英文**,不留中文硬编码给非中文用户
- **进度步骤表改为按需生成**:原先把 `tr()` 写进模块级常量,会在加载时求值一次,切换语言后进度文案不更新;改为 `updateSteps()` / `rollbackSteps()` 函数,每次推断时按当前语言生成
- **浮层改用 portal + `position: fixed`**:挂到 `document.body`、坐标由按钮矩形算出,因此不再被侧栏容器的 `overflow` 裁剪——侧栏折叠或只有 ~98px 宽时,浮层仍然是完整可读的 340px,并允许越过侧栏边界(页面滚动/缩放时重新测量以贴住按钮)
- **按钮宽度改回跟随文案**(98px 左右),与 DS Bot / remote 并排;空间不够时优先压缩自己(`flex: 0 1 auto` + `minWidth: 0` + 文字省略号),再由父级 `flex-wrap` 换行,不会把任何一个按钮挤出可视区(实测 264/200/160/120/96px 五档均无溢出)
- **按钮不再独占整行**:改回按内容宽度(`flex: 0 1 auto`),侧栏宽时与 DS Bot / remote 并排;空间不够时先压缩自己(`minWidth: 0` + 文字省略号),再由父级 `flex-wrap` 整体换行——不会把自己的按钮或别人的按钮挤出可视区(实测 264/200/160/120/96px 五档均无溢出)
- **Windows 不再弹控制台窗口**:更新过程中的每条 `git` / `pnpm` 子进程、以及重启与后台更新 helper 现在都带 `windowsHide`,不再为每条命令弹出一个 cmd 窗口(此前标题显示成 `C:\Program Files\Git\cmd\git` 的那些)
- **自动检查更新**:面板内新增开关 + 间隔(1/6/12/24 小时,默认开启、每 6 小时),偏好存 `localStorage`(每浏览器独立,改设置不需要重启 host 也不会改 profile 配置);**dsh 每次启动都查一次**,之后按间隔轮询(页面被节流时按「距上次是否到期」补查)
- **静默检查与自动换源**:后台检查按当前网络来源发起,失败后依次尝试所有镜像;全部失败就静默放弃、不打扰用户。只在「拿到 ok 且确实有新版」时留下标记
- **发现新版的红点提示**:侧栏按钮右上角显示红点,文字从「检查更新」变为「有新版本」,tooltip 给出具体 tag;手动检查或更新成功后自动清除
- **有更新界面重做**:移除常驻橙色警示区;新增「查看日志 ↗」直开 GitHub Releases 页面(`/releases/tag/<tag>`);「或切换到指定版本」按语义自动换文案——高于当前版本显示「更新到此版本」,低于显示「回退到此版本」(本地做 semver 比较,不额外请求)
- **回退入口合并**:侧栏独立的「回退版本」按钮移除,回退统一走「或切换到指定版本」;「已是最新」视图同样提供该区块,随时可回退
- **更新前检测进行中的对话**:`/status` 新增 `busySessions`(统计 `agent.status === 'running'`)。有对话在跑时点更新会先弹提示再确认强制更新——两步都写明「已生成片段会留在会话记录,但未完成的推理与等待结果的工具调用会丢失」;选择强制后 `/run` 带 `force` 并在日志里标注
- **重启不再白屏**:新增轻量 `/ping` 路由回带 `boot` id(不读 git、不扫 profile)。更新/回退完成且自动重启时,客户端轮询 `/ping`,**等 boot id 变化后再 `location.reload()`**,避免撞上旧进程已退出、新端口未绑定的空窗期(dsh-market 同思路)
- 修复:完成态绿色被 `onMouseLeave` 覆盖成灰色;「开始更新」按钮把 React 事件误当 status 传入导致直接判失败
- **网络来源选择器**:浮层顶部常驻「来源」下拉——自动(直连→镜像)/ GitHub 官方(可填本地代理端口,默认 7890)/ 国内镜像(gh-proxy.com、ghproxy.net、ghfast.top,均已实测可达)。检查进行中也能切换,切换后立即按新来源重查;`/status` 与 `/run` 都接受 `source`/`mirror`/`proxyPort`,镜像模式不再先浪费一次直连超时,官方模式不会偷偷回退镜像。代理端口默认**留空=直连**，输入框内不再显示 7890（无占位数字，避免歧义），只有提示文案「留空 = 直连，不走代理」；端口不通时服务端返回可操作提示而不是裸 git 报错。两个浮层统一为「标题 / 网络分段控件 / 分隔线 / 内容」四段式，同宽（`min(340px,100%)`）、同内边距、同圆角。**「回退版本」浮层同样带这个选择器**(读取版本列表与回退执行都走选中的来源),换来源时保留旧版本列表不闪空、换完立即按新来源重查
- **新增「回退版本」按钮**:与「检查更新」并排(宽度不够自动各占一行)。点击在按钮上方弹出小浮层选目标版本,不再使用全屏遮罩;确认后**按钮自身变成实时进度条**(拉取标签 → 校验 → 暂存 → 切换 → 安装 → 清理 → 构建 → 恢复改动),完成后按服务端 `autoRestart` 自动重启。主面板里的「版本回退」区块已移除
- **两个浮层互斥**:点「回退版本」会自动收起「检查更新」浮层(并取消未完成的版本检查),反之亦然——同屏永远只有一个窗口;再点同一个按钮则收起。浮层宽度改为 `min(340px, 100%)` / `min(268px, 100%)` 跟随侧栏,窄侧栏不再被裁掉
- **「检查更新」同构改造**:面板从全屏居中弹窗改为贴在按钮上方的小浮层(宽度跟随侧栏,上限 340px);点「开始更新」后浮层收起、**按钮自身变成实时进度条**(同一套 9 段进度表),完成后绿色对勾 + 自动重启。窄浮层里版本行改为可换行布局,「经镜像 gh-proxy」降级为 title 提示;浮层标题由「更新DSH」改为「检查更新」
- **侧栏按钮独占一行**:触发按钮现在请求 `flex-basis: 100%`,并在挂载时给真正的 flex 行(`.footerActions`,跳过插槽列表那层 `display: contents` 包装)加 `flex-wrap: wrap`,卸载时还原。这样无论同位置有没有 DS Bot「返回 DS Bot」或 remote 的按钮,它都单独占一行;同位置没有其他插件时这一行就只有它自己
- **排序改到末尾**:注册 `order` 从 `-100` 改为 `1000`,于是其他插件按钮留在上面一行、本插件排在它们下面一行(而不是插在它们中间)。collapsed 轨态仍是 36px 圆形图标
- **图标换成实心「下载托盘 + 箭头」**:18 栅格原生绘制、纯填充无描边,18/20px 下在任何 DPR 都不会发糊(旧版 24 栅格缩放到 16px 再叠加 1.5 描边,边缘会糊成灰边)。宽态为「图标 + 文字」的整行按钮(32px 高,hover 高亮整行)
- **文案**:按钮文字、`title`、`aria-label` 由「更新DSH」改为「检查更新」(面板标题与更新流程不变)

## v1.8.0

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