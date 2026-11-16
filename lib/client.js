window.__ModuleLoader__.load({
	id: "dsh-connect-doubao",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region src/client/contract.ts
		/**
		* Shared contract between the host routes and the browser card.
		*
		* The types here are a MIRROR of what `src/doubao-status.ts` actually sends.
		* They are duplicated rather than imported so the browser bundle never pulls in
		* a Node module (`node:http`, the cookie jar) — importing the real route file
		* from client code would drag DPAPI and the filesystem into the renderer.
		*
		* SECURITY: this is a NUMBER view. No cookie, no token, no account id, no email
		* or phone ever crosses this boundary, and the card renders nothing else.
		*
		* @module dsh-connect-doubao/client-contract
		*/
		/** Route the card reads, relative to the Harness web server origin. */
		const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
		/**
		* Classify the payload into one account state.
		*
		* Classification is done from the HOST's error text plus the view's own shape,
		* because the host is the only side that can see the upstream error class. The
		* text is matched loosely on purpose: the host owns the wording, this side owns
		* the presentation, and a wording change must degrade to `network` rather than
		* crash the card.
		*/
		function classifyQuotaView(view) {
			if (view === void 0) return "unreadable";
			if (view.ok) return view.exhausted ? "exhausted" : "ok";
			const text = (view.error ?? "").toLowerCase();
			if (/credential|password data|dpapi|decrypt|profile|encrypted_key|local state|无法解密/i.test(text)) return "unreadable";
			if (/session cookie|sign in|login|710012001|session_dead|登录态|重新登录/i.test(text)) return "signed_out";
			if (/710022004|risk|slider|captcha|rate.?limit|风控|滑块/i.test(text)) return "risk_challenge";
			return "network";
		}
		/** Milliseconds → a compact 「3 小时 12 分」 style countdown. */
		function formatCountdown(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "—";
			const totalMinutes = Math.floor(ms / 6e4);
			const days = Math.floor(totalMinutes / 1440);
			const hours = Math.floor(totalMinutes % 1440 / 60);
			const minutes = totalMinutes % 60;
			if (days > 0) return `${days}d ${hours}h`;
			if (hours > 0) return `${hours}h ${minutes}m`;
			if (minutes > 0) return `${minutes}m`;
			return "<1m";
		}
		/** Host-side route serving the catalog for the checklist. */
		const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
		/**
		* The Host-side settings WRITE route.
		*
		* The card cannot persist through its injected `settingsScope`: on this host
		* line `set()` resolves successfully and stores nothing (see
		* `DoubaoQuotaCard.persistField`). This endpoint does the write in the Host
		* process with `settings.mutate` — the path `dsh-connect-workbuddy` and
		* `dsh-connect-trae` also use.
		*/
		const DOUBAO_SAVE_PATH = "/plugins/dsh-connect-doubao/__save";
		/** Settings field holding the ticked entry ids. */
		const DOUBAO_ENABLED_MODELS_FIELD = "enabledModelIds";
		/**
		* Read the ticked ids out of a settings snapshot.
		*
		* A snapshot that has never been saved carries `undefined`, which means "never
		* configured" — NOT "nothing ticked". The caller seeds the draft from the
		* catalog in that case so a first-time user sees a usable, fully-ticked list
		* rather than an empty one they might mistake for a bug.
		*/
		function enabledModelIdsOf(configured) {
			const value = configured?.enabledModelIds;
			if (!Array.isArray(value)) return void 0;
			return value.filter((entry) => typeof entry === "string");
		}
		/**
		* Read the tool-emulation switch out of a settings snapshot.
		*
		* `undefined` (never saved) means OFF — the emulation is opt-in, so an
		* unconfigured install must not silently start letting the model touch files.
		*/
		function toolEmulationOf(configured) {
			return configured?.toolEmulation === true;
		}
		/** Clamp a percentage into the 0-100 range the bars render. */
		function clampPercent(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return 0;
			return Math.min(100, Math.max(0, value));
		}
		/** Host route that reports the session and runs a browser sign-in on POST. */
		const DOUBAO_AUTH_PATH = "/plugins/dsh-connect-doubao/auth";
		/** Host route serving runtime session & token usage statistics. */
		const DOUBAO_STATS_PATH = "/plugins/dsh-connect-doubao/stats";
		/** Format large token totals compactly for the card UI. */
		function formatCompactTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
			return Math.round(value).toLocaleString("en-US");
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Card styling, delivered as one scoped stylesheet string.
		*
		* A string (not a CSS import) because the browser bundle is injected into the
		* host page at runtime: a `import './x.css'` would need a bundler plugin the
		* client build deliberately does not use, and a `<style>` element inserted on
		* mount keeps the card self-contained.
		*
		* Every selector is namespaced under `dbq-` so nothing here can reach a host
		* element, and every rule uses explicit colours rather than host tokens — a
		* card that inherited the host's theme variables would render unreadable the
		* moment the host renames one.
		*
		* Colours are checked for contrast against their own background (all text
		* pairs are >= 4.5:1, the WCAG AA threshold for body text).
		*
		* Visual hierarchy: one soft surface for the card, one raised panel per quota
		* window, a hairline between sections, and exactly one loud element per row
		* (the "what is left" figure). Numbers use tabular figures so a countdown
		* ticking every second does not make the line jitter.
		*
		* @module dsh-connect-doubao/client-styles
		*/
		const DOUBAO_CARD_CSS = `
.dbq-card { display: flex; flex-direction: column; gap: 16px; padding: 16px 18px;
  border: 1px solid #262b33; border-radius: 14px; color: #e8eaed;
  background:
    radial-gradient(120% 150% at 0% 0%, rgba(74, 158, 255, .12), transparent 58%),
    linear-gradient(180deg, #191c22 0%, #14161b 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04), 0 12px 30px -14px rgba(0, 0, 0, .8);
  font-size: 13px; line-height: 1.55; font-variant-numeric: tabular-nums; }

.dbq-head { display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; padding-bottom: 2px; }
.dbq-title { font-weight: 600; font-size: 15px; letter-spacing: .01em; }
.dbq-sub { color: #9aa0a6; font-size: 12px; }

.dbq-section { display: flex; flex-direction: column; gap: 10px; }
/* Hairline instead of a box per section: five bordered boxes read as a form,
   one card with dividers reads as a panel. */
.dbq-section + .dbq-section { padding-top: 16px; border-top: 1px solid #21252c; }
.dbq-section-title { font-weight: 600; font-size: 12px; letter-spacing: .05em;
  color: #b6bdc7; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* Counts and the plan name double as a pill, so they stop competing with the
   section label for the same visual weight. */
.dbq-count { color: #a8bdd4; font-size: 11px; font-weight: 500; letter-spacing: 0;
  background: #1e242c; border: 1px solid #2b323c; border-radius: 999px; padding: 1px 8px; }
.dbq-note { color: #9aa0a6; font-size: 12px; }

/* One raised panel per window: the row is the unit of the quota area, so it
   carries the surface instead of sitting bare on the card. */
.dbq-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  background: #13161b; border: 1px solid #20242b; border-radius: 10px;
  transition: border-color .15s ease, background .15s ease; }
.dbq-row:hover { border-color: #2c333d; background: #151920; }
.dbq-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dbq-label { font-weight: 500; font-size: 12.5px; color: #dfe3e8; }
/* The loud element of the row: what is left, at a size the eye lands on first. */
.dbq-figure { font-size: 14px; font-weight: 600; color: #eef2f7; white-space: nowrap; }
.dbq-figure-sub { color: #9aa0a6; font-size: 12px; font-weight: 400; }
.dbq-row-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-meta { color: #9aa0a6; font-size: 11.5px; white-space: nowrap; }
.dbq-bar { height: 8px; border-radius: 999px; background: #1c2027; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .03); }
.dbq-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #3b82f6, #60a5fa);
  box-shadow: 0 0 10px rgba(74, 158, 255, .4);
  transition: width .5s cubic-bezier(.22, .61, .36, 1), background .2s ease; }
.dbq-fill.dbq-warn { background: linear-gradient(90deg, #d97706, #fbbf24);
  box-shadow: 0 0 10px rgba(245, 166, 35, .38); }
.dbq-fill.dbq-full { background: linear-gradient(90deg, #dc2626, #ef4444);
  box-shadow: 0 0 10px rgba(229, 83, 75, .42); }

.dbq-state { display: flex; align-items: center; gap: 8px; }
.dbq-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; background: #4a9eff;
  box-shadow: 0 0 0 3px rgba(74, 158, 255, .18); }
.dbq-dot.dbq-warn { background: #f5a623; box-shadow: 0 0 0 3px rgba(245, 166, 35, .18); }
.dbq-dot.dbq-bad { background: #e5534b; box-shadow: 0 0 0 3px rgba(229, 83, 75, .2); }
.dbq-state-text { color: #e8eaed; }
.dbq-profile { color: #8b929b; font-size: 11.5px; word-break: break-all; }

.dbq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dbq-btn { appearance: none; border: 1px solid #333a44; background: #20242b; color: #e8eaed;
  border-radius: 8px; padding: 6px 11px; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .06s ease; }
.dbq-btn:hover:not(:disabled) { background: #272d36; border-color: #3f4956; }
.dbq-btn:active:not(:disabled) { transform: translateY(1px); }
.dbq-btn:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.dbq-btn:disabled { opacity: .45; cursor: not-allowed; }
.dbq-btn.dbq-primary { border-color: #3b82f6; background: #2563eb; color: #fff; }
.dbq-btn.dbq-primary:hover:not(:disabled) { background: #2f6ff0; border-color: #60a5fa; }
.dbq-btn.dbq-dirty { border-color: #f5a623; background: #3a2c15; color: #ffd79a; }
.dbq-dirty-flag { color: #f5a623; font-size: 12px; }

.dbq-models { display: flex; flex-direction: column; gap: 6px; }
.dbq-model { display: flex; align-items: flex-start; gap: 9px; padding: 7px 10px; cursor: pointer;
  border: 1px solid #20242b; border-radius: 8px; background: #13161b;
  transition: background .15s ease, border-color .15s ease; }
.dbq-model:hover { background: #161a20; border-color: #2b323c; }
.dbq-model input[type=checkbox] { margin: 2px 0 0; flex: none; accent-color: #4a9eff; }
.dbq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dbq-model-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbq-badge { font-size: 11px; color: #9fb2c8; background: #1e242c; border: 1px solid #2f3641;
  border-radius: 999px; padding: 0 7px; }
/* The multiplier the client menu prints next to a model. Monospace-ish and
   narrow so a column of them lines up; a campaign tag is outlined instead of
   filled so a temporary promo cannot read as the standing price. */
.dbq-rate { font-size: 11px; color: #ffcf7a; background: #2a2418; border: 1px solid #4a3c22;
  border-radius: 999px; padding: 0 7px; font-variant-numeric: tabular-nums; }
.dbq-rate-promo { color: #ffb4a8; background: transparent; border-style: dashed; }
/* The thinking ladder a model offers. A level the client declares but no real
   request has exercised yet is dimmed and dotted, never silently dropped. */
.dbq-levels { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.dbq-level { font-size: 11px; color: #8fa6bd; border: 1px solid #2f3641; border-radius: 6px;
  padding: 0 5px; }
.dbq-level-unverified { color: #7b8a99; border-style: dotted; }
.dbq-model-desc { color: #9aa0a6; font-size: 11px; }
.dbq-saved { color: #7fd18a; font-size: 12px; }
.dbq-error { color: #ff9d99; font-size: 12px; }

@media (prefers-reduced-motion: reduce) {
  .dbq-fill, .dbq-btn, .dbq-row, .dbq-model, .dbq-rate-trigger { transition: none; }
}

/* ---- dialog composer model-selector & toolbar multiplier control ---- */
.dbq-host-badged {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  vertical-align: baseline;
  white-space: nowrap;
}
.dbq-host-badged-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dbq-host-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
}
.dbq-host-badge[data-tone="outline"] {
  border: 0.5px solid var(--dsw-alias-border-l4, #3a404a);
  color: var(--dsw-alias-label-tertiary, #9aa0a6);
}
.dbq-host-badge[data-tone="solid"] {
  background: var(--dsw-alias-label-primary, #e6e8eb);
  color: var(--dsw-alias-bg-layer-3, #181a1f);
}
.dbq-host-badge[data-tone="neutral"] {
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, 0.14));
  color: var(--dsw-alias-label-secondary, #9aa0a6);
}
.dbq-host-badge[data-tone="quiet"] {
  color: var(--dsw-alias-label-tertiary, #9aa0a6);
}
.dbq-host-badge[data-tone="success"] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb950) 10%, transparent);
  color: var(--dsw-alias-state-success-primary, #3fb950);
}
.dbq-host-badge[data-tone="info"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a9eff) 10%, transparent);
  color: var(--dsw-alias-state-business-primary, #4a9eff);
}
.dbq-host-badge[data-tone="warning"] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d29922) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary, #d29922);
}
.dbq-host-badge[data-tone="danger"] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #f85149);
}

.dbq-picker-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
}
.dbq-picker-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbq-picker-rate {
  flex: none;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--dsw-alias-state-warn-primary, #e0a838);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e0a838) 12%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e0a838) 32%, transparent);
}
.dbq-picker-rate-promo {
  color: var(--dsw-alias-state-error-primary, #ff7b72);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7b72) 10%, transparent);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7b72) 45%, transparent);
}

.dbq-rate-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
}
.dbq-rate-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
@media (hover: hover) {
  .dbq-rate-trigger:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
    color: var(--dsw-alias-label-primary, #e6e8eb);
  }
}
.dbq-rate-trigger-open {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.14));
  color: var(--dsw-alias-label-primary, #e6e8eb);
}
.dbq-rate-trigger-promo {
  color: var(--dsw-alias-state-error-primary, #ff7b72);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7b72) 45%, transparent);
}
.dbq-rate-trigger-caret {
  font-size: 10px;
  opacity: 0.75;
}

.dbq-rate-popover {
  position: fixed;
  z-index: 9999;
  width: min(340px, calc(100vw - 24px));
  max-height: min(380px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-3, #1e2127);
  color: var(--dsw-alias-label-primary, #e6e8eb);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.3));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  font-size: 12px;
}
.dbq-rate-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dbq-rate-popover-title {
  font-weight: 600;
  font-size: 13px;
}
.dbq-rate-popover-refresh {
  padding: 2px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  font-size: 11px;
  cursor: pointer;
}
.dbq-rate-popover-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.14));
  color: var(--dsw-alias-label-primary, #e6e8eb);
}
.dbq-rate-popover-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  max-height: 250px;
}
.dbq-rate-popover-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
}
.dbq-rate-popover-row-active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
}
.dbq-rate-popover-model {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dbq-rate-popover-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbq-rate-current-tag {
  flex: none;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a9eff) 14%, transparent);
  color: var(--dsw-alias-state-business-primary, #4a9eff);
}
.dbq-rate-popover-missing,
.dbq-rate-popover-empty {
  color: var(--dsw-alias-label-tertiary, #9aa0a6);
}
.dbq-rate-popover-note {
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #9aa0a6);
  border-top: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.2));
  padding-top: 6px;
}
`;
		//#endregion
		//#region src/client/DoubaoCatalogStore.ts
		/**
		* Shared client-side store for the Doubao model catalog & active trigger mirror.
		*
		* Fetches `DOUBAO_CATALOG_PATH` lazily on mount, throttles background refreshes
		* on focus/visibility/interval, and exposes `useSyncExternalStore` hooks so
		* both the Settings checklist and dialog composer controls stay in sync.
		*/
		const REFRESH_INTERVAL_MS = 6e4;
		const MIN_FOCUS_REFRESH_GAP_MS = 15e3;
		const listeners = /* @__PURE__ */ new Set();
		let catalogSnapshot;
		let inflight;
		let lastFetchedAt = 0;
		let intervalTimer;
		let listenersAttached = false;
		const triggerBySession = /* @__PURE__ */ new Map();
		const triggerListeners = /* @__PURE__ */ new Set();
		function emitCatalog() {
			for (const listener of listeners) listener();
		}
		function emitTrigger() {
			for (const listener of triggerListeners) listener();
		}
		function isDoubaoProviderId(providerId) {
			return typeof providerId === "string" && /doubao/i.test(providerId);
		}
		function normalizeDoubaoModelId(modelId) {
			if (typeof modelId !== "string") return void 0;
			const trimmed = modelId.trim();
			if (trimmed === "") return void 0;
			return trimmed.replace(/^doubao\//i, "");
		}
		function findCatalogModelEntry(catalog, modelId) {
			if (catalog === void 0 || !catalog.ok) return void 0;
			const normalized = normalizeDoubaoModelId(modelId);
			if (normalized === void 0) return void 0;
			return catalog.models.find((entry) => entry.id === normalized || entry.id === modelId);
		}
		function resolveClientText(value, hostResolveText) {
			if (typeof value === "string") return value;
			if (value === null || value === void 0 || typeof value !== "object") return "";
			if (hostResolveText !== void 0) try {
				const resolved = hostResolveText(value);
				if (typeof resolved === "string" && resolved !== "") return resolved;
			} catch {}
			const dict = value;
			const lang = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language.toLowerCase() : "en";
			const candidates = lang.startsWith("zh") ? [
				"zh",
				"zh-CN",
				"zh-Hans",
				"en"
			] : [
				lang,
				lang.split("-")[0] ?? "",
				"en",
				"zh"
			];
			for (const key of candidates) if (key && typeof dict[key] === "string" && dict[key] !== "") return dict[key];
			for (const entry of Object.values(dict)) if (typeof entry === "string" && entry !== "") return entry;
			return "";
		}
		async function refreshDoubaoCatalog(force = false) {
			if (typeof fetch !== "function") return;
			if (!force && Date.now() - lastFetchedAt < MIN_FOCUS_REFRESH_GAP_MS && catalogSnapshot !== void 0) return;
			if (inflight !== void 0) return inflight;
			inflight = (async () => {
				try {
					const response = await fetch(DOUBAO_CATALOG_PATH);
					if (!response.ok) return;
					catalogSnapshot = await response.json();
					lastFetchedAt = Date.now();
					emitCatalog();
				} catch {} finally {
					inflight = void 0;
				}
			})();
			return inflight;
		}
		function setDoubaoCatalogSnapshot(next) {
			catalogSnapshot = next;
			lastFetchedAt = next === void 0 ? 0 : Date.now();
			emitCatalog();
		}
		function handleWindowActive() {
			if (typeof document !== "undefined" && document.hidden) return;
			refreshDoubaoCatalog(false);
		}
		function startPollingIfNeeded() {
			if (typeof window === "undefined" || typeof document === "undefined") return;
			if (intervalTimer === void 0) intervalTimer = setInterval(() => {
				if (!document.hidden) refreshDoubaoCatalog(false);
			}, REFRESH_INTERVAL_MS);
			if (!listenersAttached) {
				listenersAttached = true;
				window.addEventListener("focus", handleWindowActive);
				document.addEventListener("visibilitychange", handleWindowActive);
			}
		}
		function stopPollingIfUnused() {
			if (listeners.size > 0) return;
			if (intervalTimer !== void 0) {
				clearInterval(intervalTimer);
				intervalTimer = void 0;
			}
			if (listenersAttached && typeof window !== "undefined" && typeof document !== "undefined") {
				listenersAttached = false;
				window.removeEventListener("focus", handleWindowActive);
				document.removeEventListener("visibilitychange", handleWindowActive);
			}
		}
		function subscribeCatalog(listener) {
			listeners.add(listener);
			startPollingIfNeeded();
			if (catalogSnapshot === void 0) refreshDoubaoCatalog(true);
			return () => {
				listeners.delete(listener);
				stopPollingIfUnused();
			};
		}
		function getCatalogSnapshot() {
			return catalogSnapshot;
		}
		function useDoubaoCatalog() {
			return (0, react.useSyncExternalStore)(subscribeCatalog, getCatalogSnapshot, getCatalogSnapshot);
		}
		function recordObservedTriggerModel(sessionId, selection) {
			const key = sessionId ?? "__default__";
			const prev = triggerBySession.get(key);
			if (prev?.provider === selection.provider && prev?.model === selection.model) return;
			triggerBySession.set(key, selection);
			emitTrigger();
		}
		function getObservedTriggerModel(sessionId) {
			return triggerBySession.get(sessionId ?? "__default__");
		}
		function useObservedTriggerModel(sessionId) {
			return (0, react.useSyncExternalStore)((listener) => {
				triggerListeners.add(listener);
				return () => {
					triggerListeners.delete(listener);
				};
			}, () => getObservedTriggerModel(sessionId), () => getObservedTriggerModel(sessionId));
		}
		//#endregion
		//#region src/client/DoubaoQuotaCard.tsx
		/**
		* The Doubao quota + model card, rendered into the host's Plugin
		* configuration surface.
		*
		* SCOPE (deliberately narrow): two quota bars with reset countdowns, the plan
		* name, the account status line, a refresh button with a 5-minute poll, four
		* distinct error states, and the model checklist. No account pool, no region
		* tabs, no credit multipliers, no check-in.
		*
		* THE ONE HONESTY REQUIREMENT: Doubao is content-driven. The request body
		* carries `bot_id`, never a model id — the server picks the model after reading
		* the prompt (see `../doubao-catalog.ts`). So the checklist does NOT choose a
		* model. Ticking an entry decides whether that ENTRY appears in DSH's model
		* picker. Every label in the model block says so, because a checklist that
		* looked like model selection would be a lie the user acts on.
		*
		* SECURITY: this component renders only the allow-listed fields of
		* `DoubaoQuotaView` / `DoubaoCatalogView`. It never reads, stores or displays a
		* cookie, token or account id, and it never reads a setting other than the
		* ticked model ids.
		*
		* @module dsh-connect-doubao/client-card
		*/
		/**
		* How often the quota is re-read while the card is on screen.
		*
		* The point of the card is "how much is left", and that number changes as the
		* user works — a five-minute-old "782" is indistinguishable from a frozen
		* panel. Thirty seconds costs one small summary call and only runs while the
		* tab is visible.
		*/
		const POLL_INTERVAL_MS = 3e4;
		/** How often the local clock ticks, so countdowns move without any request. */
		const TICK_MS = 1e3;
		/**
		* Fallback translator: renders the key itself.
		*
		* Better than throwing. If the locale registration failed, the card still shows
		* its structure (bars, state dot, controls) with visible key names, which is
		* diagnosable — a thrown render would blank the slot and hide the failure.
		*/
		const fallbackT = (key) => key;
		/** Inject the stylesheet once per document. */
		function useCardStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				const id = "dbq-card-styles";
				if (document.getElementById(id) !== null) return;
				const el = document.createElement("style");
				el.id = id;
				el.textContent = DOUBAO_CARD_CSS;
				document.head?.appendChild(el);
			}, []);
		}
		/**
		* Header every write carries.
		*
		* Not a secret: it makes the request non-simple, so a hostile page cannot send
		* it without a CORS preflight — which these routes never approve. Without it the
		* host rejects the write, which is exactly what should happen to a cross-site
		* request that has no business flipping settings.
		*/
		const WRITE_HEADERS = { "x-dsh-doubao-write": "1" };
		/**
		* GET the quota view. Never throws: every failure becomes `undefined`, which
		* classifies as `unreadable` rather than unmounting the card.
		*/
		async function fetchQuota(signal) {
			const response = await fetch(DOUBAO_QUOTA_PATH, {
				method: "GET",
				credentials: "same-origin",
				signal,
				headers: { accept: "application/json" }
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** POST forces a host-side cache bypass. Same error contract as {@link fetchQuota}. */
		async function refreshQuota(signal) {
			const response = await fetch(DOUBAO_QUOTA_PATH, {
				method: "POST",
				credentials: "same-origin",
				...signal === void 0 ? {} : { signal },
				headers: {
					accept: "application/json",
					...WRITE_HEADERS
				}
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/**
		* Read the catalog for the checklist. Never throws.
		*
		* POST, not GET: the host drops its discovery memo on a write request, so the
		* list is re-read from the client's own caches instead of answered from a
		* memo up to ten minutes old. The refresh button therefore has to POST — a GET
		* would faithfully re-render a catalog it never re-read.
		*/
		async function fetchCatalog(signal) {
			const response = await fetch(DOUBAO_CATALOG_PATH, {
				method: "POST",
				credentials: "same-origin",
				signal,
				headers: {
					accept: "application/json",
					...WRITE_HEADERS
				}
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** Read runtime session & token statistics. Never throws. */
		async function fetchStats(signal) {
			const response = await fetch(DOUBAO_STATS_PATH, {
				method: "GET",
				credentials: "same-origin",
				...signal === void 0 ? {} : { signal },
				headers: { accept: "application/json" }
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** Reset runtime session & token statistics on the host. */
		async function resetStatsRequest() {
			const response = await fetch(DOUBAO_STATS_PATH, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
					accept: "application/json",
					...WRITE_HEADERS
				},
				body: JSON.stringify({ action: "reset" })
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		function formatLatencyMs(ms) {
			if (ms === null || !Number.isFinite(ms)) return "--";
			if (ms >= 1e3) return `${(ms / 1e3).toFixed(2)}s`;
			return `${Math.round(ms)}ms`;
		}
		function formatRatePercent(rate) {
			if (rate === null || !Number.isFinite(rate)) return "--";
			return `${Math.round(rate * 100)}%`;
		}
		/**
		* The trailing half of a bar's meta line: when the instant is known, when it
		* is not, or why it is not.
		*
		* "Not started yet" is not the same statement as "unknown": Doubao opens a
		* weekly window on first use, and saying 「开始使用后计时」 is the truth the app
		* itself shows, while 「重置时间未知」 would read as a server problem.
		*/
		function instantLabel(t, resetsInMs, kind) {
			if (resetsInMs !== null && resetsInMs !== void 0) return kind === "expire" ? t("quota.expiresIn", { time: formatCountdown(resetsInMs) }) : t("quota.resetsIn", { time: formatCountdown(resetsInMs) });
			return t("quota.resetUnknown");
		}
		/** One quota bar: label, used percent, bar, reset countdown. */
		function QuotaBar(props) {
			const { label, usedPercent, resetsAt, resetsInMs, startsOnUse, usedAmount, totalAmount, instantKind, t, now } = props;
			if (usedPercent === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dbq-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dbq-row-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-label",
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-meta",
						children: t("quota.windowMissing")
					})]
				})
			});
			const used = clampPercent(usedPercent);
			const percent = clampPercent(100 - used);
			const liveMs = (resetsAt !== null && resetsAt !== void 0 && resetsAt > 0 ? Math.max(0, resetsAt - now) : null) ?? resetsInMs;
			const remainingAmount = totalAmount !== null && totalAmount !== void 0 && totalAmount > 0 ? Math.max(0, totalAmount - (usedAmount ?? 0)) : null;
			const tone = percent <= 0 ? " dbq-full" : percent <= 20 ? " dbq-warn" : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dbq-row",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-row-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-label",
							children: label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-figure",
							children: remainingAmount !== null ? t("quota.remainingAmount", {
								remaining: remainingAmount,
								total: totalAmount ?? 0
							}) : t("quota.remainingPercent", { percent })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dbq-bar",
						role: "progressbar",
						"aria-valuenow": percent,
						"aria-valuetext": t("quota.remainingPercent", { percent }),
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-label": label,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `dbq-fill${tone}`,
							style: { width: `${percent}%` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-row-foot",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-meta",
							children: startsOnUse === true && (liveMs === null || liveMs === void 0) ? t("quota.startsOnUse") : instantLabel(t, liveMs, instantKind === "expire" ? "expire" : "reset")
						}), remainingAmount !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-figure-sub",
							children: t("quota.usedAmounts", {
								used: usedAmount ?? used,
								total: totalAmount ?? 0
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-meta",
						hidden: true,
						children: `now=${now}`
					})
				]
			});
		}
		function DoubaoQuotaCard(props) {
			const t = props.t ?? fallbackT;
			const scope = props.settingsScope;
			useCardStyles();
			const [quota, setQuota] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [stats, setStats] = (0, react.useState)(void 0);
			const [statsBusy, setStatsBusy] = (0, react.useState)(false);
			const [catalog, setCatalog] = (0, react.useState)(void 0);
			const [catalogBusy, setCatalogBusy] = (0, react.useState)(false);
			/** Ticking `settingsScope` bumps this so the model block re-reads the snapshot. */
			const [settingsRevision, setSettingsRevision] = (0, react.useState)(0);
			/** Only set once the settings write has been read back and confirmed. */
			const [saved, setSaved] = (0, react.useState)(false);
			const [saveError, setSaveError] = (0, react.useState)(null);
			/**
			* The settings snapshot, used ONLY as a fallback.
			*
			* The authoritative copy is now the plugin's own file, read through
			* `DOUBAO_SAVE_PATH` below: this plugin's fiber never reaches ACTIVE on DSH
			* 0.2.1, so the host neither lists nor writes its namespace (`No configurable
			* plugin entry`). A snapshot that cannot see a save is worse than no
			* snapshot, hence the file wins when both are available.
			*/
			const scopedValue = (0, react.useMemo)(() => {
				if (scope === void 0) return void 0;
				try {
					return scope.getSnapshot().value;
				} catch {
					return;
				}
			}, [scope, settingsRevision]);
			/** Settings as persisted by the plugin itself. `undefined` = not read yet. */
			const [stored, setStored] = (0, react.useState)(void 0);
			const [storeError, setStoreError] = (0, react.useState)(null);
			const loadSettings = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(DOUBAO_SAVE_PATH, { method: "GET" });
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					const body = await response.json();
					setStored(body.value);
					setStoreError(null);
				} catch (error) {
					setStoreError(error?.message ?? "unknown error");
					setStored(scope === void 0 ? void 0 : scopedValue);
				}
			}, [scope, scopedValue]);
			(0, react.useEffect)(() => {
				loadSettings();
			}, [loadSettings]);
			const configured = stored ?? scopedValue;
			/**
			* Writes go through the plugin's own endpoint, so they do NOT depend on the
			* host's `writable` flag — that flag is exactly what was false here.
			*/
			const canWrite = stored !== void 0 || storeError === null;
			(0, react.useEffect)(() => {
				if (scope === void 0) return;
				return scope.subscribe(() => setSettingsRevision((value) => value + 1));
			}, [scope]);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				const timer = setInterval(() => setNow(Date.now()), TICK_MS);
				return () => clearInterval(timer);
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				const controller = new AbortController();
				const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
				const load = async (force) => {
					const [quotaView, statsView] = await Promise.all([(force ? refreshQuota(controller.signal) : fetchQuota(controller.signal)).catch(() => void 0), fetchStats(controller.signal).catch(() => void 0)]);
					if (!alive) return;
					setQuota(quotaView);
					if (statsView !== void 0) setStats(statsView);
				};
				load(false);
				const timer = setInterval(() => {
					if (!hidden()) load(true);
				}, POLL_INTERVAL_MS);
				const onVisible = () => {
					if (!hidden()) load(true);
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					alive = false;
					controller.abort();
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, []);
			const onRefresh = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					const [quotaView, statsView] = await Promise.all([refreshQuota().catch(() => void 0), fetchStats().catch(() => void 0)]);
					setQuota(quotaView);
					if (statsView !== void 0) setStats(statsView);
				} finally {
					setBusy(false);
				}
			}, []);
			const onRefreshStats = (0, react.useCallback)(async () => {
				setStatsBusy(true);
				try {
					const next = await fetchStats();
					if (next !== void 0) setStats(next);
				} catch {} finally {
					setStatsBusy(false);
				}
			}, []);
			const onResetStats = (0, react.useCallback)(async () => {
				setStatsBusy(true);
				try {
					const next = await resetStatsRequest();
					if (next !== void 0) setStats(next);
				} catch {} finally {
					setStatsBusy(false);
				}
			}, []);
			const loadCatalog = (0, react.useCallback)(async () => {
				setCatalogBusy(true);
				try {
					const nextCatalog = await fetchCatalog(new AbortController().signal);
					setCatalog(nextCatalog);
					setDoubaoCatalogSnapshot(nextCatalog);
				} catch {
					setCatalog(void 0);
				} finally {
					setCatalogBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadCatalog();
			}, [loadCatalog]);
			/**
			* The draft: which entries are ticked.
			*
			* `undefined` means "no draft yet" — the card derives one from the catalog
			* (ticking everything, so a first-time user sees a usable picker) rather than
			* rendering an empty list that reads as a failure.
			*/
			const [draft, setDraft] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				const models = catalog?.models;
				if (models === void 0 || models.length === 0) {
					setDraft(void 0);
					return;
				}
				const savedIds = enabledModelIdsOf(configured);
				setDraft(new Set(savedIds ?? models.map((model) => model.id)));
			}, [catalog, configured]);
			const models = catalog?.models ?? [];
			const enabledCount = draft === void 0 ? 0 : draft.size;
			/**
			* Whether the draft differs from what is saved.
			*
			* Compared as SETS of ids, so reordering the catalog never marks the card
			* dirty, and a saved value that the current catalog does not contain does not
			* either. Only ids present in the catalog can be toggled, so an id that has
			* since disappeared upstream is simply ignored.
			*/
			const dirty = (0, react.useMemo)(() => {
				if (draft === void 0) return false;
				const savedIds = enabledModelIdsOf(configured);
				const base = new Set(savedIds ?? models.map((model) => model.id));
				if (base.size !== draft.size) return true;
				for (const id of base) if (!draft.has(id)) return true;
				return false;
			}, [
				draft,
				configured,
				models
			]);
			const toggle = (0, react.useCallback)((id) => {
				setDraft((current) => {
					const next = new Set(current ?? []);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
				setSaved(false);
				setSaveError(null);
			}, []);
			const selectAll = (0, react.useCallback)(() => {
				setDraft(new Set(models.map((model) => model.id)));
				setSaved(false);
				setSaveError(null);
			}, [models]);
			const selectNone = (0, react.useCallback)(() => {
				setDraft(/* @__PURE__ */ new Set());
				setSaved(false);
				setSaveError(null);
			}, []);
			/**
			* Persist one settings field through the plugin's OWN endpoint.
			*
			* Neither `scope.set()` NOR `settings.mutate` can persist this plugin: its
			* fiber never reaches ACTIVE on DSH 0.2.1, so the host reports
			* `No configurable plugin entry "dsh-connect-doubao"` and drops every write.
			* The endpoint writes a JSON file the plugin owns (write-temp-then-rename),
			* and returns the value it now reads back — so a successful response is
			* proof of persistence, not a claim.
			*/
			const persistField = (0, react.useCallback)(async (field, value) => {
				let response;
				try {
					response = await fetch(DOUBAO_SAVE_PATH, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...WRITE_HEADERS
						},
						body: JSON.stringify({
							field,
							value
						})
					});
				} catch (error) {
					throw new Error(`host save endpoint unreachable: ${error?.message ?? String(error)}`);
				}
				const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` }));
				if (!response.ok || detail.ok !== true) {
					const reason = `${String(detail.errorName ?? "")} ${String(detail.error ?? "")}`.trim();
					throw new Error(reason === "" ? `HTTP ${String(response.status)}` : reason);
				}
				setStored(detail.value);
				setStoreError(null);
				return detail.value;
			}, []);
			/**
			* Save the draft, then READ IT BACK.
			*
			* The endpoint reporting `ok` is the commit; the read-back only confirms the
			* page's own snapshot caught up. Here it matters more than usual because a
			* save discards the draft — so a snapshot that never refreshes is reported
			* rather than silently losing the user's edits.
			*/
			const onSave = (0, react.useCallback)(async () => {
				if (draft === void 0) return;
				setBusy(true);
				setSaveError(null);
				const ids = [...draft];
				try {
					const committed = enabledModelIdsOf(await persistField(DOUBAO_ENABLED_MODELS_FIELD, ids));
					if (!(committed !== void 0 && committed.length === ids.length && ids.every((id) => committed?.includes(id)))) {
						setSaveError(t("models.saveFailed", { reason: "已写入磁盘，但回读的值与提交的不一致" }));
						return;
					}
					setSaved(true);
				} catch (error) {
					setSaveError(t("models.saveFailed", { reason: error?.message ?? "unknown error" }));
				} finally {
					setBusy(false);
				}
			}, [
				persistField,
				draft,
				t
			]);
			/**
			* The tool-emulation switch.
			*
			* Written immediately (no Save button) because it is a single independent
			* toggle: bundling it into the checklist's draft would make a model-selection
			* edit and a privilege change share one commit, and the user cannot tell which
			* one they are confirming.
			*
			* Read back for the same reason the checklist is: the host's write can resolve
			* while the value never lands (see `onSave`), and silently failing to turn OFF
			* a capability that lets a model touch files is the worse error.
			*/
			const toolsOn = toolEmulationOf(configured);
			const [toolsError, setToolsError] = (0, react.useState)(null);
			const onToggleTools = (0, react.useCallback)(async (next) => {
				setToolsError(null);
				try {
					if (toolEmulationOf(await persistField("toolEmulation", next)) !== next) setToolsError(t("models.saveFailed", { reason: "已写入磁盘，但回读的值与提交的不一致" }));
				} catch (error) {
					setToolsError(t("models.saveFailed", { reason: error?.message ?? "unknown error" }));
				}
			}, [persistField, t]);
			/**
			* The session, read from its own route.
			*
			* Deliberately NOT taken from the settings snapshot: what is signed in is not
			* a setting. The route reads the sealed session itself, so it is the only
			* honest source for "signed in / expires in N days".
			*/
			const [auth, setAuth] = (0, react.useState)(void 0);
			const [authBusy, setAuthBusy] = (0, react.useState)(false);
			const [authError, setAuthError] = (0, react.useState)(null);
			const loadAuth = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(DOUBAO_AUTH_PATH, {
						method: "GET",
						headers: { accept: "application/json" }
					});
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					setAuth(await response.json());
				} catch (error) {
					setAuthError(error?.message ?? "unknown error");
				}
			}, []);
			(0, react.useEffect)(() => {
				loadAuth();
			}, [loadAuth]);
			const postAuth = (0, react.useCallback)(async () => {
				const response = await fetch(DOUBAO_AUTH_PATH, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...WRITE_HEADERS
					},
					body: JSON.stringify({ action: "login" })
				});
				const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` }));
				if (!response.ok || detail.ok !== true) throw new Error(String(detail.error ?? `HTTP ${String(response.status)}`));
				setAuth(detail);
				return detail;
			}, []);
			/**
			* Start a fresh browser sign-in.
			*
			* The route holds this request open for the whole scan, so the button has to
			* survive a multi-minute wait — `authBusy` is what keeps the user from firing
			* three overlapping browser windows.
			*/
			const relogin = (0, react.useCallback)(async () => {
				setAuthError(null);
				setAuthBusy(true);
				try {
					const view = await postAuth();
					if (!view.signedIn) setAuthError(t("auth.loginFailed", { reason: view.detail ?? "unknown error" }));
					else onRefresh();
				} catch (error) {
					setAuthError(t("auth.loginFailed", { reason: error?.message ?? "unknown error" }));
				} finally {
					setAuthBusy(false);
				}
			}, [
				postAuth,
				onRefresh,
				t
			]);
			const state = classifyQuotaView(quota);
			const stateText = t(`account.${state}`);
			const stateTone = state === "ok" ? "" : state === "exhausted" || state === "network" ? " dbq-bad" : " dbq-warn";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dbq-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-title",
							children: t("card.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-sub",
							children: t("card.subtitle")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("quota.plan") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: quota?.plan ?? "—"
								})]
							}),
							(quota?.windows.incentive ?? []).map((window, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
								label: window.label ?? t("quota.incentive"),
								usedPercent: window.usedPercent,
								resetsInMs: window.resetsInMs,
								resetsAt: window.resetsAt,
								usedAmount: window.usedAmount,
								totalAmount: window.totalAmount,
								instantKind: "expire",
								t,
								now
							}, `incentive-${index}`)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
								label: t("quota.fiveHour"),
								usedPercent: quota?.windows.fiveHour?.usedPercent,
								resetsInMs: quota?.windows.fiveHour?.resetsInMs,
								resetsAt: quota?.windows.fiveHour?.resetsAt,
								startsOnUse: quota?.windows.fiveHour?.startsOnUse,
								usedAmount: quota?.windows.fiveHour?.usedAmount,
								totalAmount: quota?.windows.fiveHour?.totalAmount,
								t,
								now
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
								label: t("quota.weekly"),
								usedPercent: quota?.windows.weekly?.usedPercent,
								resetsInMs: quota?.windows.weekly?.resetsInMs,
								resetsAt: quota?.windows.weekly?.resetsAt,
								startsOnUse: quota?.windows.weekly?.startsOnUse,
								usedAmount: quota?.windows.weekly?.usedAmount,
								totalAmount: quota?.windows.weekly?.totalAmount,
								t,
								now
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dbq-btn",
									onClick: () => void onRefresh(),
									disabled: busy,
									children: busy ? t("quota.refreshing") : t("quota.refresh")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-note",
									children: t("quota.autoNote")
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("stats.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: stats === void 0 ? "—" : t("stats.sessionsActive", { count: stats.activeConversations })
								})]
							}),
							stats === void 0 || stats.totals.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: stats === void 0 ? t("stats.loadFailed") : t("stats.empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dbq-row",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dbq-row-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-label",
											children: t("stats.requestsLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-figure",
											children: t("stats.requestsValue", {
												succeeded: stats.totals.succeeded,
												continuations: stats.totals.continuations,
												failed: stats.totals.failed
											})
										})]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dbq-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dbq-row-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-label",
											children: t("stats.totalTokensLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-figure",
											children: t("stats.totalTokensValue", {
												total: formatCompactTokens(stats.totals.totalTokens),
												input: formatCompactTokens(stats.totals.promptTokens),
												output: formatCompactTokens(stats.totals.completionTokens)
											})
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dbq-row-foot",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-meta",
											children: t("stats.tokenBreakdown", {
												uncached: formatCompactTokens(stats.totals.uncachedInputTokens),
												cached: formatCompactTokens(stats.totals.cachedInputTokens),
												reasoning: formatCompactTokens(stats.totals.reasoningTokens)
											})
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-figure-sub",
											children: t("stats.cacheHitRate", { rate: formatRatePercent(stats.totals.cacheHitRate) })
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dbq-row",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dbq-row-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-label",
											children: t("stats.latencyLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-figure",
											children: t("stats.latencyValue", {
												ttft: formatLatencyMs(stats.totals.avgTtftMs),
												tps: stats.totals.avgTps === null ? "--" : String(stats.totals.avgTps)
											})
										})]
									})
								}),
								stats.lastTurn?.upstreamContextWindow != null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dbq-row",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dbq-row-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-label",
											children: t("stats.upstreamWindowLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-meta",
											children: t("stats.upstreamWindowValue", {
												used: formatCompactTokens(stats.lastTurn.upstreamContextWindow.totalUsed),
												window: formatCompactTokens(stats.lastTurn.upstreamContextWindow.totalWindowSize),
												system: formatCompactTokens(stats.lastTurn.upstreamContextWindow.systemPrompt),
												messages: formatCompactTokens(stats.lastTurn.upstreamContextWindow.messages),
												tools: formatCompactTokens(stats.lastTurn.upstreamContextWindow.tools)
											})
										})]
									})
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: () => void onRefreshStats(),
										disabled: statsBusy,
										children: statsBusy ? t("stats.refreshing") : t("stats.refresh")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: () => void onResetStats(),
										disabled: statsBusy || (stats?.totals.requests ?? 0) === 0,
										children: t("stats.reset")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-note",
										children: t("stats.note")
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-section-title",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("account.title") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-state",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dbq-dot${stateTone}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-state-text",
									children: stateText
								})]
							}),
							quota?.profile !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-profile",
								children: [
									t("account.profile"),
									": ",
									quota.profile
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("auth.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: auth === void 0 ? "—" : auth.signedIn ? t("auth.signedIn") : t("auth.signedOut")
								})]
							}),
							auth?.signedIn === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: auth.expiresAt === null ? t("auth.expiryUnknown") : t("auth.expires", { days: auth.daysLeft ?? 0 })
							}),
							auth?.signedIn === false && auth.detail !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note dbq-warn",
								children: auth.detail
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dbq-btn dbq-primary",
									onClick: () => void relogin(),
									disabled: !canWrite || authBusy || auth === void 0,
									children: authBusy ? t("auth.relogining") : t("auth.relogin")
								})
							}),
							authError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dbq-error",
								children: authError
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("models.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: t("models.enabledCount", { count: enabledCount })
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.routingNote")
							}),
							!canWrite && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.readOnly")
							}),
							catalog === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.loadFailed")
							}),
							catalog?.ok === true && models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.empty")
							}),
							models.some((model) => model.rate !== null) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.rateNote")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-models",
								children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dbq-model",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft?.has(model.id) ?? false,
										disabled: !canWrite || draft === void 0,
										onChange: () => toggle(model.id)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dbq-model-main",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dbq-model-name",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }),
												model.badge !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dbq-badge",
													children: model.badge
												}),
												model.rate !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: model.rate.kind === "promo" ? "dbq-rate dbq-rate-promo" : "dbq-rate",
													children: model.rate.text
												})
											]
										}), model.reasoningLevels.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-levels",
											children: model.reasoningLevels.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: level.verified ? "dbq-level" : "dbq-level dbq-level-unverified",
												title: level.verified ? t("models.levelVerified") : t("models.levelUnverified"),
												children: level.name
											}, level.id))
										})]
									})]
								}, model.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: () => void loadCatalog(),
										disabled: catalogBusy,
										children: catalogBusy ? t("models.refreshing") : t("models.refresh")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: selectAll,
										disabled: !canWrite,
										children: t("models.selectAll")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: selectNone,
										disabled: !canWrite,
										children: t("models.selectNone")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `dbq-btn dbq-primary${dirty ? " dbq-dirty" : ""}`,
										onClick: () => void onSave(),
										disabled: !canWrite || !dirty || busy,
										children: busy ? t("models.saving") : t("models.save")
									}),
									dirty && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-dirty-flag",
										children: t("models.dirty")
									}),
									!dirty && saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-saved",
										children: t("models.saved")
									}),
									saveError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-error",
										children: saveError
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("tools.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: toolsOn ? t("tools.enabled") : t("tools.disabled")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("tools.note")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dbq-model",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: toolsOn,
									disabled: !canWrite,
									onChange: (event) => void onToggleTools(event.currentTarget.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-model-main",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-model-name",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("tools.toggle") })
									})
								})]
							}),
							toolsOn && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note dbq-warn",
								children: t("tools.warning")
							}),
							toolsError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dbq-error",
								children: toolsError
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/DoubaoRateControls.tsx
		/**
		* Composer model-selector multiplier controls for Doubao models.
		*
		* Contributes to two DSH composer slots:
		*  - `conversation.input.model.label`: adds each model's billing multiplier /
		*    promo pill inside the model picker rows (`option` and `menu` placements)
		*    while preserving host badge/name rendering for all non-Doubao providers.
		*  - `conversation.input.right`: renders an interactive multiplier pill right
		*    beside the model selector trigger when a Doubao model is active, opening
		*    a portal popover with the full model multiplier table and refresh action.
		*/
		const STYLE_ELEMENT_ID = "dsh-connect-doubao-styles";
		/** Ensure plugin CSS is present in `<head>` even before Settings is opened. */
		function ensureDoubaoStyles() {
			if (typeof document === "undefined" || !document.head) return;
			let existing = document.getElementById(STYLE_ELEMENT_ID);
			if (existing === null) {
				existing = document.createElement("style");
				existing.id = STYLE_ELEMENT_ID;
				document.head.appendChild(existing);
			}
			if (existing.textContent !== DOUBAO_CARD_CSS) existing.textContent = DOUBAO_CARD_CSS;
		}
		function RatePill({ rate, tooltip }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: rate.kind === "promo" ? "dbq-picker-rate dbq-picker-rate-promo" : "dbq-picker-rate",
				...tooltip !== void 0 ? { title: tooltip } : {},
				children: rate.text
			});
		}
		function HostBadge({ badge, resolveText }) {
			const label = resolveClientText(badge.text, resolveText);
			if (label === "") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dbq-host-badge",
				"data-tone": badge.tone ?? "neutral",
				children: label
			});
		}
		/**
		* Custom model label rendered inside DSH's `conversation.input.model.label`.
		*
		* Non-Doubao providers keep the exact host badge+name presentation so
		* replacing the single slot never alters other providers' appearance.
		*/
		function DoubaoModelOptionLabel({ provider, model, placement, sessionId, t, resolveText }) {
			const isDoubao = isDoubaoProviderId(provider.id);
			const catalog = useDoubaoCatalog();
			(0, react.useEffect)(() => {
				ensureDoubaoStyles();
			}, []);
			(0, react.useEffect)(() => {
				if (placement === "trigger") recordObservedTriggerModel(sessionId, {
					provider: provider.id,
					model: model.id
				});
			}, [
				placement,
				sessionId,
				provider.id,
				model.id
			]);
			if (!isDoubao) {
				if (model.badge === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: model.name });
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dbq-host-badged",
					children: [
						placement === "trigger" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostBadge, {
							badge: model.badge,
							resolveText
						}), " "] }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-host-badged-text",
							children: model.name
						}),
						placement === "trigger" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostBadge, {
							badge: model.badge,
							resolveText
						})] })
					]
				});
			}
			if (placement === "trigger") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dbq-picker-label",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dbq-picker-name",
					children: model.name
				})
			});
			const rate = findCatalogModelEntry(catalog, model.id)?.rate ?? null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dbq-picker-label",
				"data-placement": placement,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-picker-name",
						children: model.name
					}),
					model.badge !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostBadge, {
						badge: model.badge,
						resolveText
					}),
					rate !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RatePill, {
						rate,
						tooltip: t("picker.rateTooltip")
					})
				]
			});
		}
		function computePopoverCoords(anchor) {
			if (anchor === null || typeof window === "undefined") return {
				bottom: 64,
				right: 16
			};
			const rect = anchor.getBoundingClientRect();
			const right = Math.max(12, Math.round(window.innerWidth - rect.right));
			return {
				bottom: Math.max(12, Math.round(window.innerHeight - rect.top + 8)),
				right
			};
		}
		/**
		* Interactive multiplier control placed in `conversation.input.right`
		* directly adjacent to the dialog model selector button.
		*/
		function DoubaoComposerRateControl({ sessionId, useProjection, t }) {
			const projected = useProjection?.("modelSelection");
			const observed = useObservedTriggerModel(sessionId);
			const selection = projected?.next ?? projected?.lastUsed ?? observed;
			const isDoubao = isDoubaoProviderId(selection?.provider);
			const catalog = useDoubaoCatalog();
			const [open, setOpen] = (0, react.useState)(false);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [coords, setCoords] = (0, react.useState)({
				bottom: 64,
				right: 16
			});
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				ensureDoubaoStyles();
			}, []);
			(0, react.useLayoutEffect)(() => {
				if (!open) return;
				setCoords(computePopoverCoords(rootRef.current));
				const reposition = () => setCoords(computePopoverCoords(rootRef.current));
				window.addEventListener("resize", reposition);
				return () => window.removeEventListener("resize", reposition);
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (target === null) return;
					if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			if (!isDoubao) return null;
			const activeModelId = selection?.model;
			const activeEntry = findCatalogModelEntry(catalog, activeModelId);
			const activeRate = activeEntry?.rate ?? null;
			const pillText = activeRate !== null ? t("picker.controlLabel", { rate: activeRate.text }) : t("picker.controlUnknown");
			const ariaLabel = t("picker.controlAria", { rate: activeRate?.text ?? t("picker.rateUnavailable") });
			const models = catalog?.ok === true ? catalog.models : [];
			const onRefresh = async () => {
				setRefreshing(true);
				try {
					await refreshDoubaoCatalog(true);
				} finally {
					setRefreshing(false);
				}
			};
			const popover = open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: panelRef,
				className: "dbq-rate-popover",
				role: "dialog",
				"aria-label": t("picker.popoverTitle"),
				style: {
					bottom: `${coords.bottom}px`,
					right: `${coords.right}px`
				},
				onMouseDown: (event) => {
					if (event.target instanceof Element && event.target.closest("button") !== null) event.preventDefault();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-rate-popover-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-rate-popover-title",
							children: t("picker.popoverTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dbq-rate-popover-refresh",
							onClick: () => void onRefresh(),
							disabled: refreshing,
							children: refreshing ? t("picker.refreshing") : t("picker.refresh")
						})]
					}),
					models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dbq-rate-popover-empty",
						children: t("picker.empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dbq-rate-popover-list",
						children: models.map((entry) => {
							const current = activeEntry?.id === entry.id || entry.id === activeModelId;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: current ? "dbq-rate-popover-row dbq-rate-popover-row-active" : "dbq-rate-popover-row",
								"data-active": current ? "true" : void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dbq-rate-popover-model",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-rate-popover-name",
											children: entry.name
										}),
										entry.badge !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-badge",
											children: entry.badge
										}),
										current && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dbq-rate-current-tag",
											children: t("picker.currentBadge")
										})
									]
								}), entry.rate !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RatePill, { rate: entry.rate }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-rate-popover-missing",
									children: t("picker.rateUnavailable")
								})]
							}, entry.id);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dbq-rate-popover-note",
						children: t("models.rateNote")
					})
				]
			}) : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: "dbq-rate-control",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: `dbq-rate-trigger${activeRate?.kind === "promo" ? " dbq-rate-trigger-promo" : ""}${open ? " dbq-rate-trigger-open" : ""}`,
					"aria-expanded": open,
					"aria-haspopup": "dialog",
					"aria-label": ariaLabel,
					title: t("picker.rateTooltip"),
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => setOpen((was) => !was),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-rate-trigger-text",
						children: pillText
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-rate-trigger-caret",
						"aria-hidden": "true",
						children: "▾"
					})]
				}), popover !== null && (typeof document !== "undefined" && document.body ? (0, react_dom.createPortal)(popover, document.body) : popover)]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Bilingual copy for the Doubao plugin card.
		*
		* Same key/value system the reference connector uses: one flat key map per
		* language, and a `t` bound at registration time. Keys are the contract —
		* `Translate` is typed against `zh`'s keys, so adding a key to `en` and not to
		* `zh` (or vice versa) is a type error rather than a runtime `undefined`.
		*
		* @module dsh-connect-doubao/client-locales
		*/
		/** Chinese copy. The key set that defines the contract. */
		const zh = {
			"card.title": "豆包连接",
			"card.subtitle": "浏览器扫码登录一次，之后纯 HTTP 调用，不依赖豆包客户端。",
			"card.navLabel": "豆包",
			"quota.plan": "套餐",
			"quota.fiveHour": "5 小时限额",
			"quota.weekly": "周额度",
			"quota.used": "已用 {percent}%",
			"quota.resetsIn": "{time} 后重置",
			"quota.refresh": "刷新额度",
			"quota.refreshing": "刷新中…",
			"quota.autoNote": "每 5 分钟自动刷新",
			"quota.updatedAt": "更新于 {time}",
			"quota.windowMissing": "本套餐不含此额度",
			"quota.resetUnknown": "重置时间未知",
			"quota.startsOnUse": "开始使用后计时",
			"quota.expiresIn": "{time} 后到期",
			"quota.incentive": "赠送额度",
			"quota.usedAmounts": "已用 {used} / {total}",
			"quota.remainingAmount": "剩 {remaining} / {total}",
			"quota.remainingPercent": "剩 {percent}%",
			"account.title": "账号状态",
			"account.ok": "已登录",
			"account.signed_out": "未登录：请点下面的「重新登录」扫码一次",
			"account.unreadable": "登录信息读不出来：本机保存的会话无法解密，请重新登录一次",
			"account.session_dead": "登录态已失效：请点「重新登录」重新扫码",
			"account.risk_challenge": "触发了风控验证：请在弹出的登录窗口里手动完成滑块验证",
			"account.exhausted": "额度已用尽：等待窗口重置，或在豆包客户端查看「订阅与额度管理」",
			"account.network": "连接豆包失败：请检查网络后重试",
			"account.unknown": "状态未知",
			"account.profile": "配置目录",
			"models.title": "模型",
			"models.enabledCount": "已启用 {count} ↑",
			"models.routingNote": "清单、倍率、思考档位都直接读自豆包客户端菜单，豆包上新或调价会自动出现，不需要等插件更新。带「工作任务」徽章的条目走任务模式与会员付费额度，插件会自动完成本地指令应答。缓存的档位是蓝图，实线=已在真实请求中验证，虚线=仅菜单声明",
			"models.refresh": "刷新",
			"models.refreshing": "刷新中…",
			"models.save": "保存",
			"models.saving": "保存中…",
			"models.discard": "放弃更改",
			"models.selectAll": "全选",
			"models.selectNone": "全不选",
			"models.dirty": "有未保存的更改",
			"models.saved": "已保存",
			"models.saveFailed": "保存失败：{reason}",
			"models.tier": "档位",
			"models.tierFast": "快速",
			"models.tierThink": "思考",
			"models.tierExpert": "专家",
			"models.readOnly": "当前宿主未提供设置写入通道，勾选不会生效",
			"models.loadFailed": "模型目录读取失败",
			"models.empty": "没有可用的模型条目",
			"models.levelVerified": "已在真实请求中验证",
			"models.levelUnverified": "客户端菜单声明，尚未在真实请求中验证",
			"models.rateNote": "倍率来自豆包客户端菜单，仅作展示；本插件不参与计费，也无法核对实际扣费",
			"tools.title": "实验性：工具调用",
			"tools.toggle": "让豆包驱动本地工具（读写文件、执行命令）",
			"tools.note": "豆包的接口没有函数调用通道（声明的 tools 会被静默忽略），此开关改用提示词模拟：把工具清单写进提示词，再把回复里的围栏解析回标准 tool_calls。实测约 11.5 秒/轮，复杂任务可能退化，故默认关闭。",
			"tools.warning": "开启后豆包可以读写这台机器上的文件。请确认你信任当前会话的权限范围。",
			"tools.enabled": "已开启",
			"tools.disabled": "已关闭",
			"auth.title": "登录方式",
			"auth.signedIn": "已登录",
			"auth.signedOut": "未登录",
			"auth.expires": "{days} 天后到期",
			"auth.expiryUnknown": "到期时间未知",
			"auth.relogin": "重新登录",
			"auth.relogining": "等待扫码…",
			"auth.loginFailed": "登录失败：{reason}",
			"picker.controlLabel": "倍率 {rate}",
			"picker.controlUnknown": "倍率 --",
			"picker.controlAria": "查看豆包模型倍率（当前 {rate}）",
			"picker.popoverTitle": "豆包模型倍率",
			"picker.refresh": "刷新",
			"picker.refreshing": "刷新中…",
			"picker.currentBadge": "当前",
			"picker.rateTooltip": "豆包客户端菜单标示的计费倍率（仅供参考）",
			"picker.empty": "暂无模型倍率信息",
			"picker.rateUnavailable": "--",
			"stats.title": "会话统计与 Token 用量",
			"stats.sessionsActive": "活跃会话 {count}",
			"stats.empty": "本次会话启动后暂无已完成的对话轮次",
			"stats.loadFailed": "未能读取会话统计信息",
			"stats.requestsLabel": "请求与会话",
			"stats.requestsValue": "{succeeded} 次成功 · {continuations} 次续接 · {failed} 次失败",
			"stats.totalTokensLabel": "累计 Token",
			"stats.totalTokensValue": "{total}（输入 {input} / 输出 {output}）",
			"stats.tokenBreakdown": "未缓存输入 {uncached} · 上下文缓存 {cached} · 思考 {reasoning}",
			"stats.latencyLabel": "响应与生成速度",
			"stats.latencyValue": "首字 TTFT {ttft} · 速率 {tps} tok/s",
			"stats.cacheHitRate": "缓存命中率 {rate}",
			"stats.upstreamWindowLabel": "最近一轮上游窗口",
			"stats.upstreamWindowValue": "{used} / {window}（系统 {system} · 消息 {messages} · 工具 {tools}）",
			"stats.refresh": "刷新统计",
			"stats.refreshing": "刷新中…",
			"stats.reset": "清零统计",
			"stats.note": "实时累计本进程通过 Doubao 转发的所有请求与 DSH 原生 token 用量；上游服务端窗口仅工作任务轮次上报"
		};
		/** English copy, typed to the Chinese key set. */
		const en = {
			"card.navLabel": "Doubao",
			"card.title": "Doubao connection",
			"card.subtitle": "One QR sign-in in a browser window, then plain HTTP; no Doubao app required.",
			"quota.plan": "Plan",
			"quota.fiveHour": "5-hour limit",
			"quota.weekly": "Weekly quota",
			"quota.used": "{percent}% used",
			"quota.resetsIn": "resets in {time}",
			"quota.refresh": "Refresh quota",
			"quota.refreshing": "Refreshing…",
			"quota.autoNote": "Refreshes automatically every 5 minutes",
			"quota.updatedAt": "updated {time}",
			"quota.windowMissing": "not part of this plan",
			"quota.resetUnknown": "reset time unknown",
			"quota.startsOnUse": "starts counting on first use",
			"quota.expiresIn": "expires in {time}",
			"quota.incentive": "Bonus quota",
			"quota.usedAmounts": "{used} / {total} used",
			"quota.remainingAmount": "{remaining} of {total} left",
			"quota.remainingPercent": "{percent}% left",
			"account.title": "Account status",
			"account.ok": "Signed in",
			"account.signed_out": "Not signed in: press “Sign in again” and scan the QR code",
			"account.unreadable": "Sign-in could not be read: the sealed session failed to decrypt. Sign in again",
			"account.session_dead": "Session expired: sign in again and scan the QR code",
			"account.risk_challenge": "Risk-control challenge hit: complete the slider in the sign-in window that just opened",
			"account.exhausted": "Quota exhausted: wait for the window to reset, or check subscription management in the Doubao app",
			"account.network": "Could not reach Doubao: check the network and retry",
			"account.unknown": "Status unknown",
			"account.profile": "Profile path",
			"models.title": "Models",
			"models.enabledCount": "{count} enabled ↑",
			"models.routingNote": "The list, the multipliers and the thinking levels all come from the Doubao client menu, so new models or prices appear without a plugin update. Entries badged 「工作任务」 run in task mode against the paid membership quota; the plugin answers the local workspace commands for you. Solid chip = verified on a real request, dotted = declared by the menu only",
			"models.refresh": "Refresh",
			"models.refreshing": "Refreshing…",
			"models.save": "Save",
			"models.saving": "Saving…",
			"models.discard": "Discard changes",
			"models.selectAll": "Select all",
			"models.selectNone": "Select none",
			"models.dirty": "unsaved changes",
			"models.saved": "Saved",
			"models.saveFailed": "Save failed: {reason}",
			"models.tier": "Tier",
			"models.tierFast": "Fast",
			"models.tierThink": "Thinking",
			"models.tierExpert": "Expert",
			"models.readOnly": "This host provides no settings write path; ticking has no effect",
			"models.loadFailed": "Could not read the model catalog",
			"models.empty": "No model entries available",
			"models.levelVerified": "Verified on a real request",
			"models.levelUnverified": "Declared by the client menu, not yet verified on a request",
			"models.rateNote": "Multipliers come from the Doubao client menu and are display-only; this plugin does not bill and cannot verify the actual charge",
			"tools.title": "Experimental: tool calling",
			"tools.toggle": "Let Doubao drive local tools (read/write files, run commands)",
			"tools.note": "Doubao's endpoint has no function-calling channel — a declared `tools` array is silently ignored — so this switch simulates it: the tool list goes into the prompt and the fenced block in the reply is parsed back into standard tool_calls. Measured ~11.5s per round; can degrade on complex tasks, hence off by default.",
			"tools.warning": "When on, Doubao can read and write files on this machine. Make sure you trust the permission scope of the current session.",
			"tools.enabled": "On",
			"tools.disabled": "Off",
			"auth.title": "Sign-in",
			"auth.signedIn": "Signed in",
			"auth.signedOut": "Not signed in",
			"auth.expires": "expires in {days} days",
			"auth.expiryUnknown": "expiry unknown",
			"auth.relogin": "Sign in again",
			"auth.relogining": "Waiting for the scan…",
			"auth.loginFailed": "Sign-in failed: {reason}",
			"picker.controlLabel": "Rate {rate}",
			"picker.controlUnknown": "Rate --",
			"picker.controlAria": "View Doubao model multipliers (current {rate})",
			"picker.popoverTitle": "Doubao model multipliers",
			"picker.refresh": "Refresh",
			"picker.refreshing": "Refreshing…",
			"picker.currentBadge": "Current",
			"picker.rateTooltip": "Billing multiplier shown in the Doubao client menu (display-only)",
			"picker.empty": "No model multiplier data",
			"picker.rateUnavailable": "--",
			"stats.title": "Session stats & token usage",
			"stats.sessionsActive": "{count} active sessions",
			"stats.empty": "No completed turns recorded since this session started",
			"stats.loadFailed": "Could not read session statistics",
			"stats.requestsLabel": "Requests & turns",
			"stats.requestsValue": "{succeeded} succeeded · {continuations} continuations · {failed} failed",
			"stats.totalTokensLabel": "Total tokens",
			"stats.totalTokensValue": "{total} ({input} in / {output} out)",
			"stats.tokenBreakdown": "Uncached in {uncached} · Cached in {cached} · Reasoning {reasoning}",
			"stats.latencyLabel": "Latency & speed",
			"stats.latencyValue": "TTFT {ttft} · {tps} tok/s",
			"stats.cacheHitRate": "Cache hit {rate}",
			"stats.upstreamWindowLabel": "Last upstream window",
			"stats.upstreamWindowValue": "{used} / {window} (sys {system} · msgs {messages} · tools {tools})",
			"stats.refresh": "Refresh stats",
			"stats.refreshing": "Refreshing…",
			"stats.reset": "Reset stats",
			"stats.note": "Aggregates runtime Doubao traffic alongside DSH native token & session metrics; upstream window is reported by task turns"
		};
		/** Locale namespace registered by the browser-plugin entry. */
		const NAMESPACE = "settings.doubao";
		/** Bind a language table into the `t` the card uses. */
		function translator(table) {
			return (key, vars) => {
				const template = table[key] ?? key;
				if (vars === void 0) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => {
					const value = vars[name];
					return value === void 0 ? match : String(value);
				});
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Stable browser-plugin name. */
		const name = "dsh-connect-doubao-client";
		/** Only the universally available seats; see the module note on the gate. */
		const inject = ["slots", "locale"];
		/**
		* Register the card copy and the card itself under Plugin configuration.
		*
		* Everything is inside try/catch at two levels: the whole body, and each slot
		* registration individually. A card that cannot render must never take down the
		* page — the host provider still serves models without it.
		*/
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, {
					zh,
					en
				}), "dsh-connect-doubao: card copy");
				const t = ctx.locale.bind(NAMESPACE);
				/**
				* Soft service probe.
				*
				* Reading an undeclared service property THROWS ("cannot get property X
				* without inject") — `?.` guards null/undefined, not a throwing getter — so
				* the settings seat must be reached through `ctx.get()`, which returns
				* `undefined` for an absent service instead.
				*/
				const softGet = (name) => ctx.get(name);
				let settingsScope;
				const forms = softGet("configForms");
				if (forms !== void 0) {
					let ns = "dsh-connect-doubao";
					try {
						const served = (forms.describe().getSnapshot().view?.namespaces ?? []).find((entry) => entry.ns === ns || /doubao/i.test(entry.ns));
						if (served !== void 0) ns = served.ns;
					} catch {}
					settingsScope = forms.get(ns);
				}
				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => settingsScope === void 0 ? { t } : {
								t,
								settingsScope
							}
						}, DoubaoQuotaCard));
					} catch (error) {
						console.error(`[dsh-connect-doubao] card slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard("plugins.bundle.config", "dsh-connect-doubao");
				registerCard("plugins.row.config", "dsh-connect-doubao#dsh-connect-doubao");
				/**
				* Top-level entry in the SETTINGS LEFT-HAND NAV — the surface the user
				* asked for.
				*
				* WHY THIS SLOT, AND WHERE THE NAME CAME FROM
				* ------------------------------------------
				* `settings.section` is the host's own settings-nav row slot, declared by
				* `@deepseek-ai/dsh-client-ui-settings-general`, whose `SettingsRoot`
				* renders exactly what the user's screenshot shows:
				*
				*   nav list : [navIcon(row.id), <span className="navLabel">{row.label}</span>]
				*   content : renderSlot("settings.section", { close: onClose }, { only: active })
				*
				* `only: active` is the important half: the host mounts ONLY the section the
				* user clicked, so our card is not rendered until its row is selected.
				*
				* The descriptor fields are `id` / `order` / `label` / `inject` — NOT the
				* `key` / `priority` pair the `plugins.*` slots use. Transcribed from two
				* plugins that provably appear in that nav:
				*
				*   - `@yangdcm/dsh-expert-team` ("专家团"):
				*       ctx.slots.inject('settings.section', () => ctx.slots.register({
				*         name: 'settings.section', id: 'expert-team', order: 50,
				*         label: () => t('专家团', 'Expert team') }, wrap(SettingsSection)))
				*   - `dsh-better-sidebar` ("侧边卡片"): same shape, `order: 100`.
				*
				* `dsh-better-sidebar` also documents the host's limits: "DSH 0.1.x projects
				* only `id`, `order`, and `label` from a `settings.section` registration"
				* — there is no icon field, so the host draws a generic gear for plugin rows.
				*
				* `ctx.slots.inject` waits for the host's DECLARATION of the slot, so on a
				* host that does not ship the settings shell this simply never attaches and
				* everything else keeps working.
				*
				* `order: 40` places 豆包 above 专家团's 50 and below the shell's own sections,
				* matching the position the user asked for in the list.
				*/
				const registerSettingsSection = () => {
					try {
						ctx.slots.inject("settings.section", () => ctx.slots.register({
							name: "settings.section",
							id: "dsh-connect-doubao",
							order: 40,
							label: () => t("card.navLabel"),
							inject: () => settingsScope === void 0 ? { t } : {
								t,
								settingsScope
							}
						}, DoubaoQuotaCard));
					} catch (error) {
						console.error("[dsh-connect-doubao] settings.section failed to register (host provider unaffected):", error);
					}
				};
				registerSettingsSection();
				const resolveHostText = typeof ctx.locale.resolveText === "function" ? (text) => ctx.locale.resolveText(text) : void 0;
				try {
					ensureDoubaoStyles();
				} catch {}
				const registerModelRateLabel = () => {
					try {
						ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({
							name: "conversation.input.model.label",
							priority: 30,
							inject: () => resolveHostText === void 0 ? { t } : {
								t,
								resolveText: resolveHostText
							}
						}, DoubaoModelOptionLabel));
					} catch (error) {
						console.error("[dsh-connect-doubao] conversation.input.model.label failed to register:", error);
					}
				};
				const registerComposerRateControl = () => {
					try {
						ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
							name: "conversation.input.right",
							id: "doubao-rate",
							order: 90,
							inject: () => ({ t })
						}, DoubaoComposerRateControl));
					} catch (error) {
						console.error("[dsh-connect-doubao] conversation.input.right failed to register:", error);
					}
				};
				registerModelRateLabel();
				registerComposerRateControl();
			} catch (error) {
				console.error("[dsh-connect-doubao] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.DoubaoComposerRateControl = DoubaoComposerRateControl;
		exports.DoubaoModelOptionLabel = DoubaoModelOptionLabel;
		exports.DoubaoQuotaCard = DoubaoQuotaCard;
		exports.apply = apply;
		exports.en = en;
		exports.inject = inject;
		exports.name = name;
		exports.translator = translator;
		exports.zh = zh;
		return module.exports;
	}
});
