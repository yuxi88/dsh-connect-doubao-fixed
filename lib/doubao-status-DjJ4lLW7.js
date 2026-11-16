import { $ as saveBrowserCredentials, A as classifyDoubaoFailure, B as stopGeneration, Ct as DOUBAO_UNAVAILABLE_MODELS, D as buildHeaders, I as isInvalidParamFailure, J as clearCredentialCache, L as isRetryableFailure, Lt as isTaskModel, Mt as enabledModelsOf, Nt as findDoubaoModel, O as buildQueryUrl, Q as loadDoubaoCredentials, Rt as levelIdOf, Vt as supportsReasoning, X as invalidateCredentialCache, _ as DoubaoUpstreamError, _t as DOUBAO_MAX_TOKENS, bt as DOUBAO_PROVIDER_DISPLAY_NAME, gt as DOUBAO_IMAGE_MODEL_NAME, ht as DOUBAO_IMAGE_MODEL_ID, i as findWindow, it as listDoubaoProfiles, jt as doubaoCatalogEntries, k as chat, m as DEFAULT_BOT_ID, o as invalidateQuotaCache, pt as DOUBAO_CONTEXT_WINDOW, r as fetchQuota, rt as findDoubaoUserDataDir, s as millisUntilReset, tt as describeProfileLocation, u as ACTION_BAR_BRIEF_LIST_ENDPOINT, vt as DOUBAO_MODELS, xt as DOUBAO_REASONING_LEVELS, yt as DOUBAO_PROVIDER } from "./doubao-quota-Dqwsx-0l.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
//#region src/doubao-adapter.ts
/**
* The Doubao pi-ai provider, registered into the Harness LLM seam.
*
* Assembly follows the public `dsh-llm-pi-ai` extension points, as used by
* `dsh-connect-workbuddy`:
*
*   createProvider(...)  ->  a pi-ai Provider whose models all point at the
*                           loopback shim's OpenAI-shaped surface
*   PiAiAdapter          ->  the Harness-facing adapter built from a resolved
*                           provider profile
*
* The shim (not this file) owns the Doubao dialect and all inbound hardening;
* this module only decides what the picker shows and how failures are labelled.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
*   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
*     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目实现。
*
* @module dsh-connect-doubao/adapter
*/
/** Provider idle ceiling while one stream read is outstanding. */
const DOUBAO_STREAM_IDLE_TIMEOUT_MS$1 = 3e5;
/**
* Inert pi-ai auth plane.
*
* The Doubao route authenticates only through the shim's per-process shared
* secret (resolved as the OpenAI apiKey) plus the cookie jar the shim reads
* from the local profile. pi-ai's own credential lifecycle and ambient
* discovery must never manufacture a credential here.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-doubao: the doubao route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Image-request budgets: this route is text-only, so the caps are inert. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 0,
	requestImagePixelBudget: 0,
	requestImageMaxBytes: 0
};
/**
* Thinking level map for an entry.
*
* The map is a TRANSLATION, not a passthrough: pi-ai spells levels OpenAI's way
* (`minimal`, `low`, `medium`, `high`) while Doubao publishes only 低 / 中 / 高.
* Doubao's own ids are sent as the values so the shim can hand them straight to
* `streamChat` without a second lookup — see `toDoubaoLevel` in the shim.
*
* Doubao has no "off": the weakest published level is 低, so `off` maps to it
* rather than to nothing. A model that declares no reasoning pins every level,
* so the picker cannot request thinking from a route that will not honour it.
*/
function thinkingLevelMap(info) {
	const levels = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	];
	if (!info.reasoning) return Object.fromEntries([...levels, "off"].map((level) => [level, null]));
	const rungs = ladderOf(info);
	const weakest = levelIdOf(rungs[0]);
	const pick = (index) => {
		const rung = rungs[Math.min(index, rungs.length - 1)];
		return rung === void 0 ? weakest : levelIdOf(rung);
	};
	return {
		minimal: weakest,
		low: pick(0),
		medium: rungs.length >= 2 ? pick(1) : null,
		high: pick(rungs.length - 1),
		...rungs.length >= 4 ? { xhigh: pick(3) } : { xhigh: null },
		...rungs.length >= 5 ? { max: pick(4) } : { max: null },
		off: weakest
	};
}
/**
* The wire ordinals a model offers, weakest first.
*
* Falls back to the catalog-wide ladder for models whose source does not state
* one (the IndexedDB cache, and the static catalog itself).
*/
function ladderOf(info) {
	const declared = (info.reasoningOptions ?? []).map((option) => option.level).filter((level) => Number.isFinite(level));
	const rungs = declared.length > 0 ? declared : DOUBAO_REASONING_LEVELS.filter((level) => level.verified).map((level) => level.level);
	return [...new Set(rungs)];
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const levels = thinkingLevelMap(info);
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		cost: NO_COST,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		reasoning: info.reasoning,
		thinkingLevelMap: levels,
		compat: { supportsReasoningEffort: info.reasoning }
	};
}
/**
* Assemble the adapter.
*
* Every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
* applies from the first snapshot after startup.
*/
function createDoubaoAdapter(options) {
	const { shim } = options;
	const providerId = DOUBAO_PROVIDER;
	const providerName = DOUBAO_PROVIDER_DISPLAY_NAME;
	/**
	* Which catalog ids are currently in force, or undefined for "never
	* configured" (serve everything). Updated by {@link setEnabledModelIds} when
	* the user saves a different checklist selection.
	*/
	let enabledIds = options.enabledModelIds;
	let syncBaseUrl = shim.baseUrlSync();
	if (syncBaseUrl === void 0) shim.baseUrl().then((resolved) => {
		syncBaseUrl = resolved;
		profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		options.onBaseUrlReady?.();
	}).catch(() => {});
	const buildModels = () => {
		const address = syncBaseUrl;
		if (address === void 0) return [];
		const baseUrl = `${address}/v1`;
		return enabledModelsOf(enabledIds, (options.modelsProvider ?? (() => DOUBAO_MODELS))()).map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "Doubao loopback shim secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Doubao"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: DOUBAO_STREAM_IDLE_TIMEOUT_MS$1,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-doubao retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token()
		}),
		invalidate: () => {
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		},
		setEnabledModelIds: (ids) => {
			enabledIds = ids;
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/doubao-session.ts
/**
* Conversation continuity.
*
* WHY. Until now every turn re-flattened the whole transcript into one prompt and
* sent it as a brand-new conversation. That is stateless and honest, but it
* degrades long chats: role prefixes blur into prose, and the server's own
* context handling (memory, attachments, per-conversation state) never applies.
*
* Doubao expects the opposite: the client sends ONE new message plus the
* `conversation_id` it got back on the previous turn. This module decides when a
* request is a continuation of the previous one and what delta to send.
*
* HOW A SESSION IS RECOGNISED. The Harness is stateless — it hands over the full
* transcript every time — so continuity has to be inferred. The rule: two
* requests belong to one conversation when the FIRST message is identical and
* the transcript has GROWN. That is exactly the shape of "the same chat, one
* more turn". A fresh conversation reuses the same opening only if the user
* literally starts a new chat with the same first message, in which case the
* server-side conversation is a harmless extra (and is dropped on TTL).
*
* This is a heuristic, so it is deliberately conservative: any doubt (different
* opening, same length, shorter transcript) starts a NEW conversation, which is
* the behaviour this plugin had before and is never worse than a wrong reuse.
*
* @module dsh-connect-doubao/session
*/
/**
* A conversation nobody has touched for this long is dropped.
*
* Deliberately long: Doubao threads on the account live for weeks, and every
* dropped id makes the next turn open a NEW conversation — re-uploading the
* whole transcript instead of sending the delta, which is exactly what costs
* quota. A stale id is safe to keep because a continuation the server rejects
* (710020202) is re-issued as a fresh conversation within the same turn (see
* the shim), so expiry only needs to bound staleness, not to prevent loops.
*/
const SESSION_TTL_MS = 6048e5;
/**
* Stable key for a transcript's opening HUMAN turn.
*
* Keyed on the first `user` message rather than `messages[0]`: the Harness
* usually opens with a system prompt that is IDENTICAL across unrelated chats,
* so keying on it would collapse every conversation into one entry — and the
* next turn would be appended to a stranger's thread.
*
* Hashed rather than stored: the key outlives a single request, and user text
* has no business being held there.
*/
function sessionKeyOf(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return void 0;
	const opening = messages.find((message) => message?.role === "user") ?? messages[0];
	const text = typeof opening?.content === "string" ? opening.content : JSON.stringify(opening?.content ?? "");
	if (!text) return void 0;
	return createHash("sha256").update(`${opening?.role ?? "user"}\u0000${text}`).digest("hex").slice(0, 32);
}
/**
* Whether this request continues the remembered conversation.
*
* Requires a stored conversation id AND a strictly longer transcript. Equal
* length is a RE-RUN of the same turn (a retry, or a regeneration), which must
* not be appended to the server-side conversation as if it were new.
*/
function isContinuation(messages, state) {
	if (state === void 0) return false;
	if (!Array.isArray(messages)) return false;
	return messages.length > state.messageCount;
}
/**
* The messages a continuation must actually send.
*
* Everything before `messageCount` is already on the server. Slicing from the
* INTENDED index to the end also covers the case where the Harness resent an
* extra prior message.
*/
function continuationDelta(messages, state) {
	const from = Math.min(Math.max(state.messageCount, 0), messages.length);
	return messages.slice(from);
}
/** Bounded, TTL'd store of conversation ids. */
var ConversationStore = class {
	ttlMs;
	maxEntries;
	entries = /* @__PURE__ */ new Map();
	constructor(ttlMs = SESSION_TTL_MS, maxEntries = 256) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}
	get(key, now = Date.now()) {
		if (key === void 0) return void 0;
		const state = this.entries.get(key);
		if (state === void 0) return void 0;
		if (now - state.at > this.ttlMs) {
			this.entries.delete(key);
			return;
		}
		return state;
	}
	remember(key, conversationId, messageCount, now = Date.now()) {
		if (key === void 0 || conversationId === "") return;
		this.entries.delete(key);
		this.entries.set(key, {
			conversationId,
			messageCount,
			at: now
		});
		if (this.entries.size <= this.maxEntries) return;
		for (const oldest of this.entries.keys()) {
			this.entries.delete(oldest);
			if (this.entries.size <= this.maxEntries) break;
		}
	}
	forget(key) {
		if (key !== void 0) this.entries.delete(key);
	}
	get size() {
		return this.entries.size;
	}
};
//#endregion
//#region src/doubao-discovery.ts
/**
* Discover the model list from the Doubao client's own cache.
*
* WHY THIS EXISTS. The catalog used to be a hardcoded list, so every time
* Doubao shipped a model the plugin went stale until it was updated by hand.
* The desktop app already receives that list from the server and persists it in
* its IndexedDB (`menuConfV2`), so the honest source of truth is right there on
* disk — read it instead of guessing.
*
* WHERE THE LIST COMES FROM, in priority order:
*
*   1. `Default/Preferences` -> `saman.local_storage_for_web['frontend-request-cache']`
*      -> `_DesktopActionBarBriefListRequestCacheDataV1.data.modeSelectData`
*      -> `menuConfV2.model_list.item_list[]`. Plain JSON, rewritten every time
*      the app refreshes its menu. This is the PRIMARY source.
*   2. The launcher / chat IndexedDB stores below, for installs whose
*      Preferences has not been written yet. Older and usually stale, so it
*      only fills gaps the Preferences list does not cover.
*
* WHAT THE INDEXEDDB CACHE CONTAINS. Values are V8 structured clones, not JSON:
*
*   string = tag + LEB128 length + payload
*     0x22  Latin-1 payload, length is the byte count
*     0x63  UTF-16LE payload, length is the BYTE count (measured: treating it as
*           a character count reads exactly twice too far and the name swallows
*           the following field's bytes)
*
* So parsing means reading the varint and slicing — skipping "control bytes and
* hoping" produces zero hits, which is what the first two attempts did.
*
* VALIDATION. A discovered entry is only trusted when it looks like a model:
* a short key matching `[\w-]+` and a name containing CJK or letters. Anything
* else is dropped, and if nothing survives, {@link discoverModels} returns
* undefined so the caller falls back to the static catalog. A malformed cache
* must never empty the user's model picker.
*
* @module dsh-connect-doubao/discovery
*/
/** How long a discovery result is reused before re-reading the cache. */
const DISCOVERY_TTL_MS = 6e5;
/**
* Names produced by the client for models that only exist inside 「工作任务」.
*
* The app prefixes them itself (「工作任务 Pro」, 「工作任务 Auto」), which is a
* gift: the mode a model belongs to is legible straight out of the cache.
*
* The prefix no longer means "hidden": since 0.4.1 these entries are offered
* with `taskMode: true` and are answered by the `tool_local` responder, so they
* complete instead of failing with 710010702. Only entries listed in
* `DOUBAO_UNAVAILABLE_MODELS` are withheld.
*/
const TASK_MODE_PREFIX = "工作任务";
/**
* IndexedDB stores that may hold the app's server-pushed config.
*
* `launcher` is the historical source and stops being written once the app has
* completed a few launches (measured: its last write was 2026-09-17 while the
* menu already listed a dozen models). `chat` is the store the running window
* keeps current. Both are scanned and merged per key, so listing both can only
* ever add models, never change an existing one.
*/
const CACHE_DB_DIRS = ["chrome_doubao-chat_0.indexeddb.leveldb", "chrome_doubao-launcher_0.indexeddb.leveldb"];
/** Read a LEB128 varint. Returns [value, nextOffset] or undefined. */
function readVarint(buf, at) {
	let result = 0;
	let pos = at;
	let bytes = 0;
	for (;;) {
		if (pos >= buf.length) return void 0;
		const byte = buf[pos];
		if (byte === void 0) return void 0;
		result |= (byte & 127) << 7 * bytes;
		pos += 1;
		bytes += 1;
		if ((byte & 128) === 0) break;
		if (bytes > 4) return void 0;
	}
	return [result >>> 0, pos];
}
/** Read a structured-clone string at `at`. Returns [value, nextOffset]. */
function readV8String(buf, at) {
	const tag = buf[at];
	const sized = readVarint(buf, at + 1);
	if (sized === void 0) return void 0;
	const [length, dataAt] = sized;
	const end = dataAt + length;
	if (length <= 0 || end > buf.length) return void 0;
	if (tag === 34) return [buf.subarray(dataAt, end).toString("latin1"), end];
	if (tag === 99) return [buf.subarray(dataAt, end).toString("utf16le"), end];
}
/** Find the `name` property following `from` and decode its value. */
function readNameAfter(buf, from, to) {
	for (let i = from; i < to - 6; i++) {
		if (buf[i] !== 34) continue;
		const sized = readVarint(buf, i + 1);
		if (sized === void 0) continue;
		const [length, dataAt] = sized;
		if (length !== 4 || dataAt + 4 > buf.length) continue;
		if (buf.subarray(dataAt, dataAt + 4).toString("latin1") !== "name") continue;
		const value = readV8String(buf, dataAt + 4);
		if (value === void 0) return void 0;
		const [name, next] = value;
		if (next > to) return void 0;
		return name;
	}
}
/**
* A Doubao `model_item_key`: `0`/`3`/`5`/`9`, `seed-lite-7b`, or a third-party
* slug such as `person-kimi-k3-1-pro-highspeed-261111` (37 characters).
*
* The bound used to be 24, which silently dropped every `person-*` model Doubao
* added later: the picker kept showing five legacy entries while the client
* already listed twelve. Keys are validated for SHAPE, not for length — the
* server is the only authority on which keys exist.
*/
function looksLikeModelKey(value) {
	return /^[\w.-]{1,64}$/.test(value);
}
function looksLikeModelName(value) {
	if (value.length < 2 || value.length > 40) return false;
	if (!/[\u4e00-\u9fa5A-Za-z]/.test(value)) return false;
	return !/^[a-z_]+$/.test(value) && !value.includes("http");
}
/**
* Parse one LevelDB value buffer for (key, name) pairs.
*
* Exported so the encoding can be unit-tested with synthetic bytes: the real
* cache belongs to another app and moves whenever it updates, and a parser that
* can only be exercised against it cannot be trusted to keep working.
*/
function parseCacheBuffer(buf) {
	const out = /* @__PURE__ */ new Map();
	const KEY = Buffer.from("model_item_key");
	let at = -1;
	while ((at = buf.indexOf(KEY, at + 1)) !== -1) {
		const keyRead = readV8String(buf, at + KEY.length);
		if (keyRead === void 0) continue;
		const [key, afterKey] = keyRead;
		if (!looksLikeModelKey(key)) continue;
		const name = readNameAfter(buf, afterKey, Math.min(buf.length, afterKey + 220));
		if (name === void 0 || !looksLikeModelName(name)) continue;
		if (!out.has(key)) out.set(key, {
			key,
			name,
			taskOnly: name.startsWith(TASK_MODE_PREFIX)
		});
	}
	return [...out.values()];
}
/** Scan one LevelDB directory for (key, name) pairs. */
function scanDir(dir) {
	const found = /* @__PURE__ */ new Map();
	let files;
	try {
		files = readdirSync(dir);
	} catch {
		return found;
	}
	for (const file of files) {
		if (!/\.(log|ldb)$/.test(file)) continue;
		let buf;
		try {
			buf = readFileSync(join(dir, file));
		} catch {
			continue;
		}
		for (const entry of parseCacheBuffer(buf)) if (!found.has(entry.key)) found.set(entry.key, entry);
	}
	return found;
}
function candidateProfileDirs() {
	const dirs = [];
	const seen = /* @__PURE__ */ new Set();
	const add = (dir) => {
		if (dir === void 0 || dir === "") return;
		const key = dir.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		dirs.push(dir);
	};
	for (const profile of listDoubaoProfiles()) add(profile.dir);
	if (dirs.length === 0) add(findDoubaoUserDataDir());
	return dirs;
}
/** Locate the launcher cache directory inside the Doubao profiles. */
function discoveryCacheDirs() {
	const dirs = [];
	const seen = /* @__PURE__ */ new Set();
	for (const userData of candidateProfileDirs()) for (const dbDir of CACHE_DB_DIRS) {
		const full = join(userData, "Default", "IndexedDB", dbDir);
		const key = full.toLowerCase();
		if (!seen.has(key) && existsSync(full)) {
			seen.add(key);
			dirs.push(full);
		}
	}
	return dirs;
}
/**
* The model menu as the app last persisted it in its own Preferences file.
*
* This is the source that stays current: the IndexedDB stores are written by
* whichever app window happens to be running and go stale, while Preferences is
* rewritten every time the menu is refreshed. Shape, verbatim:
*
*   { saman: { local_storage_for_web: { 'frontend-request-cache': '<json>' } } }
*     -> { _DesktopActionBarBriefListRequestCacheDataV1: { data: { modeSelectData:
*          { menuConfV2: { model_list: { item_list: [ { model_item_key, name, … } ] } } } } } }
*
* Never throws: a missing/partial/rewritten Preferences just yields no entries
* and the IndexedDB path (then the static catalog) takes over.
*/
/**
* The menu tag as a rate, or undefined when there is none.
*
* Two shapes arrive in the same field: a plain multiplier ("0.65x", "1.44x") and
* a campaign label that CONTAINS one ("限时优惠 0.01x"). Both are shown verbatim;
* `kind` only decides how the card styles it, never what it claims.
*/
function rateOf(tagList) {
	if (!Array.isArray(tagList)) return void 0;
	for (const tag of tagList) {
		const text = typeof tag?.text === "string" ? tag.text.trim() : "";
		if (text === "") continue;
		return {
			text,
			kind: /^[\d.]+x$/i.test(text) ? "ratio" : "promo"
		};
	}
}
/**
* A model's own thinking levels, or undefined when the menu declares none.
*
* `option_list` is the client's per-model ladder and it is NOT uniform: GLM ships
* 低/高/最高 (3/5/7) while 2.1 Lite ships 低/中/高 (3/4/5). Reading it here is what
* stops the picker from offering a level that model has no answer for.
*/
function reasoningOptionsOf(config) {
	const options = config?.option_list;
	if (!Array.isArray(options)) return void 0;
	const out = [];
	for (const option of options) {
		const level = typeof option?.level === "number" ? option.level : void 0;
		const name = typeof option?.name === "string" ? option.name : void 0;
		if (level === void 0 || name === void 0 || name === "") continue;
		if (out.some((known) => known.level === level)) continue;
		out.push({
			level,
			name
		});
	}
	return out.length === 0 ? void 0 : out;
}
/** Parse `item_list` entries shared by both Desktop Preferences cache and HTTP `brief_list`. */
function parseMenuItems(items) {
	if (!Array.isArray(items)) return [];
	const out = [];
	for (const item of items) {
		const key = typeof item?.model_item_key === "string" ? item.model_item_key : void 0;
		const name = typeof item?.name === "string" ? item.name : void 0;
		if (key === void 0 || name === void 0) continue;
		if (!looksLikeModelKey(key) || !looksLikeModelName(name)) continue;
		if (out.some((known) => known.key === key)) continue;
		const mode = typeof item.default_mode === "string" ? item.default_mode : void 0;
		const rate = rateOf(item.tag_list);
		const reasoningOptions = reasoningOptionsOf(item.reasoning_effort_config);
		out.push({
			key,
			name,
			taskOnly: name.startsWith("工作任务") || mode === "3",
			...mode === void 0 ? {} : { mode },
			...rate === void 0 ? {} : { rate },
			...reasoningOptions === void 0 ? {} : { reasoningOptions }
		});
	}
	return out;
}
/** Parse Doubao's `POST /alice/slot/action_bar_v3/brief_list` JSON response. */
function parseBriefListResponse(payload) {
	const entries = payload?.data?.entry_list;
	if (!Array.isArray(entries)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const ordered = [...entries.filter((entry) => entry?.action_bar_key === "coco_deep_thinking"), ...entries.filter((entry) => entry?.action_bar_key !== "coco_deep_thinking")];
	for (const entry of ordered) {
		const items = entry?.active_switch_conf?.menu_conf_v2?.model_list?.item_list ?? entry?.active_switch_conf?.menu_conf?.item_list;
		for (const parsed of parseMenuItems(items)) if (!seen.has(parsed.key)) {
			seen.add(parsed.key);
			out.push(parsed);
		}
	}
	return out;
}
function readPreferencesFromDir(userData) {
	let raw;
	try {
		raw = readFileSync(join(userData, "Default", "Preferences"), "utf8");
	} catch {
		return [];
	}
	let cache;
	try {
		const bucket = JSON.parse(raw).saman?.local_storage_for_web?.["frontend-request-cache"];
		if (typeof bucket !== "string") return [];
		cache = JSON.parse(bucket);
	} catch {
		return [];
	}
	const root = cache;
	if (root === null || typeof root !== "object") return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const cacheKey of Object.keys(root).filter((key) => key.includes("BriefListRequestCache"))) {
		const entry = root[cacheKey];
		const items = entry?.data?.modeSelectData?.menuConfV2?.model_list?.item_list ?? entry?.data?.modeSelectData?.menuConf?.item_list;
		for (const parsed of parseMenuItems(items)) if (!seen.has(parsed.key)) {
			seen.add(parsed.key);
			out.push(parsed);
		}
	}
	return out;
}
function readPreferencesEntries() {
	for (const dir of candidateProfileDirs()) {
		const entries = readPreferencesFromDir(dir);
		if (entries.length > 0) return entries;
	}
	return [];
}
/**
* All (key, name) pairs the client currently knows, task-only ones included.
*
* Exported for the diagnostics path — it is the raw view, useful when a model
* shows up in the app but not in DSH and the question is "did we not see it, or
* did we see it and classify it away".
*/
function discoverAllCachedModels() {
	const merged = /* @__PURE__ */ new Map();
	for (const entry of httpEntries ?? []) if (!merged.has(entry.key)) merged.set(entry.key, entry);
	for (const entry of readPreferencesEntries()) if (!merged.has(entry.key)) merged.set(entry.key, entry);
	for (const dir of discoveryCacheDirs()) for (const [key, entry] of scanDir(dir)) if (!merged.has(key)) merged.set(key, entry);
	return [...merged.values()];
}
/**
* The models DSH may offer: everything the client lists that is NOT task-only,
* plus the image-generation alias.
*
* Returns undefined when the cache yielded nothing usable, so the caller keeps
* the static catalog. Names are taken verbatim from the client, which is the
* whole point: when Doubao renames or adds a chat model, it shows up here
* without a plugin release.
*/
function discoverModels(now = Date.now()) {
	const all = discoverAllCachedModels();
	const unavailableIds = new Set(DOUBAO_UNAVAILABLE_MODELS.map((m) => m.id));
	const usable = all.filter((entry) => !unavailableIds.has(entry.key) && entry.key !== "image-gen");
	if (usable.length === 0) return void 0;
	const seenKeys = new Set(usable.map((e) => e.key));
	const models = usable.sort((a, b) => {
		const an = Number(a.key), bn = Number(b.key);
		const aNum = Number.isFinite(an), bNum = Number.isFinite(bn);
		if (aNum && bNum) return an - bn;
		if (aNum) return -1;
		if (bNum) return 1;
		return a.key.localeCompare(b.key);
	}).map((entry) => {
		const staticMatch = DOUBAO_MODELS.find((m) => m.id === entry.key);
		const taskMode = entry.taskOnly || isTaskModel(entry.key);
		const badge = staticMatch?.badge ?? (taskMode ? "工作任务" : void 0);
		return {
			id: entry.key,
			name: staticMatch?.name ?? entry.name,
			...badge !== void 0 ? { badge } : {},
			reasoning: supportsReasoning(entry.key),
			...taskMode ? { taskMode: true } : {},
			...entry.rate !== void 0 ? { rate: entry.rate } : {},
			...entry.reasoningOptions !== void 0 ? { reasoningOptions: entry.reasoningOptions } : {}
		};
	});
	for (const staticModel of DOUBAO_MODELS) {
		if (staticModel.id === "image-gen") continue;
		if (!seenKeys.has(staticModel.id)) models.push({ ...staticModel });
	}
	models.push({
		id: DOUBAO_IMAGE_MODEL_ID,
		name: DOUBAO_IMAGE_MODEL_NAME,
		reasoning: true
	});
	return models;
}
/** Fallback used whenever discovery is unavailable. */
function staticModels() {
	return [...DOUBAO_MODELS];
}
let memo;
let httpEntries;
let httpFetchedAt = 0;
let inFlightRefresh;
/**
* The catalog to use right now: discovered models when the cache yields them,
* otherwise the static list, re-read at most once per {@link DISCOVERY_TTL_MS}.
*
* Every consumer (picker, adapter, card) goes through this one function so the
* three views can never disagree about which models exist.
*/
function liveModels(now = Date.now()) {
	if (memo !== void 0 && now - memo.at < 6e5) return memo.models;
	const models = discoverModels(now) ?? staticModels();
	memo = {
		at: now,
		models
	};
	return models;
}
/**
* Refresh the model catalog over HTTP from Doubao's `brief_list` endpoint.
*
* Pure browser-login installs have no desktop `Preferences` cache at all, so
* without this HTTP step they stay stuck on the 6-model static fallback.
* Errors fall back quietly to cached / static models and never throw.
*/
async function refreshDiscovery(options = {}) {
	const now = options.now ?? Date.now();
	if (!options.force && httpEntries !== void 0 && now - httpFetchedAt < 6e5) return liveModels(now);
	if (!options.force && inFlightRefresh !== void 0) return inFlightRefresh;
	const run = (async () => {
		const credentials = loadDoubaoCredentials();
		if (credentials.ok) try {
			const response = await fetch(buildQueryUrl(ACTION_BAR_BRIEF_LIST_ENDPOINT, credentials.pairs.get("msToken")), {
				method: "POST",
				headers: buildHeaders(credentials, { "content-type": "application/json" }),
				body: JSON.stringify({
					language_code: "zh",
					bot_id: DEFAULT_BOT_ID
				})
			});
			if (response.ok) {
				const parsed = parseBriefListResponse(await response.json());
				if (parsed.length > 0) {
					httpEntries = parsed;
					httpFetchedAt = options.now ?? Date.now();
					memo = void 0;
				}
			}
		} catch {}
		return liveModels(options.now ?? Date.now());
	})();
	if (!options.force) inFlightRefresh = run;
	try {
		return await run;
	} finally {
		if (inFlightRefresh === run) inFlightRefresh = void 0;
	}
}
/** Forget the memo — used by the card's refresh and by tests. */
function invalidateDiscovery() {
	memo = void 0;
	httpEntries = void 0;
	httpFetchedAt = 0;
}
const FENCE_RE = new RegExp(`^\\s*\`\`\`\\s*doubao-tool\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\`\\s*`, "m");
const JSON_FENCE_RE = /(?:^|\r?\n)\s*```\s*json\s*\r?\n([\s\S]*?)\r?\n\s*```\s*/gi;
/**
* Render the tool contract appended to the prompt.
*
* MEASURED, and the reason this reads like a rulebook rather than a suggestion
* (2026-11-02, same task, same model, only the wording changed):
*
*   polite wording  → 0/2 tool calls, and the model answered 「已完成修改：…」
*                     while touching nothing. That is the worst outcome
*                     available: the user believes the file changed.
*   hard wording    → 2/2 tool calls (read first, then edit).
*
* So the rules forbid the failure modes explicitly instead of implying them:
* "never claim completion without a [tool result]", "do not paste code for the
* user to apply themselves", and "your first reply must be a call". A simulation
* has no protocol to fall back on — the prompt is the only enforcement there is,
* and a soft prompt measurably produces the hallucination.
*/
function buildToolContract(tools) {
	if (tools.map((tool) => tool.function?.name).filter((name) => typeof name === "string" && name !== "").length === 0) return "";
	return [
		"",
		"",
		"你是执行型助手，只能通过工具改动磁盘。可用工具：",
		...tools.filter((tool) => typeof tool.function?.name === "string").map((tool) => {
			const fn = tool.function;
			const schema = fn?.parameters === void 0 ? "" : ` — 参数: ${JSON.stringify(fn.parameters)}`;
			const desc = fn?.description === void 0 ? "" : ` — ${fn.description}`;
			return `- ${fn?.name}${desc}${schema}`;
		}),
		"",
		"需要调用工具时，只输出一个代码围栏，语言标记为 doubao-tool，围栏内放恰好一个 JSON 对象：{\"name\":\"<工具名>\",\"arguments\":{...}}。",
		"执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。",
		"",
		"硬性规则：",
		"- 你的第一条回复必须是一个工具调用，不能是解释、计划或代码片段。",
		"- 严禁在回复里声称「已完成」「已修改」——除非你真的执行了工具调用并收到 [tool result]。没有结果就等于没做。",
		"- 不要把修改后的代码贴给用户让他自己粘贴；直接调用工具去改。",
		"- 一次只调用一个工具；JSON 必须严格合法（双引号、无注释、无尾逗号）。",
		"- 不要重复刚刚已经做过的调用。",
		"- 每次修改文件之后，先重新读取该文件，再决定下一步；不要凭记忆连续拼接多次改动。",
		"- 全部完成后，用下列格式说明你做了什么（不要只说「已修改」）：",
		"  **改了哪个文件** → 具体改了什么（哪个函数/哪一行），为什么这么改。",
		"  如果有多处改动，逐条列出。"
	].join("\n");
}
/**
* Split a model reply into tool calls and the text the user should see.
*
* The fence is REMOVED from the visible text: a tool call is not prose, and
* leaving it in would show the user JSON they never asked to read.
*
* Malformed JSON inside a fence is dropped rather than thrown — the caller still
* has the remaining text, and a hard failure here would turn a half-good answer
* into an error.
*/
function parseToolCalls(text, makeId = (i) => `call_${Date.now()}_${i}`) {
	const calls = [];
	let rest = text;
	for (;;) {
		const match = FENCE_RE.exec(rest);
		if (match === null) break;
		const raw = (match[1] ?? "").trim();
		rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim();
		for (const parsed of parseCallJsonList(raw)) calls.push({
			id: makeId(calls.length),
			...parsed
		});
	}
	if (calls.length === 0 && rest.includes("```")) rest = rest.replace(JSON_FENCE_RE, (fullMatch, body) => {
		const parsedList = parseCallJsonList((body ?? "").trim(), true);
		if (parsedList.length === 0) return fullMatch;
		for (const parsed of parsedList) calls.push({
			id: makeId(calls.length),
			...parsed
		});
		return "";
	}).trim();
	return {
		calls: dedupeCalls(calls),
		text: rest
	};
}
/** Parse one fence body (single object or array of objects) into calls. */
function parseCallJsonList(raw, strictKeys = false) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	const items = Array.isArray(value) ? value : [value];
	const out = [];
	for (const item of items) {
		const single = parseSingleCallObject(item, strictKeys);
		if (single !== void 0) out.push(single);
	}
	return out;
}
/** Parse one call object into `{ name, arguments }`, or undefined when not usable. */
function parseSingleCallObject(value, strictKeys = false) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const outer = value;
	const record = outer.function !== null && typeof outer.function === "object" && !Array.isArray(outer.function) ? outer.function : outer;
	if (strictKeys && !("name" in record && ("arguments" in record || "params" in record))) return;
	const name = record.name ?? record.tool ?? record.function;
	if (typeof name !== "string" || name === "") return void 0;
	const args = record.arguments ?? record.params ?? record.input ?? {};
	const serialized = typeof args === "string" ? args : JSON.stringify(args);
	if (!isLikelyJsonObject(serialized)) return void 0;
	return {
		name,
		arguments: serialized
	};
}
function isLikelyJsonObject(value) {
	const trimmed = value.trim();
	if (trimmed === "") return true;
	return trimmed.startsWith("{") && trimmed.endsWith("}");
}
/**
* Drop calls repeated within the same reply.
*
* The model occasionally emits the same call twice in one turn; executing it
* twice is at best wasteful and at worst destructive (a second write of the
* same file with different content).
*/
function dedupeCalls(calls) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const call of calls) {
		const key = `${call.name}\u0000${call.arguments}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(call);
	}
	return out;
}
/**
* Fold a tool result into the flattened prompt.
*
* Doubao's endpoint takes one text block, so the OpenAI `role: "tool"` message
* has to become text. The `[tool result]` prefix is what the contract above
* promises, and it is what the probe measured against.
*/
function toolResultAsText(name, content) {
	const body = typeof content === "string" ? content : JSON.stringify(content ?? "");
	return `[tool result] ${name === void 0 ? "" : `${name}: `}${body}`;
}
//#endregion
//#region src/doubao-tokens.ts
const MESSAGE_OVERHEAD_TOKENS = 4;
const REPLY_PRIMING_TOKENS = 2;
const IMAGE_PART_TOKENS = 256;
const TOOLS_OVERHEAD_TOKENS = 4;
function isCjkOrFullwidth(code) {
	return code >= 11904 && code <= 12543 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 44032 && code <= 55215 || code >= 63744 && code <= 64255 || code >= 65280 && code <= 65519;
}
function isAsciiWordChar(code) {
	return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
}
/**
* Single-pass O(n) token count estimator tuned for mixed Chinese/English/code.
*
* Every code-unit weight is >= 0.25, guaranteeing `estimateTextTokens(s) >=
* Math.ceil(s.length / 4)` for any non-empty string.
*/
function estimateTextTokens(text) {
	if (text.length === 0) return 0;
	let score = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 56320 && next <= 57343) {
				score += 2;
				i += 1;
				continue;
			}
		}
		if (code <= 32) score += .25;
		else if (isAsciiWordChar(code)) score += .27;
		else if (isCjkOrFullwidth(code)) score += 1;
		else if (code < 128) score += .6;
		else score += .75;
	}
	return Math.max(1, Math.ceil(score));
}
/** Estimate tokens for an inbound OpenAI message `content` field. */
function estimateContentTokens(content) {
	if (typeof content === "string") return estimateTextTokens(content);
	if (content === null || content === void 0) return 0;
	if (Array.isArray(content)) {
		let tokens = 0;
		for (const part of content) {
			if (part === null || part === void 0) continue;
			if (typeof part === "string") {
				tokens += estimateTextTokens(part) + 2;
				continue;
			}
			if (typeof part === "object") {
				const record = part;
				if (record.type === "image_url" || record.type === "image") {
					tokens += IMAGE_PART_TOKENS;
					continue;
				}
				if (typeof record.text === "string") {
					tokens += estimateTextTokens(record.text) + 2;
					continue;
				}
			}
			tokens += estimateTextTokens(JSON.stringify(part));
		}
		return tokens;
	}
	return estimateTextTokens(JSON.stringify(content));
}
/** Estimate tokens for one OpenAI chat message including role & tool calls. */
function estimateMessageTokens(message) {
	let tokens = MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content);
	if (typeof message.name === "string" && message.name !== "") tokens += estimateTextTokens(message.name) + 1;
	if (typeof message.tool_call_id === "string" && message.tool_call_id !== "") tokens += estimateTextTokens(message.tool_call_id) + 1;
	if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
		const fnName = call.function?.name ?? "";
		const rawArgs = call.function?.arguments;
		const fnArgs = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? "");
		tokens += 4 + estimateTextTokens(fnName) + estimateTextTokens(fnArgs);
	}
	return tokens;
}
/** Estimate tokens consumed by tool definitions or their emulated prompt block. */
function estimateToolsTokens(tools, emulatedContractText) {
	const schemaTokens = !Array.isArray(tools) || tools.length === 0 ? 0 : estimateTextTokens(JSON.stringify(tools)) + TOOLS_OVERHEAD_TOKENS;
	const contractTokens = emulatedContractText !== void 0 && emulatedContractText !== "" ? estimateTextTokens(emulatedContractText) + TOOLS_OVERHEAD_TOKENS : 0;
	return Math.max(schemaTokens, contractTokens);
}
/** Build full usage metrics + OpenAI wire `usage` payload for one chat completion. */
function resolveChatUsage(input) {
	const messages = Array.isArray(input.messages) ? input.messages : [];
	let messagesTokens = 0;
	let prefixTokens = 0;
	const cachedPrefix = input.cachedPrefixMessages ?? 0;
	const useCachedPrefix = cachedPrefix > 0 && cachedPrefix < messages.length;
	for (let i = 0; i < messages.length; i += 1) {
		const msgTokens = estimateMessageTokens(messages[i] ?? {});
		messagesTokens += msgTokens;
		if (useCachedPrefix && i < cachedPrefix) prefixTokens += msgTokens;
	}
	const toolsTokens = estimateToolsTokens(input.tools, input.emulatedContractText);
	const promptTokens = messagesTokens + toolsTokens + (messages.length > 0 ? REPLY_PRIMING_TOKENS : 0);
	const cachedInputTokens = useCachedPrefix ? Math.min(prefixTokens, Math.max(0, promptTokens - MESSAGE_OVERHEAD_TOKENS)) : 0;
	const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens);
	const reasoningTokens = input.reasoningText !== void 0 && input.reasoningText !== "" ? estimateTextTokens(input.reasoningText) : 0;
	const answerTokens = input.answerText !== "" ? estimateTextTokens(input.answerText) : 0;
	let toolCallTokens = 0;
	if (Array.isArray(input.toolCalls)) for (const call of input.toolCalls) toolCallTokens += 4 + estimateTextTokens(call.name) + estimateTextTokens(call.arguments);
	const completionTokens = reasoningTokens + answerTokens + toolCallTokens;
	const totalTokens = promptTokens + completionTokens;
	const openai = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
		...cachedInputTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedInputTokens } } : {},
		...reasoningTokens > 0 ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}
	};
	return {
		promptTokens,
		uncachedInputTokens,
		cachedInputTokens,
		completionTokens,
		reasoningTokens,
		answerTokens,
		toolCallTokens,
		totalTokens,
		openai
	};
}
//#endregion
//#region src/doubao-stats.ts
const DOUBAO_STATS_MAX_SESSIONS = 64;
function computeTps(tokens, decodeMs) {
	if (tokens <= 0 || decodeMs <= 0) return null;
	return Number((tokens / (decodeMs / 1e3)).toFixed(1));
}
function sanitizeDuration(ms) {
	return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}
/** Tracks runtime token usage and session statistics across Doubao turns. */
var DoubaoStatsTracker = class {
	maxSessions;
	startedAt;
	updatedAt;
	requests = 0;
	succeeded = 0;
	failed = 0;
	continuations = 0;
	promptTokens = 0;
	uncachedInputTokens = 0;
	cachedInputTokens = 0;
	completionTokens = 0;
	reasoningTokens = 0;
	totalTokens = 0;
	ttftSumMs = 0;
	ttftSamples = 0;
	decodeMs = 0;
	decodeTokens = 0;
	totalDurationMs = 0;
	lastTurn = null;
	byModel = /* @__PURE__ */ new Map();
	sessions = /* @__PURE__ */ new Map();
	constructor(maxSessions = 64, now = Date.now()) {
		this.maxSessions = maxSessions;
		this.startedAt = now;
		this.updatedAt = now;
	}
	getOrInitModel(model) {
		let entry = this.byModel.get(model);
		if (entry === void 0) {
			entry = {
				model,
				requests: 0,
				succeeded: 0,
				failed: 0,
				promptTokens: 0,
				cachedInputTokens: 0,
				completionTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0
			};
			this.byModel.set(model, entry);
		}
		return entry;
	}
	recordSuccess(input) {
		const now = input.now ?? Date.now();
		const durationMs = sanitizeDuration(input.durationMs);
		const decodeMs = sanitizeDuration(input.decodeMs);
		const ttftMs = input.ttftMs !== null && Number.isFinite(input.ttftMs) && input.ttftMs >= 0 ? Math.round(input.ttftMs) : null;
		this.updatedAt = now;
		this.requests += 1;
		this.succeeded += 1;
		if (input.continuation) this.continuations += 1;
		this.promptTokens += input.usage.promptTokens;
		this.uncachedInputTokens += input.usage.uncachedInputTokens;
		this.cachedInputTokens += input.usage.cachedInputTokens;
		this.completionTokens += input.usage.completionTokens;
		this.reasoningTokens += input.usage.reasoningTokens;
		this.totalTokens += input.usage.totalTokens;
		this.totalDurationMs += durationMs;
		if (ttftMs !== null) {
			this.ttftSumMs += ttftMs;
			this.ttftSamples += 1;
		}
		if (decodeMs > 0 && input.usage.completionTokens > 0) {
			this.decodeMs += decodeMs;
			this.decodeTokens += input.usage.completionTokens;
		}
		const modelEntry = this.getOrInitModel(input.model);
		modelEntry.requests += 1;
		modelEntry.succeeded += 1;
		modelEntry.promptTokens += input.usage.promptTokens;
		modelEntry.cachedInputTokens += input.usage.cachedInputTokens;
		modelEntry.completionTokens += input.usage.completionTokens;
		modelEntry.reasoningTokens += input.usage.reasoningTokens;
		modelEntry.totalTokens += input.usage.totalTokens;
		const tps = computeTps(input.usage.completionTokens, decodeMs);
		if (input.sessionKey !== void 0 && input.sessionKey !== "") {
			const existing = this.sessions.get(input.sessionKey);
			if (existing !== void 0) this.sessions.delete(input.sessionKey);
			const next = existing === void 0 ? {
				sessionKey: input.sessionKey,
				lastModel: input.model,
				turns: 1,
				continuations: input.continuation ? 1 : 0,
				promptTokens: input.usage.promptTokens,
				uncachedInputTokens: input.usage.uncachedInputTokens,
				cachedInputTokens: input.usage.cachedInputTokens,
				completionTokens: input.usage.completionTokens,
				reasoningTokens: input.usage.reasoningTokens,
				totalTokens: input.usage.totalTokens,
				lastTtftMs: ttftMs,
				lastTps: tps,
				lastActiveAt: now
			} : {
				...existing,
				lastModel: input.model,
				turns: existing.turns + 1,
				continuations: existing.continuations + (input.continuation ? 1 : 0),
				promptTokens: existing.promptTokens + input.usage.promptTokens,
				uncachedInputTokens: existing.uncachedInputTokens + input.usage.uncachedInputTokens,
				cachedInputTokens: existing.cachedInputTokens + input.usage.cachedInputTokens,
				completionTokens: existing.completionTokens + input.usage.completionTokens,
				reasoningTokens: existing.reasoningTokens + input.usage.reasoningTokens,
				totalTokens: existing.totalTokens + input.usage.totalTokens,
				lastTtftMs: ttftMs,
				lastTps: tps,
				lastActiveAt: now
			};
			this.sessions.set(input.sessionKey, next);
			while (this.sessions.size > this.maxSessions) {
				const oldest = this.sessions.keys().next().value;
				if (oldest === void 0) break;
				this.sessions.delete(oldest);
			}
		}
		this.lastTurn = {
			at: now,
			model: input.model,
			stream: input.stream,
			continuation: input.continuation,
			promptTokens: input.usage.promptTokens,
			uncachedInputTokens: input.usage.uncachedInputTokens,
			cachedInputTokens: input.usage.cachedInputTokens,
			completionTokens: input.usage.completionTokens,
			reasoningTokens: input.usage.reasoningTokens,
			totalTokens: input.usage.totalTokens,
			ttftMs,
			durationMs,
			decodeMs,
			tps,
			upstreamContextWindow: input.upstreamContextWindow ?? null,
			upstreamFirstPacketMs: input.upstreamFirstPacketMs ?? null,
			upstreamAckMs: input.upstreamAckMs ?? null
		};
	}
	recordFailure(input) {
		const now = input.now ?? Date.now();
		const durationMs = sanitizeDuration(input.durationMs);
		this.updatedAt = now;
		this.requests += 1;
		this.failed += 1;
		this.totalDurationMs += durationMs;
		const modelEntry = this.getOrInitModel(input.model);
		modelEntry.requests += 1;
		modelEntry.failed += 1;
	}
	reset(now = Date.now()) {
		this.startedAt = now;
		this.updatedAt = now;
		this.requests = 0;
		this.succeeded = 0;
		this.failed = 0;
		this.continuations = 0;
		this.promptTokens = 0;
		this.uncachedInputTokens = 0;
		this.cachedInputTokens = 0;
		this.completionTokens = 0;
		this.reasoningTokens = 0;
		this.totalTokens = 0;
		this.ttftSumMs = 0;
		this.ttftSamples = 0;
		this.decodeMs = 0;
		this.decodeTokens = 0;
		this.totalDurationMs = 0;
		this.lastTurn = null;
		this.byModel.clear();
		this.sessions.clear();
	}
	snapshot(activeConversations = 0) {
		const cacheHitRate = this.promptTokens > 0 ? Number(Math.min(1, this.cachedInputTokens / this.promptTokens).toFixed(4)) : null;
		return {
			ok: true,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			activeConversations,
			totals: {
				requests: this.requests,
				succeeded: this.succeeded,
				failed: this.failed,
				continuations: this.continuations,
				promptTokens: this.promptTokens,
				uncachedInputTokens: this.uncachedInputTokens,
				cachedInputTokens: this.cachedInputTokens,
				completionTokens: this.completionTokens,
				reasoningTokens: this.reasoningTokens,
				totalTokens: this.totalTokens,
				cacheHitRate,
				avgTtftMs: this.ttftSamples > 0 ? Math.round(this.ttftSumMs / this.ttftSamples) : null,
				avgTps: computeTps(this.decodeTokens, this.decodeMs),
				totalDurationMs: this.totalDurationMs,
				decodeMs: this.decodeMs,
				decodeTokens: this.decodeTokens
			},
			byModel: [...this.byModel.values()],
			sessions: [...this.sessions.values()].reverse(),
			lastTurn: this.lastTurn
		};
	}
};
//#endregion
//#region src/doubao-shim.ts
/**
* Loopback shim for the Doubao route.
*
* pi-ai's OpenAI-completions API object wants an OpenAI-shaped HTTP endpoint.
* Doubao speaks a private three-line streaming dialect at a different origin,
* with credentials resolved out of a Chromium profile rather than a bearer
* token. This shim is the boundary: it terminates an OpenAI-shaped request on
* an ephemeral 127.0.0.1 port and speaks Doubao upstream.
*
* SECURITY. Everything in the inbound half is upstream-independent hardening
* and is kept deliberately identical to `dsh-connect-workbuddy`'s shim:
*
*   * binds 127.0.0.1 only, on an ephemeral port;
*   * Host header must name loopback (drops DNS-rebinding pages);
*   * a browser-sent Origin must be loopback;
*   * a per-process shared secret, compared in constant time, which pi-ai
*     sends as `Authorization: Bearer`. The secret NEVER leaves this process
*     and is never forwarded upstream — Doubao authenticates on the cookie
*     jar, which the shim resolves per request;
*   * chat POSTs must be `application/json`;
*   * request bodies are size-capped.
*
* Nothing that leaves this process carries the shared secret except the
* loopback hop, and nothing that arrives is trusted without passing all of the
* above.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）；
*   入站加固层的做法（loopback 绑定、Host/Origin 校验、常量时间 bearer 比对、
*   JSON content-type 强制、body 上限）由该项目确立，本文件原样复用其安全策略。
*
* @module dsh-connect-doubao/shim
*/
/** Hostnames the inbound half will accept. */
const LOOPBACK_HOSTS$1 = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Cap on an inbound chat body. Doubao replies are short; anything larger is abuse. */
const MAX_BODY_BYTES = 4194304;
/** Strip a port and IPv6 brackets from a Host/Origin hostname. */
function hostnameOfHost(host) {
	let hostname = host.trim();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The Host header must name loopback. A DNS-rebinding page re-resolves an
* attacker domain to 127.0.0.1 but still sends its own domain in Host, so this
* drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS$1.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin must be loopback. Non-browser clients send no Origin
* at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS$1.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each Doubao failure class surfaces as. */
const KIND_STATUS = {
	rate_limited: 429,
	quota_exhausted: 429,
	session_dead: 401,
	network: 502,
	upstream: 502,
	task_runtime_unavailable: 409
};
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** OpenAI-shaped error envelope, which is what pi-ai parses. */
function writeOpenAIError(res, status, code, message) {
	writeJson(res, status, { error: {
		message,
		type: code,
		code
	} });
}
/**
* Translate the adapter's thinking-level spelling into a Doubao level id.
*
* The adapter already speaks catalog ids, and those are the same five the client
* menu offers (低 / 中 / 高 / 极高 / 最高), so this is mostly a passthrough — but
* pi-ai's own spellings can still arrive from a hand-written request, and those
* collapse onto the nearest Doubao rung: `minimal` means 低, `medium` means 中.
* An unrecognised or absent value leaves the default in place.
*/
function toDoubaoLevel(spelling) {
	switch (spelling) {
		case "minimal":
		case "low": return "low";
		case "medium": return "mid";
		case "high": return "high";
		case "xhigh": return "xhigh";
		case "max": return "max";
		default: return;
	}
}
/**
* Name the model a request ASKED for, in words a user can read.
*
* Doubao's `model_item_key` values are opaque (`0`, `3`, `5`, `seed-lite-7b`),
* so the wire key means nothing outside the client. Returning the name — and
* naming the field `requested_model` rather than `model` — keeps the statement
* inside what we actually know: this is what we sent, not what served the
* reply. An id the catalog does not know is echoed verbatim with `unknown`, so
* a typo cannot be mistaken for a valid model.
*/
function describeRequestedModel(key) {
	if (key === void 0) {
		const fallback = findDoubaoModel(void 0);
		return {
			name: fallback.name,
			item_key: fallback.id
		};
	}
	const discovered = liveModels().find((model) => model.id === key);
	if (discovered !== void 0) return {
		name: discovered.name,
		item_key: key
	};
	return DOUBAO_MODELS.some((model) => model.id === key) ? {
		name: findDoubaoModel(key).name,
		item_key: key
	} : {
		name: key,
		item_key: key,
		unknown: true
	};
}
/**
* Resolve the per-request upstream knobs from an inbound request.
*
* Without this the shim would silently discard the model the caller picked:
* the inbound `model` is a catalog id that IS Doubao's `model_item_key`, and
* `reasoning_effort` is the adapter's level spelling.
*/
function requestOptions(parsed) {
	const level = toDoubaoLevel(parsed.reasoning_effort);
	/**
	* The 深度思考 switch, ON by default.
	*
	* The level the picker sends only reaches the wire as `reasoning_effort`
	* (3/4/5), and the server ignores it for thinking unless this switch is also
	* open: measured 2026-11-07, the same model answered with `thinking: false`
	* while effort was already 5, because every turn went out as an ordinary one
	* with `need_deep_think: 0`. Without this the picker's 低/中/高 is a control
	* that changes nothing — which is exactly what it looked like.
	*
	* `DSH_DOUBAO_DEEP_THINK=0` turns it back off, for the one case worth
	* debugging that way: a thinking turn whose first token arrives much later.
	*
	* 「工作任务」 models are deliberately left UNSET rather than sent `true`:
	* their captured shape is `need_deep_think: 10001`, and `buildChatBody` only
	* emits it while `deepThink` is `undefined`. Passing a boolean here would
	* silently downgrade every task turn to the chat shape.
	*/
	if (isImageModel(parsed.model)) return {
		modelKey: "0",
		skill: "imageGen",
		deepThink: false
	};
	const discovered = liveModels().find((model) => model.id === parsed.model);
	const taskModel = isTaskModel(parsed.model) || discovered?.taskMode === true;
	return {
		...taskModel ? {} : { deepThink: parsed.reasoning_effort === "off" ? false : process.env.DSH_DOUBAO_DEEP_THINK !== "0" },
		...parsed.model === void 0 ? {} : { modelKey: parsed.model },
		...level === void 0 ? {} : { reasoningLevel: level },
		...taskModel ? { taskMode: true } : {}
	};
}
/**
* IMAGEGEN_LOCAL_FILE: download the picture and reference it locally.
*
* The Harness renders local files reliably; a signed CDN URL in Markdown shows
* up as 「图片无法预览」 (the `~tplv-…` segment breaks link parsing and the
* origin may be blocked). Saving the bytes next to the session sidesteps both.
*
* Returns Markdown with the local path, or the remote URL when the download
* fails — a broken preview is better than a missing picture.
*/
async function imageMarkdownLocal(images) {
	if (images.length === 0) return "";
	const dir = join(homedir(), ".dsh", "doubao-images");
	const parts = [];
	for (const [i, image] of images.entries()) {
		const fallback = `![豆包生图 ${i + 1}](${markdownSafeUrl(image.url)})`;
		try {
			const res = await fetch(image.url);
			if (!res.ok) {
				parts.push(fallback);
				continue;
			}
			const buf = Buffer.from(await res.arrayBuffer());
			mkdirSync(dir, { recursive: true });
			const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const file = join(dir, `doubao-${stamp}-${i + 1}.png`);
			writeFileSync(file, buf);
			parts.push(`![豆包生图 ${i + 1}](${file.replace(/\\/g, "/")})`);
		} catch {
			parts.push(fallback);
		}
	}
	return parts.join("\n\n");
}
/**
* IMAGEGEN_URL_SAFE: make a CDN URL survive Markdown link parsing.
*
* Doubao's signed URLs carry `~tplv-…` and `x-signature=…%3D`. A bare `~` is the
* strikethrough marker, so the link breaks and the Harness renders
* 「图片无法预览：*」 instead of the picture. Percent-encoding the path segment
* keeps the bytes identical while removing the ambiguous characters.
*/
function markdownSafeUrl(raw) {
	if (typeof raw !== "string" || raw === "") return "";
	const q = raw.indexOf("?");
	const path = q === -1 ? raw : raw.slice(0, q);
	const query = q === -1 ? "" : raw.slice(q);
	return path.replace(/~/g, "%7E").replace(/\(/g, "%28").replace(/\)/g, "%29") + query.replace(/\(/g, "%28").replace(/\)/g, "%29");
}
/**
* Flatten pi-ai's content shapes (string | block array) into plain text.
*
* Doubao's endpoint takes one `text_block`, so multimodal blocks are not
* forwarded: this provider advertises text-only input and the adapter never
* offers anything else.
*/
function flattenContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const record = block;
			if (typeof record.text === "string") parts.push(record.text);
			else if (typeof record.content === "string") parts.push(record.content);
		}
	}
	return parts.join("\n");
}
/**
* Assemble the final prompt from the inbound transcript.
*
* Doubao's endpoint carries one user message; a multi-turn transcript is
* flattened newest-last with role prefixes so the model still sees the
* history. The system prompt is folded in as context rather than dropped.
*
* A `role: "tool"` message becomes a `[tool result] …` line, which is the exact
* shape the tool contract promises — the model is asked to recognise that prefix,
* so the two sides must not drift apart.
*/
/**
* Whether this turn targets the image alias.
*
* DSH may spell the model id with a provider prefix (`doubao/image-gen`) or in
* another case; a missed match silently falls back to the full agent prompt,
* which is how framework text ended up drawn into the picture.
*/
function isImageModel(model) {
	if (typeof model !== "string" || model === "") return false;
	return (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model).trim().toLowerCase() === DOUBAO_IMAGE_MODEL_ID;
}
/**
* IMAGEGEN_PROMPT: pick the sentence the user actually typed.
*
* The transcript DSH hands us is not just that sentence: it carries the
* developer prompt, a runtime snapshot, the skill catalog, the MCP listing and
* memory pages, each as its own `user` message. Taking the last user message
* therefore picked up a `<system-reminder>` block, and Doubao drew that text
* into the picture — the reported "turn 1 step 1 / tup / tun" artefacts.
*
* A picture description is short and plain, so a message qualifies only when it
* is bounded in length and carries no known marker or XML-ish wrapper.
*/
const FRAMEWORK_MARKERS = [
	"Current runtime context",
	"Current working directory:",
	"Time sampled while preparing",
	"Elapsed since the preceding",
	"Available skills:",
	"[Plugin context from",
	"[the previous turn was interrupted",
	"<system-reminder>",
	"<available_skills>",
	"<mcp_catalog>",
	"<hindsight_pages>",
	"<hindsight_page_refresh>",
	"<hindsight_knowledge",
	"A skill is a reusable set of task-specific instructions",
	"The following MCP servers are available",
	"You are an AI agent powered by"
];
/** Anything longer than this is machine context, not a picture request. */
const MAX_IMAGE_PROMPT_CHARS = 2e3;
function stripInjectedBlocks(text) {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<hindsight_page_refresh>[\s\S]*?<\/hindsight_page_refresh>/g, "").trim();
}
function looksLikeFramework(text) {
	const head = text.slice(0, 400);
	if (head.startsWith("<")) return true;
	if (/^[<\[]/.test(head) && head.includes(">")) return true;
	return FRAMEWORK_MARKERS.some((marker) => head.includes(marker));
}
function buildImagePrompt(all, outgoing) {
	const source = all.length > 0 ? all : outgoing;
	let fallback = "";
	for (let i = source.length - 1; i >= 0; i -= 1) {
		const message = source[i];
		if (message === void 0) continue;
		if ((message.role ?? "user") !== "user") continue;
		const text = stripInjectedBlocks(flattenContent(message.content));
		if (text === "" || looksLikeFramework(text)) continue;
		if (text.length <= MAX_IMAGE_PROMPT_CHARS) return text;
		if (fallback === "") fallback = text.slice(0, MAX_IMAGE_PROMPT_CHARS);
	}
	return fallback;
}
function buildPrompt(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	const turns = [];
	for (const message of messages) {
		const text = flattenContent(message.content);
		const role = message.role ?? "user";
		if (role === "tool") {
			if (text) turns.push(toolResultAsText(message.name, text));
			continue;
		}
		if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
			const fencedCalls = message.tool_calls.map((tc) => {
				const fnName = tc.function?.name ?? "";
				const rawArgs = tc.function?.arguments;
				let parsedArgs = rawArgs ?? {};
				if (typeof rawArgs === "string") try {
					parsedArgs = JSON.parse(rawArgs);
				} catch {}
				return `\`\`\`doubao-tool\n${JSON.stringify({
					name: fnName,
					arguments: parsedArgs
				})}\n\`\`\``;
			}).join("\n\n");
			const trimmed = text.trim();
			const combined = trimmed ? `${trimmed}\n\n${fencedCalls}` : fencedCalls;
			turns.push(`[assistant] ${combined}`);
			continue;
		}
		if (!text) continue;
		turns.push(role === "user" ? text : `[${role}] ${text}`);
	}
	return turns.join("\n\n");
}
/**
* The `error.type` / `error.code` string for one class of failure.
*
* pi-ai's retry policy reads these names, so they are a contract, not cosmetics:
* a non-retryable failure that says TIMEOUT invites a retry storm that cannot
* succeed.
*/
function errorCodeFor(kind, retryable) {
	if (kind === "rate_limited" || kind === "quota_exhausted") return "RATE_LIMIT";
	if (kind === "network") return retryable ? "TIMEOUT" : "SERVER";
	return "SERVER";
}
/**
* Forget a session the server has rejected.
*
* Both the in-memory copy and the sealed one on disk: the sealed session has no
* TTL (its real deadline is the server's, not a local clock), so leaving it in
* place would hand the rejected cookie back on every later request — with the
* card still showing a signed-in account, which makes the user's fix (「重新登录」)
* look like it did nothing.
*/
function revokeSession() {
	invalidateCredentialCache();
	clearCredentialCache();
}
/**
* Per-request cancellation and liveness.
*
* Two failures share one root cause: nothing ever told the upstream turn to
* stop. A client that hung up (Stop button, window closed, Harness shutting
* down) left Doubao generating for minutes — spending quota on an answer nobody
* would read — and a stream that went silent held the request open with no way
* out. Both end in `signal` being aborted, which reaches the socket through
* `fetch`, not just our side of it.
*
* `release` is wired to the response's own terminal events so every exit path
* (finished, failed, client gone) tears the watchdog down without each branch
* having to remember.
*/
function createRequestLifecycle(res, options = {}) {
	const idleMs = options.idleMs ?? 3e5;
	const abort = new AbortController();
	let gone = false;
	const onClose = () => {
		if (res.writableEnded) return;
		gone = true;
		abort.abort();
	};
	res.on("close", onClose);
	let timer;
	const disarm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	/** Reset the watchdog: an upstream delta is proof of life. */
	const onActivity = () => {
		disarm();
		timer = setTimeout(() => {
			abort.abort(/* @__PURE__ */ new Error(`豆包 ${Math.round(idleMs / 1e3)} 秒内没有返回任何数据，已中止本次请求。`));
		}, idleMs);
		timer.unref?.();
	};
	const release = () => {
		disarm();
		res.off("close", onClose);
	};
	res.once("finish", release);
	res.once("close", release);
	onActivity();
	/**
	* Hard-abandon the upstream fetch after a terminal failure.
	*
	* `reader.cancel()` only lets go of the body; aborting the signal closes the
	* socket itself, which is the same reach `stop` has — without it a failed
	* turn leaves Doubao generating into a connection nobody reads.
	*/
	const abortUpstream = (reason) => {
		abort.abort(reason ?? /* @__PURE__ */ new Error("豆包上游请求已中止。"));
	};
	return {
		signal: abort.signal,
		onActivity,
		clientGone: () => gone,
		release,
		abortUpstream
	};
}
function createDoubaoShim(options = {}) {
	const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials;
	/**
	* Doubao conversation ids by transcript opening.
	*
	* The Harness resends the whole transcript every turn, so continuity has to be
	* inferred; see `doubao-session.ts` for the rule and why it is conservative.
	* Kept per shim (i.e. per host process) — a restart simply starts new threads.
	*/
	const sessions = new ConversationStore();
	const statsTracker = options.stats ?? new DoubaoStatsTracker();
	/**
	* Circuit valve: consecutive upstream failures per conversation.
	*
	* While a conversation is in cooldown NO request leaves the process — no
	* server-side turn can start, so a retry loop can never re-trigger
	* generation and burn quota. Cleared by the next successful turn.
	*/
	const recentFailures = /* @__PURE__ */ new Map();
	const CIRCUIT_FAILURES = 3;
	const CIRCUIT_COOLDOWN_MS = 6e4;
	const bumpFailure = (key) => {
		const prev = recentFailures.get(key);
		const count = (prev?.count ?? 0) + 1;
		const until = count >= CIRCUIT_FAILURES ? Date.now() + CIRCUIT_COOLDOWN_MS : prev?.until ?? 0;
		if (recentFailures.size >= 256 && !recentFailures.has(key)) {
			const oldest = recentFailures.keys().next().value;
			if (oldest !== void 0) recentFailures.delete(oldest);
		}
		recentFailures.set(key, {
			count,
			until
		});
	};
	/** Prompt-level tool calling; ON by default so Doubao can drive local tools. */
	const emulationOn = options.toolEmulation ?? (() => true);
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	/** Read a size-capped request body. Rejects over-limit and wrong content types. */
	function readBody(req) {
		return new Promise((resolve) => {
			const chunks = [];
			let size = 0;
			let aborted = false;
			req.on("data", (chunk) => {
				if (aborted) return;
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					aborted = true;
					resolve(void 0);
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (!aborted) resolve(Buffer.concat(chunks));
			});
			req.on("error", () => {
				if (!aborted) resolve(void 0);
			});
		});
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = async () => {
		await ready.catch(() => {});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("doubao shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	/** Translate one Doubao failure into the OpenAI error envelope pi-ai expects. */
	function writeFailure(res, error) {
		if (res.writableEnded || res.destroyed) return;
		const kind = error instanceof DoubaoUpstreamError ? classifyDoubaoFailure(error) : "network";
		const message = error?.message ?? "Doubao upstream failed";
		const status = KIND_STATUS[kind];
		const retryable = isRetryableFailure(error);
		if (!res.headersSent) res.setHeader("x-should-retry", retryable ? "true" : "false");
		writeOpenAIError(res, status, errorCodeFor(kind, retryable), message);
	}
	/** Stream a completion as OpenAI SSE chunks. */
	/**
	* Stream one completion back as OpenAI-shaped SSE chunks.
	*
	* `parsed` is needed for the model and thinking level: the prompt alone says
	* nothing about which of them the caller picked.
	*
	* `emulate` switches the reply handling: instead of forwarding text deltas as
	* they arrive, the whole turn is collected and the tool fence is parsed out.
	* Streaming a fence cannot work — the call is only knowable once its JSON is
	* complete — and an emulated turn is slow enough (~11.5s measured) that
	* losing incrementality costs nothing a user would notice.
	*/
	async function streamCompletion(res, prompt, parsed, upstreamOptions, remember, forget, emulate, lifecycle, accounting) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		const chunkId = `doubao-${randomBytes(8).toString("hex")}`;
		const created = Math.floor(Date.now() / 1e3);
		const chatStartedAt = Date.now();
		let firstTokenAt = null;
		const markFirstToken = () => {
			if (firstTokenAt === null) firstTokenAt = Date.now();
		};
		const sendRaw = (payload) => {
			if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		const sendChunk = (payload) => {
			sendRaw({
				id: chunkId,
				object: "chat.completion.chunk",
				created,
				model: accounting.modelId,
				...payload
			});
		};
		let roleSent = false;
		const turnIds = {};
		let stoppedQuestionId;
		const stopActiveTurn = (reason) => {
			const { conversationId, questionId } = turnIds;
			if (conversationId === void 0 || questionId === void 0) return;
			if (stoppedQuestionId === questionId) return;
			stoppedQuestionId = questionId;
			let credentials;
			try {
				credentials = resolveCredentials();
			} catch {
				return;
			}
			if (!credentials.ok) return;
			stopGeneration(credentials, {
				conversationId,
				questionId
			}).catch((error) => {
				if (process.env.DSH_DOUBAO_DEBUG_PLAN === "1") process.stderr.write(`[plan] stop-generation(${reason}) failed: ${String(error)}\n`);
			});
		};
		lifecycle.signal.addEventListener("abort", () => stopActiveTurn("abandoned"), { once: true });
		const callbacks = {
			onThinking: (delta) => {
				lifecycle.onActivity();
				if (delta !== "") markFirstToken();
				if (!roleSent) {
					sendChunk({ choices: [{
						index: 0,
						delta: { role: "assistant" },
						finish_reason: null
					}] });
					roleSent = true;
				}
				sendChunk({ choices: [{
					index: 0,
					delta: { reasoning_content: delta },
					finish_reason: null
				}] });
			},
			onText: (delta) => {
				lifecycle.onActivity();
				if (emulate) return;
				if (delta !== "") markFirstToken();
				if (!roleSent) {
					sendChunk({ choices: [{
						index: 0,
						delta: { role: "assistant" },
						finish_reason: null
					}] });
					roleSent = true;
				}
				sendChunk({ choices: [{
					index: 0,
					delta: { content: delta },
					finish_reason: null
				}] });
			},
			onTurnIds: (ids) => {
				if (ids.conversationId !== void 0) turnIds.conversationId = ids.conversationId;
				if (ids.questionId !== void 0) turnIds.questionId = ids.questionId;
			}
		};
		let result;
		try {
			try {
				result = await chat(prompt, {
					...upstreamOptions,
					signal: lifecycle.signal,
					callbacks
				});
			} catch (error) {
				if (!accounting.isContinuationTurn || !isInvalidParamFailure(error) || firstTokenAt !== null) throw error;
				forget();
				stopActiveTurn("fallback-reissue");
				accounting.isContinuationTurn = false;
				accounting.cachedPrefixMessages = 0;
				if (process.env.DSH_DOUBAO_DEBUG_PLAN === "1") process.stderr.write("[plan] continuation rejected (710020202); re-issuing as fresh conversation\\n");
				result = await chat(buildPrompt(parsed.messages ?? []) + accounting.emulatedContractText, {
					...requestOptions(parsed),
					signal: lifecycle.signal,
					callbacks
				});
			}
			remember(result.conversationId);
			if (!roleSent) sendChunk({ choices: [{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null
			}] });
			let finishReason = "stop";
			let visibleAnswerText = result.text;
			let calls = [];
			if (emulate) {
				const parsedCalls = parseToolCalls(result.text);
				calls = parsedCalls.calls;
				visibleAnswerText = parsedCalls.text;
				const visible = parsedCalls.text.trim() === "" ? " " : parsedCalls.text;
				if (parsedCalls.text.trim() !== "" || calls.length > 0) markFirstToken();
				sendChunk({ choices: [{
					index: 0,
					delta: { content: visible },
					finish_reason: null
				}] });
				calls.forEach((call, index) => {
					sendChunk({ choices: [{
						index: 0,
						delta: { tool_calls: [{
							index,
							id: call.id,
							type: "function",
							function: {
								name: call.name,
								arguments: call.arguments
							}
						}] },
						finish_reason: null
					}] });
				});
				if (calls.length > 0) finishReason = "tool_calls";
			}
			const markdown = await imageMarkdownLocal(result.images);
			if (markdown !== "") {
				markFirstToken();
				sendChunk({ choices: [{
					index: 0,
					delta: { content: `\n\n${markdown}` },
					finish_reason: null
				}] });
			}
			sendChunk({ choices: [{
				index: 0,
				delta: {},
				finish_reason: finishReason
			}] });
			const completedAt = Date.now();
			const answerForUsage = [visibleAnswerText, markdown].filter((part) => part !== "").join("\n\n");
			const usage = resolveChatUsage({
				messages: parsed.messages ?? [],
				...parsed.tools !== void 0 ? { tools: parsed.tools } : {},
				...accounting.emulatedContractText !== "" ? { emulatedContractText: accounting.emulatedContractText } : {},
				cachedPrefixMessages: accounting.cachedPrefixMessages,
				answerText: answerForUsage,
				...result.reasoningText !== void 0 ? { reasoningText: result.reasoningText } : {},
				...calls.length > 0 ? { toolCalls: calls } : {}
			});
			const ttftMs = firstTokenAt === null ? null : Math.max(0, firstTokenAt - chatStartedAt);
			const decodeMs = firstTokenAt === null ? 0 : Math.max(0, completedAt - firstTokenAt);
			const durationMs = Math.max(0, completedAt - chatStartedAt);
			statsTracker.recordSuccess({
				model: accounting.modelId,
				...accounting.sessionKey !== void 0 ? { sessionKey: accounting.sessionKey } : {},
				stream: true,
				continuation: accounting.isContinuationTurn,
				usage,
				ttftMs,
				durationMs,
				decodeMs,
				...result.telemetry?.contextWindowUsage !== void 0 ? { upstreamContextWindow: result.telemetry.contextWindowUsage } : {},
				...result.telemetry?.firstPacketCostMs !== void 0 ? { upstreamFirstPacketMs: result.telemetry.firstPacketCostMs } : {},
				...result.telemetry?.ackCostMs !== void 0 ? { upstreamAckMs: result.telemetry.ackCostMs } : {},
				now: completedAt
			});
			if (parsed.stream_options?.include_usage !== false) sendChunk({
				choices: [],
				usage: usage.openai
			});
			if (!res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		} catch (error) {
			statsTracker.recordFailure({
				model: accounting.modelId,
				durationMs: Math.max(0, Date.now() - chatStartedAt)
			});
			lifecycle.abortUpstream(error instanceof Error ? error : void 0);
			if (error instanceof DoubaoUpstreamError && accounting.sessionKey !== void 0) bumpFailure(accounting.sessionKey);
			const kind = error instanceof DoubaoUpstreamError ? classifyDoubaoFailure(error) : "network";
			if (kind === "session_dead") {
				forget();
				revokeSession();
			} else if (accounting.isContinuationTurn && isInvalidParamFailure(error)) forget();
			if (lifecycle.clientGone()) return;
			sendRaw({ error: {
				message: error?.message ?? "Doubao upstream failed",
				type: errorCodeFor(kind, isRetryableFailure(error))
			} });
			if (!res.writableEnded && !res.destroyed) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		}
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && url.startsWith("/quota")) {
				const quota = await fetchQuota();
				const fiveHour = findWindow(quota, "five_hour");
				const weekly = findWindow(quota, "weekly");
				writeJson(res, 200, {
					ok: true,
					plan: quota.plan ?? null,
					exhausted: quota.exhausted,
					windows: {
						fiveHour: fiveHour ? {
							usedPercent: fiveHour.usedPercent,
							remainingPercent: fiveHour.remainingPercent,
							resetsAt: fiveHour.resetsAt,
							resetsInMs: millisUntilReset(fiveHour)
						} : null,
						weekly: weekly ? {
							usedPercent: weekly.usedPercent,
							remainingPercent: weekly.remainingPercent,
							resetsAt: weekly.resetsAt,
							resetsInMs: millisUntilReset(weekly)
						} : null
					},
					error: quota.error ?? null
				});
				return;
			}
			if (!(url.startsWith("/v1/chat/completions") || url === "/v1/chat/completions") || req.method !== "POST") {
				writeOpenAIError(res, 404, "not_found", "unsupported route");
				return;
			}
			if (!isJsonContentType(req)) {
				writeOpenAIError(res, 415, "unsupported_media_type", "chat requests must be application/json");
				return;
			}
			const credentials = resolveCredentials();
			if (!credentials.ok) {
				writeOpenAIError(res, 401, "session_dead", credentials.reason ?? "Doubao is not signed in");
				return;
			}
			const raw = await readBody(req);
			if (raw === void 0) {
				writeOpenAIError(res, 413, "payload_too_large", "request body exceeds the size limit");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch {
				writeOpenAIError(res, 400, "invalid_request", "request body is not valid JSON");
				return;
			}
			if ((await fetchQuota()).exhausted) {
				writeOpenAIError(res, 429, "quota_exhausted", "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端中查看额度状态。");
				return;
			}
			const imageModel = isImageModel(parsed.model);
			const sessionKey = sessionKeyOf(parsed.messages);
			const known = sessions.get(sessionKey);
			const cooldown = sessionKey !== void 0 ? recentFailures.get(sessionKey) : void 0;
			if (cooldown !== void 0 && cooldown.count >= CIRCUIT_FAILURES && Date.now() < cooldown.until) {
				const waitSec = Math.ceil((cooldown.until - Date.now()) / 1e3);
				writeOpenAIError(res, 429, "RATE_LIMIT", `豆包已连续失败 ${cooldown.count} 次，暂停发送 ${waitSec} 秒以避免继续消耗积分；稍后重试即可。`);
				return;
			}
			const continuing = !imageModel && isContinuation(parsed.messages, known);
			/**
			* What to send.
			*
			* `+1` accounts for the ASSISTANT reply this turn will add to the thread:
			* the server stores both sides, while the inbound transcript we remember
			* ends at the user message. Without it the next turn would resend last
			* turn's answer as if it were new input.
			*/
			const delta = continuing ? continuationDelta(parsed.messages ?? [], known) : [];
			const useDelta = delta.length > 0;
			let isContinuationTurn = continuing && useDelta;
			const outgoing = useDelta ? delta : parsed.messages ?? [];
			const promptBody = imageModel ? buildImagePrompt(parsed.messages ?? [], outgoing) : buildPrompt(outgoing);
			if (!promptBody) {
				writeOpenAIError(res, 400, "invalid_request", "no usable message content");
				return;
			}
			/**
			* Tool emulation: the declared tools become part of the PROMPT, because
			* Doubao ignores the real `tools` field outright (measured — it answered
			* with its own server-side search skill instead). Never append tool schemas
			* to image-generation prompts, or Doubao replies in text instead of drawing.
			*/
			const emulate = !imageModel && emulationOn() && (parsed.tools?.length ?? 0) > 0;
			const emulatedContractText = emulate ? buildToolContract(parsed.tools ?? []) : "";
			const prompt = emulate ? `${promptBody}${emulatedContractText}` : promptBody;
			if (process.env.DSH_DOUBAO_DEBUG_PROMPT === "1") {
				const raw = JSON.stringify((parsed.messages ?? []).map((m) => ({
					r: m.role,
					t: flattenContent(m.content).slice(0, 200)
				})));
				const line = `[prompt] model=${String(parsed.model)} chars=${prompt.length} tools=${parsed.tools?.length ?? 0} emulate=${emulate} msgs=${(parsed.messages ?? []).length}\nRAW=${raw}\n${prompt.slice(0, 2e3)}\n---\n`;
				process.stderr.write(line);
				try {
					appendFileSync(join(homedir(), ".dsh", "doubao-prompt.log"), line);
				} catch {}
			}
			const { signal, onActivity, clientGone, abortUpstream } = createRequestLifecycle(res);
			const upstreamOptions = {
				...requestOptions(parsed),
				signal,
				...isContinuationTurn && known !== void 0 ? {
					conversationId: known.conversationId,
					continueConversation: true
				} : {}
			};
			/** Record the thread id the server handed back, for the next turn. */
			const remember = (conversationId) => {
				if (sessionKey !== void 0) recentFailures.delete(sessionKey);
				if (!imageModel && conversationId !== void 0) sessions.remember(sessionKey, conversationId, (parsed.messages?.length ?? 0) + 1);
			};
			if (process.env.DSH_DOUBAO_DEBUG_PLAN === "1") process.stderr.write(`[plan] continuation=${isContinuationTurn} messages=${parsed.messages?.length ?? 0} sending=${outgoing.length} chars=${prompt.length} conversation=${isContinuationTurn && known !== void 0 ? known.conversationId : "(new)"}\n`);
			const sent = findDoubaoModel(parsed.model);
			let cachedPrefixMessages = isContinuationTurn && known !== void 0 ? known.messageCount : 0;
			if (parsed.stream === false) {
				const chatStartedAt = Date.now();
				let result;
				try {
					try {
						result = await chat(prompt, upstreamOptions);
					} catch (error) {
						if (!isContinuationTurn || !isInvalidParamFailure(error)) throw error;
						sessions.forget(sessionKey);
						isContinuationTurn = false;
						cachedPrefixMessages = 0;
						if (process.env.DSH_DOUBAO_DEBUG_PLAN === "1") process.stderr.write("[plan] continuation rejected (710020202); re-issuing as fresh conversation\\n");
						result = await chat(buildPrompt(parsed.messages ?? []) + emulatedContractText, {
							...requestOptions(parsed),
							signal
						});
					}
				} catch (error) {
					statsTracker.recordFailure({
						model: sent.id,
						durationMs: Math.max(0, Date.now() - chatStartedAt)
					});
					abortUpstream(error instanceof Error ? error : void 0);
					if (error instanceof DoubaoUpstreamError && sessionKey !== void 0) bumpFailure(sessionKey);
					if (isContinuationTurn && isInvalidParamFailure(error)) sessions.forget(sessionKey);
					throw error;
				}
				const completedAt = Date.now();
				remember(result.conversationId);
				const emulated = emulate ? parseToolCalls(result.text) : {
					calls: [],
					text: result.text
				};
				const content = [emulated.text, result.images.length > 0 ? await imageMarkdownLocal(result.images) : ""].filter((part) => part !== "").join("\n\n");
				const usage = resolveChatUsage({
					messages: parsed.messages ?? [],
					...parsed.tools !== void 0 ? { tools: parsed.tools } : {},
					...emulatedContractText !== "" ? { emulatedContractText } : {},
					cachedPrefixMessages,
					answerText: content,
					...result.reasoningText !== void 0 ? { reasoningText: result.reasoningText } : {},
					...emulated.calls.length > 0 ? { toolCalls: emulated.calls } : {}
				});
				statsTracker.recordSuccess({
					model: sent.id,
					...sessionKey !== void 0 ? { sessionKey } : {},
					stream: false,
					continuation: isContinuationTurn,
					usage,
					ttftMs: null,
					durationMs: Math.max(0, completedAt - chatStartedAt),
					decodeMs: 0,
					...result.telemetry?.contextWindowUsage !== void 0 ? { upstreamContextWindow: result.telemetry.contextWindowUsage } : {},
					...result.telemetry?.firstPacketCostMs !== void 0 ? { upstreamFirstPacketMs: result.telemetry.firstPacketCostMs } : {},
					...result.telemetry?.ackCostMs !== void 0 ? { upstreamAckMs: result.telemetry.ackCostMs } : {},
					now: completedAt
				});
				writeJson(res, 200, {
					id: `doubao-${completedAt}`,
					object: "chat.completion",
					created: Math.floor(completedAt / 1e3),
					model: sent.id,
					requested_model: describeRequestedModel(parsed.model),
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content: content === "" ? " " : content,
							...result.reasoningText !== "" ? { reasoning_content: result.reasoningText } : {},
							...emulated.calls.length > 0 ? { tool_calls: emulated.calls.map((call) => ({
								id: call.id,
								type: "function",
								function: {
									name: call.name,
									arguments: call.arguments
								}
							})) } : {}
						},
						finish_reason: emulated.calls.length > 0 ? "tool_calls" : "stop"
					}],
					usage: usage.openai
				});
				return;
			}
			await streamCompletion(res, prompt, parsed, upstreamOptions, remember, () => sessions.forget(sessionKey), emulate, {
				signal,
				onActivity,
				clientGone,
				abortUpstream
			}, {
				modelId: sent.id,
				sessionKey,
				isContinuationTurn,
				cachedPrefixMessages,
				emulatedContractText
			});
		} catch (error) {
			writeFailure(res, error);
		}
	}
	/** Synchronous view of the origin; undefined until the socket is bound. */
	const baseUrlSync = () => {
		const address = server.address();
		if (address === null || typeof address === "string") return void 0;
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		baseUrl,
		baseUrlSync,
		token: () => SHARED_SECRET,
		stats: () => statsTracker.snapshot(sessions.size),
		resetStats: () => {
			statsTracker.reset();
		},
		async close() {
			await ready.catch(() => {});
			server.closeAllConnections?.();
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 2e3);
				timer.unref?.();
				server.close(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	};
}
//#endregion
//#region src/doubao-auth-browser.ts
/**
* Browser-based sign-in for the Doubao plugin.
*
* WHY THIS EXISTS
*
* This is the ONLY way the plugin obtains a session. It used to be the fallback
* for machines without the desktop app, while the primary path decrypted the
* app's own cookie jar; that primary path is gone (see `./doubao-auth.ts` for
* why) because the running app locks its cookie database exclusively — which is
* exactly the state this plugin is meant to run in.
*
* Doubao's passport endpoints are plain HTTPS + a `sessionid` cookie, and
* `a_bogus`/`msToken` are NOT verified for the account/quota calls this plugin
* makes — measured 2026-11-07: a request with a deliberately corrupted `a_bogus`
* still answered 200, and only the cookie mattered. So a single interactive
* sign-in in a real Chromium is enough, with no app and no signature algorithm.
*
* HOW
*
* Spawn Chrome/Edge against a DEDICATED profile under `~/.dsh` and drive it over
* the DevTools protocol. `Storage.getCookies` is browser-scoped, so one call
* returns every cookie for every context — no target attach, no page reload.
* The profile persists between logins, so the second run usually finds the
* session still valid and needs no scan at all.
*
* SECURITY: the returned pairs are the user's live session. They are handed to
* `doubao-auth.ts`, which seals them (Windows DPAPI / AES-256-GCM elsewhere)
* before anything touches disk. Nothing here logs a value.
*
* @module dsh-connect-doubao/auth-browser
*/
/** Cookie names that must survive, in the order the plugin prefers them. */
const REQUIRED = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"uid_tt",
	"sid_guard"
];
/** Domains whose cookies belong to Doubao (the passport jar spans several). */
const DOUBAO_DOMAIN = /(^|\.)(doubao|bytedance|zijieapi)\.com$/i;
/** Where the dedicated Chromium profile lives. Persisted on purpose. */
function browserProfileDir() {
	return join(homedir(), ".dsh", "doubao-browser-profile");
}
const CANDIDATES = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];
/** Host page for the sign-in. `/chat` is the page that actually mints the jar. */
const LOGIN_URL = "https://www.doubao.com/chat/";
/**
* Chromium locations on macOS and Linux.
*
* `spawn(exe, args)` runs the binary directly (no shell), so paths with spaces
* are fine. `homedir()` is called at lookup time rather than module load so it
* reflects the current environment and can be redirected in tests.
*/
function posixCandidates() {
	const home = homedir();
	const bundles = [
		["Google Chrome.app", "Google Chrome"],
		["Microsoft Edge.app", "Microsoft Edge"],
		["Chromium.app", "Chromium"],
		["Google Chrome Canary.app", "Google Chrome Canary"]
	];
	const candidates = [];
	for (const [app, binary] of bundles) {
		const inside = join("Contents", "MacOS", binary);
		candidates.push(join("/Applications", app, inside));
		candidates.push(join(home, "Applications", app, inside));
	}
	candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
	return candidates;
}
/**
* Find an installed Chromium binary, or `undefined`.
*
* `DSH_DOUBAO_CHROME` lets a user point at any binary explicitly (a portable
* install, a non-default bundle name, etc.); it wins when the file exists.
* Otherwise the platform picks a list: win32 keeps its four default install
* paths, while macOS / Linux use .app bundles and well-known executables.
*/
function findBrowser() {
	const override = process.env.DSH_DOUBAO_CHROME;
	if (override !== void 0 && override !== "" && existsSync(override)) return override;
	const candidates = process.platform === "win32" ? CANDIDATES : posixCandidates();
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
}
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/** Poll `http://127.0.0.1:<port>/json/version` until it answers. */
async function waitForDevtools(port, deadline) {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) });
			if (response.ok) {
				const body = await response.json();
				if (typeof body.webSocketDebuggerUrl === "string") return body.webSocketDebuggerUrl;
			}
		} catch {}
		await sleep(400);
	}
}
function openSocket(url) {
	const Ctor = globalThis.WebSocket;
	return Ctor === void 0 ? void 0 : new Ctor(url);
}
/**
* One `Storage.getCookies` round-trip.
*
* Browser-scoped on purpose: the page target may still be navigating, and
* attaching to it would race the sign-in redirect chain.
*/
async function readCookies(wsUrl, timeoutMs = 15e3) {
	const socket = openSocket(wsUrl);
	if (socket === void 0) throw new Error("this Node build has no global WebSocket");
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try {
				socket.close();
			} catch {}
			reject(/* @__PURE__ */ new Error("CDP timeout while reading cookies"));
		}, timeoutMs);
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({
				id: 1,
				method: "Storage.getCookies",
				params: {}
			}));
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("CDP socket error"));
		});
		socket.addEventListener("message", (event) => {
			const data = event.data;
			if (typeof data !== "string") return;
			let message;
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			if (message.id !== 1) return;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {}
			if (message.error !== void 0) {
				reject(new Error(String(message.error.message ?? "CDP error")));
				return;
			}
			const cookies = message.result?.cookies;
			resolve(Array.isArray(cookies) ? cookies : []);
		});
	});
}
/** Pick the Doubao cookies into `name → value`. */
function pickPairs(cookies) {
	const pairs = /* @__PURE__ */ new Map();
	for (const cookie of cookies) {
		const name = cookie.name;
		const value = cookie.value;
		const domain = cookie.domain;
		if (typeof name !== "string" || typeof value !== "string" || value === "") continue;
		if (typeof domain !== "string" || !DOUBAO_DOMAIN.test(domain.replace(/^\./, ""))) continue;
		if (!pairs.has(name)) pairs.set(name, value);
	}
	return pairs;
}
/**
* Kill a spawned browser including its renderer children.
*
* Windows needs `taskkill /T` because `child.kill()` leaves renderer/gpu
* children holding the user-data-dir. On POSIX taskkill does not exist:
* spawnSync returns a status of null with error ENOENT and does NOT throw,
* so the old `catch { child.kill() }` fallback never ran — the sign-in Chrome
* (and debug port 9333) leaked after every login and the next re-login failed
* with a port-occupied error. Kill the spawned process directly here;
* Chromium reaps its own renderers on SIGTERM.
*/
function terminate(child) {
	if (child.pid === void 0) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", [
				"/PID",
				String(child.pid),
				"/T",
				"/F"
			], { stdio: "ignore" });
		} catch {
			try {
				child.kill();
			} catch {}
		}
		return;
	}
	try {
		child.kill("SIGTERM");
	} catch {}
}
/**
* Run one interactive sign-in and return the harvested cookies.
*
* The caller decides where the credentials go; this function never writes them
* anywhere. A browser window stays open for the whole budget, so the user can
* finish a QR scan or an SMS code at their own pace.
*/
async function browserLogin(options = {}) {
	const say = options.onProgress ?? (() => {});
	const exe = findBrowser();
	if (exe === void 0) return {
		ok: false,
		reason: "没找到 Chrome 或 Edge。浏览器扫码登录需要一个 Chromium 内核的浏览器。"
	};
	const timeoutMs = options.timeoutMs ?? 3e5;
	const deadline = Date.now() + timeoutMs;
	const profile = browserProfileDir();
	mkdirSync(profile, { recursive: true });
	const port = 9333;
	const child = spawn(exe, [
		`--remote-debugging-port=${String(port)}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		LOGIN_URL
	], {
		stdio: "ignore",
		detached: false
	});
	try {
		say("已打开浏览器，请在弹出的窗口里扫码或短信登录…");
		const wsUrl = await waitForDevtools(port, Math.min(deadline, Date.now() + 2e4));
		if (wsUrl === void 0) return {
			ok: false,
			reason: `浏览器调试端口 ${String(port)} 没起来（可能被占用）。`
		};
		let lastNote = 0;
		while (Date.now() < deadline) {
			let cookies = [];
			try {
				cookies = await readCookies(wsUrl);
			} catch (error) {
				say(`读取登录态失败，重试中：${error.message}`);
				await sleep(1500);
				continue;
			}
			const pairs = pickPairs(cookies);
			if (pairs.get("sessionid") !== void 0) {
				const missing = REQUIRED.filter((name) => name !== "sid_guard" && !pairs.get(name));
				if (missing.length > 0) {
					say(`登录已开始，等待 cookie 补齐（缺 ${missing.join(", ")}）…`);
					await sleep(1500);
					continue;
				}
				const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
				say(`已取到登录态（${String(pairs.size)} 条 cookie）`);
				return {
					ok: true,
					pairs,
					header
				};
			}
			if (Date.now() - lastNote > 1e4) {
				lastNote = Date.now();
				say(`… 等待扫码（已看到 ${String(cookies.length)} 条浏览器 cookie）`);
			}
			await sleep(2e3);
		}
		return {
			ok: false,
			reason: "等待登录超时。扫码完成后请重试。"
		};
	} finally {
		terminate(child);
	}
}
//#endregion
//#region src/doubao-status.ts
/** Route path, relative to the plugin mount point. */
const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
/** Route serving the model checklist's catalog. */
const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
/** Route serving live runtime session & token usage statistics. */
const DOUBAO_STATS_PATH = "/plugins/dsh-connect-doubao/stats";
/** Hostnames an inbound browser request may come from. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/**
* A browser-sent Origin must be loopback. A page on an attacker origin that
* can reach the Harness server must not be able to read the user's quota.
*/
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Host header must be loopback: a rebound name still sends its own Host. */
function loopbackHostHeader(req) {
	const host = req.headers.host;
	if (host === void 0 || host.trim() === "") return false;
	try {
		const { hostname } = new URL(`http://${host}`);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/**
* One gate for all four routes.
*
* Order matters: cheap header checks first, so a rejected request never reaches
* the filesystem or the credential store.
*/
function guard(req, res, options = {}) {
	if (!loopbackHostHeader(req)) {
		json(res, 403, { error: "host-not-loopback" });
		return false;
	}
	if (req.headers["sec-fetch-site"] === "cross-site") {
		json(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (!loopbackOrigin(req)) {
		json(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (options.write === true && req.headers["x-dsh-doubao-write"] === void 0) {
		json(res, 403, { error: "missing-write-header" });
		return false;
	}
	return true;
}
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}
/**
* Strip anything that could carry a secret or personal data out of an error.
* Upstream messages are quoted into the payload, so they are truncated and
* only the class is preserved.
*/
function safeMessage(error) {
	return (error?.message ?? "unknown error").slice(0, 200);
}
/**
* Build the quota view.
*
* An allow-list on purpose: every field here is a number or a plan name chosen
* by this function, never a passthrough of the upstream payload.
*/
/** Map one window into the card's shape; `undefined` means "not reported". */
function viewOf(window) {
	if (window === void 0) return null;
	const unknown = window.resetUnknown === true;
	return {
		usedPercent: window.usedPercent,
		remainingPercent: window.remainingPercent,
		resetsAt: unknown ? null : window.resetsAt,
		resetsInMs: unknown ? null : millisUntilReset(window),
		label: window.label ?? null,
		startsOnUse: window.startsOnUse === true,
		usedAmount: window.usedAmount ?? null,
		totalAmount: window.totalAmount ?? null
	};
}
async function doubaoQuotaView(options = {}) {
	const quota = await fetchQuota(options.force === true ? { force: true } : {});
	const fiveHour = findWindow(quota, "five_hour");
	const weekly = findWindow(quota, "weekly");
	return {
		ok: quota.error === void 0,
		profile: describeProfileLocation(),
		plan: quota.plan ?? null,
		exhausted: quota.exhausted,
		windows: {
			fiveHour: viewOf(fiveHour),
			weekly: viewOf(weekly),
			incentive: quota.windows.filter((window) => window.type === "incentive").map((window) => viewOf(window)).filter((window) => window !== null)
		},
		fetchedAt: quota.fetchedAt,
		error: quota.error ?? null
	};
}
/** Route the card writes settings through. */
const DOUBAO_SAVE_PATH = "/plugins/dsh-connect-doubao/__save";
/**
* The ONLY fields this route will write.
*
* A closed allow-list, not a schema derivation: deriving it would let a future
* schema addition quietly widen what the browser can write. Both entries are
* switches the user could already set by hand in `cordis.patch.yml`.
*
* `profileDir` used to be here for the card's folder picker. That picker is gone
* with the client-cookie path, and a field with no writer only invites a
* half-applied change: it would land on disk but reach nothing until a restart.
*/
const WRITABLE_FIELDS = /* @__PURE__ */ new Set(["enabledModelIds", "toolEmulation"]);
/** Read and parse a JSON request body, bounded. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 65536) throw new Error("body too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return void 0;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/**
* Register the settings READ/WRITE route.
*
* Why this exists at all: neither `settingsScope.set()` in the card nor
* `settings.mutate` in the host can persist this plugin — its fiber never
* reaches ACTIVE (see {@link SettingsLike}), so the host reports
* `No configurable plugin entry "dsh-connect-doubao"` and drops the write.
* This route writes a JSON file the plugin owns instead, which is also the
* only copy the card can read back.
*
* Security posture matches the read routes: loopback Origin only, GET or POST
* only, a closed allow-list of two switches, no credential in the response.
*/
function registerDoubaoSaveRoute(ctx, deps) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_SAVE_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST" && req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: req.method === "POST" })) return;
			if (req.method === "GET") {
				try {
					json(res, 200, {
						ok: true,
						value: deps.read()
					});
				} catch (error) {
					json(res, 500, {
						ok: false,
						error: safeMessage(error)
					});
				}
				return;
			}
			try {
				const body = await readJsonBody(req);
				const field = body?.field;
				if (typeof field !== "string" || !WRITABLE_FIELDS.has(field)) {
					json(res, 400, { error: `field must be one of: ${[...WRITABLE_FIELDS].join(", ")}` });
					return;
				}
				const value = body?.value;
				if (!(field === "enabledModelIds" ? Array.isArray(value) && value.every((entry) => typeof entry === "string") : typeof value === "boolean")) {
					json(res, 400, { error: `invalid value for ${field}` });
					return;
				}
				deps.write(field, value);
				deps.onApplied?.(field, value);
				json(res, 200, {
					ok: true,
					value: deps.read(),
					...deps.diagnostics === void 0 ? {} : { diagnostics: deps.diagnostics() }
				});
			} catch (error) {
				json(res, 500, {
					ok: false,
					errorName: error?.name ?? "unknown",
					error: safeMessage(error)
				});
			}
		}
	});
}
/** Register the quota route. Returns a disposer. */
function registerDoubaoQuotaRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_QUOTA_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: req.method === "POST" })) return;
			const force = req.method === "POST";
			if (force) {
				invalidateQuotaCache();
				deps.onRefresh?.();
			}
			try {
				json(res, 200, await doubaoQuotaView(force ? { force: true } : {}));
			} catch (error) {
				json(res, 500, { error: safeMessage(error) });
			}
		}
	});
}
/**
* Register the read-only catalog route backing the card's model checklist.
*
* Same security posture as the quota route: an allow-list (the static catalog),
* the same loopback-origin fence, no credential of any kind.
*
* `refresh=true` re-reads nothing on purpose — the Doubao catalog is STATIC and
* cannot be asked upstream which models exist (see `doubao-catalog.ts`). The
* card's Refresh button therefore re-reads this route, which is the honest
* behaviour: it refreshes the VIEW, and the card's note tells the user that
* selection controls picker entries rather than routing.
*/
function registerDoubaoCatalogRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_CATALOG_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: req.method === "POST" })) return;
			if (req.method === "POST") {
				invalidateDiscovery();
				await deps.refreshModels?.();
				deps.onRefreshed?.();
			}
			const models = deps.modelsProvider === void 0 ? void 0 : deps.modelsProvider();
			json(res, 200, {
				ok: true,
				models: doubaoCatalogEntries(models),
				error: null
			});
		}
	});
}
/** Route the card reads the session state through, and starts a sign-in on. */
const DOUBAO_AUTH_PATH = "/plugins/dsh-connect-doubao/auth";
/**
* Read the expiry out of `sid_guard`.
*
* Format: `sessionid|issued_epoch|ttl_seconds|"Mon, 07 Dec 2026 ..."`. The
* 30-day TTL is absolute, not sliding — verified 2026-11-07: hitting the
* account endpoint leaves this cookie byte-identical, so this instant is the
* real deadline and the card can count on it.
*/
function authExpiryOf(pairs) {
	const raw = pairs.get("sid_guard");
	if (raw === void 0) return null;
	const parts = raw.replace(/%7C/gi, "|").replace(/%2C/gi, ",").replace(/%3A/gi, ":").split("|");
	if (parts.length < 3) return null;
	const issued = Number(parts[1]);
	const ttl = Number(parts[2]);
	if (!Number.isFinite(issued) || !Number.isFinite(ttl) || issued <= 0) return null;
	return (issued + ttl) * 1e3;
}
/** Build the session view for the card. */
function authView() {
	const credentials = loadDoubaoCredentials();
	const expiresAt = credentials.ok ? authExpiryOf(credentials.pairs) : null;
	return {
		ok: true,
		signedIn: credentials.ok,
		expiresAt,
		daysLeft: expiresAt === null ? null : Math.max(0, Math.round((expiresAt - Date.now()) / 864e5)),
		detail: credentials.ok ? null : credentials.reason ?? null
	};
}
/**
* Register the session route.
*
* GET reads the state. POST accepts exactly `{"action":"login"}` and runs the
* browser sign-in — nothing else, because a body that merely fails to parse
* must not be read as "log in": a typo would open a sign-in window.
*
* POST is a WRITE (it replaces the sealed session), so it requires the same
* `x-dsh-doubao-write` header as every other write on this plugin — a hostile
* tab must not be able to make the user's browser open a sign-in window.
*
* The login is long-running on purpose: a Chromium window stays open until the
* user finishes the scan. The request is held open rather than polled so a
* failure has exactly one place to be reported.
*/
function registerDoubaoAuthRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_AUTH_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: req.method === "POST" })) return;
			if (req.method === "GET") {
				try {
					json(res, 200, authView());
				} catch (error) {
					json(res, 200, {
						ok: false,
						signedIn: false,
						expiresAt: null,
						daysLeft: null,
						detail: safeMessage(error)
					});
				}
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				json(res, 400, { error: safeMessage(error) });
				return;
			}
			if ((body ?? {}).action !== "login") {
				json(res, 400, { error: "action must be \"login\"" });
				return;
			}
			let result;
			try {
				result = await browserLogin();
			} catch (error) {
				json(res, 200, {
					...authView(),
					signedIn: false,
					detail: safeMessage(error)
				});
				return;
			}
			if (result.ok !== true || result.pairs === void 0) {
				json(res, 200, {
					...authView(),
					signedIn: false,
					detail: result.reason ?? "浏览器登录未完成"
				});
				return;
			}
			try {
				saveBrowserCredentials(result.pairs);
				invalidateCredentialCache();
				invalidateQuotaCache();
				invalidateDiscovery();
				deps.onSignedIn?.();
				json(res, 200, authView());
			} catch (error) {
				json(res, 200, {
					...authView(),
					signedIn: false,
					detail: `登录成功但凭据保存失败：${safeMessage(error)}`
				});
			}
		}
	});
}
/**
* Register the runtime session & token usage statistics route.
*
* GET returns aggregate counts, per-model breakdown, opaque session summaries,
* and last-turn telemetry (including upstream `context_window_usage` when
* reported). POST `{"action":"reset"}` clears accumulated counters.
*/
function registerDoubaoStatsRoute(ctx, deps) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_STATS_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: req.method === "POST" })) return;
			if (req.method === "GET") {
				try {
					json(res, 200, deps.read());
				} catch (error) {
					json(res, 500, {
						ok: false,
						error: safeMessage(error)
					});
				}
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				json(res, 400, { error: safeMessage(error) });
				return;
			}
			if ((body ?? {}).action !== "reset") {
				json(res, 400, { error: "action must be \"reset\"" });
				return;
			}
			try {
				deps.reset?.();
				json(res, 200, deps.read());
			} catch (error) {
				json(res, 500, {
					ok: false,
					error: safeMessage(error)
				});
			}
		}
	});
}
//#endregion
export { invalidateDiscovery as C, createDoubaoAdapter as D, DOUBAO_STREAM_IDLE_TIMEOUT_MS$1 as E, discoverModels as S, refreshDiscovery as T, estimateTextTokens as _, DOUBAO_STATS_PATH as a, DISCOVERY_TTL_MS as b, registerDoubaoCatalogRoute as c, registerDoubaoStatsRoute as d, createDoubaoShim as f, estimateMessageTokens as g, estimateContentTokens as h, DOUBAO_SAVE_PATH as i, registerDoubaoQuotaRoute as l, DoubaoStatsTracker as m, DOUBAO_CATALOG_PATH as n, doubaoQuotaView as o, DOUBAO_STATS_MAX_SESSIONS as p, DOUBAO_QUOTA_PATH as r, registerDoubaoAuthRoute as s, DOUBAO_AUTH_PATH as t, registerDoubaoSaveRoute as u, estimateToolsTokens as v, liveModels as w, discoverAllCachedModels as x, resolveChatUsage as y };
