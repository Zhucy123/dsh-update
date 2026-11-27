/**
 * dsh-update — browser half (client.js).
 *
 * Classic-script plugin bundle (no build step): registers into the sidebar
 * foot via the official `sidebar.footer.action` list slot. It enables
 * `flex-wrap: wrap` on `.footerActions` and uses adaptive width
 * (`flex: 0 1 auto` inline with siblings of matching height, or a full row
 * via `flex: 0 0 100%` when a sibling button's height differs); a high order
 * keeps it after earlier entries. The trigger is a download-tray (down-arrow)
 * icon + 「检查更新」 label (icon-only in rail mode); clicking it opens a
 * portal popover that compares the local deepseek-harness version with the
 * remote, and when an update or rollback starts, switches the panel in place
 * to live streamed progress without auto-closing.
 *
 * React is a platform module: `require("react")` resolves through the loader
 * module table. Everything is plain createElement — this file is executed
 * verbatim as a classic script.
 */
window.__ModuleLoader__.load({
	id: "@zhucy123/dsh-update",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const PLUGIN_ID = "@zhucy123/dsh-update";

		let React = null;
		try { React = require("react"); } catch {}
		let ReactDOM = null;
		try { ReactDOM = require("react-dom"); } catch {}

		const { useState, useEffect, useRef, useCallback } = React || {};

		// ---------- theme tokens (dsw alias vars, dark/light aware) ----------
		const T = {
			border: "var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			label: "var(--dsw-alias-label-primary, inherit)",
			secondary: "var(--dsw-alias-label-secondary, rgba(128,128,128,.8))",
			layer1: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))",
			layer2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
			active: "var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.18))",
			success: "var(--dsw-alias-state-success-primary, #22c55e)",
			danger: "var(--dsw-alias-text-danger, #ef4444)",
			warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
			brand: "var(--dsw-alias-brand-primary, #4f8cff)",
			mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.5))",
		};

		/**
		 * 执行中进度用的蓝：**固定值，不跟主题走**。
		 * `--dsw-alias-brand-primary` 在深色主题下是近黑的品牌色（实测 body 上是 #0f1115），
		 * 拿它画进度条会得到一条灰黑带子，用户根本看不出那是「正在走」。
		 * 与开关同一条理由（见 AutoCheckRow 里的注释）。
		 */
		const RUN_BLUE = "#4f8cff";

		// ---------- i18n: follow DSH's language setting (Settings → General → Language), live ----------
		// Borrowed from source-code-mgmt: initial value comes from the browser
		// language; once the DSH LocaleRuntime (ctx.locale) is captured, its
		// active locale wins and switches propagate via subscribe().
		// 本插件只提供中文 / English / 日本語三种界面语言。
		// DSH 语言设为其它语言（日韩法德等）时统一回落英文——不做半成品本地化，
		// 也不能留中文硬编码给非中文用户。
		const SUPPORTED_LANGS = ["zh", "en", "ja"];
		function normalizeLang(raw) {
			const base = String(raw || "").toLowerCase().split("-")[0];
			if (base === "zh") return "zh";
			if (base === "ja") return "ja";
			return "en"; // en 以及一切其它语言都走英文
		}
		let updateLang = (() => {
			try { return normalizeLang(navigator.language) } catch { return "zh" }
		})();
		/** Windows 客户端：更新走「后台分离模式」，页面会在 git 步骤后断开，
		 *  install/build 在独立进程完成并自动重启（见 host 端 handOffToUpdate）。 */
		/** 格式化 ISO 时间为本地 "MM-DD HH:mm"，供「上次后台更新」确认展示。 */
		function fmtTime(iso) {
			try {
				const d = new Date(iso);
				const p = (n) => String(n).padStart(2, "0");
				return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
			} catch { return ""; }
		}
		/** 渲染「上次后台更新」确认行：成功且版本一致 → 绿色确认；失败 → 黄色告警。 */
		function lastUpdateRows(h, T, rowStyle, status) {
			const lu = status && status.lastUpdate;
			if (!lu) return [];
			if (lu.ok && lu.bootChecked === false) {
				return [h("p", { key: "lastupd", style: { ...rowStyle, color: T.warn } },
					tr("上次更新已构建 ") + (lu.tag || tr("目标版本")) + tr("，但未做启动健康检查（当时未自动重启）。"))];
			}
			if (lu.ok && lu.tag) {
				return [h("p", { key: "lastupd", style: { ...rowStyle, color: lu.tag === status.localTag ? T.success : T.secondary } },
					(lu.tag === status.localTag
						? (tr("✓ 上次更新已完成，启动日志未见插件加载失败："))
						: (tr("上次后台更新完成于 ")) + (fmtTime(lu.at) || "?") + (tr("："))) + lu.tag)];
			}
			const reason = lu.reason ? (" — " + lu.reason) : "";
			return [h("p", { key: "lastupd", style: { ...rowStyle, color: T.warn } },
				(tr("⚠ 上次更新未完成或已回滚"))
				+ reason
				+ (tr("。详见临时目录下 dsh-update-apply-*.log")))];
		}
		let localeFace = null; // ctx.locale (the DSH LocaleRuntime), set in apply()
		/**
		 * 当前界面语言。三级取源，越靠前越准确：
		 *  1. ctx.locale（LocaleRuntime 的 active）——最权威；
		 *  2. <html lang>——DSH 的语言服务会实时把它同步成当前语言，
		 *     即使本插件晚于它激活、或拿不到 ctx.locale，这条也能跟上；
		 *  3. 浏览器语言 / 上次捕获的值——最后的兜底。
		 * 只靠第 1 条会出问题：捕获失败一次就永远停在浏览器语言，用户改设置没反应。
		 */
		function currentLang() {
			try {
				if (localeFace && typeof localeFace.getLocale === "function") {
					const active = localeFace.getLocale().active;
					if (active !== undefined && active !== null && active !== "") {
						return normalizeLang(active);
					}
				}
			} catch {}
			try {
				const docLang = typeof document !== "undefined" && document.documentElement
					? document.documentElement.lang
					: "";
				if (docLang) return normalizeLang(docLang);
			} catch {}
			return updateLang;
		}
		// ---------- 文案字典：keys 是中文原文，值按 [en, ja] 排列 ----------
		// 用 tr("中文原文") 取当前语言的文案；中文即 key，所以 zh 直接返回 key。
		// 加占位符的用 tr("… {n} …").replace("{n}", value)。
		const MESSAGES = {
			" 回退到 ": [" rolled back to ", " にロールバックしました "],
			" 并重新 install / clean / build。本页即将断开，稍后重新打开面板可看到结果。": [" and re-runs install / clean / build. This page will disconnect; reopen the panel shortly to see the result.", " を再実行します。このページは間もなく切断されます。しばらくしてパネルを開き直すと結果を確認できます。"],
			" 更新到 ": [" updated to ", " に更新しました "],
			" 行）": [" lines)", " 行)"],
			"dsh 正在重启。只有启动日志里没有 “did not activate”、“Failed to load plugins” 和 HARNESS 插件加载失败，才算更新成功。若出现这些信号，会自动 checkout 回 ": ["dsh is restarting. The update only counts as successful when the boot log shows no “did not activate”, “Failed to load plugins” or HARNESS plugin load failures. If any appear, it automatically checks back out to ", "dsh を再起動しています。起動ログに “did not activate”、“Failed to load plugins”、HARNESS プラグイン読み込み失敗が出ていない場合のみ更新成功です。これらが出た場合は自動で "],
			"{n} 秒后": ["in {n}s", "{n} 秒後"],
			"⚠ 上次更新未完成或已回滚": ["⚠ Last update did not finish or was rolled back", "⚠ 前回の更新は完了しなかったか、ロールバックされました"],
			"✓ 上次更新已完成，启动日志未见插件加载失败：": ["✓ Last update finished and the boot log looked healthy: ", "✓ 前回の更新は完了し、起動ログにプラグイン読み込み失敗はありませんでした："],
			"✓ 你的本地改动已在更新后自动恢复并保留在新版本中。": ["✓ Your local changes were restored automatically and kept in the new version.", "✓ ローカルの変更は更新後に自動で復元され、新しいバージョンに保持されています。"],
			"✓ 已是最新，无需更新。": ["✓ Already up to date.", "✓ すでに最新です。更新は不要です。"],
			"✓ 已确认当前版本为 ": ["✓ Confirmed the current version is ", "✓ 現在のバージョンを確認しました: "],
			"。详见临时目录下 dsh-update-apply-*.log": [". See dsh-update-apply-*.log in the temp directory.", "。詳細は一時ディレクトリの dsh-update-apply-*.log を参照してください。"],
			"上一版本": ["the previous version", "前のバージョン"],
			"上次后台更新完成于 ": ["Last background update finished at ", "前回のバックグラウンド更新は完了しました: "],
			"上次更新已构建 ": ["Last update built ", "前回の更新はビルドされました: "],
			"仍要检出（我接受 Web UI 可能损坏）": ["Check out anyway (web UI may break)", "それでもチェックアウトする（Web UI が壊れる可能性を承知）"],
			"需要你确认": ["Confirmation needed", "確認が必要です"],
			"待确认": ["Needs confirmation", "確認待ち"],
			"仍要继续更新": ["Continue anyway", "それでも更新を続ける"],
			"仍要继续回退": ["Roll back anyway", "それでもロールバックする"],
			"查看冲突详情": ["View conflict details", "競合の詳細を見る"],
			"以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续回退，或先手动处理（git stash / git commit），再重新检查：": ["These files have uncommitted local changes, so git refuses to overwrite them. Stash them automatically and continue the rollback, or handle them yourself (git stash / git commit) and re-check:", "以下のファイルに未コミットの変更があるため、git は上書きを拒否しました。自動で stash してロールバックを続けるか、手動で処理（git stash / git commit）してから再確認してください："],
			"以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续更新，或先手动处理（git stash / git commit），再重新检查：": ["These files have uncommitted local changes, so git refuses to overwrite them. Stash them automatically and continue the update, or handle them yourself (git stash / git commit) and re-check:", "以下のファイルに未コミットの変更があるため、git は上書きを拒否しました。自動で stash して更新を続けるか、手動で処理（git stash / git commit）してから再確認してください："],
			"关闭": ["Close", "閉じる"],
			"准备回退": ["Preparing rollback", "ロールバックの準備"],
			"准备更新": ["Preparing update", "更新の準備"],
			"切换": ["Checkout", "切替"],
			"切换到新版本": ["Switching to the new version", "新しいバージョンへ切替"],
			"切换到目标版本": ["Checking out the target tag", "対象バージョンへ切替"],
			"发现新版本 {tag}": ["New version {tag}", "新しいバージョン {tag} があります"],
			"取消": ["Cancel", "キャンセル"],
			"后台日志：": ["Background log: ", "バックグラウンドログ："],
			"启动检查日志：": ["Boot-check log: ", "起動チェックログ："],
			"回退到此版本": ["Roll back to this version", "このバージョンにロールバック"],
			"回退失败": ["Rollback failed", "ロールバック失敗"],
			"回退完成": ["Rollback complete", "ロールバック完了"],
			"回退完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。": ["Rollback complete. Click “Restart DSH” to apply immediately, or restart dsh web later.", "ロールバック完了。「DSH を再起動」を押すとすぐ反映されます。後で dsh web を手動で再起動してもかまいません。"],
			"回退完成，即将自动重启 dsh（": ["Rollback complete — restarting dsh automatically (", "ロールバック完了。まもなく dsh を自動で再起動します（"],
			"回退完成，正在重启": ["Rollback complete, restarting", "ロールバック完了、再起動中"],
			"回退完成，请手动重启": ["Rollback complete, restart manually", "ロールバック完了、手動で再起動してください"],
			"回退成功": ["Rollback succeeded", "ロールバック成功"],
			"回退被本地改动阻止": ["Rollback blocked by local changes", "ローカルの変更によりロールバックがブロックされました"],
			"如果某个对话正在改文件，这次写入可能只做了一半。能等的话，建议等它答完再更新。": ["If a turn is writing files, that write may be left half done. Wait for the answer to finish if you can.", "いずれかの会話がファイルを書き換えている場合、その書き込みが中途半端に終わる可能性があります。可能なら回答が終わるのを待ってから更新してください。"],
			"安装": ["Install", "インストール"],
			"安装依赖": ["Installing dependencies", "依存関係をインストール"],
			"完成，正在重启": ["Done, restarting", "完了、再起動中"],
			"完成，请手动重启": ["Done, restart manually", "完了、手動で再起動してください"],
			"官方": ["GitHub", "公式"],
			"已从 ": [" switched from ", " から "],
			"已安装插件的 peer 可能不接受此版本": ["Plugin peer ranges may not accept this version", "インストール済みプラグインの peer がこのバージョンを受け付けない可能性があります"],
			"已拒绝检出 {tag}": ["Refusing to check out {tag}", "{tag} のチェックアウトを拒否しました"],
			"已是最新版本": ["Already up to date", "すでに最新です"],
			"已有更新正在执行中": ["An update is already running", "すでに更新を実行中です"],
			"建议等对话答完再更新，内容不会丢；也可以强制更新，但会丢掉没答完的部分。": ["Wait for it to finish for a clean update, or force it and lose the unfinished part.", "会話が終わってから更新すれば内容は失われません。強制更新もできますが、未完了の部分は失われます。"],
			"开始更新": ["Start update", "更新を開始"],
			"强制更新": ["Force update", "強制更新"],
			"强制更新会立即重启 dsh。正在进行的 {n} 个对话会被当场中断：已生成的片段会留在会话记录里，但模型未完成的推理、以及仍在等待结果的工具调用会丢失。": ["Forcing the update restarts dsh immediately. The {n} running turn(s) will be cut off mid-answer: partial output stays in the session log, but the model's unfinished reasoning and any tool call still waiting on a result are lost.", "強制更新は dsh を即座に再起動します。実行中の {n} 件の会話はその場で中断されます。生成済みの断片はセッション記録に残りますが、モデルの未完了の推論と、結果待ちのツール呼び出しは失われます。"],
			"当前 commit：": ["Current commit: ", "現在の commit："],
			"当前有 {n} 个对话正在进行。更新会重启 dsh，正在生成的回答会被打断。": ["This machine has {n} turn(s) in progress. Updating restarts dsh, which cuts them off.", "現在 {n} 件の会話が実行中です。更新は dsh を再起動するため、生成中の回答は中断されます。"],
			"当前版本": ["the current version", "現在のバージョン"],
			"恢复": ["Restore", "復元"],
			"恢复本地改动": ["Restoring your local changes", "ローカルの変更を復元"],
			"或回退到历史版本": ["Or roll back to an older version", "または古いバージョンに戻す"],
			"选择更早的版本回退；与更新走同一套安全检查。": ["Pick an older version to roll back to; same safety checks as an update.", "古いバージョンを選んでロールバックします。更新と同じ安全チェックを通ります。"],
			"拉取": ["Fetch", "取得"],
			"拉取版本标签": ["Fetching version tags", "バージョンタグを取得"],
			"拉取远程版本标签": ["Fetching remote version tags", "リモートのバージョンタグを取得"],
			"插件 peerDependency 可能与 {tag} 不兼容": ["Peer dependencies may not match {tag}", "プラグインの peerDependency が {tag} と互換でない可能性があります"],
			"插件版本可能不兼容": ["Plugin version conflict", "プラグインのバージョンが非互換の可能性"],
			"新版本": ["the new version", "新しいバージョン"],
			"无法获取": ["Unavailable", "取得できません"],
			"无法获取更新内容，": ["Couldn't load release notes — ", "リリースノートを取得できませんでした："],
			"无法连接更新服务": ["Cannot reach the update service", "更新サービスに接続できません"],
			"旧版本": ["the old version", "古いバージョン"],
			"暂存": ["Stash", "一時退避"],
			"暂存本地改动": ["Stashing local changes", "ローカルの変更を一時退避"],
			"更新受阻": ["Update blocked", "更新がブロックされました"],
			"更新失败": ["Update failed", "更新失敗"],
			"更新失败，重试": ["Update failed, retry", "更新失敗、再試行"],
			"更新完成": ["Update complete", "更新完了"],
			"更新完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。": ["Update complete. Click “Restart DSH” to apply immediately, or restart dsh web later.", "更新完了。「DSH を再起動」を押すとすぐ反映されます。後で dsh web を手動で再起動してもかまいません。"],
			"更新完成，即将自动重启 dsh（": ["Update complete — restarting dsh automatically (", "更新完了。まもなく dsh を自動で再起動します（"],
			"更新已移交独立后台进程执行（运行中的 dsh 占用文件句柄，无法在本进程内完成安装）。本页面即将断开。安装/构建后会重启 dsh 并检查启动日志——若出现 did not activate / Failed to load plugins，会自动回到上一版本。请稍后重新打开面板查看结果。": ["The update was handed off to a detached background process (an in-process install would fail while the running dsh holds file locks). This page will disconnect shortly. After install/build, dsh restarts and the boot log is checked — “did not activate” / “Failed to load plugins” rolls back to the previous version. Reopen this panel to see the result.", "更新は独立したバックグラウンドプロセスに引き継がれました（実行中の dsh がファイルをロックしているため、このプロセス内ではインストールできません）。まもなくこのページは切断されます。インストール/ビルド後に dsh を再起動して起動ログを確認し、did not activate / Failed to load plugins があれば自動で前のバージョンに戻します。しばらくしてパネルを開き直すと結果を確認できます。"],
			"更新已转入后台执行": ["Update handed off", "更新をバックグラウンドへ引き継ぎ"],
			"更新成功": ["Update succeeded", "更新成功"],
			"更新目录：": ["Update directory: ", "更新ディレクトリ："],
			"更新被本地改动阻止": ["Update blocked by local changes", "ローカルの変更により更新がブロックされました"],
			"最新": ["the latest", "最新"],
			"有对话正在进行": ["Turns in progress", "会話が実行中です"],
			"有新版本": ["Update available", "新しいバージョンあり"],
			"有更新": ["Update available", "更新あり"],
			"未知": ["Unknown", "不明"],
			"未知错误": ["Unknown error", "不明なエラー"],
			"本地代理端口": ["Local proxy port", "ローカルプロキシポート"],
			"本地已是 ": ["Local is already ", "ローカルはすでに "],
			"本地改动与新版本冲突，已安全保存在 git stash（未丢失），可在仓库目录手动执行 git stash apply 处理。": ["Your local changes conflict with the new version. They are safely kept in git stash (nothing lost); run git stash apply in the repo to handle them.", "ローカルの変更が新しいバージョンと競合しました。git stash に安全に保存されています（失われていません）。リポジトリで git stash apply を実行して処理してください。"],
			"本地版本：": ["Local: ", "ローカル："],
			"本机代理": ["local proxy", "ローカルプロキシ"],
			"本次更新内容（": ["What's new in ", "今回の更新内容（"],
			"本次更新暂无内容说明。": ["No release notes for this version.", "このバージョンの更新内容はありません。"],
			"本次未自动重启，因此没有检查启动日志。若页面出现 Failed to load plugins / did not activate，请回退到上一版本。": ["Auto-restart is off, so the web UI boot was not checked. If the page shows “Failed to load plugins” / “did not activate”, roll back to the previous tag.", "自動再起動が無効のため、起動ログは確認していません。ページに Failed to load plugins / did not activate が出た場合は前のバージョンにロールバックしてください。"],
			"构建": ["Build", "ビルド"],
			"构建完成": ["Build finished", "ビルド完了"],
			"构建完成，正在检查 Web UI 是否正常启动": ["Build finished — checking the web UI boot", "ビルド完了。Web UI が正常に起動するか確認中"],
			"查看 GitHub Releases →": ["see GitHub Releases →", "GitHub Releases を見る →"],
			"查看官方发布说明 ↗": ["View official release notes ↗", "公式リリースノートを見る ↗"],
			"点击查看实时进度": ["Click to view live progress", "クリックで進捗を表示"],
			"查看本次更新日志（": ["View this update's log (", "今回の更新ログを見る（"],
			"校验": ["Verify", "検証"],
			"校验目标版本": ["Verifying the target tag", "対象バージョンを検証"],
			"检查": ["Check", "確認"],
			"检查异常：": ["Check error: ", "確認エラー："],
			"这个目录不是 git 仓库，无法检查更新。": ["That directory is not a git checkout, so updates cannot be checked.", "このディレクトリは git リポジトリではないため、更新を確認できません。"],
			"检查必需路径": ["Checking required paths", "必須パスを確認"],
			"检查更新": ["Check for updates", "更新を確認"],
			"检查间隔": ["Check interval", "確認間隔"],
			"检测到新版本 ": ["New version detected: ", "新しいバージョンを検出: "],
			"正在回退到 ": ["Rolling back to ", "ロールバック中: "],
			"正在检查启动是否健康": ["Checking that the web UI boots", "起動が正常か確認中"],
			"正在检查版本…": ["Checking for updates…", "バージョンを確認中…"],
			"正在获取更新内容…": ["Loading release notes…", "更新内容を取得中…"],
			"正在重启 DeepSeek Harness… 页面会短暂断开，新进程就绪后刷新即可。": ["Restarting DeepSeek Harness… the page will disconnect briefly; refresh once it is back.", "DeepSeek Harness を再起動中… ページは一時的に切断されます。新しいプロセスが起動したら再読み込みしてください。"],
			"此版本会损坏 Web UI": ["This tag would break the web UI", "このバージョンは Web UI を壊す可能性があります"],
			"每 {n} 小时": ["every {n}h", "{n} 時間ごと"],
			"清理": ["Clean", "整理"],
			"清理旧构建产物": ["Cleaning stale build output", "古いビルド成果物を整理"],
			"留空 = 直连，不走代理": ["blank = direct connection", "空欄 = 直接接続（プロキシ不使用）"],
			"目标版本": ["the target version", "対象バージョン"],
			"确定要强制更新吗？": ["Update anyway?", "本当に強制更新しますか？"],
			"确定，立即更新": ["Yes, update now", "はい、今すぐ更新"],
			"稍后再来": ["Wait", "後で"],
			"立即重启": ["Restart now", "今すぐ再起動"],
			"站点": ["Site", "サイト"],
			"端口": ["Port", "ポート"],
			"约 2 秒后": ["in a few seconds", "約 2 秒後"],
			"经镜像获取": ["fetched via mirror", "ミラー経由で取得"],
			"网络": ["Network", "ネットワーク"],
			"自动": ["Auto", "自動"],
			"自动暂存并继续回退": ["Stash automatically and continue", "自動で退避して続行"],
			"自动暂存并继续更新": ["Stash automatically and continue", "自動で退避して続行"],
			"自动检查": ["Auto check", "自動確認"],
			"自动检查更新": ["Check for updates automatically", "自動で更新を確認"],
			"请等待当前更新完成后再试。": ["Wait for the running update to finish, then try again.", "実行中の更新が完了してから、もう一度お試しください。"],
			"与更新服务的连接中断了（可能被构建过程打断）。请稍后重新检查版本状态。": ["The connection to the update service dropped (the build may have interrupted it). Check the version status again in a moment.", "更新サービスとの接続が切れました（ビルドに中断された可能性があります）。しばらくしてから再度バージョンを確認してください。"],
			"远程版本：": ["Remote: ", "リモート："],
			"重启DSH": ["Restart DSH", "DSH を再起動"],
			"重启失败": ["Restart failed", "再起動失敗"],
			"重启失败，请手动重启 dsh web。": ["Restart failed — please restart dsh web manually.", "再起動に失敗しました。dsh web を手動で再起動してください。"],
			"重新构建": ["Rebuilding", "再ビルド"],
			"重新检查": ["Re-check", "再確認"],
			"重试": ["Retry", "再試行"],
			"镜像": ["Mirror", "ミラー"],
			"镜像站点": ["Mirror site", "ミラーサイト"],
			"（无法解析具体文件）": ["(could not parse the file list)", "（具体的なファイルを解析できません）"],
			"）": ["", "）"],
			"）…页面会短暂变空白，重启完成后会自动刷新，无需手动操作。": [")… the page goes blank briefly; it reloads itself once the restart finishes, no manual refresh needed.", "）…ページは一時的に真っ白になります。再起動が終われば自動で再読み込みします（手動操作は不要）。"],
			"，与本次更新目标一致。": [", matching this update's target.", "。今回の更新対象と一致しています。"],
			"，但未做启动健康检查（当时未自动重启）。": [" but did not verify the web UI boot (auto-restart was off).", "。ただし起動チェックは行っていません（当時、自動再起動は無効でした）。"],
			"，无需更新。": [", no update needed.", "。更新は不要です。"],
			"，正在更新…": [" — updating…", "。更新中…"],
			"：": [": ", "："],
			"准备中": ["Preparing", "準備中"],
			"拉取中": ["Fetching", "取得中"],
			"校验中": ["Verifying", "検証中"],
			"检查中": ["Checking", "チェック中"],
			"暂存中": ["Stashing", "退避中"],
			"切换中": ["Switching", "切り替え中"],
			"安装中": ["Installing", "インストール中"],
			"清理中": ["Cleaning", "クリーン中"],
			"构建中": ["Building", "ビルド中"],
			"恢复中": ["Restoring", "復元中"],
			"正在更新…": ["Updating…", "更新中…"],
			"正在回退…": ["Rolling back…", "ロールバック中…"],
			"更新时页面会短暂空白": ["The page goes blank briefly while updating", "更新中はページが一時的に真っ白になります"],
			"浅色主题下是白屏，深色主题下是黑屏。构建替换网页资源时的正常现象，不是报错；完成后会自动重启并刷新页面，不用手动操作。": ["White in a light theme, black in a dark one. That is the build replacing the web assets, not an error; dsh restarts and the page reloads itself afterwards, nothing to do by hand.", "ライトテーマでは白、ダークテーマでは黒になります。ビルドが Web アセットを差し替えている間の正常な動作で、エラーではありません。完了後は自動で再起動し、ページも自動で再読み込みされます（手動操作は不要）。"],
		};

		/** 当前界面语言：'zh' | 'en' | 'ja'。 */
		function lang() {
			return currentLang();
		}

		/** 取当前语言的文案。未知 key 原样返回（不会因为漏翻译就丢内容）。 */
		function tr(key) {
			const k = String(key);
			const l = currentLang();
			if (l === "zh") return k;
			const entry = MESSAGES[k];
			if (entry === undefined) return k;
			const value = l === "ja" ? entry[1] : entry[0];
			return typeof value === "string" && value !== "" ? value : (l === "ja" ? entry[0] : k);
		}

		/** 本插件是否真的为这个语言提供了翻译（用于「仅中日英」的回落判断）。 */
		function hasTranslation(l) {
			return SUPPORTED_LANGS.includes(l);
		}

		/** Re-render when DSH switches language (subscribe to the LocaleRuntime).
		 *  注意:依赖数组只能含 localeFace,绝不能含 tick——effect 体内每次都 setTick,
		 *  若把 tick 放进 deps,每次重渲染都会让 effect 重跑 → 再 setTick → 无限重渲染循环
		 *  (React 反复提交,CPU 空转)。localeFace 变化(晚捕获)时 effect 才重跑补订阅。 */
		const localeReadyListeners = new Set();

		function useLocale() {
			const [tick, setTick] = useState(0);
			useEffect(() => {
				const bump = () => setTick((n) => n + 1);
				const cleanups = [];
				localeReadyListeners.add(bump);
				cleanups.push(() => { localeReadyListeners.delete(bump); });
				// 首选：LocaleRuntime 的 subscribe（语言切换会通知）。
				if (localeFace && typeof localeFace.subscribe === "function") {
					cleanups.push(localeFace.subscribe(bump));
				}
				// 兜底：DSH 切语言时会把 <html lang> 改掉，盯这个属性就够了。
				// 没有它，一旦 subscribe 没挂上（locale 晚到、或换了实现），界面就再也不更新。
				try {
					if (typeof MutationObserver === "function" && typeof document !== "undefined") {
						const mo = new MutationObserver(bump);
						mo.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
						cleanups.push(() => mo.disconnect());
					}
				} catch {}
				bump();
				return () => { for (const off of cleanups) { try { off(); } catch {} } };
			}, [localeFace]);
		}

		// ---------- wire helpers ----------
		async function fetchStatus(net) {
			// net: { source, mirror, proxyPort } —— 换来源后立刻按新网络重查。
			let url = "/api/dsh-update/status";
			if (net && net.source && net.source !== "auto") {
				const q = ["source=" + encodeURIComponent(net.source)];
				if (net.source === "mirror" && net.mirror) q.push("mirror=" + encodeURIComponent(net.mirror));
				if (net.source === "github" && net.proxyPort) q.push("proxyPort=" + encodeURIComponent(String(net.proxyPort)));
				url += "?" + q.join("&");
			}
			const res = await fetch(url);
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}

		/**
		 * Fetch release notes for a tag. Resolves { state: 'ok', body, htmlUrl },
		 * { state: 'loading' } is set by the caller, or { state: 'error' }.
		 */
		async function fetchReleaseNotes(tag, net) {
			try {
				const q = ["tag=" + encodeURIComponent(tag)];
				if (net && net.source && net.source !== "auto") {
					q.push("source=" + encodeURIComponent(net.source));
					if (net.source === "mirror" && net.mirror) q.push("mirror=" + encodeURIComponent(net.mirror));
					if (net.source === "github" && net.proxyPort) q.push("proxyPort=" + encodeURIComponent(String(net.proxyPort)));
				}
				const res = await fetch("/api/dsh-update/release-notes?" + q.join("&"));
				if (!res.ok) throw new Error("HTTP " + String(res.status));
				const data = await res.json();
				if (data && data.ok && typeof data.body === "string") {
					return { state: "ok", body: data.body, htmlUrl: data.htmlUrl };
				}
				return { state: "error" };
			} catch {
				return { state: "error" };
			}
		}

		/**
		 * POST the update run and stream JSON-lines to onEvent.
		 * Resolves when the stream ends.
		 */
		async function runUpdate(onEvent, opts) {
			const payload = {};
			if (opts && opts.stash) payload.stash = true;
			if (opts && opts.targetTag) payload.targetTag = opts.targetTag;
			if (opts && opts.allowMissingRequiredPaths) payload.allowMissingRequiredPaths = true;
			if (opts && opts.confirmPeerConflicts) payload.confirmPeerConflicts = true;
			// 网络来源：让执行阶段也走用户选的链路（镜像 / 官方 + 本地代理端口）。
			if (opts && opts.source && opts.source !== "auto") payload.source = opts.source;
			if (opts && opts.source === "mirror" && opts.mirror) payload.mirror = opts.mirror;
			if (opts && opts.source === "github" && opts.proxyPort) payload.proxyPort = opts.proxyPort;
			// 用户已确认强制更新：服务端只用于日志标注，不改变执行流程。
			if (opts && opts.force === true) payload.force = true;
			const body = JSON.stringify(payload);
			const res = await fetch("/api/dsh-update/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			if (!res.ok || !res.body) {
				// Attach the status code and any JSON detail so the caller can
				// distinguish "another run is in progress" (409) from real failures.
				let detail = "";
				try { detail = await res.text(); } catch {}
				const error = new Error("HTTP " + String(res.status) + (detail !== "" ? ": " + detail : ""));
				error.status = res.status;
				throw error;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line === "") continue;
					let evt;
					try { evt = JSON.parse(line); } catch { continue; }
					onEvent(evt);
				}
			}
			if (buffer.trim() !== "") {
				try { onEvent(JSON.parse(buffer.trim())); } catch {}
			}
		}

		// ---------- panel view state machine ----------
		// view: { kind: 'checking' } | { kind: 'result', status } |
		//       { kind: 'available', status, notes } | { kind: 'updating', status, lines } |
		//       { kind: 'done', result } | { kind: 'error', message } | { kind: 'conflict' } |
		//       { kind: 'tag-health', health } | { kind: 'peers', peers }

		/** Strip HTML tags and light markdown markers from a release-note line.
		 *  `[文字](链接)` 只保留文字（否则会露出裸 Markdown 语法）。 */
		function cleanNoteLine(text) {
			return String(text)
				.replace(/<[^>]*>/g, "")
				.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
				.replace(/\*\*/g, "")
				.replace(/`/g, "");
		}

		/**
		 * Render the release body (GitHub markdown-ish) as lightweight
		 * elements: <h3> section headings, `* ` bullets, plain lines. The body
		 * carries both languages separated by a `---` line (Chinese first);
		 * the section matching the current UI language is rendered. When the
		 * body has only one language, that one is used.
		 * notes: { state: 'loading' } | { state: 'error' } | { state: 'ok', body }.
		 */
		/** 比较两个 dsh-v* tag 的新旧：>0 表示 a 比 b 新，0 相同，<0 更旧。
		 *  只做前端展示用（决定按钮写「更新」还是「回退」），不参与任何校验。 */
		function compareTagTo(a, b) {
			const parse = (t) => {
				const m = /^dsh-v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(t || ""));
				if (!m) return null;
				return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" };
			};
			const x = parse(a); const y = parse(b);
			if (!x || !y) return 0;
			for (let i = 0; i < 3; i++) {
				if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
			}
			// 同版本号：无 prerelease 的正式版比带 prerelease 的新。
			if (x.pre === y.pre) return 0;
			if (x.pre === "") return 1;
			if (y.pre === "") return -1;
			const pa = x.pre.split(".");
			const pb = y.pre.split(".");
			for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
				const ra = pa[i];
				const rb = pb[i];
				if (ra === undefined) return -1;
				if (rb === undefined) return 1;
				if (ra === rb) continue;
				const numericA = /^\d+$/.test(ra);
				const numericB = /^\d+$/.test(rb);
				if (numericA && numericB) return Number(ra) < Number(rb) ? -1 : 1;
				if (numericA) return -1;
				if (numericB) return 1;
				return ra < rb ? -1 : 1;
			}
			return 0;
		}
		function renderReleaseNotes(h, T, notes) {
			if (!notes || notes.state === "loading") {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					tr("正在获取更新内容…"));
			}
			if (notes.state === "error") {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					tr("无法获取更新内容，"),
					h("a", { href: "https://github.com/deepseek-ai/deepseek-harness/releases", target: "_blank", rel: "noreferrer", style: { color: T.brand } },
						tr("查看 GitHub Releases →")));
			}
			const body = String(notes.body || "");
			// Split at the first zh/en separator line; the header line
			// `[中文]… | [English]…` lives in the first (zh) part only.
			const parts = body.split(/\r?\n---\r?\n/);
			// 发布说明只有中文段和英文段：非中文界面（en / ja）都用英文段。
			const selected = (lang() !== "zh" && parts.length > 1 ? parts[1] : parts[0]) || "";
			const lines = selected.split(/\r?\n/);
			const out = [];
			let started = false;
			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") continue;
				if (line.startsWith("---")) break; // extra separator — stop
				if (line.startsWith("[")) continue; // language-switch header line
				started = true;
				// 小标题：GitHub Releases API 返回的 body 是 Markdown 源码，
				// 实际写作既可能是 `### 标题` 也可能是 `<h3>标题</h3>`——两种都要认，
				// 否则 Markdown 写法会原样显示成「### xxx」。
				const heading = /^<h[1-6][^>]*>(.*?)<\/h[1-6]>$/.exec(line) || /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading !== null) {
					const headingText = heading[2] !== undefined ? heading[2] : heading[1];
					out.push(h("p", { key: out.length, style: { margin: "10px 0 2px", fontWeight: 700, fontSize: 13, color: T.label } },
						cleanNoteLine(headingText)));
					continue;
				}
				// 列表项：`* / -` 无序 与 `1.` 有序，统一渲染为圆点。
				const bullet = /^(?:[*\-]|\d+[.)])\s+(.*)$/.exec(line);
				if (bullet !== null) {
					out.push(h("p", { key: out.length, style: { margin: "2px 0", fontSize: 12.5, color: T.secondary, lineHeight: 1.6 } },
						"• " + cleanNoteLine(bullet[1])));
					continue;
				}
				out.push(h("p", { key: out.length, style: { margin: "2px 0", fontSize: 12.5, color: T.secondary, lineHeight: 1.6 } },
					cleanNoteLine(line)));
			}
			if (!started) {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					tr("本次更新暂无内容说明。"));
			}
			return h("div", { style: { margin: "10px 0 0", padding: "10px 12px", borderRadius: 10, background: T.layer1, maxHeight: 240, overflow: "auto" } },
				...out);
		}

		// 内置镜像清单（与服务端 MIRROR_CHOICES 一致）：首屏还在检查、status 未回来时
		// 也要能显示选择器，否则网络差时用户根本没有切换入口。
		const FALLBACK_MIRRORS = [
			{ id: "gh-proxy", label: "gh-proxy.com" },
			{ id: "ghproxy-net", label: "ghproxy.net" },
			{ id: "ghfast", label: "ghfast.top" },
		];
		/**
 * 执行中的进度条是「不确定式」的：服务端只给出当前阶段、总时长不可知，所以不显示百分比——
 * 让一条色带从左往右跑、出右边再从左边进来，循环往复，用户看到「还在动」就够了。
 * keyframes 只能写在样式表里（内联 animation 引用不到动画名），这里注入一次到 head，
 * 用固定 id 去重，热重载或多次挂载都不会重复插入。
 */
