# Changelog

<p align="right"><b>简体中文</b> · <a href="CHANGELOG.en.md">English</a> · <a href="CHANGELOG.ja.md">日本語</a></p>

本插件遵循 [semver](https://semver.org/lang/zh-CN/) 与 DSH 的 `dsh-v*` 版本节奏无关——插件的功能/修复版本独立递增。

> **npm 包名**:`@zhucy123/dsh-update`(2026-09-02 发布时,裸名 `dsh-update` 已被第三方注册为 1.3KB 占位空壳包,故采用 scoped 名;插件 ID 与 `/api/dsh-update/*` 路由前缀仍为 `dsh-update`,下方 v1.2.0 条目中的历史命令仅作说明)。

## v2.0.2(当前)

围绕代码审查发现的问题完成一轮集中安全边界与进程生命周期加固，补齐仓库身份识别、镜像 SHA 校验、Helper 临时脚本与异步失败保护、全面监督进程识别以及 16 项真实运行时行为测试。

### 安全与仓库边界修复

- **校验更新目标仓库身份，并明确拒绝 npm 安装的 `@deepseek-ai/dsh`**(#2)：在 `lib/safety.js` 新增 `isNpmInstalledHarness` 与 `verifyHarnessRepo`，校验目标 `.git` 仓库的根 `package.json`（`@deepseek-ai/dsh-root` / `deepseek-harness`）、`apps/cli/package.json` 或 `origin` URL（`deepseek-harness`）。在 `/status`、`/run` 与 `defaultRepoDir()` 中拦截无关 git 仓库与通过 npm 安装的 CLI（可通过 `allowUnverifiedRepo: true` 跳过），并在 `lib/client.js` 与三语 README 中给出清晰的 `npm install -g @deepseek-ai/dsh@latest` 升级引导
- **第三方镜像拉取后核对 tag SHA**(#4)：新增 `verifyMirrorTagSha`，经第三方镜像（显式镜像或 `auto` 回退）fetch 后、checkout 前直接向官方 `api.github.com` 核对目标 tag 的 commit SHA。若不一致立即中止更新且不检出；官方 API 不可达时默认提示信任风险继续，可配置 `verifyMirrorSha: true` 严格中止。三语 README 同步写明镜像路径的信任边界
- **凭据脱敏与网络协议加固**(#10)：新增 `redactSecrets` 对 git/pnpm 实时输出、`lsRemoteTags`、SSE 报错及冲突详情中的 `https?://user:pass@` 凭据脱敏；直连 `fetchJson` 补齐 2MB（`MAX_FETCH_JSON_BYTES`）响应体积上限（同时校验 `Content-Length` 与流式读取字节数）；HTTP `CONNECT` 隧道的 `tls.connect` 显式配置 `ALPNProtocols: ['http/1.1']`

### 健壮性与进程生命周期修复

- **Helper 改用临时 `.cjs` 脚本并在确认 `'spawn'` 后再退出宿主**(#3 / #10)：新增 `spawnDetachedHelper`，将三个 detached helper 写入 `tmpdir()` 临时 `.cjs` 文件执行（规避 Windows `CreateProcess` 32767 字符上限，退出或失败时自删），并在 `'spawn'` 事件确认进程拉起后才安排宿主 `SIGTERM`。异步 `ENOENT` / `EMFILE` 启动失败时，`/restart` 立即复位 `restartScheduled` 并返回 HTTP `500`，`handOffToUpdate` 与 `scheduleBootVerify` 触发自动回滚并向 SSE 报错，绝不误杀宿主
- **`git describe` 限制为 `dsh-v*` 并保护未打 tag 的本地提交**(#5)：`localVersion` 改为 `git describe --tags --match 'dsh-v*' --abbrev=0`，消除仓库内其他 tag 遮蔽 `localTag` 导致的误报「可更新」；新增 `countUntaggedLocalCommits`，在 `/status` 返回 `localAheadCommits`，并在 `runUpdateStreaming` 检出前默认拒绝存在未包含在任何 `dsh-v*` tag 的本地提交，防止产生游离 HEAD（可配 `allowLocalCommits: true` 覆盖）
- **`stash: true` 后 `checkout` 失败自动还原本地改动**(#6)：在 `checkout` 失败分支（含 `conflict` 及其他失败）引入 `restorePreCheckoutStash`，若更新前成功 `stash push -u`，先尝试 `git stash apply`（成功则 `stash drop`），apply 失败则保留 stash 条目并在错误详情中提示手动执行 `git stash apply` 恢复
- **扩大监督进程识别范围**(#7)：扩展 `detectedSupervisor` 覆盖 `systemd`（system unit）、`systemd-user`（`NOTIFY_SOCKET` 或匹配 `MANAGERPID`）、`pm2`、`supervisord`、`launchd`（macOS `ppid === 1` 且非终端/SSH 继承）及 `container`（Docker / Kubernetes 容器），防止插件与托管进程双开抢占端口
- **真实监听端口解析与 `boot-verify` 端口超时对齐**(#8)：新增 `resolveListeningPort`，按 `config.port` → 宿主 `webServer`/`connection` 端口 → CLI `--port`/`-p` → 请求 `Host`/URL 优先级获取真实端口；在 `bootVerifyHelperSource` 与 `updateHelperSource` 引入 `hostPid` 与 `isPidAlive` 探测，端口 60 秒仍被占用时，若旧宿主已退出则与分离路径对齐执行回滚，若旧宿主仍存活则写明确 `aborting:` 日志后退出，避免在存活宿主脚下清理构建或双开；新增 `parseDetachedUpdateLog` 从日志提取 `aborting:` 及构建失败 `reason`
- **`/run` 非法 JSON 返回 400 与参数一致性**(#9 / #10)：`handleRun` 对读取失败、非法 JSON 或非对象 JSON（数组/基本类型）明确返回 HTTP `400`（保留空 body 与 `null` 的默认兼容且不锁 `activeRun`）；`runUpdateStreaming` 统一使用 `windowsDetachedUpdate === true` 默认关闭

### 前端、依赖与测试

- **fork 仓库发布说明链接**(#10)：`/status` 返回 `repoSlug`，`lib/client.js` 新增 `safeRepoSlug` 优先使用当前仓库的 `owner/repo` 拼接 GitHub Releases 链接
- **解除 `agents` 硬依赖**(#10)：`inject` 移除 `agents`，`countRunningAgents` 改为从 `ctx` 动态安全读取，`agents` 服务不可用时不再影响插件挂载
- **测试扩充**：单元测试由 53 条扩充至 **69 条**，新增 16 项覆盖上述安全与生命周期路径的运行时行为测试及 `node:vm` 前端组件渲染测试

## v2.0.1

这一版做两件事:**把 5 个 API 路由接进 DSH 的准入检查**(插件市场上架复核时指出的问题),以及把**更新/回退的整个过程重做**,让它在真实的回退场景里不再出岔子——白屏、刷新太慢、手动刷完它自己又刷一次,以及按钮上看不出到底在干什么。

### 安全修复

- **5 个 API 路由接入 DSH 准入检查**:从裸 `webServer.register` 迁到 `ctx.connection.fetch.register`。宿主在请求到达插件前统一做 Host/Origin 信任栅栏(防 DNS rebinding / 跨域调用)与浏览器登录态校验,浏览器里打开的任意网页**无法再调用** `/run`、`/restart` 等端点触发真正的更新。原先插件自写的 loopback/Origin fence 一并移除,鉴权收敛到宿主一处;SSE 流式响应用 `ReadableStream` 适配,进度输出与回滚逻辑不变
- **`engines.dsh` 限定 `>=0.2.3-0`**:共享 `/api` 准入模型从 0.2.3 起稳定;`-0` 后缀让 `0.2.3-alpha.*` 也满足(本机可升级到的 `0.2.3-alpha.2` 不会被判不兼容)
- `inject` 增加 `connection`;README 的「路由只接受本机请求」等旧口径同步更新

### 健壮性与数据安全修复

- **修复干净工作树开启 `stash: true` 误删历史 stash**:`git stash push -u` 在工作树无改动时会将 `No local changes to save` 输出到 stdout 而非 stderr,`beginStashOrCheckout` 曾据此误判 `stashedSomething = true`,并在更新/回退收尾时误将用户既有的 `stash@{0}` `apply` 后 `drop` 掉。现改为操作前先用 `git status --porcelain` 判空
- **修复 `stash apply` 冲突后工作树残留未合并状态**:3 处冲突清理从 `git checkout -- .` 改为 `git reset --hard HEAD`,彻底还原 unmerged index,避免冲突标记残留导致后续构建失败并触发回滚
- **修复 `/release-notes` 在「官方 + 本地代理端口」模式下未走代理**:通过 Node 内置 `node:http` 与 `node:tls` 实现零依赖 HTTP `CONNECT` 隧道及 HTTP 代理请求(支持 chunked 编码与超时/句柄清理),并将代理端口纳入缓存键,避免直连失败缓存污染带代理的查询;客户端同时将当前选中的网络来源透传给 `/release-notes`
- **修复 `servingPort` 适配 Fetch Request 与无端口抢跑**:`servingPort` 同时支持 WHATWG `Headers.get('host')` 及 `request.url` 端口回退;在 `port === null` 时将 `bootVerifyHelperSource` 与 `updateHelperSource` 的等待窗口延长至 `5000ms` / `5500ms`(大于宿主退出延迟),避免旧进程尚未退出就抢占端口或文件锁
- **端口探测与超时进程树清理加固**:三处 helper `listening()` 改为并发探测 `127.0.0.1` 与 `::1`(兼容仅监听 IPv6 的环境)并及时清理定时器;Windows 下通过 `shell: true` 启动的 `pnpm` 超时时改用 `taskkill /PID ... /T /F` 清理整个子进程树
- **完善 `runUpdateStreaming` Promise 生命周期与 `/run` 请求校验**:`runUpdateStreaming` 的 Promise 现完整覆盖全部异步回调流程直至终态收尾,确保外层异常兜底与 `activeRun` 锁释放真正生效;`handleRun` 增加 `64 KiB` 请求体上限(超限返回 `413`)并校验 JSON 解析结果为非 `null` 普通对象;`/release-notes` 改用 `parseTag` 校验 tag
- **修复非 GitHub `origin` 选镜像与 `auto` 多镜像回退**:非 GitHub 仓库在 `mirror` 模式下直接报错,不再向 git 传入 `undefined`;`auto` 模式下版本检查、更新拉取与发布说明均支持按镜像清单依次回退并记住最近可用镜像;显式网络模式不再覆写 `auto` 缓存;清理硬编码 `gh-proxy.com` 提示与未使用的 `restartScript` 字段
- **补齐 `semverSatisfies` 边界与软链接插件扫描**:`semverSatisfies` 新增支持 `^0`、`^0.0`、`~1`、`<=1.2`、`>1.2`、操作符带空格与连字符范围;`walkPluginManifests` / `readJson` 支持软链接与 Junction 插件目录并带防环保护(`removeOrphanLibsOnDisk` 仍严格不跟随符号链接)
- **修复前端状态机与交互细节**:
  - `BusyDialog`(「有对话进行中」二次确认)保留完整 `opts`,不再丢失 `stash: true`
  - `compareTagTo` 改为按 `.` 拆段的数值 semver prerelease 比较,修复 `alpha.10` 与 `alpha.2` 字典序错乱
  - `watchPendingReload` 每次轮询复查 `RELOAD_KEY` 是否已被清除(消除 409 / 失败 / 取消后长达 10 分钟的 600ms 孤儿轮询泄漏),`run()` 内 `/ping` 回调校验 token 与终态以防竞态,`armRestartWatch` 避免重复并发轮询
  - `done` / `error` 态点击侧栏按钮重查时补传 `net` 与 `measureAnchor()`
  - 移除运行中按钮 `title` tooltip 里残余的假百分比
  - `peers` 拦截卡片在日语界面回退英文 `messageEn`,不再显示中文
  - `captureLocale()` 异步捕获 `ctx.locale` 后通知 `useLocale` 重新订阅
  - 缺少 `React` 时 `apply()` 安全早退而非顶层崩溃,清理 `MESSAGES` 中 3 条未引用字典项

### 刷新与重启

- **修复手动刷新后又自动刷了一次**:用于「重启后自动刷新」的 `localStorage` 标记里记的是重启前那个进程的 boot id。用户等不及自动刷新、自己按了 F5 之后,新加载的页面第一眼看到的就是「boot 和标记里不一样」,于是判定「新进程刚接管」又 `location.reload()` 了一遍——表现就是「刷新完,过一会儿它自己又刷了」。现在不只看 boot 是否变化,还要看**新进程的启动时刻是否晚于本页面加载时刻**(boot 前半段就是服务端进程启动的 `Date.now()`,base36)。本页本来就由新进程服务时(也就是用户已经手动刷过、或上一次自动刷新已生效),只清标记、不再 reload。时间戳解析不出来时回退到「本页是否已观测过旧 boot」的判断,行为依然正确
- **自动刷新来得太慢**:两条刷新通道(等 SSE `done` 事件的 `armRestartWatch`、页面加载时的 `watchPendingReload`)原本首轮延迟 1.0–1.2 秒、间隔 1.5 秒,用户等几秒没动静就手动刷了。现在首轮 250 毫秒、间隔 600 毫秒——重启空窗期连不上不算异常,继续轮询即可,所以加密轮询没有副作用
- **修复更新/回退后页面不自动刷新**:build 阶段替换网页资源会让页面变空白、SSE 连接断开,客户端收不到带 `autoRestart` 的 done 事件,原来只靠该事件的自动刷新就不会触发(只能手动刷新,或等 DSH 原生的「服务版本变化」弹窗)。现在任务开始就把当前 boot id 写进 `localStorage`,页面(重新)加载时独立轮询 `/ping`,发现 boot 变化即自动 reload——不依赖 SSE。标记 10 分钟过期、幂等轮询,失败/拦截/跳过时清除
- **文案还在让人手动刷新**:`回退完成后请刷新网页`、`请按 F5 刷新页面` 这类提示是上一版的过渡说法。既然刷新现在已经自动化,文案改为「重启完成后会自动刷新,无需手动操作」(构建前提示、回退/更新完成提示、后台分离更新提示,中英日三语同步)

### 按钮与进度窗

- **按钮不再显示百分数**:服务端只报阶段、不报总时长,任何百分比都是猜的;猜错停在 82% 比不显示更让人以为卡死。执行中按钮改成进行时文案(安装中 / 构建中 / 清理中…),配一条从左往右匀速跑、循环往复的蓝色色带,只表达「还在动」。完成时变绿,文字直接说清结束了什么——「更新完成」或「回退完成」。色带用固定的蓝色而非主题品牌色:某些环境下 `--dsw-alias-brand-primary` 解析成近黑,色带会整块发灰
- **进度窗不再自动关闭**:点「开始更新」/「回退到此版本」后窗口就地变成进度窗,一直开着,右上角有 ✕ 可以自己关掉。关掉只隐藏窗口,任务继续跑,点侧栏按钮随时再打开(执行中打开不会重新检查版本、不会覆盖掉进度视图)
- **修掉点窗口外部会中断进度流**:原来「点击浮层以外的位置」会无条件递增 `runToken`,执行中这样做会让后续所有进度事件因 token 不符被丢弃——窗口收起来再打开就是一片空白。现在与关闭按钮同一条规则:只有非执行期才作废这一轮
- **安全闸门的确认卡片沿用现有窗口**:窗口开着时把内容换成询问卡片;用户已经关掉窗口时重新弹出,否则「仍要继续」无处可点
- **「有新版本」红点不再压字**:宽态下红点改为排在文字之后的独立块,不再绝对定位在右上角。原来 7px 的圆点放在 `right: 6` 处,而文字右边缘距按钮右缘 10px,两者**必然重叠 3px**;纵向又正好落在 13px 字号的字头上,看起来像屏幕上的一粒脏点。描边也从硬白圈换成同色淡光,深浅主题下都贴合

### 其它界面改进

- **「查看日志」改名「查看官方发布说明」**:面板里已经直接展示本次 GitHub Releases 更新内容,这个跳新标签的按钮现在明确指向官方发布页,不再和面板内实时进度日志混淆(中/英/日三语同步)
- **更新执行中可点开进度浮层**:以前按钮在更新时会禁用、面板自动收起后就没法再看实时进度;现在执行中点按钮会重新打开同一个浮层,`updating` 视图里的逐行日志照常滚动追加(自动贴底、手动上滑暂停跟随)。关掉浮层只隐藏窗口、不取消更新流,再点还能接着看
- **记住网络来源选择**:选「官方」并填入端口(如 7890),或选某个镜像后,选择会存进浏览器本地(`localStorage`),下次打开面板仍是上次的来源 / 端口 / 镜像,不用每次重选。读取时会校验端口范围与镜像 id,脏数据自动回落「自动」,不会把非法端口带给 `/run`
- **回退流程与更新流程对齐**:与更新一样,点「回退到此版本」后窗口就地切换为**精简进度窗**(只显示当前阶段 + 逐行日志,保留关闭按钮,去掉网络来源/自动检查/大段黄色提示)并使侧栏按钮进入实时进度条,不自动关闭,直到完成或手动关闭(隐藏后点侧栏按钮可随时重新打开);完成后按钮变绿色对勾,并和成功更新一样轮询 `/ping` 自动刷新页面
- **版本切换区只用于回退**:有新版时顶部已有「开始更新」,下方版本区原本还默认选中最新版并显示「更新到此版本」,与顶部重复;「已是最新」时竟然也提供「更新到此版本」,自相矛盾。现在两种状态下版本区都只列比本地旧的历史版本,标题统一为「或回退到历史版本」、按钮固定「回退到此版本」,升级与回退职责分明
- **peer 冲突提示更精准**:① prerelease 目标(如 `0.2.3-alpha.1`)按其稳定版 `0.2.3` 匹配 range,消除大量假阳性(如 `>=0.1.7-rc.1 <0.3.0-0` 本就覆盖 alpha,之前却误报);② 只扫描**已启用**的插件(`dsh.profile.bundles`),已安装但未启用的不再计入;③ 冲突详情折叠显示,不再重复两遍长清单;④ 回退拦截按钮显示「仍要继续回退」、取消后按钮恢复正常、继续时进度不重头
- **修复回退「失败 / 卡在拉取 12%」**:真正原因是回退目标与已安装插件的 peerDependency 冲突(旧 harness tag 满足不了 WorkBuddy 等插件钉的版本),服务端按设计发出 `peers` 拦截等待用户确认;但面板在执行开始就被收起,拦截卡片看不见,用户只看到按钮卡在百分比。现在三类安全闸门(peer 冲突 / 必需路径缺失 / 本地改动冲突)触发时会**自动重新打开面板**并显示「仍要继续」等确认按钮,按钮同时退出进度态并进入独立的「需要你确认」(窄态「待确认」)外观,不再误显示「更新失败,重试」。另外回退不再被 `fetch` 后的「重算最新版本 / 已是最新就跳过」覆盖目标 tag

### 重构

- 删除回退入口并入面板后遗留的死代码:独立「回退版本」按钮的整套状态机、`RollbackPopover`、`describeRollbackBlocked` 及相关字典条目,以及 host 端不再使用的 `webServer` inject 与适配器方法。功能不变,client.js 从 2405 行减到 2081 行

### 文档、测试与打包

- **打包清单与截图路径修复**:`package.json` 的 `files` 清单纳入 `screenshots.json`,并修正其中失效的 `button-progress-zh.png` 路径
- **三语配图与文档同步**:使用 `ego-browser` 重新截取全部 12 张三语配图,并同步更新三语 README 与 CHANGELOG
- **扩充单元测试**:单元测试由 35 条扩充至 53 条,新增真 git 仓库、HTTP `CONNECT` 代理隧道及 `node:vm` 客户端运行时测试

### 说明

- **构建阶段页面仍会短暂空白**:`pnpm run build` 替换网页资源时,浏览器加载不到旧 bundle,这段时间页面无法交互。实测(2 秒采样粒度)这段窗口通常只有 **2 秒左右**;真正长的是重启空窗(约 18 秒,期间进程还没绑定端口)。而宿主 tsc 编译的那几分钟里 `dist` 一直是完好的,页面可以正常使用
## v2.0.0

本次更新(**侧栏按钮重做 + 三语界面 + 网络来源可选 + 一批会出事的问题修掉**)。相比 v1.8.0:

### 新增

- **三语界面**——中文 / English / 日本語。原来只有中英硬编码,现在是一份以中文原文为 key 的字典(187 条),`tr()` 取词;DSH 语言设成其它任何语言(韩法德俄西葡等)时统一回落**英文**,不留中文硬编码给非中文用户。取源三级:`ctx.locale` → `<html lang>` → 浏览器语言,并监听 `<html lang>` 变化实时切换,不用刷新
- **网络来源选择器**——浮层顶部常驻「自动 / 官方 / 镜像」。自动:先直连 GitHub,8 秒超时后按镜像清单逐个重试,首个成功的记住;官方:只走直连,可填本地代理端口(Clash / V2Ray 的 7890 之类);镜像:指定 `gh-proxy.com` / `ghproxy.net` / `ghfast.top` 之一。选择存 `localStorage`,检查和执行更新走同一条链路
- **自动检查更新**——开关 + 间隔(1 / 6 / 12 / 24 小时,默认开启、每 6 小时),每次 `dsh web` 启动额外查一次。后台查到新版只改按钮外观(文字变「有新版本」+ 右上角红点),不弹窗、不打断你;失败静默换镜像重试
- **插件图标**——`icon.svg`,128 网格蓝色渐变圆角方块 + 托盘 + 下落箭头,30px 下清晰
- **更新前检测进行中的对话**——`/status` 新增 `busySessions`。有对话在跑时点更新会先提示再确认,写明「已生成片段会留在会话记录,但未完成的推理与等待结果的工具调用会丢失」

### 界面与交互

- **侧栏按钮重做**——图标换成 18 栅格实心「托盘 + 下落箭头」(旧版 24 栅格缩放到 16px 会糊成灰边),文案由「更新DSH」改为「检查更新」,排序改到末尾
- **按钮宽度跟着文案走**——`flex: 0 1 auto` + `minWidth: 0` + 文字省略,不再撑满整行;空间不够时优先压缩自己,不会把别人的按钮挤出可视区
- **位置自适应**——兄弟按钮高度差 >4px 就自己占一行,差不多就并排。用 `ResizeObserver`(parent + 每个兄弟按钮)加 `MutationObserver`(插槽增删)实时测量
- **浮层从全屏遮罩改成贴按钮的小窗**——portal 到 `document.body` + `position: fixed`,不再被侧栏 `overflow` 裁剪,侧栏折叠时也完整可读;点浮层外部即收起
- **执行时按钮自己变成进度条**——浮层收起,按钮填充宽度就是进度,文字显示当前阶段;未填充部分有一层浅色底槽,比例一眼可辨
- **版本回退并入检查更新面板**——单独的「回退版本」按钮移除,统一走「切换到其它版本」,按钮文字按版本高低自动变成「更新到此版本」或「回退到此版本」

### 修复

- **`done` 事件从来没带过 `autoRestart`**——客户端 7 处依赖它判断是否轮询 `/ping` 等新进程再刷新,服务端不写,整条「重启不白屏」链路是死代码,成功卡片反而显示「点击重启立即生效」。现在由 `buildDoneEvent()` 统一生成,build / detached / 关闭三种模式如实填写
- **`checkStatus` 同步阻塞 host 最长 38 秒**——原来用 `execFileSync`,直连 8s + 镜像 30s 会把整个事件循环堵死,期间所有 agent 轮次、WebSocket 心跳、`/ping` 全停。改为 `execFile` + Promise,逐层 async
- **回滚会撞上已恢复的本地改动**——`stash apply` + `drop` 后用户改动只在工作树,裸 `git checkout` 被 git 拒绝,回滚失败留半更新树。现在回滚前重新 `stash push -u`、回滚后 `apply` 回来
- **helper 回滚会静默移走「仅未跟踪 / 仅已暂存」的改动**——用 `git diff --quiet` 判定时这两类都返回 0,但 `stash push -u` 照样收走,于是不置 `reStashed`、永不 apply,文件静默从工作树消失。改用 `git status --porcelain`
- **畸形 `GIT_CONFIG_*` 环境注入会让 git 全挂**——某些 CLI 留下 `GIT_CONFIG_COUNT` 却不留 `KEY`,git 对**任何**命令报 `missing config key GIT_CONFIG_KEY_0`。新增 `sanitizeGitEnv()`,覆盖 10 类不自洽形状,host 与三个 helper 进程共用
- **进度推断虚高**——原始 pnpm 输出里 `clean-css` 会命中 `/clean/` 让 install 跳到 64%。现在只对 `step` / `notice` 推进度,且取命中项里 pct 最大者
- **`upPhase === 'done'` 是死终态**——按钮被 disable,关掉自动重启的用户永久卡在绿勾上。现在 `done` / `error` 态点击即回 `idle` 并重查
- **Windows 会闪 cmd 窗口**——每条 `git` / `pnpm` 子进程、以及重启与后台更新 helper 补上 `windowsHide`
- **5 处硬编码中文绕过 `tr()`**——日/英界面下会显示中文,已全改
- **回滚目标取的是「最近 tag」而非原始 commit**——`git describe --abbrev=0` 会丢掉 HEAD 之后的本地提交,改用 `status.localCommit`
- **`/ping` 缺 loopback 校验**——它会回带 pid / boot。同时 `isLoopbackRequest` 补 `socket.remoteAddress` 判定,并放宽 127/8 整段
- **`windowsHide` 在 `safety.js` 里漏了 2 处**——它们在默认更新路径上被调用,Windows 仍会闪窗

### 内部整理

- **`runUpdateStreaming` 699 行 → 518 行**,抽出三个模块级函数:`createProcessRunners()`(107 行,git/pnpm 子进程管线)、`performRollback()`(94 行,失败回滚全链)、`buildDoneEvent()`(成功 done 的唯一生成点)。目的不是数字好看,而是让「状态机在哪」看得见
- **测试从 11 条加到 20 条**(19 pass / 1 skip),新增部分以运行时行为测试为主:真起 git 子进程、真跑一次注定失败的回滚、先断言污染环境下 git 确实失败再断言清理后能跑通。1 条 skip 是需要创建符号链接的用例,Windows 无开发者模式时 `symlinkSync` 抛 EPERM,已改为能力探测后 skip
- **仓库行尾统一**——新增 `.gitattributes`(`* text=auto eol=crlf`),仓库以 LF 存储、工作树检出 CRLF,`git add` 不再反复提示 `LF will be replaced by CRLF`

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
