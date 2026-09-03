/**
 * dsh-update 鈥?browser half (client.js).
 *
 * Classic-script plugin bundle (no build step): registers into the sidebar
 * foot via the official `sidebar.footer.action` list slot, with a negative
 * order so the trigger renders ABOVE the other footer entries (the
 * remote-web-ui phone trigger, order 0). The trigger is a circular update
 * icon + "鏇存柊DSH" label; clicking it opens a panel that compares the local
 * deepseek-harness version with the remote, and when a newer version exists
 * runs the update with live streamed progress.
 *
 * React is a platform module: `require("react")` resolves through the loader
 * module table. Everything is plain createElement 鈥?this file is executed
 * verbatim as a classic script.
 */
window.__ModuleLoader__.load({
	id: "dsh-update",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const PLUGIN_ID = "dsh-update";

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

		// ---------- i18n: follow DSH's language setting (Settings 鈫?General 鈫?Language), live ----------
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
		 *  娉ㄦ剰:渚濊禆鏁扮粍鍙兘鍚?localeFace,缁濅笉鑳藉惈 tick鈥斺€攅ffect 浣撳唴姣忔閮?setTick,
		 *  鑻ユ妸 tick 鏀捐繘 deps,姣忔閲嶆覆鏌撻兘浼氳 effect 閲嶈窇 鈫?鍐?setTick 鈫?鏃犻檺閲嶆覆鏌撳惊鐜?
		 *  (React 鍙嶅鎻愪氦,CPU 绌鸿浆)銆俵ocaleFace 鍙樺寲(鏅氭崟鑾?鏃?effect 鎵嶉噸璺戣ˉ璁㈤槄銆?*/
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
					en ? "Loading release notes鈥? : "姝ｅ湪鑾峰彇鏇存柊鍐呭鈥?);
			}
			if (notes.state === "error") {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					en ? "Couldn't load release notes 鈥?" : "鏃犳硶鑾峰彇鏇存柊鍐呭锛?,
					h("a", { href: "https://github.com/deepseek-ai/deepseek-harness/releases", target: "_blank", rel: "noreferrer", style: { color: T.brand } },
						en ? "see GitHub Releases 鈫? : "鏌ョ湅 GitHub Releases 鈫?));
			}
			const body = String(notes.body || "");
			// Split at the first zh/en separator line; the header line
			// `[涓枃]鈥?| [English]鈥 lives in the first (zh) part only.
			const parts = body.split(/\r?\n---\r?\n/);
			const selected = (en && parts.length > 1 ? parts[1] : parts[0]) || "";
			const lines = selected.split(/\r?\n/);
			const out = [];
			let started = false;
			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") continue;
				if (line.startsWith("---")) break; // extra separator 鈥?stop
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
						"鈥?" + cleanNoteLine(bullet[1])));
					continue;
				}
				out.push(h("p", { key: out.length, style: { margin: "2px 0", fontSize: 12.5, color: T.secondary, lineHeight: 1.6 } },
					cleanNoteLine(line)));
			}
			if (!started) {
				return h("p", { style: { margin: "10px 0 0", fontSize: 12.5, color: T.secondary } },
					en ? "No release notes for this version." : "鏈鏇存柊鏆傛棤鍐呭璇存槑銆?);
			}
			return h("div", { style: { margin: "10px 0 0", padding: "10px 12px", borderRadius: 10, background: T.layer1, maxHeight: 240, overflow: "auto" } },
				...out);
		}

		function UpdatePanel({ view, onClose, onRecheck, onStart, onStartStash, onStartRollback, onRestart, restartState }) {
			const h = React.createElement;
			const en = currentLang() === "en";

			// 鏇存柊鏃ュ織鑷姩婊氬姩锛氳繘搴﹁拷鍔犳椂 pre 鑷姩璐村簳锛涚敤鎴蜂富鍔ㄥ悜涓婃粴鍔ㄩ槄璇绘椂鏆傚仠璺熼殢锛?
			// 鐩村埌鍏堕噸鏂版粴鍥炲簳閮ㄣ€?
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

			// 鑷姩閲嶅惎鍊掕鏃讹細done 甯?autoRestart 鏃朵粠 restartInMs 璧锋瘡绉掗€掑噺锛?
			// 璁┿€屽嵆灏嗚嚜鍔ㄩ噸鍚?dsh锛圢 绉掑悗锛夈€嶆槸鐪熷疄鍊掕鏃惰€岄潪闈欐€佹枃妗堛€?
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
					// 鍋滃湪 1锛堥〉闈㈤€氬父鍦ㄦ鍓嶅凡琚嚜鍔ㄩ噸鍚墦鏂級锛涗笉浼氬嚭鐜般€? 绉掑悗銆嶃€?
					setAutoCountdown((c) => (c === null || c <= 1 ? c : c - 1));
				}, 1000);
				return () => window.clearInterval(id);
			}, [view.kind, view.result]);

			// 鍥為€€鐩爣閫夋嫨锛坮esult 瑙嗗浘锛夛細璁颁綇鐢ㄦ埛鍦?<select> 閲岄€夌殑 tag銆?
			const [rollbackTag, setRollbackTag] = React.useState(null);
			const vs = view.kind === "result" ? view.status : undefined;
			const rollbackOptions = (vs && Array.isArray(vs.tags) ? vs.tags : [])
				.filter((t) => t !== (vs && vs.localTag));

			const status =
				view.kind === "result" || view.kind === "available" || view.kind === "updating"
					? view.status
					: undefined;

			const title =
				view.kind === "done" && view.result.ok && view.result.skipped ? "宸叉槸鏈€鏂扮増鏈?
				: view.kind === "done" && view.result.ok && view.result.rollback ? "鍥為€€瀹屾垚"
				: view.kind === "done" && view.result.ok ? "鏇存柊瀹屾垚"
				: view.kind === "error" ? "鏇存柊澶辫触"
				: view.kind === "conflict" ? "鏇存柊鍙楅樆"
				: "鏇存柊DSH";

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
						"鏌ョ湅鏈鏇存柊鏃ュ織锛? + view.lines.length + " 琛岋級"),
					h("pre", { style: preStyle }, view.lines.join("\n")))
				: null;

			let body;
			if (view.kind === "checking") {
				body = h("p", { style: statusLine }, "姝ｅ湪妫€鏌ョ増鏈€?);
			} else if (view.kind === "available" && status !== undefined) {
				// 妫€娴嬪埌鏂扮増鏈細涓嶈嚜鍔ㄦ墽琛岋紝鍏堝睍绀虹増鏈姣?+ 椤甸潰鍙樼┖鐧芥彁绀?+ 銆屽紑濮嬫洿鏂般€嶆寜閽?
				const rows = [
					h("p", { key: "local", style: rowStyle },
						"鏈湴鐗堟湰锛?, h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? "鏈煡")),
					h("p", { key: "remote", style: rowStyle },
						"杩滅▼鐗堟湰锛?, h("b", { style: { color: T.success } }, status.remoteTag ?? "鏃犳硶鑾峰彇"),
						status.remoteVia === "proxy" ? "锛堢粡闀滃儚 gh-proxy.com锛? : "",
						"锛堟湁鏇存柊锛?),
				];
				const warnBox = {
					margin: "10px 0 0", padding: "10px 12px", borderRadius: 10,
					background: "var(--dsw-alias-state-warn-bg, rgba(245,158,11,.12))",
					border: "1px solid " + T.warn, color: T.label, fontSize: 13, lineHeight: 1.6,
				};
				// 鑷姩閲嶅惎鏄惁鐢熸晥鐢辨湇鍔＄鍒ゅ畾锛坰upervisor 鎵樼 / allowRestart:false 浼氱鐢級銆?
				const willAutoRestart = status.autoRestart !== false;
				const warnLines = willAutoRestart
					? [
						h("div", { key: "t", style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							"鈿?鏇存柊瀹屾垚鍚庝細鑷姩閲嶅惎 dsh锛岃纭娌℃湁杩涜涓殑宸ヤ綔鎴栧璇?),
						h("div", { key: "a" }, "鏇存柊鎴愬姛鍚?dsh 浼氳嚜鍔ㄩ噸鍚紙绾?2 绉掑悗锛夛紝灞婃椂鏁翠釜椤甸潰浼氱煭鏆傚彉绌虹櫧锛屾仮澶嶅悗鍒锋柊缃戦〉鍗冲彲鈥斺€斾絾姝ｅ湪杩涜鐨勪笅杞?/ 瀵硅瘽 / 浠诲姟鍙兘浼氳涓柇銆?),
						h("div", { key: "b" }, "鏋勫缓闃舵涔熶細鏇挎崲缃戦〉璧勬簮鏂囦欢锛岄〉闈㈠彲鑳芥彁鍓嶅彉绌虹櫧鈥斺€斿睘姝ｅ父鐜拌薄锛屽熀鏈剰鍛崇潃鏇存柊宸插畬鎴愶紝鍙樊鑷姩閲嶅惎銆?),
						h("div", { key: "c" }, "濡傛灉涓嶆柟渚跨幇鍦ㄩ噸鍚紝鍙偣鍙充笂瑙?鉁?鍏抽棴锛岀◢鍚庡啀鏉ユ洿鏂般€?)
					]
					: [
						h("div", { key: "t", style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							"鈿?鏇存柊鏈熼棿鏁翠釜椤甸潰鍙兘绐佺劧鍙樼┖鐧斤紝灞炴甯哥幇璞?),
						h("div", { key: "a" }, "鏋勫缓闃舵浼氭浛鎹㈢綉椤佃祫婧愭枃浠讹紝椤甸潰鍙兘绐佺劧鏁撮〉鍙樼┖鐧芥垨鐭殏鍗￠】鈥斺€旈〉闈㈠彉绌虹櫧鍩烘湰鎰忓懗鐫€鏇存柊宸插畬鎴愶紝鍙樊閲嶅惎鐢熸晥銆?),
						h("div", { key: "b" }, "鏈鏇存柊涓嶄細鑷姩閲嶅惎 dsh锛堝凡琚厤缃鐢ㄦ垨鐢辩郴缁熸墭绠★級锛岄〉闈㈠彉绌虹櫧鍚庤鎸?F5 鍒锋柊锛岀劧鍚庢墜鍔ㄩ噸鍚?dsh 鏈嶅姟銆?)
					];
				body = h("div", null,
					...rows,
					h("div", { style: warnBox }, ...warnLines),
					// 鏈鏇存柊鍐呭锛圙itHub Releases锛夛紝鎸?DSH 鐣岄潰璇█鏄剧ず涓?鑻辨枃娈?
					h("div", { key: "notes", style: { margin: "12px 0 0" } },
						h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } },
							(currentLang() === "en" ? "What's new in this release (" : "鏈鏇存柊鍐呭锛?) + (status.remoteTag ?? "") + ")"),
						renderReleaseNotes(h, T, view.notes)),
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", { type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: () => onStart(status) }, "寮€濮嬫洿鏂?),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, "閲嶆柊妫€鏌?)
					)
				);
			} else if (view.kind === "result" && status !== undefined) {
				const rows = [
					h("p", { key: "local", style: rowStyle },
						"鏈湴鐗堟湰锛?, h("b", { style: { color: T.label } }, status.localTag ?? status.localCommit ?? "鏈煡")),
					h("p", { key: "remote", style: rowStyle },
						"杩滅▼鐗堟湰锛?, h("b", { style: { color: T.label } }, status.remoteTag ?? "鏃犳硶鑾峰彇"),
						status.remoteVia === "proxy" ? "锛堢粡闀滃儚 gh-proxy.com锛? : ""),
				];
				if (status.error !== undefined) {
					rows.push(h("p", { key: "err", style: { ...rowStyle, color: T.warn } }, "妫€鏌ュ紓甯革細" + status.error));
				} else {
					rows.push(h("p", { key: "uptodate", style: { ...statusLine, color: T.success } }, "鉁?宸叉槸鏈€鏂帮紝鏃犻渶鏇存柊銆?));
				}
				// 宸叉槸鏈€鏂版椂浠嶆彁渚涖€岀増鏈洖閫€銆嶏細鍚庢倲鏇存柊 / 鎯虫崲鍥炴棫鐗堟湰鏃讹紝
				// 浠庢湰鍦板凡鎷夊彇鐨?dsh-v* tag 涓€変竴涓洖閫€鐩爣锛堥粯璁ょ涓€涓?= 鏈€杩戠殑鍘嗗彶鐗堟湰锛夈€?
				let rollbackBlock = null;
				if (status.error === undefined && rollbackOptions.length > 0) {
					const selected = rollbackOptions.includes(rollbackTag) ? rollbackTag : rollbackOptions[0];
					rollbackBlock = h("div", { key: "rollback", style: { margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-state-warn-bg, rgba(245,158,11,.12))", border: "1px solid " + T.warn } },
						h("p", { style: { margin: 0, fontWeight: 700, fontSize: 13, color: T.label } }, "鐗堟湰鍥為€€"),
						h("p", { style: { margin: "4px 0 0", fontSize: 12.5, color: T.secondary, lineHeight: 1.6 } },
							"鏇存柊鍚庢倲浜嗭紵鍙洖閫€鍒颁互涓嬩换涓€鍘嗗彶鐗堟湰锛堟瀯寤?+ 閲嶅惎锛岃繃绋嬩笌鏇存柊鐩稿悓锛夛細"),
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
							}, "鍥為€€鍒版鐗堟湰")),
						h("p", { style: { margin: "8px 0 0", fontSize: 12, color: T.warn, lineHeight: 1.6 } },
							status.autoRestart !== false
								? "鍥為€€瀹屾垚鍚庝細鑷姩閲嶅惎 dsh锛堢害 2 绉掑悗锛夛紝椤甸潰浼氱煭鏆傚彉绌虹櫧锛屾仮澶嶅悗鍒锋柊缃戦〉鍗冲彲鈥斺€旇纭繚娌℃湁杩涜涓殑宸ヤ綔鎴栧璇濄€?
								: "鍥為€€瀹屾垚鍚庝笉浼氳嚜鍔ㄩ噸鍚紙宸茶閰嶇疆绂佺敤鎴栫敱绯荤粺鎵樼锛夛紝璇锋墜鍔ㄩ噸鍚?dsh 鏈嶅姟銆?));
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
							? "姝ｅ湪鍥為€€鍒?" + view.targetTag + " 鈥?
							: "妫€娴嬪埌鏂扮増鏈?" + (status.remoteTag ?? "") + "锛屾鍦ㄦ洿鏂扳€?),
					h("div", { style: warnBox },
						h("div", { style: { fontWeight: 700, color: T.warn, margin: "0 0 4px" } },
							view.targetTag
								? "鈿?鍥為€€杩涜涓細瀹屾垚鍚庡皢鑷姩閲嶅惎 dsh"
								: (status.autoRestart !== false
									? "鈿?鏇存柊杩涜涓細瀹屾垚鍚庡皢鑷姩閲嶅惎 dsh"
									: "鈿?鏇存柊杩涜涓細鏁翠釜椤甸潰鍙兘绐佺劧鍙樼┖鐧斤紝灞炴甯哥幇璞?)),
						status.autoRestart !== false
							? h("div", null, view.targetTag
								? "鍥為€€鎴愬姛鍚?dsh 浼氳嚜鍔ㄩ噸鍚紙绾?2 绉掑悗锛夛紝椤甸潰浼氱煭鏆傚彉绌虹櫧鈥斺€旇鍕垮叧闂湰绐楀彛锛屾柊杩涚▼灏辩华鍚庡埛鏂扮綉椤靛嵆鍙仮澶嶃€?
								: "鏇存柊鎴愬姛鍚?dsh 浼氳嚜鍔ㄩ噸鍚紙绾?2 绉掑悗锛夛紝椤甸潰浼氱煭鏆傚彉绌虹櫧鈥斺€旇鍕垮叧闂湰绐楀彛锛屾柊杩涚▼灏辩华鍚庡埛鏂扮綉椤靛嵆鍙仮澶嶃€?)
							: h("div", null, view.targetTag
								? "鏈鍥為€€涓嶄細鑷姩閲嶅惎 dsh锛堝凡琚厤缃鐢ㄦ垨鐢辩郴缁熸墭绠★級锛岄〉闈㈠彉绌虹櫧鍚庤鎸?F5 鍒锋柊锛岀劧鍚庢墜鍔ㄩ噸鍚?dsh 鏈嶅姟銆?
								: "鏈鏇存柊涓嶄細鑷姩閲嶅惎 dsh锛堝凡琚厤缃鐢ㄦ垨鐢辩郴缁熸墭绠★級锛岄〉闈㈠彉绌虹櫧鍚庤鎸?F5 鍒锋柊锛岀劧鍚庢墜鍔ㄩ噸鍚?dsh 鏈嶅姟銆?),
						h("div", null, view.targetTag
							? "鏋勫缓闃舵浼氭浛鎹㈢綉椤佃祫婧愭枃浠讹紝椤甸潰鍙兘鎻愬墠鏁撮〉鍙樼┖鐧芥垨鐭殏鍗￠】鈥斺€旈〉闈㈠彉绌虹櫧鍩烘湰鎰忓懗鐫€鍥為€€宸插畬鎴愶紝鍙樊鑷姩閲嶅惎鐢熸晥銆?
							: "鏋勫缓闃舵浼氭浛鎹㈢綉椤佃祫婧愭枃浠讹紝椤甸潰鍙兘鎻愬墠鏁撮〉鍙樼┖鐧芥垨鐭殏鍗￠】鈥斺€旈〉闈㈠彉绌虹櫧鍩烘湰鎰忓懗鐫€鏇存柊宸插畬鎴愶紝鍙樊鑷姩閲嶅惎鐢熸晥銆?),
						status.autoRestart !== false
							? h("div", null, view.targetTag
								? "濡傛灉鍏ㄧ▼椤甸潰娌℃湁鍙樼┖鐧斤紝浼氭甯告樉绀恒€屽洖閫€瀹屾垚锛屽嵆灏嗚嚜鍔ㄩ噸鍚?dsh銆嶃€?
								: "濡傛灉鍏ㄧ▼椤甸潰娌℃湁鍙樼┖鐧斤紝浼氭甯告樉绀恒€屾洿鏂板畬鎴愶紝鍗冲皢鑷姩閲嶅惎 dsh銆嶃€?)
							: h("div", null, view.targetTag
								? "濡傛灉鍏ㄧ▼椤甸潰娌℃湁鍙樼┖鐧斤紝浼氭甯告樉绀恒€屽洖閫€瀹屾垚銆嶏紝闅忓悗鎵嬪姩閲嶅惎鍗冲彲銆?
								: "濡傛灉鍏ㄧ▼椤甸潰娌℃湁鍙樼┖鐧斤紝浼氭甯告樉绀恒€屾洿鏂板畬鎴愩€嶏紝闅忓悗鎵嬪姩閲嶅惎鍗冲彲銆?)
					),
					h("pre", { style: preStyle, ref: logRef, onScroll: onLogScroll }, view.lines.join("\n"))
				);
			} else if (view.kind === "done") {
				const r = view.result;
				const st = view.status;
				const content = [];
				if (r.skipped) {
					content.push(h("p", { key: "s", style: detail }, "鏈湴宸叉槸 " + (r.from ?? "鏈€鏂?) + "锛屾棤闇€鏇存柊銆?));
				} else {
					const head = h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" } },
						h("span", { style: { color: T.success, fontSize: 20, lineHeight: 1 } }, "鉁?),
						h("span", { style: { fontWeight: 700, fontSize: 16, color: T.label } },
							(r.rollback ? "鍥為€€鎴愬姛" : "鏇存柊鎴愬姛") + (r.to ? " " + r.to : "")),
					);
					content.push(head);
					content.push(h("p", { key: "d", style: detail },
						r.rollback
							? "宸蹭粠 " + (r.from ?? "褰撳墠鐗堟湰") + " 鍥為€€鍒?" + (r.to ?? "鐩爣鐗堟湰") + "銆?
							: "宸蹭粠 " + (r.from ?? "鏃х増鏈?) + " 鏇存柊鍒?" + (r.to ?? "鏂扮増鏈?) + "銆?));
					// 鏋勫缓鍚庢牳楠岋紙鏈嶅姟绔湪 build 鎴愬姛鍚庨噸鏂拌鍙?git 鐘舵€侊級锛?
					// 纭鏈鏇存柊瀹為檯钀藉埌鐨勭増鏈紝閬垮厤銆屾樉绀烘洿鏂板畬鎴愪絾浠嶄互涓烘湁鏇存柊銆嶇殑鍥版儜銆?
					if (r.verifiedTag && r.to && r.verifiedTag === r.to) {
						content.push(h("p", { key: "verified", style: { ...detail, color: T.success } },
							"鉁?宸茬‘璁ゅ綋鍓嶇増鏈负 " + r.verifiedTag + "锛屼笌鏈鏇存柊鐩爣涓€鑷淬€?));
					}
					if (st) {
						const rows = [];
						if (st.repoDir) rows.push(h("p", { key: "rd", style: rowStyle }, "鏇存柊鐩綍锛?, h("b", { style: { color: T.label } }, st.repoDir)));
						const commit = r.verifiedCommit || st.localCommit;
						if (commit) rows.push(h("p", { key: "rc", style: rowStyle }, "褰撳墠 commit锛?, h("b", { style: { color: T.label } }, commit)));
						if (rows.length > 0) content.push(h("div", { key: "git", style: { margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 2 } }, ...rows));
					}
					if (r.stashApplied) content.push(h("p", { key: "stash-applied", style: { ...detail, color: T.success } }, "鉁?浣犵殑鏈湴鏀瑰姩宸插湪鏇存柊鍚庤嚜鍔ㄦ仮澶嶅苟淇濈暀鍦ㄦ柊鐗堟湰涓€?));
					if (r.stashKept) content.push(h("p", { key: "stash-kept", style: { ...detail, color: T.warn } }, "鏈湴鏀瑰姩涓庢柊鐗堟湰鍐茬獊锛屽凡瀹夊叏淇濆瓨鍦?git stash锛堟湭涓㈠け锛夛紝鍙湪浠撳簱鐩綍鎵嬪姩鎵ц git stash apply 澶勭悊銆?));
					if (r.autoRestart) {
						// 鏈嶅姟绔湪鏇存柊鎴愬姛鍚庡凡瀹夋帓鑷姩閲嶅惎锛堢害 2 绉掑悗锛夛紝姝ゅ鍛婄煡鐢ㄦ埛骞舵樉绀?
						// 鐪熷疄鍊掕鏃讹細椤甸潰浼氱煭鏆傚彉绌虹櫧锛屾仮澶嶅悗鍒锋柊涓€娆″嵆鍙€?
						const when = autoCountdown !== null
							? (en ? "in " + autoCountdown + "s" : autoCountdown + " 绉掑悗")
							: (en ? "in a few seconds" : "绾?2 绉掑悗");
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.brand, fontWeight: 600 } },
							en
								? (r.rollback
									? "Rollback complete 鈥?dsh will restart automatically " + when + ". The page may go blank briefly; refresh once it is back."
									: "Update complete 鈥?dsh will restart automatically " + when + ". The page may go blank briefly; refresh once it is back.")
								: (r.rollback
									? "鍥為€€瀹屾垚锛屽嵆灏嗚嚜鍔ㄩ噸鍚?dsh锛? + when + "锛夆€﹂〉闈細鐭殏鍙樼┖鐧斤紝灞婃椂鍒锋柊缃戦〉鍗冲彲鎭㈠銆?
									: "鏇存柊瀹屾垚锛屽嵆灏嗚嚜鍔ㄩ噸鍚?dsh锛? + when + "锛夆€﹂〉闈細鐭殏鍙樼┖鐧斤紝灞婃椂鍒锋柊缃戦〉鍗冲彲鎭㈠銆?)));
					} else {
						content.push(h("p", { key: "restart-note", style: { ...detail, marginTop: 8, color: T.secondary } },
							en ? (r.rollback ? "Rollback complete. Click \u201CRestart DSH\u201D to apply immediately, or restart dsh web later."
								: "Update complete. Click \u201CRestart DSH\u201D to apply immediately, or restart dsh web later.")
								: (r.rollback ? "鍥為€€瀹屾垚銆傜偣鍑汇€岄噸鍚疍SH銆嶇珛鍗崇敓鏁堬紝鎴栫◢鍚庢墜鍔ㄩ噸鍚?dsh web銆?
									: "鏇存柊瀹屾垚銆傜偣鍑汇€岄噸鍚疍SH銆嶇珛鍗崇敓鏁堬紝鎴栫◢鍚庢墜鍔ㄩ噸鍚?dsh web銆?)));
					}
					if (logBlock !== null) content.push(h("div", { key: "log" }, logBlock));
				}
				body = h("div", null, ...content);
			} else if (view.kind === "conflict") {
				const c = view.conflict || {};
				const filesText = (c.files && c.files.length > 0) ? c.files.join("\n") : "锛堟棤娉曡В鏋愬叿浣撴枃浠讹級";
				body = h("div", null,
					h("p", { style: { ...statusLine, color: T.warn } }, view.targetTag ? "鍥為€€琚湰鍦版敼鍔ㄩ樆姝? : "鏇存柊琚湰鍦版敼鍔ㄩ樆姝?),
					h("p", { style: detail }, view.targetTag
						? "浠ヤ笅鏂囦欢瀛樺湪鏈彁浜ょ殑鏈湴淇敼锛実it 鎷掔粷瑕嗙洊浠ヤ繚鎶や綘鐨勬敼鍔ㄣ€傚彲鑷姩鏆傚瓨鍚庣户缁洖閫€锛屾垨鍏堟墜鍔ㄥ鐞嗭紙git stash / git commit锛夛紝鍐嶉噸鏂版鏌ワ細"
						: "浠ヤ笅鏂囦欢瀛樺湪鏈彁浜ょ殑鏈湴淇敼锛実it 鎷掔粷瑕嗙洊浠ヤ繚鎶や綘鐨勬敼鍔ㄣ€傚彲鑷姩鏆傚瓨鍚庣户缁洿鏂帮紝鎴栧厛鎵嬪姩澶勭悊锛坓it stash / git commit锛夛紝鍐嶉噸鏂版鏌ワ細"),
					h("pre", { style: preStyle }, filesText),
					logBlock,
					h("div", { style: { ...actions, marginTop: 14 } },
						h("button", { type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: () => onStartStash(view.status, view.targetTag) }, view.targetTag ? "鑷姩鏆傚瓨骞剁户缁洖閫€" : "鑷姩鏆傚瓨骞剁户缁洿鏂?),
						h("button", { type: "button", style: actionBtnStyle(T), onClick: onRecheck }, "閲嶆柊妫€鏌?)
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
						? "Restarting DeepSeek Harness鈥?the page will disconnect briefly; refresh once it is back."
						: "姝ｅ湪閲嶅惎 DeepSeek Harness鈥?椤甸潰浼氱煭鏆傛柇寮€锛屾柊杩涚▼灏辩华鍚庡埛鏂板嵆鍙€?);
			} else {
				const buttons = [];
				if (doneOk) {
					// 宸插畨鎺掕嚜鍔ㄩ噸鍚椂锛屾寜閽敼涓恒€岀珛鍗抽噸鍚€嶏紙鎻愬墠瑙﹀彂锛屼笉绛夐偅 8 绉掞級銆?
					const autoRestarting = !!(view.result && view.result.autoRestart);
					buttons.push(h("button", { key: "restart", type: "button", style: { ...actionBtnStyle(T), background: T.brand, color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: T.brand, fontWeight: 600 }, onClick: onRestart },
						autoRestarting ? (en ? "Restart now" : "绔嬪嵆閲嶅惎") : (en ? "Restart DSH" : "閲嶅惎DSH")));
				}
				if (showRecheck) {
					buttons.push(h("button", { key: "recheck", type: "button", style: actionBtnStyle(T), onClick: onRecheck },
						en ? "Re-check" : "閲嶆柊妫€鏌?));
				}
				if (buttons.length > 0) {
					footer = h("div", { style: { marginTop: 4 } },
						restartState === "error"
							? h("p", { key: "rerr", style: { ...detail, color: T.danger } },
								en ? "Restart failed 鈥?please restart dsh web manually." : "閲嶅惎澶辫触锛岃鎵嬪姩閲嶅惎 dsh web銆?)
							: null,
						h("div", { style: actions }, ...buttons));
				}
			}

			return h("div", { style: panel, role: "dialog", "aria-modal": "true", "aria-label": title },
				h("div", { style: headStyle },
					h("h2", { style: titleStyle }, title),
					h("button", { type: "button", style: closeBtn, "aria-label": "鍏抽棴", onClick: onClose }, "鉁?)
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
			useLocale(); // 璇█鍒囨崲鏃堕噸娓叉煋锛堟洿鏂板唴瀹归殢 DSH 鐣岄潰璇█鍒囨崲涓?鑻辨枃娈碉級

			/** 涓€閿噸鍚?dsh锛堝€熼壌 dsh-market锛氭湇鍔＄ detached helper 鎸夊師鍛戒护鎷夎捣鏂拌繘绋嬶級銆?*/
			const restart = useCallback(async () => {
				setRestartState("restarting");
				try {
					const res = await fetch("/api/dsh-update/restart", { method: "POST" });
					if (!res.ok) {
						let detail = "";
						try { detail = await res.text(); } catch {}
						throw new Error("HTTP " + String(res.status) + (detail !== "" ? ": " + detail : ""));
					}
					// 鎴愬姛鍚庢湰杩涚▼绾?500ms 閫€鍑恒€乭elper 鎺ョ鈥斺€旈〉闈細鐭殏鏂紑銆?
					// 鑻?12 绉掑悗缁勪欢浠嶅瓨娲伙紙寮傚父鎯呭喌锛夛紝鎻愮ず鎵嬪姩閲嶅惎銆?
					window.setTimeout(() => {
						setRestartState((s) => (s === "restarting" ? "error" : s));
					}, 12000);
				} catch (error) {
					setRestartState("error");
					setView({ kind: "error", message: "閲嶅惎澶辫触", detail: String(error) });
				}
			}, []);

			/** 鑷姩閲嶅惎澶辫触鍏滃簳锛歞one 鎼哄甫 autoRestart 鏃讹紝鑻?restartInMs + 缂撳啿鍚?
			 *  椤甸潰浠嶅瓨娲伙紙鏈閲嶅惎鎵撴柇锛夛紝璇存槑鑷姩閲嶅惎鍙兘鏈敓鏁堚€斺€旀妸閲嶅惎鐘舵€佺疆涓?
			 *  error锛岃鐢ㄦ埛鐪嬪埌銆岄噸鍚け璐ワ紝璇锋墜鍔ㄩ噸鍚€嶅苟鍙敤銆岀珛鍗抽噸鍚€嶆寜閽€?*/
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
					setView({ kind: "error", message: "鏃犳硶杩炴帴鏇存柊鏈嶅姟", detail: String(error) });
					return;
				}
				if (token !== runToken.current) return;
				// 鏈夋洿鏂版椂涓嶈嚜鍔ㄦ墽琛岋細鍏堝睍绀烘湰鍦?杩滅▼鐗堟湰 + 椤甸潰鍙樼┖鐧芥彁绀?+ 鏇存柊鍐呭 + 銆屽紑濮嬫洿鏂般€嶆寜閽紝
				// 鐢辩敤鎴风偣鍑诲悗鎵嶇湡姝ｆ墽琛岋紙閬垮厤鑷姩鏇存柊閫斾腑椤甸潰鍙樼┖鐧介€犳垚鍥版儜锛夈€?
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
							append("鈻?", evt.text);
						} else if (evt.type === "line") {
							append("", evt.text);
						} else if (evt.type === "notice") {
							// 鏈嶅姟绔湪鍏抽敭鑺傜偣锛堝紑濮?/ 鏋勫缓鍓嶏級鍙戦€佺殑椤甸潰鍙樼┖鐧芥彁閱?
							append("鈿?", evt.text);
						} else if (evt.type === "done") {
							if (evt.ok) {
								setView({ kind: "done", result: evt, status, lines: log.slice() });
							} else {
								// 澶辫触锛坥k:false锛夎蛋閿欒瑙嗗浘锛歞one 瑙嗗浘瀵瑰け璐ユ棤澶勭悊锛?
								// 浼氭覆鏌撴垚璇鎬х殑缁胯壊銆屾洿鏂版垚鍔熴€嶃€?
								setView({ kind: "error", message: targetTag ? "鍥為€€澶辫触" : "鏇存柊澶辫触", detail: evt.error ?? "鏈煡閿欒", lines: log.slice() });
							}
						} else if (evt.type === "conflict") {
							setView({ kind: "conflict", conflict: evt, status, lines: log.slice(), targetTag });
						}
					}, { stash: !!stash, targetTag });
				} catch (error) {
					if (token !== runToken.current) return;
					if (error && error.status === 409) {
						setView({ kind: "error", message: "宸叉湁鏇存柊姝ｅ湪鎵ц涓?, detail: "璇风瓑寰呭綋鍓嶆洿鏂板畬鎴愬悗鍐嶈瘯銆? });
						return;
					}
					setView({ kind: "error", message: targetTag ? "鍥為€€澶辫触" : "鏇存柊澶辫触", detail: String(error), lines: log.slice() });
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
					title: "鏇存柊DSH",
					"aria-label": "鏇存柊DSH",
					onClick: openPanel,
					onMouseEnter: (e) => { e.currentTarget.style.background = T.hover; e.currentTarget.style.color = T.label; },
					onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.secondary; },
				},
					icon,
					wide ? h("span", { style: { fontSize: 13 } }, "鏇存柊DSH") : null
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

			// 鎺ョ DSH 鐨勮瑷€璁剧疆锛堝€熼壌 source-code-mgmt锛夛細client-locale 鎻愪緵
			// ctx.locale锛圠ocaleRuntime锛夛紝currentLang() 瀹炴椂璇诲畠锛涜嫢瀹冩櫄浜庢湰鎻掍欢
			// 婵€娲伙紝鍗曟寤惰繜琛ユ姄锛岀粍浠跺厛鎸夋祻瑙堝櫒璇█娓叉煋銆?
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