const PROGRESS_ANIM_ID = 'dsh-update-progress-anim';
function ensureProgressAnim() {
	try {
		if (document.getElementById(PROGRESS_ANIM_ID) !== null) return;
		const style = document.createElement('style');
		style.id = PROGRESS_ANIM_ID;
		style.textContent = '@keyframes dshUpdateSweep{0%{left:-45%}100%{left:100%}}';
		document.head.appendChild(style);
	} catch { /* 没有 document 时静默降级为静态色带 */ }
}

/** 浮层内的细分隔线：让「头部 / 网络 / 内容 / 操作」四段看起来是分开的。 */
		const POP_DIVIDER = { height: 1, background: T.border, opacity: 0.6, margin: "1px 0" };
		/**
		 * 重启探活：等新进程真正起来再刷新页面，而不是立刻 reload。
		 *
		 * 立刻 location.reload() 会撞上旧进程已退出、新进程还没绑端口的空窗期，
		 * 浏览器只能显示「无法访问此网站」——这就是用户说的白屏。
		 * dsh-market 的做法是记住 boot id、轮询 /status 直到 boot 变化再 reload，
		 * 这里用同样思路，但走更轻的 /ping（不读 git、不扫 profile）。
		 *
		 * 未配置自动重启时不轮询：那种情况下进程不会自己起来，轮询只会白等。
		 */
		async function armRestartWatch(windowMs) {
			if (reloadWatchActive && readPendingReload() !== null) return;
			// 先抓住当前 boot id：没有它就无法区分「旧进程还在」和「新进程已起」。
			let before;
			let pendingBoot;
			try {
				const res = await fetch("/api/dsh-update/ping", { cache: "no-store" });
				if (!res.ok) throw new Error("HTTP " + String(res.status));
				const body = await res.json();
				before = body.boot;
			} catch {
				// 连旧进程都摸不到：可能重启已经开始，直接进入轮询。
				before = undefined;
			}

			// 默认 90 秒（进程内更新）；后台分离模式 install+build 远超此值，
			// 由 done.restartWindowMs 传入更长的窗口。
			const deadline = Date.now() + (typeof windowMs === "number" && windowMs > 0 ? windowMs : 90_000);
			const poll = () => {
				if (Date.now() > deadline) return; // 超时不刷新：留给用户手动处理，别把人锁在死循环里
				fetch("/api/dsh-update/ping", { cache: "no-store" })
					.then((res) => {
						if (!res.ok) throw new Error("HTTP " + String(res.status));
						return res.json();
					})
					.then((body) => {
						// 初始 /ping 失败（重启可能已经开始）：不能把「第一次见到的 boot」
						// 直接当成旧进程的基准——那可能已经是新进程，之后永不变化、也就永不刷新。
						// 改用「连续两次看到同一个 boot」作为稳定基准；拿到基准后的下一次变化才 reload。
						if (before === undefined) {
							if (typeof body.boot === "string") {
								if (pendingBoot === undefined) pendingBoot = body.boot;
								else if (pendingBoot === body.boot) before = body.boot;
							}
							setTimeout(poll, 600);
							return;
						}
						if (typeof body.boot === "string" && body.boot !== before) {
							window.location.reload();
							return;
						}
						setTimeout(poll, 600);
					})
					.catch(() => { setTimeout(poll, 600); }); // 空窗期连不上是正常的
			};
			setTimeout(poll, 250);
		}
		// ---------- 更新前的「有对话在进行」确认 ----------
		// 只在 status.busySessions > 0 时出现：更新会重启 dsh，正在跑的对话会被打断。
		// 两步确认（先提示再确认强制），避免手滑把工作进行中的对话搞丢。
		function BusyDialog({ busy, stage, onLater, onForce, onConfirmForce, width, anchor }) {
			const h = React.createElement;
			useLocale();
			const box = {
				// fixed + portal：脱离侧栏 overflow 裁剪，侧栏折叠/很窄时也能完整展开。
				position: "fixed", zIndex: 1400,
				...popoverAnchor(anchor),
				width: width || "min(340px, calc(100vw - 32px))",
				boxSizing: "border-box", padding: 16, borderRadius: 14,
				display: "flex", flexDirection: "column", gap: 10,
				background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border,
				color: T.label, boxShadow: "0 10px 28px rgba(0,0,0,.28)", textAlign: "left", fontSize: 13,
			};
			const confirming = stage === "confirm";

			return h("div", { style: box, role: "dialog", "aria-label": tr("有对话正在进行"), "data-dsh-update-pop": "1" },
				h("div", { style: { display: "flex", alignItems: "flex-start", gap: 10 } },
					h("span", { style: { fontSize: 15, lineHeight: "18px" } }, "⚠"),
					h("strong", { style: { fontSize: 14, fontWeight: 600, flex: 1, lineHeight: 1.4 } },
						confirming
							? (tr("确定要强制更新吗？"))
							: (tr("有对话正在进行"))),
					h("button", {
						type: "button",
						onClick: onLater,
						"aria-label": tr("关闭"),
						style: { appearance: "none", border: "none", background: "transparent", color: T.secondary, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 2px" },
					}, "✕")),

				confirming
					? h(React.Fragment, null,
						h("p", { style: { margin: 0, fontSize: 12.5, color: T.secondary, lineHeight: 1.65 } },
							tr("强制更新会立即重启 dsh。正在进行的 {n} 个对话会被当场中断：已生成的片段会留在会话记录里，但模型未完成的推理、以及仍在等待结果的工具调用会丢失。").replace("{n}", String(busy))),
						h("p", { style: { margin: 0, fontSize: 12.5, color: T.warn, lineHeight: 1.65 } },
							tr("如果某个对话正在改文件，这次写入可能只做了一半。能等的话，建议等它答完再更新。")),
						h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 } },
							h("button", { type: "button", style: actionBtnStyle(T), onClick: onLater },
								tr("稍后再来")),
							h("button", {
								type: "button",
								style: { ...actionBtnStyle(T), background: T.danger, color: "#fff", borderColor: T.danger, fontWeight: 600 },
								onClick: onConfirmForce,
							}, tr("确定，立即更新"))))
					: h(React.Fragment, null,
						h("p", { style: { margin: 0, fontSize: 12.5, color: T.secondary, lineHeight: 1.65 } },
							tr("当前有 {n} 个对话正在进行。更新会重启 dsh，正在生成的回答会被打断。").replace("{n}", String(busy))),
						h("p", { style: { margin: 0, fontSize: 12.5, color: T.secondary, lineHeight: 1.65 } },
							tr("建议等对话答完再更新，内容不会丢；也可以强制更新，但会丢掉没答完的部分。")),
						h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 } },
							h("button", { type: "button", style: actionBtnStyle(T), onClick: onLater },
								tr("稍后再来")),
							h("button", {
								type: "button",
								style: { ...actionBtnStyle(T), background: "transparent", color: T.danger, borderColor: T.danger, fontWeight: 600 },
								onClick: onForce,
							}, tr("强制更新")))),
			);
		}
		/** 浮层宽度：跟随 footer，但不小于 200、不超过 340，且不超出视口。
		 *  这样窄侧栏里不会溢出到聊天区，宽侧栏里也不会被拉得过长。 */
		/** 浮层定位：贴住按钮上方，且不超出视口。返回 position:fixed 所需的 top/left/maxW。 */
