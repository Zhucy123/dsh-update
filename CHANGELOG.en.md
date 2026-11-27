# Changelog

<p align="right"><a href="CHANGELOG.md">简体中文</a> · <b>English</b> · <a href="CHANGELOG.ja.md">日本語</a></p>

This plugin follows [semver](https://semver.org/) and is independent of DSH's `dsh-v*` release cadence — the plugin's feature and fix versions increment on their own.

> **npm package name**: `@zhucy123/dsh-update` (when it was published on 2026-09-02, the bare name `dsh-update` had already been registered by a third party as a 1.3KB placeholder shell package, so the scoped name was adopted; the plugin ID and the `/api/dsh-update/*` route prefix are still `dsh-update`, and the historical command in the v1.2.0 entry below is for illustration only).

## v2.0.1 (current)

### Security fix

- **All 5 API routes now go through DSH's admission check**: migrated from bare `webServer.register` to `ctx.connection.fetch.register`. The host applies its Host/Origin trust fence (anti DNS-rebinding / cross-origin) and browser login check before a request reaches the plugin, so no web page open in your browser can call `/run`, `/restart`, etc. to trigger a real update. The plugin's own hand-rolled loopback/Origin fences were removed — authentication now lives in one place. The SSE progress stream is adapted via `ReadableStream`; progress output and rollback logic are unchanged
- **`engines.dsh` constrained to `>=0.2.3-0`**: the shared `/api` admission model stabilised in 0.2.3; the `-0` suffix lets `0.2.3-alpha.*` satisfy it (so `0.2.3-alpha.2`, the newest locally installable version, is not rejected as incompatible)
- `inject` now includes `connection`; README's old "local requests only" wording updated in all three languages

### UI improvements

- **Renamed “View release notes” to “View official release notes”**: the panel already shows this release's GitHub Releases notes inline, so the button that opens a new tab now clearly points at the official release page instead of being confused with the live progress log (all three locales)
- **Progress popover can be reopened during an update**: the trigger used to be disabled while updating, so once the panel auto-collapsed there was no way to see live progress again. Now clicking it while running reopens the same popover and the `updating` view keeps streaming its line-by-line log (auto-scroll to bottom, pauses when you scroll up). Closing the popover only hides it — it does not cancel the stream (`runToken` is not advanced while running), so you can reopen and keep watching
- **Network source choice is remembered**: picking “official” with a proxy port (e.g. 7890) or a specific mirror now persists in browser `localStorage`, so the next panel open restores the last source / port / mirror instead of resetting to “auto”. The stored value is validated on read (port range, mirror id), so stale or hand-edited data falls back to “auto” rather than sending a bad port to `/run`
- **Rollback now behaves like an update**: clicking “roll back to this version” closes the panel immediately and the sidebar button becomes a live progress bar; clicking it opens a **minimal progress window** (just the current stage + line-by-line log — no title, source picker, auto-check or long yellow warnings); completion turns the button green with a check mark and — just like a successful update — it polls `/ping` to detect the new process and reloads the page automatically
- **Version picker is now rollback-only**: with a new version found, the top already has “start update” while the lower version list defaulted to the latest tag with an “update to this version” button — redundant; and when already up to date it still offered “update to this version”, which is self-contradictory. In both states the lower list now only offers tags older than local, titled “Or roll back to an older version” with a fixed “roll back to this version” button — upgrades and rollbacks are cleanly separated
- **Fixed the page not auto-reloading after an update/rollback**: the build step replaces web assets, blanking the page and severing the SSE before the `autoRestart` done event arrives — so the old done-driven refresh never fired (leaving manual refresh or DSH's native “server version changed” dialog as the only options). The current boot id is now written to `localStorage` when a task starts; on page (re)load an independent `/ping` poll detects a changed boot id and reloads automatically — no SSE needed. The marker expires after 10 minutes, polling is idempotent, and it is cleared on failure/interception/skip
- **More accurate peer-conflict warnings**: (1) prerelease targets (e.g. `0.2.3-alpha.1`) are matched against ranges by their stable core `0.2.3`, removing false positives (e.g. `>=0.1.7-rc.1 <0.3.0-0` clearly covers the alpha but used to be flagged); (2) only **enabled** plugins (`dsh.profile.bundles`) are scanned — installed-but-disabled ones no longer count; (3) conflict details are collapsed and no longer printed twice; (4) the rollback interception button says “roll back anyway”, cancelling restores the button, and continuing keeps progress instead of restarting
- **Fixed rollback “failing / stuck at pull 12%”**: the real cause was a peerDependency conflict — the older harness tag cannot satisfy the versions pinned by installed plugins (e.g. WorkBuddy), so the server correctly emitted a `peers` interception awaiting confirmation. But the panel was closed when execution started, hiding the interception card, so the user only saw the button stuck at a percentage. Now all three safety gates (peer conflict / missing required paths / local-change conflict) **reopen the panel** and show their confirm buttons, while the button leaves the progress state and switches to a distinct “confirmation needed” look (“Needs confirmation” when narrow) instead of wrongly showing “update failed, retry”. Rollbacks also no longer have their chosen tag overwritten by the post-fetch “recompute latest / skip if up-to-date” logic

### Refactor

- Removed dead code left behind after the rollback entry moved into the panel: the whole standalone “rollback version” button state machine, `RollbackPopover`, `describeRollbackBlocked` and their dictionary entries, plus the unused `webServer` inject and adapter methods on the host side. No behaviour change; client.js shrank from 2405 to 2081 lines

## v2.0.0

This release (**sidebar button reworked + tri-lingual UI + selectable network source + a batch of bugs that would bite fixed**). Compared with v1.8.0:

### Added

- **Tri-lingual UI** — Chinese / English / Japanese. Only Chinese and English were hard-coded before; now there is one dictionary keyed by the original Chinese strings (187 entries) with `tr()` doing the lookup. When DSH's language is set to anything else (Korean, French, German, Russian, Spanish, Portuguese and so on) it falls back uniformly to **English**, so no hard-coded Chinese is left for non-Chinese users. The source is resolved in three levels: `ctx.locale` → `<html lang>` → browser language, and changes to `<html lang>` are watched so the UI switches live without a refresh
- **Network source selector** — "Auto / Official / Mirror" is always present at the top of the overlay. Auto: try GitHub directly first, then retry the mirrors in the mirror list one by one after an 8-second timeout, remembering the first that succeeds; Official: direct connection only, with an optional local proxy port (Clash / V2Ray's 7890 and the like); Mirror: one of `gh-proxy.com` / `ghproxy.net` / `ghfast.top`. The choice is stored in `localStorage`, and the check and the update run go through the same path
- **Automatic update check** — a toggle plus an interval (1 / 6 / 12 / 24 hours, enabled by default at every 6 hours), with one extra check on every `dsh web` start. When the background check finds a new version it only changes the button's appearance (the text becomes "New version available" + a red dot in the top-right corner); it does not pop up and does not interrupt you, and on failure it silently switches to a mirror and retries
- **Plugin icon** — `icon.svg`, a blue gradient rounded square on a 128 grid + a tray + a falling arrow, still crisp at 30px
- **Detect in-flight conversations before updating** — `/status` gains `busySessions`. When conversations are running, clicking update warns first and asks for confirmation, stating that "already generated fragments stay in the session record, but unfinished reasoning and tool calls waiting for results will be lost"

### UI and interaction

- **Sidebar button reworked** — the icon becomes a solid 18-grid "tray + falling arrow" (the old 24-grid one blurred into grey edges when scaled to 16px), the label changes from "Update DSH" to "Check for updates", and it is sorted to the end
- **Button width follows its label** — `flex: 0 1 auto` + `minWidth: 0` + text ellipsis, so it no longer fills the whole row; when space runs short it shrinks itself first and never pushes other buttons out of view
- **Position adapts** — a height difference of >4px from sibling buttons puts it on a row of its own, otherwise it sits side by side. Measured live with `ResizeObserver` (parent + every sibling button) and `MutationObserver` (slot additions and removals)
- **The overlay goes from a full-screen mask to a small window anchored to the button** — portal to `document.body` + `position: fixed`, no longer clipped by the sidebar's `overflow`, and fully readable even with the sidebar collapsed; clicking outside collapses it
- **While running, the button itself becomes the progress bar** — the overlay collapses and the button's fill width is the progress, with the current stage as its text; the unfilled part keeps a light track so the ratio is obvious at a glance
- **Version rollback folded into the check-for-updates panel** — the separate "Roll back version" button is removed and everything goes through "Switch to another version", whose label becomes "Update to this version" or "Roll back to this version" depending on whether the version is higher or lower

### Fixes

- **The `done` event never carried `autoRestart`** — seven places on the client rely on it to decide whether to poll `/ping` for a new process and then refresh, but the server never wrote it, so the whole "restart without a white screen" chain was dead code and the success card instead said "click restart to take effect now". It is now produced in one place by `buildDoneEvent()`, filled in truthfully for the build / detached / shutdown modes
- **`checkStatus` blocked the host synchronously for up to 38 seconds** — it used `execFileSync`, and 8s direct + 30s mirror froze the entire event loop, during which every agent turn, WebSocket heartbeat and `/ping` stopped. Changed to `execFile` + Promise, async at every layer
- **Rollback collided with already-restored local changes** — after `stash apply` + `drop` the user's changes existed only in the working tree, so a bare `git checkout` was rejected by git and the failed rollback left a half-updated tree. Rollback now stashes with `stash push -u` again beforehand and `apply`s afterwards
- **Helper rollback silently moved away "untracked-only / staged-only" changes** — `git diff --quiet` returns 0 for both kinds, yet `stash push -u` swept them up anyway, so `reStashed` was never set and they were never applied, and the files silently vanished from the working tree. Switched to `git status --porcelain`
- **A malformed `GIT_CONFIG_*` environment injection broke git entirely** — some CLIs leave `GIT_CONFIG_COUNT` behind without a matching `KEY`, and git then fails **any** command with `missing config key GIT_CONFIG_KEY_0`. Added `sanitizeGitEnv()`, covering 10 inconsistent shapes, shared by the host and the three helper processes
- **Progress inference over-reported** — in raw pnpm output `clean-css` matched `/clean/` and made install jump to 64%. Now only `step` / `notice` advance progress, and the largest pct among the matches wins
- **`upPhase === 'done'` was a dead terminal state** — the button stayed disabled, so users who turned auto-restart off were stuck on the green check forever. Clicking in the `done` / `error` state now returns to `idle` and re-checks
- **Windows flashed cmd windows** — `windowsHide` is now set on every `git` / `pnpm` child process, and on the restart and background-update helpers too
- **Five hard-coded Chinese strings bypassed `tr()`** — they showed Chinese in the Japanese/English UI; all changed
- **The rollback target was "the most recent tag" rather than the original commit** — `git describe --abbrev=0` drops local commits after HEAD; `status.localCommit` is used now
- **`/ping` lacked a loopback check** — it echoes back pid / boot. `isLoopbackRequest` now also checks `socket.remoteAddress` and accepts the whole 127/8 range
- **`windowsHide` was missing from 2 places in `safety.js`** — they are called on the default update path, so Windows still flashed windows

### Internal cleanup

- **`runUpdateStreaming` from 699 lines to 518**, with three module-level functions extracted: `createProcessRunners()` (107 lines, the git/pnpm child-process pipeline), `performRollback()` (94 lines, the whole failure-rollback chain) and `buildDoneEvent()` (the single producer of the success `done`). The point was not a nicer number but making "where the state machine lives" visible
- **Tests from 11 to 20** (19 pass / 1 skip); the additions are mostly runtime behaviour tests: really spawning git child processes, really running a rollback that is bound to fail, first asserting that git does fail in a polluted environment and then that it runs cleanly after sanitising. The one skip is a case that needs a symlink; `symlinkSync` throws EPERM on Windows without developer mode, so it now probes the capability and skips
- **Repository line endings unified** — `.gitattributes` added (`* text=auto eol=crlf`): the repository stores LF and the working tree checks out CRLF, so `git add` no longer keeps warning `LF will be replaced by CRLF`

## v1.8.0

This release (**updating to alpha by hand still works, but a missing contextMenus / a stale lib/ / a failed plugin load no longer leaves the Web UI in a broken state**):

- **The alpha channel is not blocked**: `dsh-v*` comparison still includes prereleases. When a new version exists you can update to the newest tag with "Start update", or pick any local tag under "Specific version (including alpha)". The rollback list keeps alpha as well
- **Recompute the target after fetch**: the tag used for checkout is refreshed from the remote after a successful `git fetch --tags` (falling back to the local tag just fetched) instead of reusing the `remoteTag` cached when the panel was opened
- **requiredPaths before checkout**: by default `packages/client/ui-context-menu/package.json` must exist in the target tag. If it is missing the checkout is refused, with a Chinese and English explanation that the tag has no `contextMenus` and that the old `lib/` will leave the page stuck at `Failed to load plugins` / `N entries did not activate`. The panel offers a "check out anyway" override; `config.allowMissingRequiredPaths: true` or `requiredPaths: []` relaxes it, and the `DSH_UPDATE_REQUIRED_PATHS` environment variable (comma-separated) works too
- **A stale lib/ only removes whitelisted orphan directories**: after checkout, if a package has a `package.json` in the old tree but not in the new one and its path is under `packages/` or `apps/` (configurable via `orphanLibRoots`), that package's `lib/` is deleted. `..`, absolute paths and real paths pointing outside the repository are rejected; for symlinks only the link itself is removed
- **`pnpm run clean` failing now means failing**: no more warning and carrying on to build. A failure in install / clean / build checks the tree back out to the tag (or commit) from before the update and re-runs install, clean and build
- **Startup health check**: with auto-restart on, after a successful build the new dsh is launched and, once the port is up, `bootHealthWindowMs` (15 seconds by default) is observed. If the logs contain `did not activate` (excluding `0 entries did not activate`), `Failed to load plugins`, or HARNESS + plugin + fail on one line, the new process is killed, the previous version restored and the build re-run. Success requires a clean startup window, not just a build exit code. With auto-restart off the panel states that no startup check was performed
- **Plugin peer warnings**: before updating, `~/.dsh/profiles/*/package.json`, its direct dependencies and package.json files under `plugins/` are scanned. If a peer whose name contains dsh / harness / deepseek cannot cover the target version (including WorkBuddy-style pinned versions where alpha does not satisfy the stable range), the default `confirm` lists the conflicts before continuing. `peerConflictPolicy` can also be set to `block` or `ignore`
- Added `node --test test/update-safety.test.mjs`, covering tag comparison, semver/peer, requiredPaths, stale lib/ removal and startup-log judgement

## v1.7.0

This release (**Windows defaults back to an "in-process update" — restoring the old experience where progress is visible the whole time**):

- **`windowsDetachedUpdate` default changed from `true` to `false`**: to work around Windows being unable to delete locked old packages during `pnpm install`, v1.6.3 handed install/build to a detached background process by default, at the cost of the page disconnecting after the hand-off, incomplete progress and a required refresh. The default is now the **in-process** path again: the whole update (fetch → stash → checkout → install → clean → build → restart) runs in one process, the panel keeps streaming live progress and never disconnects midway — the experience from before v1.6.2
- **Detached background mode becomes opt-in**: if you do hit file locks (`pnpm install` fails with `[WARN] Failed to remove ...` and rolls back), add `config: { windowsDetachedUpdate: true }` for that bundle in the profile's `cordis.patch.yml` to switch back to background mode. On failure the plugin still rolls back automatically under "fail without self-harm", so the working tree never stops in a half-updated state
- **Client hints no longer guess from the UA**: the panel used to judge Windows from `navigator.userAgent` and show a "the page will disconnect, the update moves to the background" warning — which is **misleading** in the default (in-process) mode. The server's `/status` now has a `detachedUpdate` field (genuinely determined from platform + config) and the client shows the matching text; in-process mode instead states clearly that "progress stays visible in this panel the whole time and never disconnects midway"
- **Fixed two branches where Chinese and English were swapped**: the two Windows detached explanations in the `available` view (with `autoRestart` on and off) had the English branch of the `en ? … : …` ternary written in Chinese and vice versa, so the English UI showed Chinese
- Kept v1.6.3's detached implementation and v1.6.4's companion fixes (hand-off card title, hidden restart button against two processes fighting for the port, concurrency protection for the hand-off gap) — they still apply when the mode is explicitly enabled
- No other behaviour changes; with a `link:` install a source edit takes effect immediately, and the new default is available after restarting `dsh web` once

## v1.6.4

This release (**companion fixes for v1.6.3's "Windows detached background update" + robustness hardening**):

- **The background hand-off card title no longer contradicts itself**: when `done` carried `detached` the title was still rendered from `ok:true` as "**Update complete**", fighting the card body's "the update has moved to the background" and easily making users believe the update had succeeded. A detached result now renders its own title, "The update has moved to the background"
- **The "Restart DSH / Restart now" buttons are hidden during a background hand-off**: after the hand-off the update helper is already waiting for the port to be released and will start the new dsh itself; clicking restart at that moment goes through `/restart`, spawns a second restart helper, and the two helpers each start a dsh and fight for the same port (the `restartScheduled` latch only guards the `/restart` route, not the update helper). The detached card now keeps only "Check again"
- **Release notes support Markdown**: the `body` returned by the GitHub Releases API is Markdown source, but only `<h3>…</h3>` was recognised, so `### heading` was displayed literally as "### xxx". `#`~`######`, `* / -` and `1.` lists are now supported, and `[text](link)` is stripped to just the text (no more raw Markdown on screen)
- **Rollback stays available when offline / the remote check fails**: the "Version rollback" entry required `status.error === undefined`, so when GitHub was unreachable (direct and mirror both failing) the whole rollback UI was hidden — even though rollback is entirely offline (local `git tag -l`) and is exactly what you need without a network. It now shows whenever selectable historical tags exist; when there are none it says explicitly that no other `dsh-v*` tags have been fetched locally, instead of silently disappearing
- **No more dead clicks when react-dom is not injected**: with `ReactDOM` null it called `createPortal` unconditionally, so clicking the button threw a TypeError, the panel never opened and there was no hint at all; it now degrades to rendering in place and the panel works as usual
- **Concurrency protection now covers the 4-second hand-off gap**: `endRun()` clears `activeRun` while this process still lives for 4 seconds before exiting, during which another tab can trigger `/run` or `/restart` again. A `handingOff` flag was added and `/run` and `/restart` both decide through `updateInFlight()` (activeRun ‖ handingOff), so the gap keeps returning 409
- **`/status` no longer scans the temp directory in full every time**: the last background update result (`lastDetachedUpdate`) is cached for 5 seconds by mtime, avoiding repeated `readdirSync` + `statSync` over the whole tmpdir each time the panel opens
- **Automatic failure rollback no longer points at `unknown`**: when `localVersion()` could not get a commit it returned the string `'unknown'`, which was then used as the rollback checkout target and produced a `git checkout unknown` that was bound to fail; it now returns undefined
- Fixed a stale comment (the auto-restart countdown has long been 2 seconds, but the comment still said 8); the README version badge and the "version history" section are synced to the current version (they were missed when v1.6.3 shipped and still showed 1.6.2)
- No other behaviour changes; with a `link:` install a source edit takes effect immediately, and the host-side changes apply after restarting `dsh web` once

## v1.6.3

This release (**fixes the root cause of updates failing and rolling back on Windows because the running service holds file locks**):

- **Windows switches to a "detached background update"**: the whole update pipeline (git fetch/stash/checkout → `pnpm install` → `pnpm run build`) used to run inside the running dsh process — on Windows the running service holds handles on files in the old `node_modules` (native `.node` modules in particular), `pnpm install` cannot delete the locked old package (the typical error being `[WARN] Failed to remove ...\fs-ext@2.1.1`), install never completes → the plugin rolls back automatically under "fail without self-harm", and the update never succeeds
- **The fix**: the git steps (fetch/stash/checkout) do not touch `node_modules` and still complete in-process (keeping the existing conflict detection / auto-stash interaction); after a successful checkout, install → stash apply/drop → clean → build → auto-restart is handed over as a whole to a **detached background process** (`scheduleDetachedUpdate` + `updateHelperSource`): the main process answers `done{detached}` and exits 4 seconds later, releasing every file lock; the helper waits for the port to be released and then runs install/build without locks, starts the new dsh with the original command on success, and on failure rolls back with `git checkout` and writes a log — progress is written throughout to `%TEMP%\dsh-update-apply-*.log` so you can troubleshoot after the page disconnects
- **Client side**: when `done` carries `detached` a dedicated card is rendered ("the update has moved to the background", no more false green "update succeeded"); the pre-update and in-progress hints add, on Windows clients, that the page will disconnect and the background job will finish and restart automatically; the background log path is shown on the result card
- **The reminder chain is complete (before and after the page disconnects)**: ① before clicking "Start update" the Windows client appends a note about background mode; ② while updating (the `updating` view) a highlighted banner says "this page will disconnect once the git steps finish…"; ③ at the moment of hand-off the server appends a notice; ④ the `done` card; ⑤ the process exits only **4 seconds** after the hand-off (was 1.5), giving the user time to read the notices; ⑥ **confirmation after the page recovers**: `/status` gains a `lastUpdate` field that parses the newest `dsh-update-apply-*.err.log` and reports "✓ the last background update completed: version X (time)" or "⚠ the last background update did not complete / was rolled back", so the user can confirm the outcome by opening the panel after a refresh
- **Configurable**: `config.windowsDetachedUpdate: false` turns detached mode off and returns to the old in-process install/build path (on Windows it will most likely fail again on file locks; for troubleshooting only)
- The POSIX (macOS/Linux) flow is unchanged — POSIX allows unlinking open files, so in-process install has no lock conflicts
- No other behaviour changes; with a `link:` install a source edit takes effect immediately, and the new flow is available after restarting `dsh web` once

## v1.6.2

This release (**fixes the bug where the plugin could not load after being published under a scoped package name**):

- **Plugin registration ID aligned with the installed package name**: since v1.6.1 the package has been published under the scoped name `@zhucy123/dsh-update` (the bare name `dsh-update` was already taken by a third party), but two loading identifiers inside the plugin still pointed at the old bare name, so when the DSH framework loaded it by scoped package name it found no matching registered plugin — the sidebar "⭯ Update DSH" button disappeared and the console reported an ID mismatch. Both are now the scoped package name:
  - `cordis.patch.yml` loader entry `name:`: `dsh-update` → `@zhucy123/dsh-update` (the Cordis patch layer resolves the plugin by package name from the profile's `node_modules`, so it must match the installed name)
  - `lib/client.js` browser registration `load({ id })` and `PLUGIN_ID`: `dsh-update` → `@zhucy123/dsh-update` (`window.__ModuleLoader__` registers client bundles by package name, and the ID must match)
- The plugin's **internal identifiers are unchanged** (the host plugin id `dsh-update` in `lib/index.js`, the sidebar slot id, the `/api/dsh-update/*` route prefix) — DSH decouples "installed package name" from "internal plugin id", so the scoped name only affects installation/loading and makes no perceptible difference to users once installed
- No other behaviour changes; with a `link:` install a source edit takes effect immediately, and the sidebar button is back after one full restart of `dsh web`

## v1.6.1

This release (Windows auto-restart fix + adversarial review hardening):

- **Fixes Windows auto-restart failing silently**: after the update finished, "auto-restart dsh" was triggered but the replacement process never started, the page went blank and the service stopped running, leaving only a manual restart (symptom: the helper diagnosed "the replacement did not bind port 3080 within 20s" and the out log was 0 bytes). The root cause was the Windows branch wrapping PowerShell in a Node `spawn(detached: true)` to start the replacement — on Windows `detached: true` sets `DETACHED_PROCESS`, which breaks handle/console inheritance from PowerShell to node (Node.js issue #51018), so the replacement node process never actually starts
- **Windows restart goes back to `detached: false`**: aligned with the restart configuration long proven by dsh-market on Windows (`-WindowStyle Hidden` still keeps the service silent with no visible console; process-group independence comes from the helper's own inherited detached session, so closing any window does not affect the service; `windowsHide: true` keeps windows from popping up). The POSIX branch is unchanged (still `detached: true` + setsid)
- **Fixes the client's `useLocale` re-rendering forever**: the subscription dependency array wrongly contained `tick`, so once the locale runtime was ready every re-render re-ran the effect and incremented `tick` again — an infinite submit loop burning CPU. It now depends only on `localeFace` (the same pattern as source-code-mgmt), and language switching still takes effect through live subscription
- **Fixes a restart latch leak**: when `scheduleRestart` failed to start the helper (EMFILE, say), the `restartScheduled` latch was not released and the error not thrown, and `/restart` did not clearly answer 500 — afterwards the latch stayed true forever, silently swallowing every later manual/automatic restart and permanently disabling restart
- **Stashing includes untracked files**: auto-stash now uses `git stash push -u`. Untracked files were not stashed before, so if the new version occupied the same path, checkout kept reporting "untracked working tree files would be overwritten" and "auto-stash and continue the update" looped forever; untracked files are now stashed too and restored unchanged on success (gitignored files are unaffected)
- **Failures of stash drop / working-tree cleanup are reported**: these two steps no longer fail silently; the panel says so explicitly (it does not change whether this update counts as a success)
- **A 10s timeout on POSIX pnpm detection**: when `pnpm --version` hangs abnormally (a broken nvm/alias shim) it no longer blocks the event loop forever; on timeout or failure it falls back to `corepack pnpm`
- No other behaviour changes; with a `link:` install a source edit takes effect immediately, and auto-restart works again after restarting dsh once

## v1.6.0

This release (macOS / Linux compatibility + first-principles / adversarial hardening):

**Cross-platform (macOS / Linux)**
- **The restart entry no longer depends on `dsh` being on PATH**: `restartLaunch` uses node + the original entry + `execArgv`/arguments/working directory whenever `argv[1]` exists — on macOS/Linux dsh is often installed inside node_modules and reachable only through pnpm/corepack, where the old bare `dsh` fallback failed
- **POSIX restart processes detach from the terminal**: the POSIX branch of `respawnInvocation` uses `detached: true` (Node's internal `setsid`) so the replacement becomes its own session/process group with no controlling terminal — closing the terminal or window that started it does not affect the service, output goes to a tmpdir log, and everything stays silent (matching the Windows semantics of v1.5.2)
- **pnpm resolution works on POSIX**: prefer `pnpm`, and fall back automatically to `corepack pnpm` (bundled with Node 16.9+) when it is missing, covering fresh macOS/Linux environments that have only corepack and no global pnpm
- **Fail fast when git / pnpm is missing**: an asynchronous spawn failure (binary absent / not on PATH) now ends immediately with a clear error instead of hanging until the timeout reports "timed out"; a `delivered` guard prevents double close/error callbacks

**First-principles hardening (fail without self-harm)**
- **Automatic rollback on failure**: after `git checkout` to the new version, if `pnpm install` / `pnpm run build` fails, the tree is checked back out to the version from before the update/rollback (the original tag when possible, the original commit when there is no local tag), so the working tree and artifacts never stop in a half-updated state; if the rollback itself fails, the error gives the commands to recover by hand
- **SIGKILL fallback on timeout**: when git/pnpm hangs, `SIGKILL` follows `SIGTERM` after 3 seconds, leaving no stray processes
- **A 30s timeout on `gitSync`**: synchronous git calls (such as the rollback checkout) can no longer block the event loop forever
- **Client fallback when auto-restart fails**: when `done` carries `autoRestart` and the page is still alive 10 seconds after `restartInMs` (auto-restart did not take effect), the UI automatically says "restart failed, please restart manually" and offers a "restart now" button — no more sitting on a countdown stuck at 1 second

**Adversarial hardening (robustness / security)**
- **A browser disconnect no longer drags the host down**: `res.write` is wrapped in try/catch with a `res.on('error')` fallback — a page going blank / F5 during an update (dropped connection) no longer throws an uncaught exception that crashes the dsh process
- **git output forced to English**: `GIT_ENV` gains `LC_ALL:C` + `LANG:C`, so conflict detection / empty-stash checks are no longer affected by localised output from non-English locales such as zh_CN
- **Rollback target fallback**: `from ?? status.localCommit`, so it also rolls back when the local tree is not on a tag
- **Rollback target allowlist**: `targetTag` must match a `dsh-v*` release tag; arbitrary refs (branches/commits) are rejected, preventing an abnormal call from steering checkout at any ref

## v1.5.2

This release:

- **Windows auto-restart goes silent**: the restart replacement process goes from `detached: false` to `detached: true` + `windowsHide: true` (CREATE_NO_WINDOW) — no visible console window any more, and the service runs silently in its own windowless process group; closing any window no longer affects the service (previously closing the exposed bat/cmd window took the service down with it)
- The PowerShell wrapper layer is kept, so git/pnpm spawned later by the service inherit the hidden console instead of each popping up a window

## v1.5.1

This release:

- **Fixes invisible white-on-white buttons in dark theme**: primary buttons such as "Roll back to this version" had their text colour hard-coded to pure white `#fff`, while in dark theme DSH's brand colour `--dsw-alias-brand-primary` itself resolves to near-white (`rgb(249,250,251)`) — white on white made the text completely invisible until selected
  - The "Roll back to this version" button now has a **transparent background + amber border/text** (the same colour family as the "version rollback" warning panel), clearly readable in dark theme
  - Buttons of the same kind ("Start update", "Auto-stash and continue the update/rollback", "Restart DSH/restart now") now take their text colour from the platform contrast token `var(--dsw-alias-label-primary-foreground, #fff)`: dark text in dark theme, unchanged appearance in light theme, matching how DSH's own primary buttons behave

## v1.5.0

This release:

- **Version rollback**: regret an update? The "already up to date" result view gains a "version rollback" panel — a dropdown lists **all historical versions** (the local `dsh-v*` tags, newest to oldest, with the newest historical version selected by default), and "Roll back to this version" performs the rollback: re-fetch to confirm → `git rev-parse --verify` to check the target tag exists → checkout → install → clean → build, the exact same flow as an update with the same live streaming progress; on success dsh restarts automatically (about 2 seconds later, as with an update; when the system does not allow restarts it does not restart automatically, following the existing logic). Uncommitted local changes during a rollback go through the same conflict handling as an update (auto-stash and continue)
- The status endpoint `/api/dsh-update/status` gains a `tags` field (local historical versions, newest → oldest) for the rollback panel
- Rollback reuses the update's execution pipeline (`runUpdateStreaming` + `options.targetTag`) with no duplicated code, and its safety boundaries (loopback-only / concurrency protection / auto-restart latch) are exactly the same as an update's

## v1.4.1

This release:

- **dsh restarts automatically when an update completes**: when the update succeeds and the system allows restarts (dictated by supervisor management / `allowRestart: false`), the server triggers a restart about **2 seconds** after `done` — even if the page has already gone blank or disconnected, with no button to click. The completion card shows a brand-coloured "Update complete, restarting dsh automatically (in N seconds)…" with a **real countdown** (decrementing every second); after the page briefly goes blank, one refresh brings it back. Auto-restart is guarded by a one-shot latch shared with manual restart, so two helpers can never fight for the port; the `done` event gains `autoRestart` / `restartInMs`
- **A warning before updating (confirm nothing is in flight)**: when a new version is detected the warning box now reads "⚠ dsh restarts automatically once the update completes; please confirm no work or conversation is in progress" — making explicit that a successful update restarts automatically and interrupts in-flight downloads/conversations/tasks, and that you can close the panel and update later if you are not in a hurry; with `allowRestart: false` or under supervisor management the old wording "this update will not restart automatically" is used, so nothing misleads
- **Update progress scrolls automatically**: the log area no longer stays pinned at the top but follows the output to the bottom in real time (scrolling up to read pauses the follow, and returning to the bottom resumes it)
- The status endpoint `/api/dsh-update/status` gains an `autoRestart` field so the UI can decide whether to show the auto-restart warning

## v1.4.0

This release:

- **One-click dsh restart (borrowed from dsh-market)**: the completion card gains a "Restart DSH" button — the server uses a detached helper to start dsh again with the **original launch command** (node + entry + arguments + working directory): the helper outlives the current process, waits for port 3080 to be genuinely released before starting the new process, writes output to a tmpdir log, checks within 20 seconds whether the new process took over the port, and leaves diagnostics on failure. The current process answers and exits 500 ms later. The safety boundaries follow dsh-market: only requests that are **direct loopback + Origin matched** are accepted (proxied forwarding is rejected), and it is disabled under a supervisor (systemd) or with `config.allowRestart: false`
- **Release notes follow the UI language (borrowed from source-code-mgmt)**: it takes over DSH's language setting (`ctx.locale` LocaleRuntime, subscribed live for switching, falling back to the browser language when not captured). The Chinese and English parts of the release notes (separated by `---`) are shown per language: the Chinese UI shows the Chinese part, the English UI the English part, updated instantly on a language switch
- Added the route `POST /api/dsh-update/restart` (loopback-only, strictly validated)

## v1.3.5

This release:

- **Show what this update contains**: when a new version is detected the panel shows that version's (remoteTag's) GitHub Releases notes (new features / experience improvements / bug fixes and so on). The content comes from the GitHub Releases API (direct first, mirror fallback, cached for 1 hour); if fetching fails it degrades to a "View GitHub Releases →" link. The language version shows only the Chinese part (the English part follows `---` and is truncated automatically)
- Added the route `GET /api/dsh-update/release-notes?tag=…` (loopback-only)

## v1.3.4

This release:

- **Fixes update progress not showing**: DSH web enables gzip on responses by default (`compression: gzip`), and the `compression` middleware **buffers the small streaming JSON lines in zlib until the stream ends** before sending anything — so the panel showed no progress at all for the whole update. The update stream now responds with `text/event-stream` (a type the DSH webserver explicitly exempts from compression) + `cache-control: no-cache, no-transform`, and calls `flushHeaders` immediately, so each step arrives in real time
- **Feedback as soon as it opens**: clicking "Start update" immediately shows "checking the version and preparing the update…", so there is no blank wait any more (the version check can take several seconds over the network)
- **Logs are not lost**: the completion / conflict / failure cards all carry a "view this update's log" collapsible section, so you can review the whole process even if the output arrived all at once

## v1.3.3

This release:

- **Automatic GitHub mirror switching**: every operation that touches GitHub (version comparison via `ls-remote`, `git fetch` during an update) **tries a direct connection first**; when the direct attempt times out or fails and the origin is github.com, it automatically retries through the `gh-proxy.com` mirror — no response within 8 seconds switches for ls-remote, and a 90-second direct timeout switches for fetch; the mirror address is used for that command only and **does not touch the repository's remote configuration**. When a mirror request succeeds, the panel annotates the remote version with "(via mirror gh-proxy.com)"
- **The mirror is configurable**: `config.gitProxy` (in the profile's cordis.patch.yml) or the `DSH_UPDATE_GIT_PROXY` environment variable changes the mirror prefix, and setting it to an empty string turns mirror fallback off

## v1.3.2

This release:

- **Concurrency protection**: only one update task may run at a time. Repeated clicks / several tabs triggering it at once get 409 on the later request and the panel says "an update is already running", so two concurrent checkout+build runs never trample each other
- **Post-build verification**: after a successful build the server re-reads the git status and the `done` event carries `verifiedTag` / `verifiedCommit`; the completion panel shows "✓ current version confirmed as X, matching this update's target" — no more confusion where the UI says the update completed and you still think an update is available
- **Remote check caching**: `git ls-remote` results are cached for 60 seconds (failures are not cached), so opening the panel repeatedly no longer blocks for 30 seconds each time when GitHub is slow; the panel shows the state at the moment it was opened or "Check again" was clicked, and old panels (including in other tabs) do not refresh automatically — trust "Check again"

## v1.3.1

This release:

- **Automatic repository directory detection**: fixes "check failed: not a git checkout" — `dsh web` may be started from a subdirectory (such as `apps/cli/src`) while the old logic took `process.cwd()` as the repository root. It now walks up from cwd by default looking for the directory containing `.git`; `config.repoDir` / `DSH_UPDATE_REPO_DIR` still override it

## v1.3.0

This release:

- **`pnpm run clean` runs automatically before building**: fixes "build reports MISSING_EXPORT after an update / the restart cannot open" — after a version switch, the old version's `lib/` build artifacts (git-ignored, not removed by checkout) may reference exports that have been removed or renamed in the new source, and leftover package directories (such as a package deleted upstream) are treated by tsdown as workspace packages and packaged, failing the build. Clean now runs automatically after `pnpm install` and before `pnpm run build` (idempotent); a clean failure only warns and the build result still decides
- **Streaming output is UTF-8 safe**: git/pnpm output is split into lines with a streaming TextDecoder, so multi-byte characters (Chinese, for instance) are no longer garbled across chunk boundaries
- **git command timeout**: a single git command times out after 5 minutes (so fetch cannot hang forever); pnpm stays at 20 minutes

## v1.2.0

This release:

- **Distributed as a Profile Bundle, active as soon as it is installed**: `package.json`'s `dsh.bundle` changed from a bare string to the object form `{ "patch": "./cordis.patch.yml" }`, and a `cordis.patch.yml` was added (inserting the `dsh-update` line). Now `dsh plugin --profile web add dsh-update` installs, is automatically added to `dsh.profile.bundles` and registered in the Cordis loader tree in one step, with **no need to edit `cordis.patch.yml` by hand to activate it**; the README's "installing ≠ activating" explanation and its activation-config section have been removed. No functional change

## v1.1.0 (historical)

This release:

- **Confirm before updating**: when a new version is detected it no longer updates automatically but shows the local/remote versions + a note that the page will go blank + a "Start update" button, running only after you click it; if you do not need the update you can simply close the panel
- **Warn in advance that the page will go blank**: both when the update starts and during the build, the UI states clearly that "the whole page may suddenly go blank, which is normal — a blank page basically means the update has finished and only a restart is left; press F5 to refresh, and restarting the dsh service by hand is recommended"
- **The post-completion restart guidance is removed**: the completion panel no longer shows restart instructions / a "copy restart command" button, leaving the user to restart dsh web themselves; the `DSH_UPDATE_RESTART_SCRIPT` environment variable is no longer used by the UI (the host's status still passes the value through, kept only for compatibility)

## v1.0.0 (historical)

First release: version comparison + one-click update + streaming progress + post-completion restart guidance.
