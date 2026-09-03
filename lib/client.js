/**
 * dsh-update — browser half (client.js).
 *
 * Classic-script plugin bundle (no build step): registers into the sidebar
 * foot via the official `sidebar.footer.action` list slot, with a negative
 * order so the trigger renders ABOVE the other footer entries (the
 * remote-web-ui phone trigger, order 0). The trigger is a circular update
 * icon + "更新DSH" label; clicking it opens a panel that compares the local
 * deepseek-harness version with the remote, and when a newer version exists
 * runs the update with live streamed progress.
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

		const { useState, useEffect, useRef, useCallback } = React;

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

		// ---------- i18n: follow DSH's language setting (Settings → General → Language), live ----------
		// Borrowed from source-code-mgmt: initial value comes from the browser
		// language; once the DSH LocaleRuntime (ctx.locale) is captured, its
		// active locale wins and switches propagate via subscribe().
		let updateLang = (() => {
			try { return String(navigator.language || "zh").toLowerCase().split("-")[0] === "en" ? "en" : "zh" } catch { return "zh" }
		})();
		let localeFace = null; // ctx.locale (the DSH LocaleRuntime), set in apply()
		function currentLang() {
			try {
				if (localeFace && typeof localeFace.getLocale === "function") {
					const active = localeFace.getLocale().active;
					if (active !== undefined && active !== null && active !== "") {
						return String(active).toLowerCase().split("-")[0] === "en" ? "en" : "zh";
					}
				}
			} catch {}
			return updateLang;
		}
		/** Re-render when DSH switches language (subscribe to the LocaleRuntime).
		 *  注意:依赖数组只能含 localeFace,绝不能含 tick——effect 体内每次都 setTick,
		 *  若把 tick 放进 deps,每次重渲染都会让 effect 重跑 → 再 setTick → 无限重渲染循环
		 *  (React 反复提交,CPU 空转)。localeFace 变化(晚捕获)时 effect 才重跑补订阅。 */
		function useLocale() {
			const [tick, setTick] = useState(0);
			useEffect(() => {
				if (!localeFace || typeof localeFace.subscribe !== "function") return;
				const off = localeFace.subscribe(() => setTick((n) => n + 1));
				setTick((n) => n + 1);
				return off;
			}, [localeFace]);
		}

		// ---------- wire helpers ----------
		async function fetchStatus() {
			const res = await fetch("/api/dsh-update/status");
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}

		/**
		 * Fetch release notes for a tag. Resolves { state: 'ok', body, htmlUrl },
		 * { state: 'loading' } is set by the caller, or { state: 'error' }.
		 */
		async function fetchReleaseNotes(tag) {
			try {
				const res = await fetch("/api/dsh-update/release-notes?tag=" + encodeURIComponent(tag));
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
			const body = opts && (opts.stash || opts.targetTag)
				? JSON.stringify({ stash: !!opts.stash, targetTag: opts.targetTag || undefined })
				: undefined;
			const res = await fetch("/api/dsh-update/run", {
				method: "POST",
				headers: body ? { "content-type": "application/json" } : undefined,
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
		//       { kind: 'done', result } | { kind: 'error', message } | { kind: 'conflict' }

		/** Strip HTML tags and light markdown markers from a release-note line. */
		function cleanNoteLine(text) {
			return String(text)
				.replace(/<[^>]*>/g, "")
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
		function renderReleaseNotes(h, T, notes) {
			const en = currentLang() === "en";
			if (!notes || notes.state === "loading") {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					en ? "Loading release notes…" : "正在获取更新内容…");
			}
			if (notes.state === "error") {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					en ? "Couldn't load release notes — " : "无法获取更新内容，",
					h("a", { href: "https://github.com/deepseek-ai/deepseek-harness/releases", target: "_blank", rel: "noreferrer", style: { color: T.brand } },
						en ? "see GitHub Releases →" : "查看 GitHub Releases →"));
			}
			const body = String(notes.body || "");
			// Split at the first zh/en separator line; the header line
			// `[中文]… | [English]…` lives in the first (zh) part only.
			const parts = body.split(/\r?\n---\r?\n/);
			const selected = (en && parts.length > 1 ? parts[1] : parts[0]) || "";
			const lines = selected.split(/\r?\n/);
			const out = [];
			let started = false;
			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") continue;
				if (line.startsWith("---")) break; // extra separator — stop
				if (line.startsWith("[")) continue; // language-switch header line
				started = true;
				const heading = /^<h3[^>]*>(.*?)<\/h3>$/.exec(line);
				if (heading !== null) {
					out.push(h("p", { key: out.length, style: { margin: "10px 0 2px", fontWeight: 700, fontSize: 13, color: T.label } },
						cleanNoteLine(heading[1])));
					continue;
				}
				const bullet = /^[*\-]\s+(.*)$/.exec(line);
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
					en ? "No release notes for this version." : "本次更新暂无内容说明。");
			}
			return h("div", { style: { margin: "10px 0 0", padding: "10px 12px", borderRadius: 10, background: T.layer1, maxHeight: 240, overflow: "auto" } },
				...out);
		}

		function UpdatePanel({ view, onClose, onRecheck, onStart, onStartStash, onStartRollback, onRestart, restartState }) {
			const h = React.createElement;
			const en = currentLang() === "en";

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

			// 回退目标选择（result 视图）：记住用户在 <select> 里选的 tag。
			const [rollbackTag, setRollbackTag] = React.useState(null);
			const vs = view.kind === "result" ? view.status : undefined;
			const rollbackOptions = (vs && Array.isArray(vs.tags) ? vs.tags : [])
				.filter((t) => t !== (vs && vs.localTag));

			const status =
				view.kind === "result" || view.kind === "available" || view.kind === "updating"
					? view.status
					: undefined;

			const title =
				view.kind === "done" && view.result.ok && view.result.skipped ? "已是最新版本"
				: view.kind === "done" && view.result.ok && view.result.rollback ? "回退完成"
				: view.kind === "done" && view.result.ok ? "更新完成"
				: view.kind === "error" ? "更新失败"
				: view.kind === "conflict" ? "更新受阻"
				: "更新DSH";

			const panel = {
				position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 12,
				width: 560, maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 48px)", overflow: "auto",
				boxSizing: "border-box", padding: 24, borderRadius: 20,
				background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border,
				color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))",
			};
			const headStyle = { display: "flex", alignItems: "flex-start", gap: 12 };
			const closeBtn = {
				appearance: "none", border: "none", background: "transparent", color: T.secondary,
				cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px", borderRadius: 6,
			};
			const titleStyle = { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4, flex: 1 };
			const detail = { margin: "6px 0 0", color: T.secondary, fontSize: 13, lineHeight: 1.6 };
			const statusLine = { margin: 0, fontWeight: 600, fontSize: 14 };
			const preStyle = {
				maxHeight: 220, margin: "10px 0 0", overflow: "auto", padding: "10px 12px",
				borderRadius: 10, background: T.layer1, color: T.secondary, fontSize: 12,
				fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", lineHeight: 1.6, whiteSpace: "pre-wrap",
			};
			const rowStyle = { display: "flex", gap: 8, fontSize: 13, color: T.secondary, margin: 0, lineHeight: 1.6 };
			const actions = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 };

			// Collapsible raw log in the final cards, so the streamed output is
			// never lost even if it arrived in one burst at the very end.
			const logBlock = view.lines && view.lines.length > 0
				? h("details", { style: { margin: "10px 0 0" } },
					h("summary", { style: { cursor: "pointer", fontSize: 12, color: T.secondary } },
						"查看本次更新日志（" + view.lines.length + " 行）"),
					h("pre", { style: preStyle }, view.lines.join("\n")))
				: null;

			let body;
			if (view.kind === "checking") {
				body = h("p", { style: statusLine }, "正在检查版本…");
			} else if (view.kind === "available" && status !== undefined) {
				// 检测到新版本：不自动执行，先展示版本对比 + 页面变空白提示 + 「开始更新」按钮
				const rows = [
					h("p", { key: "local", style: rowStyle },
						"本地版本：", h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? "未知")),
					h("p", { key: "remote", style: rowStyle },
						"远程版本：", h("b", { style: { color: T.success } }, status.remoteTag ?? "无法获取"),
						status.remoteVia === "proxy" ? "（经镜像 gh-proxy.com）" : "",
						"（有更新）"),
				];
				const warnBox = {
					margin: "10px 0 0", padding: "10px 12px", borderRadius: 10,
					background: "var(--dsw-alias-state-warn-bg, rgba(245,158,11,.12))",
					border: "1px solid " + T.warn, color: T.label, fontSize: 13, lineHeight: 1.6,
				};
				// 自动重启是否生效由服务端判定（supervisor 托管 / allowRestart:false 会禁用）。
				const willAutoRestart = status.autoRestart !== false;
				const warnLines = willAutoRestart
					? [
						h("div", { key: "t", style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							"⚠ 更新完成后会自动重启 dsh，请确认没有进行中的工作或对话"),
						h("div", { key: "a" }, "更新成功后 dsh 会自动重启（约 2 秒后），届时整个页面会短暂变空白，恢复后刷新网页即可——但正在进行的下载 / 对话 / 任务可能会被中断。"),
						h("div", { key: "b" }, "构建阶段也会替换网页资源文件，页面可能提前变空白——属正常现象，基本意味着更新已完成，只差自动重启。"),
						h("div", { key: "c" }, "如果不方便现在重启，可点右上角 ✕ 关闭，稍后再来更新。")
					]
					: [
						h("div", { key: "t", style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							"⚠ 更新期间整个页面可能突然变空白，属正常现象"),
						h("div", { key: "a" }, "构建阶段会替换网页资源文件，页面可能突然整页变空白或短暂卡顿——页面变空白基本意味着更新已完成，只差重启生效。"),
						h("div", { key: "b" }, "本次更新不会自动重启 dsh（已被配置禁用或由系统托管），页面变空白后请按 F5 刷新，然后手动重启 dsh 服务。")
					];
				body = h("div", null,
					...rows,
					h("div", { style: warnBox }, ...warnLines),
					// 本次更新内容（GitHub Releases），按 DSH 界面语言显示中/英文段
					h("div", { key: "notes", style: { margin: "12px 0 0" } },
						h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } },
							(currentLang() === "en" ? "What's new in this release (" : "本次更新内容（") + (status.remoteTag ?? "") + ")"),
						renderReleaseNotes(h, T, view.notes)),
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", { type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: () => onStart(status) }, "开始更新"),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, "重新检查")
					)
				);
			} else if (view.kind === "result" && status !== undefined) {
				const rows = [
					h("p", { key: "local", style: rowStyle },
						"本地版本：", h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? "未知")),
					h("p", { key: "remote", style: rowStyle },
						"远程版本：", h("b", { style: { color: T.label } }, status.remoteTag ?? "无法获取"),
						status.remoteVia === "proxy" ? "（经镜像 gh-proxy.com）" : ""),
				];
				if (status.error !== undefined) {
					rows.push(h("p", { key: "err", style: { ...rowStyle, color: T.warn } }, "检查异常：" + status.error));
				} else {
					rows.push(h("p", { key: "uptodate", style: { ...statusLine, color: T.success } }, "✓ 已是最新，无需更新。"));
				}
				// 已是最新时仍提供「版本回退」：后悔更新 / 想换回旧版本时，
				// 从本地已拉取的 dsh-v* tag 中选一个回退目标（默认第一个 = 最近的历史版本）。
				let rollbackBlock = null;
				if (status.error === undefined && rollbackOptions.length > 0) {
					const selected = rollbackOptions.includes(rollbackTag) ? rollbackTag : rollbackOptions[0];
					rollbackBlock = h("div", { key: "rollback", style: { margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-state-warn-bg, rgba(245,158,11,.12))", border: "1px solid " + T.warn } },
						h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } }, "版本回退"),
						h("p", { style: { margin: "4px 0 0", fontSize: 12.5, color: T.secondary, lineHeight: 1.6 } },
							"更新后悔了？可回退到以下任一历史版本（构建 + 重启，过程与更新相同）："),
						h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "8px 0 0", flexWrap: "wrap" } },
							h("select", {
								value: selected,
								onChange: (e) => setRollbackTag(e.target.value),
								style: { font: "inherit", fontSize: 13, color: T.label, background: T.layer1, border: "1px solid " + T.border, borderRadius: 8, padding: "5px 10px", maxWidth: "100%" },
							}, rollbackOptions.map((t) => h("option", { key: t, value: t }, t))),
							h("button", {
								type: "button",
								style: { ...actionBtnStyle(T), background: "transparent", color: T.warn, borderColor: T.warn, fontWeight: 600 },
								onClick: () => { if (selected) onStartRollback(status, selected); },
							}, "回退到此版本")),
						h("p", { style: { margin: "8px 0 0", fontSize: 12, color: T.warn, lineHeight: 1.6 } },
							status.autoRestart !== false
								? "回退完成后会自动重启 dsh（约 2 秒后），页面会短暂变空白，恢复后刷新网页即可——请确保没有进行中的工作或对话。"
								: "回退完成后不会自动重启（已被配置禁用或由系统托管），请手动重启 dsh 服务。"));
				}
				body = h("div", null, rows, rollbackBlock);
			} else if (view.kind === "updating" && status !== undefined) {
				const warnBox = {
					margin: "0 0 10px", padding: "10px 12px", borderRadius: 10,
					background: "var(--dsw-alias-state-warn-bg, rgba(245,158,11,.12))",
					border: "1px solid " + T.warn, color: T.label, fontSize: 13, lineHeight: 1.6,
				};
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.brand } },
						view.targetTag
							? "正在回退到 " + view.targetTag + " …"
							: "检测到新版本 " + (status.remoteTag ?? "") + "，正在更新…"),
					h("div", { style: warnBox },
						h("div", { style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							view.targetTag
								? "⚠ 回退进行中：完成后将自动重启 dsh"
								: (status.autoRestart !== false
									? "⚠ 更新进行中：完成后将自动重启 dsh"
									: "⚠ 更新进行中：整个页面可能突然变空白，属正常现象")),
						status.autoRestart !== false
							? h("div", null, view.targetTag
								? "回退成功后 dsh 会自动重启（约 2 秒后），页面会短暂变空白——请勿关闭本窗口，新进程就绪后刷新网页即可恢复。"
								: "更新成功后 dsh 会自动重启（约 2 秒后），页面会短暂变空白——请勿关闭本窗口，新进程就绪后刷新网页即可恢复。")
							: h("div", null, view.targetTag
								? "本次回退不会自动重启 dsh（已被配置禁用或由系统托管），页面变空白后请按 F5 刷新，然后手动重启 dsh 服务。"
								: "本次更新不会自动重启 dsh（已被配置禁用或由系统托管），页面变空白后请按 F5 刷新，然后手动重启 dsh 服务。"),
						h("div", null, view.targetTag
							? "构建阶段会替换网页资源文件，页面可能提前整页变空白或短暂卡顿——页面变空白基本意味着回退已完成，只差自动重启生效。"
							: "构建阶段会替换网页资源文件，页面可能提前整页变空白或短暂卡顿——页面变空白基本意味着更新已完成，只差自动重启生效。"),
						status.autoRestart !== false
							? h("div", null, view.targetTag
								? "如果全程页面没有变空白，会正常显示「回退完成，即将自动重启 dsh」。"
								: "如果全程页面没有变空白，会正常显示「更新完成，即将自动重启 dsh」。")
							: h("div", null, view.targetTag
								? "如果全程页面没有变空白，会正常显示「回退完成」，随后手动重启即可。"
								: "如果全程页面没有变空白，会正常显示「更新完成」，随后手动重启即可。")
					),
					h("pre", { style: preStyle, ref: logRef, onScroll: onLogScroll }, view.lines.join("\n"))
				);
			} else if (view.kind === "done") {
				const r = view.result;
				const st = view.status;
				const content = [];
				if (r.skipped) {
					content.push(h("p", { key: "s", style: detail }, "本地已是 " + (r.from ?? "最新") + "，无需更新。"));
				} else {
					const head = h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" } },
						h("span", { style: { color: T.success, fontSize: 20, lineHeight: 1 } }, "✓"),
						h("span", { style: { fontWeight: 700, fontSize: 16, color: T.label } },
							(r.rollback ? "回退成功" : "更新成功") + (r.to ? " " + r.to : "")),
					);
					content.push(head);
					content.push(h("p", { key: "d", style: detail },
						r.rollback
							? "已从 " + (r.from ?? "当前版本") + " 回退到 " + (r.to ?? "目标版本") + "。"
							: "已从 " + (r.from ?? "旧版本") + " 更新到 " + (r.to ?? "新版本") + "。"));
					// 构建后核验（服务端在 build 成功后重新读取 git 状态）：
					// 确认本次更新实际落到的版本，避免「显示更新完成但仍以为有更新」的困惑。
					if (r.verifiedTag && r.to && r.verifiedTag === r.to) {
						content.push(h("p", { key: "verified", style: { ...detail, color: T.success } },
							"✓ 已确认当前版本为 " + r.verifiedTag + "，与本次更新目标一致。"));
					}
					if (st) {
						const rows = [];
						if (st.repoDir) rows.push(h("p", { key: "rd", style: rowStyle }, "更新目录：", h("b", { style: { color: T.label } }, st.repoDir)));
						const commit = r.verifiedCommit || st.localCommit;
						if (commit) rows.push(h("p", { key: "rc", style: rowStyle }, "当前 commit：", h("b", { style: { color: T.label } }, commit)));
						if (rows.length > 0) content.push(h("div", { key: "git", style: { margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 2 } }, ...rows));
					}
					if (r.stashApplied) content.push(h("p", { key: "stash-applied", style: { ...detail, color: T.success } }, "✓ 你的本地改动已在更新后自动恢复并保留在新版本中。"));
					if (r.stashKept) content.push(h("p", { key: "stash-kept", style: { ...detail, color: T.warn } }, "本地改动与新版本冲突，已安全保存在 git stash（未丢失），可在仓库目录手动执行 git stash apply 处理。"));
					if (r.autoRestart) {
						// 服务端在更新成功后已安排自动重启（约 2 秒后），此处告知用户并显示
						// 真实倒计时：页面会短暂变空白，恢复后刷新一次即可。
						const when = autoCountdown !== null
							? (en ? "in " + autoCountdown + "s" : autoCountdown + " 秒后")
							: (en ? "in a few seconds" : "约 2 秒后");
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.brand, fontWeight: 600 } },
							en
								? (r.rollback
									? "Rollback complete — dsh will restart automatically " + when + ". The page may go blank briefly; refresh once it is back."
									: "Update complete — dsh will restart automatically " + when + ". The page may go blank briefly; refresh once it is back.")
								: (r.rollback
									? "回退完成，即将自动重启 dsh（" + when + "）…页面会短暂变空白，届时刷新网页即可恢复。"
									: "更新完成，即将自动重启 dsh（" + when + "）…页面会短暂变空白，届时刷新网页即可恢复。")));
					} else {
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.secondary } },
							en ? (r.rollback ? "Rollback complete. Click \u201CRestart DSH\u201D to apply immediately, or restart dsh web later."
								: "Update complete. Click \u201CRestart DSH\u201D to apply immediately, or restart dsh web later.")
								: (r.rollback ? "回退完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。"
									: "更新完成。点击「重启DSH」立即生效，或稍后手动重启 dsh web。")));
					}
					if (logBlock !== null) content.push(h("div", { key: "log" }, logBlock));
				}
				body = h("div", null, ...content);
			} else if (view.kind === "conflict") {
				const c = view.conflict || {};
				const filesText = (c.files && c.files.length > 0) ? c.files.join("\n") : "（无法解析具体文件）";
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.warn } }, view.targetTag ? "回退被本地改动阻止" : "更新被本地改动阻止"),
					h("p", { style: detail }, view.targetTag
						? "以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续回退，或先手动处理（git stash / git commit），再重新检查："
						: "以下文件存在未提交的本地修改，git 拒绝覆盖以保护你的改动。可自动暂存后继续更新，或先手动处理（git stash / git commit），再重新检查："),
					h("pre", { style: preStyle }, filesText),
					logBlock,
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", { type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: () => onStartStash(view.status, view.targetTag) }, view.targetTag ? "自动暂存并继续回退" : "自动暂存并继续更新"),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, "重新检查")
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
			const doneOk = view.kind === "done" && view.result && view.result.ok && !view.result.skipped;

			let footer = null;
			if (restartState === "restarting") {
				footer = h("p", { style: { ...detail, marginTop: 10, color: T.brand } },
					en
						? "Restarting DeepSeek Harness… the page will disconnect briefly; refresh once it is back."
						: "正在重启 DeepSeek Harness… 页面会短暂断开，新进程就绪后刷新即可。");
			} else {
				const buttons = [];
				if (doneOk) {
					// 已安排自动重启时，按钮改为「立即重启」（提前触发，不等那 8 秒）。
					const autoRestarting = !!(view.result && view.result.autoRestart);
					buttons.push(h("button", { key: "restart", type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: onRestart },
						autoRestarting ? (en ? "Restart now" : "立即重启") : (en ? "Restart DSH" : "重启DSH")));
				}
				if (showRecheck) {
					buttons.push(h("button", { key: "recheck", type: "button", style: actionBtnStyle(T), onClick: onRecheck },
						en ? "Re-check" : "重新检查"));
				}
				if (buttons.length > 0) {
					footer = h("div", { style: { marginTop: 4 } },
						restartState === "error"
							? h("p", { key: "rerr", style: { ...detail, color: T.danger } },
								en ? "Restart failed — please restart dsh web manually." : "重启失败，请手动重启 dsh web。")
							: null,
						h("div", { style: actions }, ...buttons));
				}
			}

			return h("div", { style: panel, role: "dialog", "aria-modal": "true", "aria-label": title },
				h("div", { style: headStyle },
					h("h2", { style: titleStyle }, title),
					h("button", { type: "button", style: closeBtn, "aria-label": "关闭", onClick: onClose }, "✕")
				),
				body,
				footer
			);
		}

		function actionBtnStyle() {
			return {
				appearance: "none", font: "inherit", cursor: "pointer",
				border: "1px solid " + T.border, borderRadius: 8, padding: "5px 14px",
				fontSize: 13, lineHeight: 1.5, background: "transparent", color: T.label,
			};
		}

		// ---------- the sidebar footer trigger ----------
		function UpdateTrigger({ wide }) {
			const h = React.createElement;
			const [open, setOpen] = useState(false);
			const [view, setView] = useState({ kind: "checking" });
			const [restartState, setRestartState] = useState(null); // null | 'restarting' | 'error'
			const runToken = useRef(0);
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
					setView({ kind: "error", message: "重启失败", detail: String(error) });
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

			const check = useCallback(async () => {
				setView({ kind: "checking" });
				const token = ++runToken.current;
				let status;
				try {
					status = await fetchStatus();
				} catch (error) {
					if (token !== runToken.current) return;
					setView({ kind: "error", message: "无法连接更新服务", detail: String(error) });
					return;
				}
				if (token !== runToken.current) return;
				// 有更新时不自动执行：先展示本地/远程版本 + 页面变空白提示 + 更新内容 + 「开始更新」按钮，
				// 由用户点击后才真正执行（避免自动更新途中页面变空白造成困惑）。
				if (status.outdated) {
					setView({ kind: "available", status, notes: { state: "loading" } });
					fetchReleaseNotes(status.remoteTag).then((notes) => {
						if (token !== runToken.current) return;
						setView(prev => prev.kind === "available" ? { ...prev, notes } : prev);
					});
				} else {
					setView({ kind: "result", status });
				}
			}, []);

			const run = useCallback(async (status, stash, targetTag) => {
				const token = ++runToken.current;
				const log = [];
				const append = (prefix, text) => {
					const line = prefix ? prefix + text : text;
					log.push(line);
					setView(prev => prev.kind === "updating"
						? { ...prev, lines: [...prev.lines, line] }
						: prev);
				};
				setView({ kind: "updating", status, lines: [], targetTag });
				try {
					await runUpdate((evt) => {
						if (token !== runToken.current) return;
						if (evt.type === "step") {
							append("▶ ", evt.text);
						} else if (evt.type === "line") {
							append("", evt.text);
						} else if (evt.type === "notice") {
							// 服务端在关键节点（开始 / 构建前）发送的页面变空白提醒
							append("⚠ ", evt.text);
						} else if (evt.type === "done") {
							if (evt.ok) {
								setView({ kind: "done", result: evt, status, lines: log.slice() });
							} else {
								// 失败（ok:false）走错误视图：done 视图对失败无处理，
								// 会渲染成误导性的绿色「更新成功」。
								setView({ kind: "error", message: targetTag ? "回退失败" : "更新失败", detail: evt.error ?? "未知错误", lines: log.slice() });
							}
						} else if (evt.type === "conflict") {
							setView({ kind: "conflict", conflict: evt, status, lines: log.slice(), targetTag });
						}
					}, { stash: !!stash, targetTag });
				} catch (error) {
					if (token !== runToken.current) return;
					if (error && error.status === 409) {
						setView({ kind: "error", message: "已有更新正在执行中", detail: "请等待当前更新完成后再试。" });
						return;
					}
					setView({ kind: "error", message: targetTag ? "回退失败" : "更新失败", detail: String(error), lines: log.slice() });
				}
			}, []);

			const start = useCallback((status) => { void run(status, false, undefined); }, [run]);
			const startStash = useCallback((status, targetTag) => { void run(status, true, targetTag); }, [run]);
			const startRollback = useCallback((status, tag) => { void run(status, false, tag); }, [run]);

			const openPanel = useCallback(() => {
				setOpen(true);
				void check();
			}, [check]);

			const closePanel = useCallback(() => {
				runToken.current++;
				setOpen(false);
			}, []);

			const recheck = useCallback(() => { void check(); }, [check]);

			// Unmount safety: never land on a dead component.
			useEffect(() => () => { runToken.current++ }, []);

			// Circular update icon (refresh arrows in a circle).
			const icon = h("svg", {
				viewBox: "0 0 16 16", width: wide ? 16 : 18, height: wide ? 16 : 18,
				fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				h("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89" }),
				h("path", { d: "M13.5 2.5v3h-3" })
			);

			// Wide: label + icon in a row; rail: circular icon only (36px circle).
			const wideStyle = {
				display: "inline-flex", alignItems: "center", gap: 6,
				height: 30, padding: "0 12px", border: "none", borderRadius: 15,
				background: "transparent", color: T.secondary, cursor: "pointer",
				fontSize: 13, lineHeight: 1,
			};
			const railStyle = {
				display: "inline-flex", alignItems: "center", justifyContent: "center",
				width: 36, height: 36, border: "none", borderRadius: "50%", padding: 0,
				background: "transparent", color: T.secondary, cursor: "pointer",
			};

			return h(React.Fragment, null,
				h("button", {
					type: "button",
					style: wide ? wideStyle : railStyle,
					title: "更新DSH",
					"aria-label": "更新DSH",
					onClick: openPanel,
					onMouseEnter: (e) => { e.currentTarget.style.background = T.hover; e.currentTarget.style.color = T.label; },
					onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.secondary; },
				},
					icon,
					wide ? h("span", { style: { fontSize: 13 } }, "更新DSH") : null
				),
				open ? ReactDOM.createPortal(
					h("div", { style: overlayStyle(T), role: "presentation" },
						h("div", { style: maskStyle(T), "aria-hidden": "true", onClick: closePanel }),
						h(UpdatePanel, { view, onClose: closePanel, onRecheck: recheck, onStart: start, onStartStash: startStash, onStartRollback: startRollback, onRestart: restart, restartState })
					),
					document.body
				) : null
			);
		}

		function overlayStyle() {
			return { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" };
		}
		function maskStyle() {
			return { position: "absolute", inset: 0, background: T.mask, backdropFilter: "var(--dsw-mask-blur, blur(4px))" };
		}

		// ---------- cordis plugin body ----------
		// Declare the slots service: runtime provides it; this plugin's entry
		// activates once the sidebar foot seat is declared and rendered.
		const inject = ["slots"];

		function apply(ctx) {
			if (!ctx.slots || typeof ctx.slots.inject !== "function") return;

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
							if (active) updateLang = String(active).toLowerCase().split("-")[0] === "en" ? "en" : "zh";
						} catch {}
						return true;
					}
					return false;
				} catch { return false }
			};
			if (!captureLocale()) {
				window.setTimeout(captureLocale, 1200);
			}

			// Register into the sidebar foot action list. Negative order places
			// this trigger ABOVE the other footer entries (remote-web-ui, order 0),
			// so the update circle sits on top of the phone circle in the rail.
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-update",
				order: -100,
			}, UpdateTrigger));
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