function popoverAnchor(anchor) {
  const gap = 8;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  if (!anchor) return { left: 8, bottom: 80 };
  // 左边界对齐按钮，但不超出视口右侧。
  const left = Math.max(8, Math.min(anchor.left, vw - 348));
  // 浮层在按钮上方：距视口底部 = 视口高 - 按钮顶 + 间距。
  const bottom = Math.max(8, (window.innerHeight || 800) - anchor.top + gap);
  return { left, bottom };
}

/** 浮层宽度：固定 340，仅受视口限制。
 *  浮层已 portal 到 body + position:fixed，可以越过侧栏边界——侧栏折叠成
 *  56px 窄条时，用侧栏宽度算会把它压成竖条，所以这里不再参考 footer。 */
function popoverWidth() {
			return "min(340px, calc(100vw - 32px))";
		}
		// ---------- 自动检查更新 ----------
		// 偏好存在浏览器本地（每台机器/每个浏览器各自决定），不写 profile 配置：
		// 这样改开关不会触发 host 重启，也不会污染用户的 cordis 配置。
		const AUTO_KEY = "dsh-update:auto-check";
		const AUTO_HOURS = [1, 6, 12, 24];
		const AUTO_DEFAULT = { enabled: true, hours: 6 };

		function readAutoCheck() {
			try {
				const raw = window.localStorage.getItem(AUTO_KEY);
				if (raw === null) return { ...AUTO_DEFAULT };
				const parsed = JSON.parse(raw);
				const hours = AUTO_HOURS.includes(parsed && parsed.hours) ? parsed.hours : AUTO_DEFAULT.hours;
				return { enabled: parsed && parsed.enabled !== false, hours };
			} catch {
				return { ...AUTO_DEFAULT };
			}
		}

		function writeAutoCheck(value) {
			try { window.localStorage.setItem(AUTO_KEY, JSON.stringify(value)); } catch { /* 隐私模式写不进去：本次会话仍生效 */ }
		}

		// 网络来源偏好同样存在浏览器本地：用户选过「官方 + 端口 7890」或某个镜像后，
		// 下次打开面板应记住，而不是每次都回到「自动」。校验字段防止旧值/脏数据污染。
		const NET_KEY = "dsh-update:net";
		function readNet() {
			try {
				const raw = window.localStorage.getItem(NET_KEY);
				if (raw === null) return { source: "auto" };
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed.source !== "string") return { source: "auto" };
				if (parsed.source === "auto") return { source: "auto" };
				if (parsed.source === "github") {
					const p = Number(parsed.proxyPort);
					return Number.isInteger(p) && p >= 1 && p <= 65535
						? { source: "github", proxyPort: p }
						: { source: "github" };
				}
				if (parsed.source === "mirror" && typeof parsed.mirror === "string" && parsed.mirror !== "") {
					return { source: "mirror", mirror: parsed.mirror };
				}
				return { source: "auto" };
			} catch {
				return { source: "auto" };
			}
		}

		function writeNet(value) {
			try { window.localStorage.setItem(NET_KEY, JSON.stringify(value)); } catch { /* 隐私模式写不进去：本次会话仍生效 */ }
		}

		// ---- 重启后自动刷新：不依赖 SSE ----------------------------------------
		// 背景：更新/回退在 build 阶段替换网页资源，页面变空白时 SSE 可能断开，
		// 客户端收不到 done 事件，armRestartWatch 就永远不会被调用，于是不会自动刷新。
		// 方案：发起任务时把「当前 boot id + 目标版本」写进 localStorage；页面（重新）加载时
		// 读这个标记，轮询 /ping 直到 boot 变化（说明新进程已接管），再自动 reload。
		// 这样即使 SSE 断了，只要页面脚本恢复，就能补上自动刷新。
		/**
		 * boot 标识的前半段是进程启动时刻的 Date.now()（base36）——服务端用
		 * ${Date.now().toString(36)}-${随机串} 生成。有了它就能判断「这个进程是先于
		 * 本页面启动的」还是「本页面就是它拉起来的」，而这恰好是决定要不要刷新的关键。
		 * 解析不出来（格式变了）就返回 null，调用方回退到观察式判断。
		 */
		function bootStartedAt(boot) {
			if (typeof boot !== "string") return null;
			const at = parseInt(boot.split("-")[0], 36);
			return Number.isFinite(at) && at > 0 ? at : null;
		}

		const RELOAD_KEY = "dsh-update:pending-reload";
		const RELOAD_MAX_MS = 10 * 60 * 1000; // 最长等 10 分钟，避免标记永久卡住

		function markPendingReload(boot, target) {
			try {
				window.localStorage.setItem(RELOAD_KEY, JSON.stringify({
					boot: typeof boot === "string" ? boot : "",
					target: typeof target === "string" ? target : "",
					at: Date.now(),
				}));
			} catch { /* 隐私模式写不进去：仅有依赖 SSE 的路径可用 */ }
		}

		function clearPendingReload() {
			try { window.localStorage.removeItem(RELOAD_KEY); } catch {}
		}

		function readPendingReload() {
			try {
				const raw = window.localStorage.getItem(RELOAD_KEY);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed.boot !== "string" || typeof parsed.at !== "number") return null;
				if (Date.now() - parsed.at > RELOAD_MAX_MS) { clearPendingReload(); return null; }
				return parsed;
			} catch {
				clearPendingReload();
				return null;
			}
		}

		/** 页面加载时 / 写标记后调用：若有待刷新标记，轮询 /ping 直到 boot 变化再 reload。
		 *  与 SSE 完全独立，SSE 断了也能补上刷新。幂等：同时只跑一个轮询循环。 */
		let reloadWatchActive = false;
		function watchPendingReload() {
			if (reloadWatchActive) return;
			const pending = readPendingReload();
			if (pending === null) return;
			reloadWatchActive = true;
			const lastBoot = pending.boot;
			let settled = false;
			// 本页是否已经成功观测过一次 boot，作为时间戳判断不可用时的兜底。
			// 供参考的失败形态：本次页面加载本身就落在新进程上（用户刚手动刷过、或上一次
			// 自动刷新已生效），却因为「boot 与标记不同」又 reload 一次——用户看到的就是
			// 「手动刷新完，过一会儿它又自己刷了」。真正的接管一定发生在本页已经观测到
			// 旧 boot 之后，所以只有那之后的变化才值得 reload。
			let observed = false;
			const deadline = Date.now() + RELOAD_MAX_MS;
			const poll = async () => {
				if (readPendingReload() === null) { settled = true; reloadWatchActive = false; return; }
				if (settled) return;
				if (Date.now() > deadline) { clearPendingReload(); reloadWatchActive = false; return; }
				let boot;
				try {
					const res = await fetch("/api/dsh-update/ping", { cache: "no-store" });
					if (!res.ok) throw new Error("HTTP " + String(res.status));
					const body = await res.json();
					boot = body && body.boot;
				} catch {
					// 重启空窗期连不上是正常的：这不代表已经换了进程，下一轮再看。
					window.setTimeout(poll, 600);
					return;
				}
				if (readPendingReload() === null) { settled = true; reloadWatchActive = false; return; }
				if (typeof boot === "string" && boot !== lastBoot) {
					settled = true;
					clearPendingReload();
					reloadWatchActive = false;
					// 新进程确实已经接管，但「本页需不需要刷新」还要再判断一次：
					// 若该进程的启动时刻早于本页面的加载时刻，说明本页本来就是它服务的
					// （用户已经手动刷新过，或上一次自动刷新已生效）——再刷一次只会让用户
					// 看到「刚刷新完，过一会儿它又自己刷了」。
					// 时间戳取不到时，回退到「本页是否已经观测过旧 boot」。
					const processStartedAt = bootStartedAt(boot);
					const pageLoadedAt = (window.performance && window.performance.timeOrigin) || 0;
					const stale = processStartedAt !== null && pageLoadedAt > 0
						? processStartedAt > pageLoadedAt
						: observed;
					if (stale) window.location.reload();
					return;
				}
				if (typeof boot === "string") observed = true;
				window.setTimeout(poll, 600);
			};
			window.setTimeout(poll, 250);
		}

		/** 静默检查：先按用户选择，失败后逐个换镜像重试。启动检查和定时检查都走这里。
		 *  只有「拿到 ok 且 outdated」才算发现更新；全都失败就静默放弃，不打扰用户。 */
		async function silentCheck(preferred) {
			const attempts = [];
			const first = preferred && preferred.source ? preferred : { source: "auto" };
			attempts.push(first);
			// 首选失败时的备选：把所有镜像按顺序再试一遍（去重，跳过已试过的）。
			for (const m of FALLBACK_MIRRORS) {
				if (first.source === "mirror" && first.mirror === m.id) continue;
				attempts.push({ source: "mirror", mirror: m.id });
			}
			for (const net of attempts) {
				try {
					const status = await fetchStatus(net);
					if (status && status.ok === true) return { status, net };
				} catch { /* 换下一个 */ }
			}
			return null;
		}

		/**
		 * 页面中断提示：「更新过程中页面会变空白」这件事必须说在明处，
		 * 否则用户看到整屏空白第一反应就是「装坏了」。
		 * 措辞不能只说「白屏」：深色主题下那是黑屏，浅色才是白屏。
		 */
		function BlindHint({ h, T }) {
			return h("div", {
				"data-dsh-update": "blind-hint",
				style: {
					display: "flex", alignItems: "flex-start", gap: 8,
					margin: "12px 0 0", padding: "9px 11px", borderRadius: 10,
					border: "1px solid color-mix(in srgb, " + T.warn + " 45%, transparent)",
					background: "color-mix(in srgb, " + T.warn + " 10%, transparent)",
				},
			},
				h("span", { "aria-hidden": "true", style: { fontSize: 13, lineHeight: "18px", flex: "none" } }, "⚠"),
				h("div", { style: { minWidth: 0 } },
					h("p", { style: { margin: 0, fontSize: 12, fontWeight: 600, color: T.label, lineHeight: 1.5 } },
						tr("更新时页面会短暂空白")),
					h("p", { style: { margin: "3px 0 0", fontSize: 11.5, color: T.secondary, lineHeight: 1.6 } },
						tr("浅色主题下是白屏，深色主题下是黑屏。构建替换网页资源时的正常现象，不是报错；完成后会自动重启并刷新页面，不用手动操作。"))));
		}

/** 面板里的「自动检查更新」一行：开关 + 间隔。 */
		function AutoCheckRow({ value, onChange }) {
			const h = React.createElement;
			useLocale();
			const enabled = !!(value && value.enabled);
			const hours = (value && value.hours) || AUTO_DEFAULT.hours;
			return h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
				h("button", {
					type: "button",
					role: "switch",
					"aria-checked": enabled,
					onClick: () => onChange({ ...value, enabled: !enabled }),
					title: tr("自动检查更新"),
					style: {
						position: "relative", width: 34, height: 19, flex: "0 0 auto", padding: 0,
						border: "none", boxSizing: "border-box", appearance: "none", lineHeight: 0,
						verticalAlign: "middle",
						borderRadius: 999, cursor: "pointer",
						// 固定色，不跟主题走：深色主题下 brand 是白色、layer2 是近黑，
						// 白色轨道 + 白色圆点会完全看不见开关状态。
						background: enabled ? "#4f8cff" : "rgba(128,128,128,.42)",
						transition: "background .15s ease",
					},
				},
					h("span", {
						"aria-hidden": "true",
						style: {
							position: "absolute", top: 3, left: enabled ? 19 : 2,
							width: 13, height: 13, borderRadius: "50%", background: "#fff",
							transition: "left .15s ease",
						},
					})),
				h("span", { style: { fontSize: 11, color: T.secondary, whiteSpace: "nowrap", marginRight: 2 } },
					tr("自动检查")),
				enabled
					? h("select", {
						value: String(hours),
						onChange: (e) => onChange({ ...value, hours: Number(e.target.value) }),
						"aria-label": tr("检查间隔"),
						style: { font: "inherit", fontSize: 11.5, color: T.label, background: T.layer1, border: "1px solid " + T.border, borderRadius: 7, padding: "3px 6px" },
					}, AUTO_HOURS.map((hh) => h("option", { key: hh, value: String(hh) },
						tr("每 {n} 小时").replace("{n}", String(hh)))))
					: null,
			);
		}
		// ---------- 网络来源选择器 ----------
		// 分段控件比下拉更直观；端口留空就是直连，输入框里不放任何占位数字，
		// 免得看起来像「已经填了 7890」。
		function SourcePicker({ net, onChange, mirrors, busy }) {
			const h = React.createElement;
			useLocale();
			const source = net && net.source ? net.source : "auto";
			const mirror = net && net.mirror ? net.mirror : (mirrors[0] && mirrors[0].id) || "";
			const port = net && net.proxyPort ? String(net.proxyPort) : "";
			const [portText, setPortText] = React.useState(port);
			React.useEffect(() => { setPortText(port); }, [port]);

			const commitPort = (raw) => {
				const t = String(raw).trim();
				if (t === "") { onChange({ source: "github" }); return; }
				const n = Number.parseInt(t, 10);
				if (Number.isInteger(n) && n >= 1 && n <= 65535) onChange({ source: "github", proxyPort: n });
				else { setPortText(""); onChange({ source: "github" }); }
			};

			// 三个分段按钮：选中态用浅色底 + 主色文字，未选中只有 hover。
			const segBtn = (key, label) => {
				const active = source === key;
				return h("button", {
					key,
					type: "button",
					disabled: busy,
					"aria-pressed": active,
					onClick: () => {
						if (busy) return;
						if (key === "auto") onChange({ source: "auto" });
						else if (key === "github") commitPort(portText);
						else onChange({ source: "mirror", mirror });
					},
					style: {
						appearance: "none", font: "inherit", fontSize: 11.5, lineHeight: 1,
						padding: "5px 9px", borderRadius: 7, border: "1px solid " + (active ? "transparent" : T.border),
						background: active ? T.hover : "transparent",
						color: active ? T.label : T.secondary,
						fontWeight: active ? 600 : 400,
						cursor: busy ? "default" : "pointer",
						opacity: busy ? 0.6 : 1,
						whiteSpace: "nowrap",
					},
				}, label);
			};

			const ctrl = {
				font: "inherit", fontSize: 11.5, color: T.label, background: T.layer1,
				border: "1px solid " + T.border, borderRadius: 7, padding: "4px 6px",
			};

			return h("div", {
				style: { display: "flex", flexDirection: "column", gap: 6 },
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 11, color: T.secondary, whiteSpace: "nowrap", marginRight: 2 } },
						tr("网络")),
					h("div", { style: { display: "flex", gap: 4 } },
						segBtn("auto", tr("自动")),
						segBtn("github", tr("官方")),
						segBtn("mirror", tr("镜像")))),

				source === "mirror"
					? h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
						h("span", { style: { fontSize: 11, color: T.secondary, whiteSpace: "nowrap" } },
							tr("站点")),
						h("select", {
							value: mirror,
							disabled: busy,
							"aria-label": tr("镜像站点"),
							style: { ...ctrl, flex: 1, minWidth: 0 },
							onChange: (e) => {
								setPortText(portText);
								onChange({ source: "mirror", mirror: e.target.value });
							},
						}, mirrors.map((m) => h("option", { key: m.id, value: m.id }, m.label))))
					: null,

				source === "github"
					? h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
						h("span", { style: { fontSize: 11, color: T.secondary, whiteSpace: "nowrap" } },
							tr("端口")),
						h("input", {
							type: "text",
							inputMode: "numeric",
							value: portText,
							disabled: busy,
							placeholder: "",
							"aria-label": tr("本地代理端口"),
							style: { ...ctrl, width: 54, textAlign: "center" },
							onChange: (e) => setPortText(e.target.value.replace(/[^0-9]/g, "").slice(0, 5)),
							onBlur: () => commitPort(portText),
							onKeyDown: (e) => { if (e.key === "Enter") commitPort(portText); },
						}),
						h("span", { style: { fontSize: 10.5, color: T.secondary, opacity: 0.85, lineHeight: 1.4 } },
							portText === ""
								? (tr("留空 = 直连，不走代理"))
								: (tr("本机代理"))))
					: null,
			);
		}
		function UpdatePanel({ view, net, onNetChange, mirrors, autoCheck, onAutoCheck, width, anchor, onClose, onRecheck, onStart, onStartStash, onStartRollback, onAllowMissing, onConfirmPeers, onRestart, restartState }) {
			const h = React.createElement;
			// 语言切换时必须重渲染：面板里全是 tr() 取的文案，不订阅就停在旧语言。
			useLocale();

			// 更新日志自动滚动：进度追加时 pre 自动贴底；用户主动向上滚动阅读时暂停跟随，
			// 直到其重新滚回底部。
			const logRef = React.useRef(null);
			const stickToBottom = React.useRef(true);
			React.useEffect(() => {
				const el = logRef.current;
				if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
			}, [view.lines]);
			const onLogScroll = (e) => {
				const el = e.currentTarget;
				stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			};

			// 自动重启倒计时：done 带 autoRestart 时从 restartInMs 起每秒递减，
			// 让「即将自动重启 dsh（N 秒后）」是真实倒计时而非静态文案。
			const [autoCountdown, setAutoCountdown] = React.useState(null);
			React.useEffect(() => {
				const r = view.kind === "done" ? view.result : undefined;
				if (!r || !r.autoRestart || typeof r.restartInMs !== "number") {
					setAutoCountdown(null);
					return;
				}
				const total = Math.max(1, Math.ceil(r.restartInMs / 1000));
				setAutoCountdown(total);
				const id = window.setInterval(() => {
					// 停在 1（页面通常在此前已被自动重启打断）；不会出现「0 秒后」。
					setAutoCountdown((c) => (c === null || c <= 1 ? c : c - 1));
				}, 1000);
				return () => window.clearInterval(id);
			}, [view.kind, view.result]);

			// 回退目标选择：面板里「切换到其它版本」的下拉（高/低版本自动变成更新/回退）。
			const [rollbackTag, setRollbackTag] = React.useState(null);

			const status =
				view.kind === "result" || view.kind === "available" || view.kind === "updating"
					? view.status
					: undefined;

			const title =
				// 后台分离更新：git 步骤完成后已移交独立进程，本页即将断开——
				// 标题不能再用「更新完成」（会与 body 的「已转入后台执行」自相矛盾）。
				view.kind === "tag-health" ? (tr("此版本会损坏 Web UI"))
				: view.kind === "peers" ? (tr("插件版本可能不兼容"))
				: view.kind === "done" && view.result.pendingBootCheck ? (tr("正在检查启动是否健康"))
				: view.kind === "done" && view.result.detached ? (tr("更新已转入后台执行"))
				: view.kind === "done" && view.result.ok && view.result.skipped ? (tr("已是最新版本"))
				: view.kind === "done" && view.result.ok && view.result.rollback ? tr("回退完成")
				: view.kind === "done" && view.result.ok ? tr("更新完成")
				: view.kind === "error" ? tr("更新失败")
				: view.kind === "conflict" ? tr("更新受阻")
				: tr("检查更新");

			// 小浮层：贴在「检查更新」按钮上方，不再是全屏居中弹窗。
			const panel = {
				// fixed + portal：脱离侧栏裁剪；坐标由 UpdateTrigger 按按钮矩形算出后传入。
				position: "fixed", zIndex: 1300,
				...popoverAnchor(anchor),
				display: "flex", flexDirection: "column", gap: 10,
				// 宽度按 footer 实测宽度算（见 popoverWidth）：既不压成竖条，也不溢出聊天区。
				width: width || "min(340px, calc(100vw - 32px))",
				boxSizing: "border-box", padding: 16, borderRadius: 14,
				background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border,
				color: T.label, boxShadow: "0 10px 28px rgba(0,0,0,.28)", textAlign: "left",
			};
			const headStyle = { display: "flex", alignItems: "flex-start", gap: 12 };
			const closeBtn = {
				appearance: "none", border: "none", background: "transparent", color: T.secondary,
				cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 2px", borderRadius: 6,
			};
			const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.4, flex: 1 };
			const detail = { margin: "6px 0 0", color: T.secondary, fontSize: 13, lineHeight: 1.6 };
			const statusLine = { margin: 0, fontWeight: 600, fontSize: 14 };
			const preStyle = {
				maxHeight: 220, margin: "10px 0 0", overflow: "auto", padding: "10px 12px",
				borderRadius: 10, background: T.layer1, color: T.secondary, fontSize: 12,
				fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", lineHeight: 1.6, whiteSpace: "pre-wrap",
			};
			const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 12.5, color: T.secondary, margin: 0, lineHeight: 1.55, overflowWrap: "anywhere" };
			const actions = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 };

			// Collapsible raw log in the final cards, so the streamed output is
			// never lost even if it arrived in one burst at the very end.
			const logBlock = view.lines && view.lines.length > 0
				? h("details", { style: { margin: "10px 0 0" } },
					h("summary", { style: { cursor: "pointer", fontSize: 12, color: T.secondary } },
						tr("查看本次更新日志（") + view.lines.length + tr(" 行）")),
					h("pre", { style: preStyle }, view.lines.join("\n")))
				: null;

			let body;
			if (view.kind === "checking") {
				body = h("p", { style: statusLine }, tr("正在检查版本…"));
			} else if (view.kind === "available" && status !== undefined) {
				// 有更新：版本对比 + 更新内容 + 主操作。橙色警示搬进了「开始更新」前的一步
				// （检测到进行中的对话才提示），这里不再常驻大段警告。
				// 下方版本区只列比本地旧的历史版本（纯回退用）：升级交给顶部的「开始更新」，
				// 否则下拉默认选中最新版 + 「更新到此版本」会和「开始更新」完全重复。
				const manualOptions = (Array.isArray(status.tags) ? status.tags : [])
					.filter((t) => t !== status.localTag && compareTagTo(t, status.localTag) < 0);
				const manualSelected = manualOptions.includes(rollbackTag) ? rollbackTag : (manualOptions[0] || "");
				const rows = [
					h("p", { key: "local", style: rowStyle },
						h("span", { style: { whiteSpace: "nowrap" } }, tr("本地版本：")), h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? tr("未知"))),
					h("p", { key: "remote", style: rowStyle },
						h("span", { style: { whiteSpace: "nowrap" } }, tr("远程版本：")),
						h("b", {
							style: { color: T.success },
							title: status.remoteVia === "proxy" ? tr("经镜像获取") : undefined,
						}, status.remoteTag ?? tr("无法获取")),
						h("span", { key: "has", style: { whiteSpace: "nowrap", color: T.success } }, tr("有更新"))),
					...lastUpdateRows(h, T, rowStyle, status),
				];

				// 「查看日志」直接开 GitHub 对应的 releases 页面（新标签），不依赖镜像可用性。
				const notesUrl = status.remoteTag
					? "https://github.com/deepseek-ai/deepseek-harness/releases/tag/" + encodeURIComponent(status.remoteTag)
					: undefined;

				body = h("div", null,
					...rows,
					// 本次更新内容（GitHub Releases），按 DSH 界面语言显示中/英文段
					h("div", { key: "notes", style: { margin: "12px 0 0" } },
						h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } },
							(tr("本次更新内容（")) + (status.remoteTag ?? "") + (tr("）"))),
						renderReleaseNotes(h, T, view.notes),
						notesUrl
							? h("button", {
								type: "button",
								style: { ...actionBtnStyle(T), marginTop: 8, fontSize: 12, padding: "4px 10px" },
								title: notesUrl,
								onClick: () => { window.open(notesUrl, "_blank", "noopener,noreferrer"); },
							}, tr("查看官方发布说明 ↗"))
							: null),
					...(Array.isArray(status.peerConflicts) && status.peerConflicts.length > 0
						? [h("details", { key: "peers", style: { margin: "10px 0 0" } },
							h("summary", { style: { cursor: "pointer", fontSize: 12, color: T.warn } },
								tr("已安装插件的 peer 可能不接受此版本")),
							h("pre", { style: { ...preStyle, maxHeight: 140 } }, status.peerConflicts.map((c) =>
								(c.profile || "?") + " / " + (c.plugin || "?") + ": " + c.dependency + "@" + c.range + " → " + c.target).join("\n")))]
						: []),
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", {
							type: "button",
							style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 },
							// 必须包一层：直接把 onStart 传给 onClick 会把 React 事件当 status 传进去。
							onClick: () => onStart(status),
						}, tr("开始更新")),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, tr("重新检查"))),
					manualOptions.length > 0
						? h("div", { key: "manual", style: { margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, border: "1px solid " + T.border } },
							h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } },
								tr("或回退到历史版本")),
							h("p", { style: { margin: "4px 0 0", fontSize: 12, color: T.secondary, lineHeight: 1.55 } },
								tr("选择更早的版本回退；与更新走同一套安全检查。")),
							h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "8px 0 0", flexWrap: "wrap" } },
								h("select", {
									value: manualSelected,
									onChange: (e) => setRollbackTag(e.target.value),
									style: { font: "inherit", fontSize: 12.5, color: T.label, background: T.layer1, border: "1px solid " + T.border, borderRadius: 8, padding: "5px 8px", maxWidth: "100%" },
								}, manualOptions.map((t) => h("option", { key: t, value: t }, t))),
								h("button", {
									type: "button",
									style: { ...actionBtnStyle(T), fontWeight: 600 },
									onClick: () => { if (manualSelected) onStartRollback(status, manualSelected); },
								}, tr("回退到此版本"))))
						: null
				);
			} else if (view.kind === "result" && status !== undefined) {
				const rows = [
					h("p", { key: "local", style: rowStyle },
						h("span", { style: { whiteSpace: "nowrap" } }, tr("本地版本：")), h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? tr("未知"))),
					h("p", { key: "remote", style: rowStyle },
						h("span", { style: { whiteSpace: "nowrap" } }, tr("远程版本：")),
						h("b", {
							style: { color: T.label },
							title: status.remoteVia === "proxy" ? tr("经镜像获取") : undefined,
						}, status.remoteTag ?? tr("无法获取"))),
				];
				if (status.error !== undefined) {
					// `not a git checkout: <dir>` 是 npm 安装的典型结果。原始英文报错对用户没有意义，
					// 换成一句能指导下一步的话，并把目录附在末尾便于确认。
					const notGit = /^not a git checkout/.test(String(status.error));
					rows.push(h("p", { key: "err", style: { ...rowStyle, color: T.warn } },
						tr("检查异常：") + (notGit
							? tr("这个目录不是 git 仓库，无法检查更新。") + " (" + String(status.repoDir ?? "") + ")"
							: String(status.error))));
				} else {
					rows.push(h("p", { key: "uptodate", style: { ...statusLine, color: T.success } }, tr("✓ 已是最新，无需更新。")));
				}
				// 页面断开期间由后台进程完成的更新：给出「上次后台更新」确认/告警。
				rows.push(...lastUpdateRows(h, T, rowStyle, status));

				// 已是最新：版本区只用于回退到历史版本。既然已是最新，不该再出现
				// 「更新到此版本」这种自相矛盾的选项。
				const manualOptions = (Array.isArray(status.tags) ? status.tags : [])
					.filter((t) => t !== status.localTag && compareTagTo(t, status.localTag) < 0);
				const manualSelected = manualOptions.includes(rollbackTag) ? rollbackTag : (manualOptions[0] || "");

				body = h("div", null, rows,
					manualOptions.length > 0
						? h("div", { key: "manual", style: { margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, border: "1px solid " + T.border } },
							h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } },
								tr("或回退到历史版本")),
							h("p", { style: { margin: "4px 0 0", fontSize: 12, color: T.secondary, lineHeight: 1.55 } },
								tr("选择更早的版本回退；与更新走同一套安全检查。")),
							h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "8px 0 0", flexWrap: "wrap" } },
								h("select", {
									value: manualSelected,
									onChange: (e) => setRollbackTag(e.target.value),
									style: { font: "inherit", fontSize: 12.5, color: T.label, background: T.layer1, border: "1px solid " + T.border, borderRadius: 8, padding: "5px 8px", maxWidth: "100%" },
								}, manualOptions.map((t) => h("option", { key: t, value: t }, t))),
								h("button", {
									type: "button",
									style: { ...actionBtnStyle(T), fontWeight: 600 },
									onClick: () => { if (manualSelected) onStartRollback(status, manualSelected); },
								}, tr("回退到此版本"))))
						: null);
			} else if (view.kind === "updating" && status !== undefined) {
				// 精简进度视图：只显示当前阶段 + 往复色带 + 逐行日志。
				// 不给百分比：服务端只报阶段、不报总时长，数字是猜的，猜错比不显示更糟。
				ensureProgressAnim();
				body = h("div", null,
					h("p", { style: { ...statusLine, color: RUN_BLUE } },
						view.targetTag
							? tr("正在回退到 ") + view.targetTag + " …"
							: tr("检测到新版本 ") + (status.remoteTag ?? "") + tr("，正在更新…")),
					// 一条色带从左往右匀速跑、循环往复：只要还在动就说明没卡死。
					h("div", { "data-dsh-update": "sweep", style: {
						position: "relative", height: 4, borderRadius: 2, overflow: "hidden",
						margin: "8px 0 2px",
						background: "color-mix(in srgb, " + RUN_BLUE + " 16%, transparent)",
					} }, h("span", { "aria-hidden": "true", style: {
						position: "absolute", top: 0, bottom: 0, width: "45%", borderRadius: 2,
						background: RUN_BLUE, animation: "dshUpdateSweep 1.5s linear infinite",
					} })),
					h("pre", { style: preStyle, ref: logRef, onScroll: onLogScroll }, view.lines.join("\n"))
				);
			} else if (view.kind === "tag-health") {
				const health = view.health || {};
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.danger } },
						tr("已拒绝检出 {tag}").replace("{tag}", health.to || "")),
					h("pre", { style: preStyle }, (health.message || "") + "\n\n" + (health.messageEn || "")),
					logBlock,
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", {
							type: "button",
							style: { ...actionBtnStyle(T), background: T.warn, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.warn, fontWeight: 600 },
							onClick: () => onAllowMissing(view.status, view.targetTag, view.stash, view.confirmPeerConflicts),
						}, tr("仍要检出（我接受 Web UI 可能损坏）")),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, tr("取消")))
				);
			} else if (view.kind === "peers") {
				const peers = view.peers || {};
				// 服务端的 message 已含逐条冲突清单，不要再拼一遍 conflicts（那会让同一份
				// 清单显示两次）。只取一段说明，长列表放在 details 里折叠，默认收起。
				const message = lang() !== "zh" ? (peers.messageEn || peers.message || "") : (peers.message || "");
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.warn } },
						tr("插件 peerDependency 可能与 {tag} 不兼容").replace("{tag}", peers.to || "")),
					h("details", { style: { margin: "8px 0 0" } },
						h("summary", { style: { cursor: "pointer", fontSize: 12, color: T.secondary } },
							tr("查看冲突详情")),
						h("pre", { style: { ...preStyle, maxHeight: 200 } }, message)),
					logBlock,
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", {
							type: "button",
							style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 },
							onClick: () => onConfirmPeers(view.status, view.targetTag, view.stash, view.allowMissingRequiredPaths),
						}, view.targetTag ? tr("仍要继续回退") : tr("仍要继续更新")),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, tr("取消")))
				);
			} else if (view.kind === "done") {
				const r = view.result;
				if (r.pendingBootCheck) {
					body = h("div", null,
						h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" } },
							h("span", { style: { color: T.brand, fontSize: 20, lineHeight: 1 } }, "⏳"),
							h("span", { style: { fontWeight: 700, fontSize: 16, color: T.label } },
								tr("构建完成，正在检查 Web UI 是否正常启动"))),
						h("p", { style: detail },
							tr("dsh 正在重启。只有启动日志里没有 “did not activate”、“Failed to load plugins” 和 HARNESS 插件加载失败，才算更新成功。若出现这些信号，会自动 checkout 回 ") + (r.from || tr("上一版本")) + tr(" 并重新 install / clean / build。本页即将断开，稍后重新打开面板可看到结果。")),
						...(r.logErr ? [h("p", { key: "logpath", style: { ...detail, fontSize: 12, color: T.secondary } },
							(tr("启动检查日志：")) + r.logErr)] : []),
						logBlock
					);
				} else if (r.detached) {
					// Windows 后台分离更新：git 步骤已完成，install/build 在独立后台进程中继续，
					// 本页面即将断开。不显示误导性的绿色「更新成功」。
					body = h("div", null,
						h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" } },
							h("span", { style: { color: T.brand, fontSize: 20, lineHeight: 1 } }, "⏳"),
							h("span", { style: { fontWeight: 700, fontSize: 16, color: T.label } },
								tr("更新已转入后台执行"))),
						h("p", { style: detail },
							tr("更新已移交独立后台进程执行（运行中的 dsh 占用文件句柄，无法在本进程内完成安装）。本页面即将断开。安装/构建后会重启 dsh 并检查启动日志——若出现 did not activate / Failed to load plugins，会自动回到上一版本。请稍后重新打开面板查看结果。")),
						...(r.logErr ? [h("p", { key: "logpath", style: { ...detail, fontSize: 12, color: T.secondary } },
							(tr("后台日志：")) + r.logErr)] : []),
						logBlock
					);
				} else {
				const st = view.status;
				const content = [];
				if (r.skipped) {
					content.push(h("p", { key: "s", style: detail }, tr("本地已是 ") + (r.from ?? tr("最新")) + tr("，无需更新。")));
				} else {
					const head = h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" } },
						h("span", { style: { color: T.success, fontSize: 20, lineHeight: 1 } }, "✓"),
						h("span", { style: { fontWeight: 700, fontSize: 16, color: T.label } },
							(r.bootChecked === false
								? (tr("构建完成"))
								: (r.rollback ? tr("回退成功") : tr("更新成功"))) + (r.to ? " " + r.to : "")),
					);
					content.push(head);
					content.push(h("p", { key: "d", style: detail },
						r.rollback
							? tr("已从 ") + (r.from ?? tr("当前版本")) + tr(" 回退到 ") + (r.to ?? tr("目标版本")) + "。"
							: tr("已从 ") + (r.from ?? tr("旧版本")) + tr(" 更新到 ") + (r.to ?? tr("新版本")) + "。"));
					// 构建后核验（服务端在 build 成功后重新读取 git 状态）：
					// 确认本次更新实际落到的版本，避免「显示更新完成但仍以为有更新」的困惑。
					if (r.verifiedTag && r.to && r.verifiedTag === r.to) {
						content.push(h("p", { key: "verified", style: { ...detail, color: T.success } },
							tr("✓ 已确认当前版本为 ") + r.verifiedTag + tr("，与本次更新目标一致。")));
					}
					if (st) {
						const rows = [];
						if (st.repoDir) rows.push(h("p", { key: "rd", style: rowStyle }, tr("更新目录："), h("b", { style: { color: T.label } }, st.repoDir)));
						const commit = r.verifiedCommit || st.localCommit;
						if (commit) rows.push(h("p", { key: "rc", style: rowStyle }, tr("当前 commit："), h("b", { style: { color: T.label } }, commit)));
						if (rows.length > 0) content.push(h("div", { key: "git", style: { margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 2 } }, ...rows));
					}
					if (r.bootChecked === false) content.push(h("p", { key: "boot", style: { ...detail, color: T.warn } },
						tr("本次未自动重启，因此没有检查启动日志。若页面出现 Failed to load plugins / did not activate，请回退到上一版本。")));
					if (r.stashApplied) content.push(h("p", { key: "stash-applied", style: { ...detail, color: T.success } }, tr("✓ 你的本地改动已在更新后自动恢复并保留在新版本中。")));
					if (r.stashKept) content.push(h("p", { key: "stash-kept", style: { ...detail, color: T.warn } }, tr("本地改动与新版本冲突，已安全保存在 git stash（未丢失），可在仓库目录手动执行 git stash apply 处理。")));
					if (r.autoRestart) {
						// 服务端在更新成功后已安排自动重启（约 2 秒后），此处告知用户并显示
						// 真实倒计时：页面会短暂变空白，恢复后刷新一次即可。
						const when = autoCountdown !== null
							? tr("{n} 秒后").replace("{n}", String(autoCountdown))
							: (tr("约 2 秒后"));
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.brand, fontWeight: 600 } },
								(r.rollback
									? tr("回退完成，即将自动重启 dsh（") + when + tr("）…页面会短暂变空白，重启完成后会自动刷新，无需手动操作。")
									: tr("更新完成，即将自动重启 dsh（") + when + tr("）…页面会短暂变空白，重启完成后会自动刷新，无需手动操作。"))));
					} else {
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.secondary } },
							(r.rollback
								? tr("回退完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。")
								: tr("更新完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。"))));
					}
					if (logBlock !== null) content.push(h("div", { key: "log" }, logBlock));
				}
				body = h("div", null, ...content);
				}
			} else if (view.kind === "conflict") {
				const c = view.conflict || {};
				const filesText = (c.files && c.files.length > 0) ? c.files.join("\n") : tr("（无法解析具体文件）");
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.warn } }, view.targetTag ? tr("回退被本地改动阻止") : tr("更新被本地改动阻止")),
					h("p", { style: detail }, view.targetTag
						? tr("以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续回退，或先手动处理（git stash / git commit），再重新检查：")
						: tr("以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续更新，或先手动处理（git stash / git commit），再重新检查：")),
					h("pre", { style: preStyle }, filesText),
					logBlock,
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", { type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: () => onStartStash(view.status, view.targetTag) }, view.targetTag ? tr("自动暂存并继续回退") : tr("自动暂存并继续更新")),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, tr("重新检查"))
					)
				);
			} else if (view.kind === "error") {
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.danger } }, view.message),
					view.detail !== undefined && view.detail !== ""
						? h("pre", { style: preStyle }, view.detail)
						: null,
					logBlock
				);
			}

			const showRecheck = view.kind === "done" || view.kind === "error";
			// 后台分离更新时**不提供**重启按钮：update helper 已在等端口释放后自行拉起
			// 新 dsh，此时用户点「重启DSH」会走 /restart 再生成一个 restart helper，
			// 两个 helper 各自拉起 dsh 并抢同一个端口（restartScheduled latch 只管
			// /restart 路由，约束不到 update helper）。
			const doneOk = view.kind === "done" && view.result && view.result.ok && !view.result.skipped && !view.result.detached && !view.result.pendingBootCheck;

			let footer = null;
			if (restartState === "restarting") {
				footer = h("p", { style: { ...detail, marginTop: 10, color: T.brand } },
					tr("正在重启 DeepSeek Harness… 页面会短暂断开，新进程就绪后刷新即可。"));
			} else {
				const buttons = [];
				if (doneOk) {
					// 已安排自动重启时，按钮改为「立即重启」（提前触发，不等那 2 秒）。
					const autoRestarting = !!(view.result && view.result.autoRestart);
					buttons.push(h("button", { key: "restart", type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: onRestart },
						autoRestarting ? (tr("立即重启")) : (tr("重启DSH"))));
				}
				if (showRecheck) {
					buttons.push(h("button", { key: "recheck", type: "button", style: actionBtnStyle(T), onClick: onRecheck },
						tr("重新检查")));
				}
				if (buttons.length > 0) {
					footer = h("div", { style: { marginTop: 4 } },
						restartState === "error"
							? h("p", { key: "rerr", style: { ...detail, color: T.danger } },
								tr("重启失败，请手动重启 dsh web。"))
							: null,
						h("div", { style: actions }, ...buttons));
				}
			}

			// 来源选择器常驻顶部：检查中也能直接换来源重查（网络差时的逃生口）。
			const sourceRow = mirrors !== undefined && mirrors.length > 0
				? h(SourcePicker, {
					net, onChange: onNetChange, mirrors,
					busy: view.kind === "updating",
				})
				: null;

			// 自动检查更新：与网络来源同一区，都是「这台机器怎么查更新」的偏好。
			const autoRow = autoCheck !== undefined && typeof onAutoCheck === "function"
				? h(AutoCheckRow, { value: autoCheck, onChange: onAutoCheck })
				: null;

			// 执行中也保留标题栏：右上角的关闭按钮必须一直在——窗口可以手动关掉，
			// 关掉之后点侧栏按钮还能再打开（进度本身不随窗口关闭而中断）。
			// 网络来源 / 自动检查这些「怎么查更新」的偏好只在非执行期出现：
			// 执行中改它们毫无用处，只会把进度区挤小。
			const inProgress = view.kind === "updating";
			return h("div", { style: panel, role: "dialog", "aria-label": title, "data-dsh-update-pop": "1" },
				h("div", { style: headStyle },
					h("h2", { style: titleStyle }, title),
					h("button", { type: "button", style: closeBtn, "aria-label": tr("关闭"), title: tr("关闭"), onClick: onClose }, "✕")
				),
				inProgress ? null : (sourceRow || autoRow ? h("div", { style: POP_DIVIDER }) : null),
				inProgress ? null : sourceRow,
				inProgress ? null : autoRow,
				inProgress ? null : (sourceRow || autoRow ? h("div", { style: POP_DIVIDER }) : null),
				// 页面中断提示放在正文之前、视线必经的位置：更新一开始用户就会遇到整屏空白，
				// 事后再解释已经晚了。执行中同样显示——那正是它发生的时候。
				h(BlindHint, { h, T }),
				h("div", { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } }, body),
				inProgress ? null : footer
			);
		}

		function actionBtnStyle() {
			return {
				appearance: "none", font: "inherit", cursor: "pointer",
				border: "1px solid " + T.border, borderRadius: 8, padding: "5px 14px",
				fontSize: 13, lineHeight: 1.5, background: "transparent", color: T.label,
			};
		}

		// 把服务端流式步骤映射成回退进度：标签里带这些关键词就推进一格。
		// 没有精确总步数（stash / 回滚分支会增减），所以只做单调递增的近似。
		// 步骤表必须每次按当前语言生成：写成模块级常量会让 tr() 在加载时求值一次，
		// 之后切换语言，进度文案仍是旧语言。
		function rollbackSteps() {
			return [
				{ re: /fetch|Fetching/i, pct: 12, text: tr("拉取"), ing: tr("拉取中"), hint: tr("拉取版本标签") },
				{ re: /Verifying tag/i, pct: 18, text: tr("校验"), ing: tr("校验中"), hint: tr("校验目标版本") },
				{ re: /required path|必需路径/i, pct: 22, text: tr("检查"), ing: tr("检查中"), hint: tr("检查必需路径") },
				{ re: /stash/i, pct: 28, text: tr("暂存"), ing: tr("暂存中"), hint: tr("暂存本地改动") },
				{ re: /Checking out/i, pct: 36, text: tr("切换"), ing: tr("切换中"), hint: tr("切换到目标版本") },
				{ re: /install/i, pct: 52, text: tr("安装"), ing: tr("安装中"), hint: tr("安装依赖") },
				{ re: /clean/i, pct: 64, text: tr("清理"), ing: tr("清理中"), hint: tr("清理旧构建产物") },
				{ re: /build/i, pct: 82, text: tr("构建"), ing: tr("构建中"), hint: tr("重新构建") },
				{ re: /Restoring your local changes/i, pct: 92, text: tr("恢复"), ing: tr("恢复中"), hint: tr("恢复本地改动") },
			];
		}

		/** 从一行流式输出推断回退进度；认不出就返回 null（保持当前进度）。 */
		/** 取命中项里 pct 最大者：`Restoring your local changes` 同时命中 stash(28) 与
		 *  restore(92)，取第一个会永远停在 28%（与 updateProgressOf 同一修法）。 */
		function rollbackProgressOf(text) {
			let best = null;
			for (const step of rollbackSteps()) {
				if (step.re.test(text) && (best === null || step.pct > best.pct)) best = step;
			}
			return best;
		}

		// 更新（检查更新 → 开始更新）的进度表：与回退共用同一套识别方式，
		// 只是多了一次 fetch / stash，且不含「回退」这种额外分支。
		function updateSteps() {
			return [
				{ re: /Fetching tags|fetch/i, pct: 10, text: tr("拉取"), ing: tr("拉取中"), hint: tr("拉取远程版本标签") },
				{ re: /Verifying tag/i, pct: 16, text: tr("校验"), ing: tr("校验中"), hint: tr("校验目标版本") },
				{ re: /required path|必需路径/i, pct: 20, text: tr("检查"), ing: tr("检查中"), hint: tr("检查必需路径") },
				{ re: /stash/i, pct: 26, text: tr("暂存"), ing: tr("暂存中"), hint: tr("暂存本地改动") },
				{ re: /Checking out/i, pct: 34, text: tr("切换"), ing: tr("切换中"), hint: tr("切换到新版本") },
				{ re: /install/i, pct: 52, text: tr("安装"), ing: tr("安装中"), hint: tr("安装依赖") },
				{ re: /clean/i, pct: 64, text: tr("清理"), ing: tr("清理中"), hint: tr("清理旧构建产物") },
				{ re: /build/i, pct: 82, text: tr("构建"), ing: tr("构建中"), hint: tr("重新构建") },
				{ re: /Restoring your local changes/i, pct: 92, text: tr("恢复"), ing: tr("恢复中"), hint: tr("恢复本地改动") },
			];
		}

		/** 从一行流式输出推断更新进度；认不出就返回 null（保持当前进度）。
		 *  取「所有命中项里 pct 最大者」而不是第一个：`Restoring your local changes`
		 *  同时命中 stash(26) 与 restore(92)，取第一个会永远停在 26。 */
		function updateProgressOf(text) {
			let best = null;
			for (const step of updateSteps()) {
				if (step.re.test(text) && (best === null || step.pct > best.pct)) best = step;
			}
			return best;
		}
		// ---------- the sidebar footer trigger ----------
		function UpdateTrigger({ wide }) {
			const h = React.createElement;
			// 触发器里也要拿到当前语言：BusyDialog 等内联浮层要用（缺了会直接抛
			// ReferenceError，把整个组件从侧栏卸载掉）。
			const [open, setOpen] = useState(false);
			const [view, setView] = useState({ kind: "checking" });
			const [restartState, setRestartState] = useState(null); // null | 'restarting' | 'error'
			const runToken = useRef(0);
			const rowRef = useRef(null);
			// DSH 的 .footerActions 是 display:flex 且不换行，不改父级就只能和 DS Bot /
			// remote 的按钮挤在同一行。这里给它开 wrap，卸载时还原，避免影响别人。
			useEffect(() => {
				const el = rowRef.current;
				if (!el) return undefined;
				// 插槽列表会用一个 display:contents 的容器把各项隔开，真正的 flex 行是
				// 它外面的 .footerActions——跳过 contents 层，否则给 wrap 给的是一层假壳。
				let parent = el.parentElement;
				while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
				if (!parent) return undefined;
				const previous = parent.style.flexWrap;
				parent.style.flexWrap = "wrap";
				// 浮层宽度参照 footer 而不是按钮：按钮只有 ~98px，用 100% 会被压成竖条；
				// 只参照视口又会在窄侧栏里溢出到聊天区。
				// 顺带量一下兄弟按钮的高度：别人比我们高一截（比如 Remote 是 42px、
				// 我们是 32px）时混排会高低错落，这时让自己独占一行更整齐。
				const measure = () => {
					setFootWidth(Math.round(parent.getBoundingClientRect().width));
					const selfH = el.getBoundingClientRect().height;
					let taller = false;
					for (const btn of parent.querySelectorAll("button")) {
						if (el.contains(btn)) continue; // 自己的按钮不算
						const h = btn.getBoundingClientRect().height;
						if (h > 0 && Math.abs(h - selfH) > 4) { taller = true; break; }
					}
					setNeedsOwnLine(taller);
				};
				measure();
				// 光盯 parent 不够：兄弟按钮自己改高度时 parent 尺寸不变、不会触发回调，
				// needsOwnLine 就会卡在旧值上（等高时仍独占一行）。所以把每个按钮也纳入观察，
				// 并用 MutationObserver 跟上插槽里按钮的增删。
				const observed = new Set();
				const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
				const observeAll = () => {
					if (!ro) return;
					ro.observe(parent);
					for (const btn of parent.querySelectorAll("button")) {
						if (observed.has(btn)) continue;
						observed.add(btn);
						ro.observe(btn);
					}
				};
				observeAll();
				let mo = null;
				try {
					if (typeof MutationObserver === "function") {
						mo = new MutationObserver(() => { observeAll(); measure(); });
						mo.observe(parent, { childList: true, subtree: true });
					}
				} catch {}
				window.addEventListener("resize", measure);
				return () => {
					parent.style.flexWrap = previous;
					if (ro) ro.disconnect();
					if (mo) mo.disconnect();
					window.removeEventListener("resize", measure);
				};
			}, []);
			useLocale(); // 语言切换时重渲染（更新内容随 DSH 界面语言切换中/英文段）

			/** 一键重启 dsh（借鉴 dsh-market：服务端 detached helper 按原命令拉起新进程）。 */
			const restart = useCallback(async () => {
				setRestartState("restarting");
				try {
					const res = await fetch("/api/dsh-update/restart", { method: "POST" });
					if (!res.ok) {
						let detail = "";
						try { detail = await res.text(); } catch {}
						throw new Error("HTTP " + String(res.status) + (detail !== "" ? ": " + detail : ""));
					}
					// 成功后本进程约 500ms 退出、helper 接管——页面会短暂断开。
					// 若 12 秒后组件仍存活（异常情况），提示手动重启。
					window.setTimeout(() => {
						setRestartState((s) => (s === "restarting" ? "error" : s));
					}, 12000);
				} catch (error) {
					setRestartState("error");
					setView({ kind: "error", message: tr("重启失败"), detail: String(error) });
				}
			}, []);

			/** 自动重启失败兜底：done 携带 autoRestart 时，若 restartInMs + 缓冲后
			 *  页面仍存活（未被重启打断），说明自动重启可能未生效——把重启状态置为
			 *  error，让用户看到「重启失败，请手动重启」并可用「立即重启」按钮。 */
			React.useEffect(() => {
				const r = view.kind === "done" ? view.result : undefined;
				if (!r || !r.autoRestart || typeof r.restartInMs !== "number") return;
				const t = window.setTimeout(() => {
					setRestartState((s) => (s === "restarting" ? s : "error"));
				}, r.restartInMs + 10000);
				return () => window.clearTimeout(t);
			}, [view.kind, view.result]);

			// 网络来源（选择器状态）：'auto' | 'github'（可带 proxyPort）| 'mirror'（带 mirror id）
			// 从 localStorage 恢复上次选择（含官方模式的端口），不用每次重选。
			const [net, setNet] = React.useState(() => readNet());
			// 自动检查：偏好（localStorage）+ 最近一次检查发现的待更新标记。
			const [autoCheck, setAutoCheck] = React.useState(() => readAutoCheck());
			// 后台静默检查的结果：有新版时用它把按钮变成「有新版本」+ 红点。
			const [pendingTag, setPendingTag] = React.useState("");
			const lastAutoAt = useRef(0);
			// footer 实测宽度：浮层宽度按它算（0 = 还没测到）。
			const [footWidth, setFootWidth] = React.useState(0);
			// 兄弟按钮高度与我不一致时（如 Remote 42px vs 我 32px），自己独占一行。
			const [needsOwnLine, setNeedsOwnLine] = React.useState(false);
			// 按钮在视口中的矩形：浮层是 position:fixed 挂在 body 上，需要真实坐标才能贴住按钮。
			const [anchor, setAnchor] = React.useState(null);
			// 服务端回带的镜像清单；首次 status 到达后用真实清单替换内置兜底。
			const [mirrors, setMirrors] = React.useState(FALLBACK_MIRRORS);

			// 偏好变更立刻落盘（localStorage 写失败也不影响本次会话）。
			const changeAutoCheck = useCallback((next) => {
				setAutoCheck(next);
				writeAutoCheck(next);
			}, []);

			// 后台静默检查：启动时一次 + 按设置的间隔轮询。只更新「有没有新版」标记，
			// 不弹窗、不改视图，失败了静默换镜像再试（silentCheck 内部处理）。
			const runAutoCheck = useCallback(async () => {
				lastAutoAt.current = Date.now();
				const hit = await silentCheck(net);
				if (!hit) return; // 全部来源都失败：静默放弃，等下一轮或用户手动点
				setPendingTag(hit.status && hit.status.outdated ? String(hit.status.remoteTag || "") : "");
			}, [net]);

			// dsh 每次启动（= 这个组件首次挂载）都查一次；之后按 hours 定时。
			React.useEffect(() => {
				if (!autoCheck.enabled) { setPendingTag(""); return undefined; }
				void runAutoCheck();
				const periodMs = Math.max(1, autoCheck.hours) * 60 * 60 * 1000;
				const id = window.setInterval(() => {
					// 页面长时间挂后台时定时器可能被节流；补一次「到期才查」的判断。
					if (Date.now() - lastAutoAt.current >= periodMs) void runAutoCheck();
				}, Math.min(periodMs, 30 * 60 * 1000));
				return () => window.clearInterval(id);
			}, [autoCheck.enabled, autoCheck.hours, runAutoCheck]);

			const check = useCallback(async (useNet) => {
				setView({ kind: "checking" });
				const token = ++runToken.current;
				let status;
				try {
					status = await fetchStatus(useNet);
				} catch (error) {
					if (token !== runToken.current) return;
					setView({ kind: "error", message: tr("无法连接更新服务"), detail: String(error) });
					return;
				}
				if (token !== runToken.current) return;
				if (Array.isArray(status.mirrors) && status.mirrors.length > 0) setMirrors(status.mirrors);
				// 有更新时不自动执行：先展示本地/远程版本 + 页面变空白提示 + 更新内容 + 「开始更新」按钮，
				// 由用户点击后才真正执行（避免自动更新途中页面变空白造成困惑）。
				// 手动检查成功：以这次结果为准，清掉/重设后台检查留下的红点。
				setPendingTag(status.outdated ? String(status.remoteTag || "") : "");
				if (status.outdated) {
					setView({ kind: "available", status, notes: { state: "loading" } });
					fetchReleaseNotes(status.remoteTag, useNet).then((notes) => {
						if (token !== runToken.current) return;
						setView(prev => prev.kind === "available" ? { ...prev, notes } : prev);
					});
				} else {
					setView({ kind: "result", status });
				}
			}, []);

			const run = useCallback(async (status, opts) => {
				const stash = !!(opts && opts.stash);
				const targetTag = opts && opts.targetTag;
				const allowMissingRequiredPaths = !!(opts && opts.allowMissingRequiredPaths);
				const confirmPeerConflicts = !!(opts && opts.confirmPeerConflicts);
				// 从安全闸门拦截点「仍要继续」重新进入：保留已走过的进度，不从 6% 重头。
				const resume = !!(opts && opts.resume);
				const token = ++runToken.current;
				// 流里是否收到过终态事件。服务端中途崩溃 / 被 build 替换资源打断时，
				// 流会「正常结束」但一个终态都没有——不补这一手，按钮永远停在进度条上。
				let terminal = false;
				// 记下当前 boot id 作为待刷新基准：任务成功后服务会重启、boot 变化，
				// 页面（重新）加载时 watchPendingReload 靠这个基准自动刷新，不依赖 SSE。
				void fetch("/api/dsh-update/ping", { cache: "no-store" })
					.then((r) => {
						if (!r.ok) throw new Error("HTTP " + String(r.status));
						return r.json();
					})
					.then((b) => {
						if (token !== runToken.current || terminal) return;
						if (b && typeof b.boot === "string") {
							markPendingReload(b.boot, targetTag);
							// 立即启动轮询：即使页面没重载、SSE 中途断开，也能感知 boot 变化并刷新。
							watchPendingReload();
						}
					})
					.catch(() => {});
				// 从「检查更新」面板发起的任务（更新或从「切换到其它版本」发起的回退）都走这里：
				// 两者都要让侧栏的「检查更新」按钮变成实时进度条、可点击查看进度浮层。
				const trackUpdate = !targetTag;
				// 回退的日志步骤文案不同（「切换到目标版本」等），用对应的解析器推进度。
				const progressOf = targetTag ? rollbackProgressOf : updateProgressOf;
				const log = [];
				// trackProgress：只有服务端的 step 事件才推进进度条。原始 git/pnpm 输出
				// （line）里全是包名之类的噪声——pnpm 打印 `+ clean-css` 会命中 /clean/,
				// 让 install 阶段直接跳到 64%，所以那类行只追加日志。
				const append = (prefix, text, trackProgress = false) => {
					const line = prefix ? prefix + text : text;
					log.push(line);
					// 更新与回退都推进侧栏按钮的进度条（回退用 rollbackProgressOf 的步骤文案）。
					if (trackProgress) {
						const step = progressOf(line);
						if (step) {
							setUpStep(step.ing || step.text);
							setUpHint(step.hint || step.text);
							setUpPct((prev) => (step.pct > prev ? step.pct : prev));
						}
					}
					setView(prev => prev.kind === "updating"
						? { ...prev, lines: [...prev.lines, line] }
						: prev);
				};
				setUpTarget(targetTag === undefined ? "" : String(targetTag));
				setView({ kind: "updating", status, lines: [], targetTag });
				// 按钮进入执行中进度条态，面板就地切换为实时进度视图（不自动关闭）。
				setUpPhase("running");
				if (!resume) {
					setUpPct(6);
					setUpStep(targetTag ? tr("正在回退…") : tr("准备中"));
					setUpHint(targetTag ? tr("准备回退") : tr("准备更新"));
				}
				// 不关窗：窗口就地切换成进度视图（含右上角关闭按钮），用户可以一直看着。
				measureAnchor();
				setOpen(true);
				try {
					await runUpdate((evt) => {
						if (token !== runToken.current) return;
						if (evt.type === "step") {
							append("▶ ", evt.text, true);
						} else if (evt.type === "line") {
							append("", evt.text);
						} else if (evt.type === "notice") {
							// 服务端在关键节点（开始 / 构建前）发送的页面变空白提醒
							append("⚠ ", evt.text, true);
						} else if (evt.type === "done") {
							terminal = true;
							if (evt.ok) {
								// skipped / recomputed 表示「fetch 后发现没有更新」，不是一次更新完成：
								// 走 result 视图显示「已是最新」，别让按钮变成「完成，请手动重启」。
								if (evt.skipped === true) {
									// 按钮必须复位：skipped 表示没执行任何切换，回退/更新都不能停在进度条上。
									if (trackUpdate) setPendingTag("");
									clearPendingReload(); // 没有重启，取消待刷新标记
									setUpPhase("idle");
									setUpPct(0);
									setView({ kind: "result", status, lines: log.slice() });
								} else {
								if (trackUpdate) setPendingTag("");
								// 按钮终态：更新与回退都变成绿色对勾（用户要的「和更新的流程一样」）。
								setUpPct(100);
								setUpStep(evt.autoRestart
									? (targetTag ? tr("回退完成，正在重启") : tr("完成，正在重启"))
									: (targetTag ? tr("回退完成，请手动重启") : tr("完成，请手动重启")));
								setUpPhase("done");
								// 自动重启后的页面刷新对更新/回退一视同仁：服务端在成功 checkout+build
								// 后会 scheduleBootVerify 并 SIGTERM 重启，客户端必须轮询 /ping 感知新进程
								// 再 location.reload()。以前这行被关在 if (trackUpdate) 里，导致从
								// 「切换到其它版本」发起的回退从不刷新，页面停在「回退完成」不动。
								// markPendingReload 已在任务开始时写入 boot 基准：页面重新加载时
								// watchPendingReload 会轮询 /ping 感知 boot 变化并自动 reload，
								// 即使 build 阶段 SSE 断开也能补上刷新。armRestartWatch 是即时通道，两者互补。
								if (evt.autoRestart) armRestartWatch(evt.restartWindowMs);
								else clearPendingReload(); // 不重启：标记已无意义
								setView({ kind: "done", result: evt, status, lines: log.slice() });
								}
							} else {
								// 按钮失败态：更新/回退都要能重试（点按钮回到 idle 并重新检查）。
								setUpPhase("error");
								clearPendingReload(); // 失败没重启，取消待刷新标记
								// 失败（ok:false）走错误视图：done 视图对失败无处理，
								// 会渲染成误导性的绿色「更新成功」。
								setView({ kind: "error", message: targetTag ? tr("回退失败") : tr("更新失败"), detail: evt.error ?? tr("未知错误"), lines: log.slice() });
							}
						} else if (evt.type === "conflict" || evt.type === "tag-health" || evt.type === "peers") {
							terminal = true;
							// 安全闸门拦截：需要用户看清楚并决定是否继续。开始时面板被收起、
							// 按钮变成进度条，若这里不重新打开，用户只会看到按钮卡在进度百分比
							// 却看不到拦截卡片（回退被 peer 冲突挡住就是这个现象）。
							measureAnchor();
							// 窗口开着就把它就地变成询问卡片；用户已经关掉则重新弹出，否则确认按钮无处可点。
							setOpen(true);
							// 独立 confirm 态：不是「更新失败」，而是等待用户决定是否越过安全闸门。
							setUpPhase("confirm");
							clearPendingReload(); // 拦截未重启；用户若继续会重新 run 并重写标记
							setUpStep(tr("需要你确认"));
							if (evt.type === "conflict") {
								setView({ kind: "conflict", conflict: evt, status, lines: log.slice(), targetTag });
							} else if (evt.type === "tag-health") {
								setView({ kind: "tag-health", health: evt, status, lines: log.slice(), targetTag, stash: !!stash, confirmPeerConflicts: !!confirmPeerConflicts });
							} else {
								setView({ kind: "peers", peers: evt, status, lines: log.slice(), targetTag, stash: !!stash, allowMissingRequiredPaths: !!allowMissingRequiredPaths });
							}
						}
					}, { stash: !!stash, targetTag, allowMissingRequiredPaths, confirmPeerConflicts, force: !!(opts && opts.force), ...net });
					// 流结束却没收到任何终态事件：服务端可能中途崩溃，或被 build 替换资源打断。
					// 必须自己收尾，否则 UI 永远停在「更新中」。
					if (!terminal && token === runToken.current) {
						setUpPhase("error");
						// 注意：流中断可能是 build 替换资源导致（服务仍会重启成功）。
						// 这里不清标记，让 watchPendingReload 在页面重载后完成刷新；
						// 若其实没重启，标记 10 分钟后自动过期，不会误刷新。
						setView({
							kind: "error",
							message: targetTag ? tr("回退失败") : tr("更新失败"),
							detail: tr("与更新服务的连接中断了（可能被构建过程打断）。请稍后重新检查版本状态。"),
							lines: log.slice(),
						});
					}
				} catch (error) {
					terminal = true;
					if (token !== runToken.current) return;
					if (error && error.status === 409) {
						setUpPhase("error");
						clearPendingReload(); // 409 没启动任务，取消标记
						setView({ kind: "error", message: tr("已有更新正在执行中"), detail: tr("请等待当前更新完成后再试。") });
						return;
					}
					setUpPhase("error");
					clearPendingReload(); // 请求层报错，任务没真正执行
					setView({ kind: "error", message: targetTag ? tr("回退失败") : tr("更新失败"), detail: String(error), lines: log.slice() });
				}
				// net 必须在依赖里：否则闭包永远捕获首次渲染的 {source:'auto'}，
				// 用户在浮层里选的镜像 / 官方+代理端口对 /run 完全不生效。
			}, [net]);

			// ---- 有进行中对话时的两步确认 ----
			// stage: null（关闭）| 'warn'（先提示）| 'confirm'（确认强制）
			const [busyStage, setBusyStage] = React.useState(null);
			const [busyCount, setBusyCount] = React.useState(0);
			const [busyStatus, setBusyStatus] = React.useState(null);
			const [busyOpts, setBusyOpts] = React.useState({});

			// 开始更新/回退前先看有没有进行中的对话；有就先弹确认，没有就直接跑。
			const guardStart = useCallback((status, opts) => {
				const busy = Number(status && status.busySessions) || 0;
				if (busy > 0) {
					setBusyCount(busy);
					setBusyStatus(status);
					setBusyOpts(opts || {});
					setBusyStage("warn");
					return;
				}
				void run(status, opts);
			}, [run]);

			const start = useCallback((status) => { guardStart(status, {}); }, [guardStart]);
			const startStash = useCallback((status, targetTag) => { guardStart(status, { stash: true, targetTag }); }, [guardStart]);
			const startRollback = useCallback((status, tag) => { guardStart(status, { targetTag: tag }); }, [guardStart]);
			const startAllowMissing = useCallback((status, targetTag, stash, confirmPeerConflicts) => {
				void run(status, { stash: !!stash, targetTag, allowMissingRequiredPaths: true, confirmPeerConflicts: !!confirmPeerConflicts, resume: true });
			}, [run]);
			const startConfirmPeers = useCallback((status, targetTag, stash, allowMissingRequiredPaths) => {
				void run(status, { stash: !!stash, targetTag, confirmPeerConflicts: true, allowMissingRequiredPaths: !!allowMissingRequiredPaths, resume: true });
			}, [run]);

			// ---- 更新/回退进度：按钮自身变成实时进度条 ----
			// phase: 'idle' | 'running' | 'done' | 'error'
			// （回退入口已合并进「检查更新」面板的「切换到其它版本」，两者共用这套状态。）
			const [upPhase, setUpPhase] = React.useState("idle");
			const [upPct, setUpPct] = React.useState(0);
			const [upStep, setUpStep] = React.useState("");
			const [upHint, setUpHint] = React.useState("");
			// 本轮任务的目标 tag：空=更新，非空=回退。按钮在「执行中/完成」里要据此选文案，
			// 而 targetTag 只在 run() 的闭包里，渲染层拿不到，所以单独存一份。
			const [upTarget, setUpTarget] = React.useState("");

			// 点击「浮层 + 触发按钮」之外的地方就收起浮层。
			// 这样打开 DSH 自己的设置/插件等面板时，我们的小窗不会傻乎乎地留在屏幕上。
			// 用 pointerdown 而不是 click：DSH 的模态一按下就吞掉事件，用 click 会收不到。
			React.useEffect(() => {
				const anyOpen = open || busyStage !== null;
				if (!anyOpen) return undefined;
				const onDown = (ev) => {
					const t = ev.target;
					if (!(t instanceof Node)) return;
					// 自己按钮（含 rowRef）里的点击不算外部。
					if (rowRef.current && rowRef.current.contains(t)) return;
					// 浮层已 portal 到 body，不在 row 里：按 data 标记查找。
					let el = t;
					while (el) {
						if (el instanceof HTMLElement && el.dataset && el.dataset.dshUpdatePop === "1") return;
						el = el.parentNode;
					}
					// 点外部只是把窗口收起来，绝不能打断正在跑的任务：
					// runToken 是「这一轮事件还要不要继续渲染」的判据，执行中递增会让
					// 后续所有进度事件因 token 不符被丢弃——窗口再打开时是一片空白。
					// 与 closePanel 保持同一条规则：只有非执行期才作废这一轮。
					if (open && upPhase !== "running") runToken.current++;
					setOpen(false);
					setBusyStage(null);
				};
				document.addEventListener("pointerdown", onDown, true);
				return () => document.removeEventListener("pointerdown", onDown, true);
			}, [open, busyStage, upPhase]);

			// 记录按钮矩形（供 fixed 浮层定位）；打开期间窗口尺寸变化也重新对齐。
			const measureAnchor = useCallback(() => {
				const el = rowRef.current;
				if (!el) return;
				const r = el.getBoundingClientRect();
				setAnchor({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
			}, []);

			// 浮层是 fixed + portal，页面滚动时不自动跟随按钮：滚动/缩放时重新测量，
			// 让浮层始终贴住按钮。capture 是为了接住内部滚动容器的事件。
			React.useEffect(() => {
				if (!open && busyStage === null) return undefined;
				const onScrollOrResize = () => measureAnchor();
				window.addEventListener("scroll", onScrollOrResize, true);
				window.addEventListener("resize", onScrollOrResize);
				return () => {
					window.removeEventListener("scroll", onScrollOrResize, true);
					window.removeEventListener("resize", onScrollOrResize);
				};
			}, [open, busyStage, measureAnchor]);

			const openPanel = useCallback(() => {
				// 执行中 / 等待确认时都只开面板、不重新 check：
				// running 的 view 是 "updating"（含逐行日志），confirm 的 view 是拦截卡片，
				// 重新 check 会用 checking 覆盖它们，用户就看不到进度/确认按钮了。
				const keepView = upPhase === "running" || upPhase === "confirm";
				if (open) { setOpen(false); return; } // 再点一次收起
				measureAnchor();
				setOpen(true);
				if (!keepView) void check(net);
			}, [check, open, upPhase, net]);

			const closePanel = useCallback(() => {
				// 执行中只隐藏面板，不递增 token：否则 run() 里的 token 比对会把后续
				// 进度事件全丢掉（更新仍在后台跑，但用户再打开面板看不到任何新进度）。
				if (upPhase !== "running") runToken.current++;
				setOpen(false);
				// done 是「本轮结束」的展示态，confirm 是「已取消确认」：关掉面板后按钮都要能再用。
				setUpPhase((phase) => (phase === "done" || phase === "confirm" ? "idle" : phase));
			}, [upPhase]);

			// 换来源：记住选择并立刻按新网络重查（网络差时用户不必关窗重开）。
			const changeNet = useCallback((next) => {
				setNet(next);
				writeNet(next); // 记住选择：下次打开面板仍是这个来源 / 端口 / 镜像
				setOpen(true);
				void check(next);
			}, [check]);

			const recheck = useCallback(() => {
				// 重新检查 = 新一轮被动检查：把 done（绿勾）和 confirm（等待确认）都收回 idle，
				// 否则取消拦截后按钮会一直停在「需要你确认」。
				setUpPhase((phase) => (phase === "done" || phase === "confirm" ? "idle" : phase));
				setUpPct(0);
				clearPendingReload(); // 取消确认：任务未执行，取消待刷新标记
				void check(net);
			}, [check, net]);

			// Unmount safety: never land on a dead component.
			useEffect(() => () => { runToken.current++ }, []);

						// Solid download glyph for 「检查更新」: arrow into a tray = pull a newer
			// build down. Drawn natively on an 18 grid and filled (no stroke), so it
			// stays crisp at 18px/20px on any device pixel ratio — a scaled 24-grid
			// outline is what used to look blurry. Strokes are ~2 device pixels wide
			// at DPR 1.5, the minimum that still reads as a solid shape.
			const icon = h("svg", {
				viewBox: "0 0 18 18", width: wide ? 18 : 20, height: wide ? 18 : 20,
				fill: "currentColor", stroke: "none", "aria-hidden": "true",
			},
				h("path", { d: "M7.9 2.2h2.2v4.5h2.3L9 11.2 5.6 6.7h2.3z" }),
				h("path", { d: "M3 11.4h2.2v2.1h7.6v-2.1H15v3.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" })
			);
			// Wide: 独占一行的整行按钮（图标 + 文字）；rail: 36px 圆形图标。
			const wideStyle = {
				display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8,
				width: "100%", height: 32, padding: "0 10px", margin: 0,
				border: "none", borderRadius: 10,
				background: "transparent", color: T.secondary, cursor: "pointer",
				fontSize: 13, lineHeight: 1, textAlign: "left",
			};
			const railStyle = {
				display: "inline-flex", alignItems: "center", justifyContent: "center",
				width: 36, height: 36, border: "none", borderRadius: "50%", padding: 0,
				background: "transparent", color: T.secondary, cursor: "pointer",
			};
// react-dom 注入失败时不能硬点按钮就炸：createPortal 需要它，
			// 缺失时降级为就地渲染（面板仍可用），而不是抛 TypeError 让面板永远打不开。
			const canPortal = ReactDOM !== null && typeof ReactDOM.createPortal === "function";
			// 面板本身是贴在按钮上方的小浮层（UpdatePanel 内部自带 position:absolute）。
			const updatePopover = h(UpdatePanel, {
				view, net, onNetChange: changeNet, mirrors,
				autoCheck, onAutoCheck: changeAutoCheck,
				width: popoverWidth(footWidth), anchor,
				onClose: closePanel, onRecheck: recheck,
				onStart: start, onStartStash: startStash, onStartRollback: startRollback,
				onAllowMissing: startAllowMissing, onConfirmPeers: startConfirmPeers,
				onRestart: restart, restartState,
			});

			// 不占满整行：按内容宽度排布，`flex: 0 1 auto` 表示「宽度按内容、空间不够
			// 时优先压缩自己」——这样窄侧栏里被挤的永远是我们，而不是把 DS Bot /
			// remote 的按钮推出可视区。父容器的 wrap 由挂载时的 effect 保证，
			// 极端窄时整体换到下一行，也不会溢出。
			// wide 且兄弟按钮跟我高度不一致时独占一行：混排高低错落很难看。
			// 其余情况保持 `0 1 auto`——按内容宽度、可与别人并排，空间不够先压缩自己。
			const rowStyle = wide
				? (needsOwnLine
					? { flex: "0 0 100%", width: "100%", minWidth: 0, display: "flex", flexWrap: "wrap", gap: 4 }
					: { flex: "0 1 auto", minWidth: 0, display: "flex", flexWrap: "wrap", gap: 4 })
				: { flex: "0 0 auto", display: "flex", gap: 2 };

			// 按钮宽度**永远跟着文案走**，不随「是否独占一行」拉伸。
			// 独占一行是行的属性（rowStyle 的 flex 0 0 100%），不是按钮的属性：
			// 之前这里给 `flex: 1 1 auto`，按钮会撑满整行，hover 底色和进度条底槽
			// 都跟着拉成一条通栏色带，和旁边 Remote 那种按内容收缩的按钮不一致。
			// `minWidth: 0` + 文字省略保证很窄时是「显示 …」而不是把整行顶出去。
			const btnStyle = wide
				? { ...wideStyle, width: "auto", flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }
				: railStyle;

			const mkBtn = (label, svgIcon, onClick, opts) => {
				// hover 离开后要回到「该状态本来的颜色」：done 态是绿色、running 态是品牌色，
				// 一律恢复成 secondary 会把它们覆盖掉（进度条执行完看不出来）。
				const baseColor = (opts && opts.style && opts.style.color) || T.secondary;
				// 同理，running 态有一层进度条轨道底色，hover 离开必须回到它而不是 transparent，
				// 否则鼠标划过一次轨道就消失，按钮又变回「一条短药丸」，看不出百分比。
				const baseBg = (opts && opts.style && opts.style.background) || "transparent";
				return h("button", {
				type: "button",
				style: { ...btnStyle, position: "relative", overflow: "hidden", ...((opts && opts.style) || {}) },
				title: (opts && opts.title) || label,
				"aria-label": label,
				disabled: !!(opts && opts.disabled),
				onClick,
				onMouseEnter: (ev) => { ev.currentTarget.style.background = T.hover; ev.currentTarget.style.color = T.label; },
				onMouseLeave: (ev) => { ev.currentTarget.style.background = baseBg; ev.currentTarget.style.color = baseColor; },
			},
				(opts && opts.fill) || null,
				svgIcon,
				wide ? h("span", { style: { fontSize: 13, whiteSpace: "nowrap", position: "relative", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "0 1 auto" } }, label) : null,
				// 「有新版本」的红点。
				//
				// 宽态（有文字）**排在文字后面**，不做绝对定位：原来 top 6 / right 6 的
				// 7px 圆点横向占 right-13..right-6，而文字右边缘在 right-10（0 10px 内边距），
				// 二者必然相撞；纵向 6..13 又正好压在 13px 字号的字头，看起来像屏幕上
				// 的一粒脏点，而不是「有新版本」的提示。
				//
				// 收起态只有图标、没有文字，右上角内侧仍是空位，那里用绝对定位更直观。
				(opts && opts.badge) ? h("span", {
					"aria-hidden": "true",
					style: wide ? {
						flex: "0 0 auto", width: 7, height: 7, borderRadius: "50%",
						marginLeft: 1, background: T.danger,
						// 一圈同色淡光：小圆点直接贴在浅底上边缘会发虚，加一圈过渡色更实。
						boxShadow: "0 0 0 2.5px color-mix(in srgb, " + T.danger + " 18%, transparent)",
					} : {
						position: "absolute", top: 5, right: 5,
						width: 7, height: 7, borderRadius: "50%", background: T.danger,
						boxShadow: "0 0 0 2px var(--dsw-alias-bg-layer-3, #fff)",
					},
				}) : null
				);
			};

			// 更新按钮的外观：正常 / 执行中（ing 文案 + 循环色带）/ 完成（绿色对勾）。
			// 有新版（后台检查发现）且不在执行/完成态：按钮文字换成「有新版本」并加红点。
			//
			// 执行中不显示百分比：服务端只报阶段、不报总时长，任何数字都是猜的，
			// 猜错了比不显示更糟（用户会以为卡住）。改为「安装中 / 构建中…」这类进行时文案，
			// 配一条匀速循环的色带表达「还在动」。
			const targetTagNow = upTarget !== "";
			const hasNew = pendingTag !== "" && upPhase === "idle";
			let updateLabel = hasNew ? (tr("有新版本")) : (tr("检查更新"));
			let updateFill = null;
			let updateIconNow = icon;
			if (upPhase === "running") {
				// upStep 现在存的就是进行时文案（见 append 里的 setUpStepIn)。
				updateLabel = wide ? (upStep || (targetTagNow ? tr("正在回退…") : tr("正在更新…"))) : "";
				ensureProgressAnim();
				updateFill = h("span", {
					"aria-hidden": "true",
					style: {
						position: "absolute", top: 0, bottom: 0, width: "45%", borderRadius: 10,
						background: "color-mix(in srgb, " + RUN_BLUE + " 45%, transparent)",
						animation: "dshUpdateSweep 1.5s linear infinite",
						pointerEvents: "none",
					},
				});
			} else if (upPhase === "done") {
				updateLabel = wide ? (targetTagNow ? tr("回退完成") : tr("更新完成")) : "";
				updateIconNow = h("svg", {
					viewBox: "0 0 18 18", width: wide ? 18 : 20, height: wide ? 18 : 20,
					fill: "none", stroke: "currentColor", strokeWidth: 2,
					strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
				}, h("path", { d: "M3.6 9.4l3.6 3.6 7.2-7.2" }));
			} else if (upPhase === "confirm") {
				// 安全闸门等待人工确认：不是失败，别显示「更新失败，重试」。
				updateLabel = wide ? tr("需要你确认") : tr("待确认");
			} else if (upPhase === "error") {
				updateLabel = wide ? (tr("更新失败，重试")) : (tr("重试"));
			}
			const busyDialogNode = busyStage !== null ? h(BusyDialog, {
				busy: busyCount,
				stage: busyStage,
				width: popoverWidth(footWidth), anchor,
				onLater: () => { setBusyStage(null); },
				onForce: () => { setBusyStage("confirm"); },
				onConfirmForce: () => {
					setBusyStage(null);
					if (busyStatus) void run(busyStatus, { ...busyOpts, force: true });
				},
			}) : null;
			return h(React.Fragment, null,
				h("div", { ref: rowRef, style: { ...rowStyle, position: "relative" }, "data-dsh-update": "row" },
					mkBtn(updateLabel, updateIconNow, () => {
						// 执行中也可以点：打开同一个浮层看实时进度（openPanel 在 running 时不重新 check）。
						// done 不是终态：点一下收回 idle 并重新检查，否则关闭自动重启的用户
						// 会永久卡在一个禁用不了的绿色对勾上（面板里的 recheck 够不到）。
						if (upPhase === "done" || upPhase === "error") {
							setUpPhase("idle");
							measureAnchor();
							setOpen(true);
							void check(net);
							return;
						}
						// confirm 态：点按钮重新打开拦截卡片让用户决定，不重置、不重新检查。
						openPanel();
					}, {
						fill: updateFill,
						// 执行中不再禁点：点开浮层看进度。进度靠 fill + 底色 + cursor 表达。
						badge: hasNew,
						title: upPhase === "running" ? ((upHint || upStep) + " · " + tr("点击查看实时进度")) : (hasNew ? tr("发现新版本 {tag}").replace("{tag}", pendingTag) : undefined),
						// 进度条底槽：不加这层底色，未填充的那部分完全透明，
						// 52% 看起来像一条占满的短药丸（视觉上等于 100%）。
						style: upPhase === "running"
							? { color: RUN_BLUE, cursor: "pointer", background: "color-mix(in srgb, " + RUN_BLUE + " 14%, transparent)" }
							: upPhase === "confirm" ? { color: T.warn, cursor: "pointer" }
							: upPhase === "done" ? { color: T.success } : undefined,
					}),
					// portal 到 body：侧栏容器有 overflow，留在原地会被裁掉；
					// 挂出去后浮层能自由越过侧栏边界（侧栏折叠时也完整可见）。
					open ? (canPortal ? ReactDOM.createPortal(updatePopover, document.body) : updatePopover) : null,

					busyDialogNode !== null ? (canPortal ? ReactDOM.createPortal(busyDialogNode, document.body) : busyDialogNode) : null
				),
			);
		}


		// ---------- cordis plugin body ----------
		// Declare the slots service: runtime provides it; this plugin's entry
		// activates once the sidebar foot seat is declared and rendered.
		const inject = ["slots"];

		function apply(ctx) {
			if (!React || !useState || !ctx.slots || typeof ctx.slots.inject !== "function") return;

			// 重启后自动刷新（不依赖 SSE）：页面（重新）加载时检查是否有待刷新标记，
			// 有就轮询 /ping 等新进程接管后自动 reload。
			watchPendingReload();

			// 接管 DSH 的语言设置（借鉴 source-code-mgmt）：client-locale 提供
			// ctx.locale（LocaleRuntime），currentLang() 实时读它；若它晚于本插件
			// 激活，单次延迟补抓，组件先按浏览器语言渲染。
			const captureLocale = () => {
				try {
					if (localeFace) return true;
					const lf = (ctx && ctx.locale) || (typeof ctx.get === "function" ? ctx.get("locale") : undefined);
					if (lf && typeof lf.getLocale === "function") {
						localeFace = lf;
						try {
							const active = lf.getLocale().active;
							if (active) updateLang = normalizeLang(active);
						} catch {}
						for (const listener of Array.from(localeReadyListeners)) {
							try { listener(); } catch {}
						}
						return true;
					}
					return false;
				} catch { return false }
			};
			// locale 服务可能比本插件晚激活好几秒（设置面板打开时才装载等）。
			// 只试一次的话，抓不到就永久停在浏览器语言——用户改语言没任何反应。
			// 这里按递增间隔多试几次，抓到即停。
			if (!captureLocale()) {
				let tries = 0;
				const retry = () => {
					if (captureLocale() || ++tries >= 12) return;
					window.setTimeout(retry, Math.min(5000, 400 * tries));
				};
				window.setTimeout(retry, 800);
			}

			// Register into the sidebar foot action list. A high order puts this
			// trigger after the other footer entries, so with the 100%-width row it
			// takes its own line BELOW them (and alone when it is the only one).
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-update",
				order: 1000,
			}, UpdateTrigger));
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
