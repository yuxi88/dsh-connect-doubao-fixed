//#region src/doubao-auth.d.ts
interface DoubaoCredentials {
  /** Cookie pairs ready for a `Cookie:` header. */
  header: string;
  /** Individual pairs, for selective use (e.g. msToken in a query string). */
  pairs: Map<string, string>;
  /** True when a usable session was loaded. */
  ok: boolean;
  /** Human-readable reason when `ok` is false. Never contains a secret. */
  reason?: string;
}
/**
 * How long a loaded session stays in the process cache.
 *
 * Not a security boundary: unsealing costs a child process on Windows (DPAPI), and
 * every upstream call wants the header, so the cache is what keeps a chat turn
 * from spawning one process per request. Doubao rotates its own cookies
 * server-side; the first rejected request is the accurate expiry signal.
 */
declare const CREDENTIAL_TTL_MS: number;
/**
 * Cookie names Doubao's chat backend actually needs for authentication.
 * Verified in M1/M2: this exact set authenticated while the app was closed.
 */
declare const REQUIRED_COOKIE_NAMES: readonly ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "ttwid", "odin_tt", "passport_csrf_token", "s_v_web_id"];
/** Seal browser-harvested cookies to disk. Throws if sealing fails. */
declare function saveBrowserCredentials(pairs: Map<string, string>): void;
/** Read the sealed browser session, or `undefined` when absent/unusable. */
declare function loadBrowserCredentials(): DoubaoCredentials | undefined;
/** True when a sealed browser session exists on disk. */
declare function hasBrowserCredentials(): boolean;
/** Drop the sealed session (a re-login always overwrites it). */
declare function clearBrowserCredentials(): void;
/**
 * The session this plugin runs on: the sealed browser sign-in, or a failure that
 * tells the user what to do about it.
 *
 * Cached in process memory for `CREDENTIAL_TTL_MS` because the read costs a
 * PowerShell child process. A failure is reported as `{ ok: false, reason }`
 * rather than thrown so the provider can surface an actionable message instead
 * of a stack trace; the login route drops this cache, so a fresh scan is visible
 * immediately.
 */
declare function loadDoubaoCredentials(options?: {
  force?: boolean;
}): DoubaoCredentials;
/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
declare function invalidateCredentialCache(): void;
/**
 * Revoke the sealed session on disk as well.
 *
 * Called when the server refuses the session. Replacing it needs a fresh QR
 * scan, so keeping the file would only make every later request fail the same
 * way while the card still showed a signed-in account — the user's fix
 * (「重新登录」) would then look like it had no effect. Deleting it makes the
 * next request say "log in", which is the truth.
 */
declare function clearCredentialCache(): void;
//#endregion
//#region src/doubao-catalog.d.ts
/**
 * Doubao model catalog.
 *
 * Doubao DOES let the caller pick a model. The choice travels in the request
 * body at TWO mirrored locations, and upstream ignores the request if only one
 * is written:
 *
 *   option.model_config.model_item_key       ← numeric or slug
 *   option.aggregate_params.model_item_key   ← same value, same body
 *
 * Every id below was read off a real request the desktop app sent, not inferred.
 * They are NOT interchangeable with numbers that appear elsewhere in the body:
 * `aggregate_params.mode_id` is also often "3", but it means the 对话/工作 mode
 * switch, NOT the Turbo model. The two are named apart throughout this codebase
 * precisely because the collision is easy to fall into.
 *
 * ⚠️ ENCODING IS MIXED. `seed-lite-7b` is a string slug; `3`, `5` and `9` are
 * numeric enum values. They travel as JSON strings either way and MUST be
 * forwarded verbatim — never parsed to a number, or the slug is lost.
 *
 * 推理强度 (reasoning effort) is a separate axis. It travels as
 * `reasoning_effort` (mirrored like the model) and, redundantly, as
 * `need_deep_think = 10000 + level` plus `ext.use_deep_think`. See
 * {@link DOUBAO_REASONING_LEVELS} for which levels are verified.
 *
 * @module dsh-connect-doubao/catalog
 */
/** Provider route id this bundle owns. */
declare const DOUBAO_PROVIDER = "doubao";
/** Shown in the DSH model picker. */
declare const DOUBAO_PROVIDER_DISPLAY_NAME = "豆包（Doubao）";
/** How much context a Doubao conversation holds. */
declare const DOUBAO_CONTEXT_WINDOW = 256000;
/** Generous output ceiling; the subscription quota, not this, is the real bound. */
declare const DOUBAO_MAX_TOKENS = 32000;
/**
 * `option.agent_mode` / `ext.agent_mode`.
 *
 * VERIFIED AGAINST A CDP-CAPTURED REQUEST (2026-10-22, 对话 mode):
 *
 *   agent_mode 2  →  普通对话
 *   agent_mode 1  →  「工作任务」 (every turn is handed to `Agent-GeneralTask`)
 *
 * The previous revision of this constant said 1 for chat and carried a comment
 * claiming work mode sends 2 — BOTH were backwards, and sending 1 is exactly
 * what made every request from this plugin look like a work task.
 *
 * Task mode used to end in `710010702` because the executing runtime was the
 * desktop app's CUA process. Since 0.4.1 the plugin answers the server's
 * `tool_local` commands over HTTP instead, so task turns complete.
 */
declare const CHAT_AGENT_MODE = 2;
/** 「工作任务」 mode. Requires the `tool_local` responder — see `doubao-upstream.ts`. */
declare const TASK_AGENT_MODE = 1;
/**
 * Which machine runs a 「工作任务」.
 *
 * Read off the desktop client's own enum (`ai-views` bundle, module 941658):
 *
 *   RuntimeType_Cloud_VM  = 1   → 「工作任务 · 云电脑」: ByteDance's VM executes
 *   RuntimeType_Local_PC  = 2   → 「工作任务 · 本地电脑」: THIS machine executes
 *
 * The plugin uses 2 on purpose: the cloud VM's artefacts are unreachable from an
 * external client, whereas the local runtime is this very machine — the same one
 * the Harness already executes tools on.
 */
declare const TASK_RUNTIME_CLOUD_VM = 1;
declare const TASK_RUNTIME_LOCAL_PC = 2;
/**
 * Sandbox authorisation level.
 *
 * `2` is what the client sends with its 「全部允许」 authorisation setting (read
 * off the same captured task request). The cloud uses it to decide how freely it
 * may plan file and command actions inside the declared workspace.
 */
declare const TASK_SANDBOX_AUTH_ALLOW_ALL = 2;
/**
 * A reasoning-effort level.
 *
 * `level` is Doubao's own ordinal and maps onto the wire as
 * `reasoning_effort` and `need_deep_think = 10000 + level`.
 *
 * `level` IS Doubao's `reasoning_effort` — the two are the same number, not two
 * parallel scales. It also feeds `need_deep_think = 10000 + level` and
 * `ext.use_deep_think`. So 高 is `reasoning_effort: 5` AND
 * `need_deep_think: 10005`; there is no separate "tier" numbering anywhere.
 *
 * All three values were read off the running desktop app by diffing the config
 * it re-serialises when the level is switched (M8 续二). They are not inferred
 * and not extrapolated from a pattern.
 */
interface DoubaoReasoningLevel {
  /**
   * DSH-facing label. The five this catalog names are `low|mid|high|xhigh|max`,
   * but the client menu is not limited to them (自动 publishes 中 at ordinal 8), so
   * an unnamed ordinal carries its own decimal spelling instead of being dropped.
   */
  id: 'low' | 'mid' | 'high' | 'xhigh' | 'max' | (string & {});
  name: string;
  /** The value sent as `reasoning_effort`; also `need_deep_think - 10000`. */
  level: number;
  /** True when `level` was observed on the running client. */
  verified: boolean;
}
declare const DOUBAO_REASONING_LEVELS: readonly DoubaoReasoningLevel[];
/** The level used when a request names none. Verified on the wire. */
declare const DEFAULT_REASONING_LEVEL_ID = "high";
/** Reasoning level for an id, falling back to the default. */
declare function findReasoningLevel(id: string | undefined): DoubaoReasoningLevel;
/** The catalog entry for a wire ordinal, or undefined for one it does not know. */
declare function reasoningLevelOf(ordinal: number | undefined): DoubaoReasoningLevel | undefined;
/**
 * The wire spelling of an ordinal.
 *
 * `model_extra_params.reasoning_effort` for 2.1 Lite is a STRING in the captured
 * request, and that string is the level's name-id, not its number. An ordinal
 * with no catalog entry falls back to its own decimal form, so a level Doubao
 * adds later still travels instead of snapping back to 高.
 */
declare function levelIdOf(ordinal: number): string;
/**
 * `need_deep_think` / `ext.use_deep_think` — the 深度思考 switch.
 *
 * CDP-captured 2026-10-23, the same conversation sent with the switch OFF and ON:
 *
 *   off →  option.need_deep_think: 0   ext.use_deep_think: "0"
 *   on  →  option.need_deep_think: 3   ext.use_deep_think: "3"
 *
 * `3` is what the switch sends — NOT `10000 + reasoning_effort`. That shape
 * (10005 at 高) was this plugin's own invention, and sending it produced no
 * thinking at all: every frame still carried `block_type: 10000` and the reply
 * agent was `pc_general_nocot_agent` (no-CoT).
 *
 * The two axes are independent: effort still travels as `reasoning_effort`
 * 3/4/5, while this flag only says whether the model may think before answering.
 */
declare const DEEP_THINK_OFF = 0;
declare const DEEP_THINK_ON = 3;
/** `need_deep_think` value for the switch state. */
declare function needDeepThinkValue(deepThink: boolean): number;
/**
 * Doubao's skill table, transcribed verbatim from the client bundle
 * (`{FreeChat:0, SkillWrite:2, SkillImageGen:3, …}`), not inferred.
 *
 * `skill_id` is the decimal string of `skill_type`; the two are ALWAYS the same
 * number, which is why a plain turn carries `{"skill_id":"0","skill_type":0}`.
 * On the wire it is a JSON STRING inside `ext.input_skill`.
 *
 * There is no separate HTTP endpoint for text-to-image in the client — the only
 * generation URL is `/creativity/canvas/exec`, which is the image EDITOR
 * (cutout / outpaint / layer split). So a skill turn must go through
 * `/chat/completion`, and it does: verified 2026-11-02, `skill_type: 3` returns
 * real `rc_gen_image/*.jpeg` artefacts from Seedream 5.0.
 */
declare const DOUBAO_SKILLS: {
  readonly freeChat: 0;
  readonly write: 2;
  readonly imageGen: 3;
  readonly search: 4;
  readonly translate: 5;
  readonly read: 6;
  readonly webpage: 7;
  readonly deepSearch: 8;
  readonly musicGen: 9;
  readonly edu: 11;
  readonly codeInterpreter: 13;
  readonly codeAssistant: 16;
  readonly videoGeneration: 17;
  readonly aiPPT: 18;
};
type DoubaoSkillName = keyof typeof DOUBAO_SKILLS;
/** The `ext.input_skill` JSON string for a skill; undefined means plain chat. */
declare function inputSkillOf(skill: DoubaoSkillName | undefined): string | undefined;
/**
 * `block_type` of a creation (image-generation) block.
 *
 * Shape, from a captured stream:
 *   content.creation_block.creations[] = {
 *     type: 1,                       // 1 = image
 *     id: "<task id>",
 *     image: { key, status, image_ori{url,width,height}, image_preview{…}, image_thumb{…} }
 *   }
 */
declare const CREATION_BLOCK_TYPE = 2074;
/**
 * DSH-side alias for "generate an image".
 *
 * NOT a Doubao `model_item_key` — Doubao has no model by this name. Selecting it
 * makes the shim send an ordinary chat turn with `input_skill: imageGen`, and
 * Doubao answers with Seedream. Keeping it in the catalog is what puts 生图 in
 * DSH's model picker without inventing a second UI.
 */
declare const DOUBAO_IMAGE_MODEL_ID = "image-gen";
declare const DOUBAO_IMAGE_MODEL_NAME: string;
/** The chat model a skill turn rides on: the app's own default. */
declare const SKILL_CARRIER_MODEL_ID = "0";
interface DoubaoModelInfo {
  /**
   * Catalog id, and the exact `model_item_key` to put on the wire. These are the
   * same string on purpose: DSH keys every join on the model id, so keeping them
   * identical removes a translation layer that could only be wrong.
   */
  id: string;
  /** UI name, verbatim from the desktop app's picker. */
  name: string;
  /**
   * Status badge shown next to the name, exactly as the app renders it.
   * `undefined` when the app shows no badge.
   *
   * Note 「即将下线」 is NOT a property of the Turbo model: the app publishes
   * TWO Turbo entries and only the retiring one carries it.
   */
  badge?: string;
  /**
   * Whether this route can actually think.
   *
   * NOT the same as "the app shows a reasoning-effort picker for it": the picker
   * is drawn from the app's own model menu, while this flag is what DSH uses to
   * decide whether to offer 低/中/高 at all. Measured 2026-11-07 — see
   * {@link NO_THINKING_MODEL_IDS}.
   */
  reasoning: boolean;
  /** True when the model runs in 「工作任务」 (`mode_id: "3"`, `agent_mode: 1`) mode. */
  taskMode?: boolean;
  /**
   * Billing-multiplier tag exactly as the client menu renders it ("0.65x"), or
   * a campaign label ("限时优惠 0.01x").
   *
   * DISPLAY ONLY. The plugin bills nothing and cannot verify what the server will
   * charge, so this is the client's own claim, shown unchanged and attributed.
   */
  rate?: DoubaoModelRate;
  /**
   * The thinking levels THIS model offers, in the client menu's own order.
   *
   * Absent on entries read from the IndexedDB cache (that source carries no
   * config) and on the static catalog, where the catalog-wide list applies. It
   * matters because the menu is per-model: GLM publishes 低/高/最高 while 2.1 Lite
   * publishes 低/中/高, so one shared list is wrong for at least one of them.
   */
  reasoningOptions?: readonly DoubaoReasoningOption[];
}
/** A menu tag that states a price multiplier or a campaign. */
interface DoubaoModelRate {
  /** The tag text verbatim, e.g. "0.65x" or "限时优惠 0.01x". */
  text: string;
  /** `ratio` is a plain multiplier; `promo` is a campaign label. */
  kind: 'ratio' | 'promo';
}
/** One selectable thinking level, as the client declares it for ONE model. */
interface DoubaoReasoningOption {
  /** Doubao's ordinal, sent as `reasoning_effort`. */
  level: number;
  /** The client's own label for it (低 / 中 / 高 / 极高 / 最高). */
  name: string;
}
/**
 * The entries DSH may offer.
 *
 * WHY THESE ENTRIES. Doubao groups models by MODE, and the model list is per-mode:
 *
 *   对话       → 豆包 快速 (0), 豆包 2.1 Turbo·专家 (3)
 *   工作任务   → 自动 (9), 2.1 Lite (seed-lite-7b), 2.1 Pro (5), Turbo (3)
 *
 * The 「工作任务」 group (`seed-lite-7b`, `5`, `9`) runs through `Agent-GeneralTask`
 * (`mode_id: "3"`, `agent_mode: 1`) and is accompanied by an HTTP `tool_local`
 * workspace responder (`msg/ack` -> `upload_command_result` -> `msg/complete`)
 * so external turns complete without `710010702`.
 *
 * MEASURED, 2026-10-22: `model_item_key` is forwarded verbatim (the server stores
 * it on the message), but in 对话 mode it does NOT change what answers —
 * 0 / 3 / 5 / seed-lite-7b AND a deliberately bogus key all returned answers of
 * indistinguishable length and latency (12.3–14.0 s). So this list is honest
 * about what the PICKER can offer; it does not claim per-key routing.
 *
 * 「豆包 快速」 leads because it is the app's own chat-mode default, so an
 * unconfigured install reproduces the app rather than something that merely
 * happens to work.
 */
declare const DOUBAO_MODELS: readonly DoubaoModelInfo[];
/** True when `id` is a 「工作任务」-mode model (`seed-lite-7b`, `5`, `9`). */
declare function isTaskModel(id: string | undefined): boolean;
/**
 * Entries that exist in the desktop app but are deliberately NOT offered here.
 *
 * Kept as data rather than a comment so the README and any future UI can state
 * the reason from one place — and so re-adding one is a deliberate act that has
 * to confront this note.
 */
declare const DOUBAO_UNAVAILABLE_MODELS: readonly {
  id: string;
  name: string;
  reason: string;
}[];
/**
 * The model used when a request names none.
 *
 * 「豆包 快速」 is the app's own chat-mode default — `menuConfV2`'s
 * `default_select_mode_map.chat` points at it — so leaving it unnamed here
 * reproduces what the desktop app would have done. Spelled out rather than
 * taken from `DOUBAO_MODELS[0]`, so reordering the list cannot silently change
 * which model an unconfigured session gets.
 */
declare const DOUBAO_DEFAULT_MODEL_ID = "0";
/**
 * Catalog entry for a model id, falling back to {@link DOUBAO_DEFAULT_MODEL_ID}.
 *
 * An id the catalog does not know resolves to the default rather than throwing:
 * a stale id in a saved session should degrade to a working model, not break
 * the request. `describeRequestedModel` in the shim is what surfaces the miss.
 */
declare function findDoubaoModel(id: string | undefined): DoubaoModelInfo;
/** True when the key is a catalog entry this release knows by name. */
declare function isKnownModelId(id: string | undefined): boolean;
/** Entries as pi-ai-shaped descriptors, for model discovery. */
interface DiscoveredDoubaoModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities: ('text' | 'image')[];
  reasoning: boolean;
}
/**
 * Model ids measured to never think, whatever the 深度思考 switch says.
 *
 * 「豆包 快速」 is served by a no-CoT agent: with the switch ON and effort 高 the
 * reply still came back `thinking: false` and the frames carried no 10040
 * container, while the identical request on 2.1 Pro flipped to `thinking: true`.
 * Discovered catalogs come from the client's own menu dump, which marks every
 * entry as reasoning-capable, so this set has to be applied AFTER discovery —
 * otherwise the picker would keep advertising a control that does nothing.
 */
declare const NO_THINKING_MODEL_IDS: ReadonlySet<string>;
/** Whether a model can think, by measurement rather than by menu declaration. */
declare function supportsReasoning(id: string): boolean;
/**
 * Publish the catalog as pi-ai model descriptors.
 *
 * `models` defaults to the static list but is normally the DISCOVERED one — the
 * caller passes whatever the client cache currently reports, so a model Doubao
 * ships appears without a plugin release.
 */
declare function discoverDoubaoModels(models?: readonly DoubaoModelInfo[]): DiscoveredDoubaoModel[];
/**
 * Narrow the catalog to the ids the user has ticked.
 *
 * Selecting an entry now genuinely selects a model, so this is a real
 * restriction — but it still only decides WHICH ENTRIES APPEAR IN DSH's MODEL
 * PICKER; the per-request choice is made by the DSH session, not here.
 *
 * `undefined` (never configured) serves the whole catalog: a first-run install
 * must show its models. Ids that no longer exist are dropped.
 *
 * A model DISCOVERED after the user last saved is kept even when it is not in
 * their tick list — otherwise a new Doubao release would be invisible until the
 * user thought to reopen the card and re-save, which is exactly the staleness
 * this path exists to remove.
 */
declare function enabledModelsOf(enabledIds: string[] | undefined, models?: readonly DoubaoModelInfo[]): DoubaoModelInfo[];
/** One catalog entry as the card's checklist consumes it. */
interface DoubaoCatalogEntry {
  /** The real `model_item_key`. */
  id: string;
  name: string;
  /** Status badge, or null when the app shows none. */
  badge: string | null;
  /** Billing-multiplier / campaign tag from the client, or null. Display only. */
  rate: DoubaoModelRate | null;
  /** Reasoning-effort levels this model offers. */
  reasoningLevels: Array<{
    id: string;
    name: string;
    level: number;
    verified: boolean;
  }>;
}
declare function doubaoCatalogEntries(models?: readonly DoubaoModelInfo[]): DoubaoCatalogEntry[];
//#endregion
//#region src/doubao-upstream.d.ts
declare const CHAT_ENDPOINT = "https://www.doubao.com/chat/completion";
declare const QUOTA_ENDPOINT = "https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/";
declare const ACCOUNT_ENDPOINT = "https://www.doubao.com/passport/account/info/v2/";
declare const TOOL_LOCAL_ACK_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/ack";
declare const TOOL_LOCAL_UPLOAD_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/upload_command_result";
declare const TOOL_LOCAL_COMPLETE_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/complete";
declare const ACTION_BAR_BRIEF_LIST_ENDPOINT = "https://www.doubao.com/alice/slot/action_bar_v3/brief_list";
declare const BREAK_STREAM_ENDPOINT = "https://www.doubao.com/im/message/break_stream_msg";
/**
 * Client version strings. These are the desktop app build this was last
 * verified against (M9), and they MOVE with every Doubao release — a newer app
 * sends different values here and a very old one will eventually stop being
 * accepted. Re-check them whenever Doubao auto-updates; the risk-control layer
 * compares them against the session it sees.
 */
declare const DOUBAO_VERSION = "2.31.4";
declare const RUNTIME_VERSION = "3.39.0";
/**
 * Frozen, non-secret client identity.
 *
 * These are constant across Doubao sessions and are NOT credentials. Keeping
 * them fixed is what makes an external request look like the same install to
 * the risk-control layer.
 */
declare const CLIENT_PARAMS: {
  readonly aid: "582478";
  readonly real_aid: "582478";
  readonly version_code: "20800";
  readonly pc_version: "2.31.4";
  readonly device_id: "2697515174213273";
  readonly tea_uuid: "2697515174213273";
  readonly web_id: "7677868049198630415";
  readonly fp: "verify_2697515174213273";
  readonly chromium_version: "147.0.7727.149";
  readonly runtime_version: "3.39.0";
  readonly channel: "win";
  readonly language: "zh";
  readonly region: "CN";
  readonly sys_region: "CN";
  readonly tz_name: "Asia/Shanghai";
  readonly pkg_type: "release_version";
  readonly client_platform: "pc_client";
  readonly device_platform: "web";
  readonly doubao_device_platform: "desktop";
  readonly web_platform: "desktop";
  readonly samantha_web: "1";
  readonly 'use-olympus-account': "1";
};
/** The default Doubao assistant; content routing means the model is chosen server-side. */
declare const DEFAULT_BOT_ID = "7338286299411103781";
/** Headers that make an external request indistinguishable from the app's. */
declare function buildHeaders(credentials: DoubaoCredentials, extra?: Record<string, string>): Record<string, string>;
declare function buildQueryUrl(endpoint: string, msToken?: string): string;
interface DoubaoMessage {
  role: 'user' | 'assistant';
  content: string;
}
interface DoubaoUsage {
  /** Input + output token accounting when the server reports it. */
  promptTokens?: number;
  completionTokens?: number;
}
/** Server-reported context window breakdown from Doubao's `context_window_usage`. */
interface DoubaoContextWindowUsage {
  systemPrompt: number;
  messages: number;
  skills: number;
  tools: number;
  totalWindowSize: number;
  /** Sum of systemPrompt + messages + skills + tools reported by upstream. */
  totalUsed: number;
}
/** Optional timing and window telemetry emitted on upstream SSE frames. */
interface DoubaoUpstreamTelemetry {
  contextWindowUsage?: DoubaoContextWindowUsage;
  ackCostMs?: number;
  firstPacketCostMs?: number;
  finishTimeMs?: number;
  finishReasonChat?: string;
}
/** One generated image from a creation block (`block_type: 2074`). */
interface DoubaoImage {
  /** Server task id for this creation. */
  taskId?: string;
  /** Stable asset key, e.g. `tos-cn-i-…/rc_gen_image/<uuid>.jpeg`. */
  key?: string;
  /** Best available URL: original > preview > thumb. */
  url: string;
  width?: number;
  height?: number;
}
interface DoubaoChatResult {
  text: string;
  /** Model identifier reported by the server for this reply, if any. */
  model?: string;
  conversationId?: string;
  messageId?: string;
  reasoningText?: string;
  /** True when the server routed to a thinking-capable model. */
  thinking: boolean;
  /**
   * Images produced by a skill turn (`input_skill: imageGen`).
   *
   * Empty unless the request asked for a creation. The URLs are signed but
   * long-lived (`x-expires` in 2037 on the captured ones), so they can be
   * handed straight to the user or downloaded.
   */
  images: DoubaoImage[];
  /**
   * The agent the server says served this turn (`intention_agent_name`).
   *
   * Not a model identifier — it names the server-side AGENT, which is how a
   * 「工作任务」 turn becomes visible at all: chat turns and task turns use the
   * same endpoint and the same stream, and this field is the only read-back
   * evidence of which one was actually used.
   */
  intentionAgent?: string;
  /** Server-side telemetry parsed from `ext.context_window_usage` and timing tags. */
  telemetry?: DoubaoUpstreamTelemetry;
}
/**
 * Extra evidence about a failure, carried on the error itself.
 *
 * Classification needs more than the business code: an HTTP status, whether
 * the transport (fetch/reader) failed, and whether the answer was cut off all
 * map to different kinds and different retry decisions. Keeping that evidence
 * on the error means the classifier never has to re-derive it from a message
 * string, and a throw site can declare its own class when the shape is
 * unusual (`kind`).
 */
interface DoubaoUpstreamErrorMeta {
  /** HTTP status of the failing response, when there was one. */
  httpStatus?: number;
  /** The socket/fetch itself failed — the server never answered. */
  transport?: boolean;
  /** The stream ended before the reply did: the answer is partial. */
  truncated?: boolean;
  /** Classify as this kind regardless of code/status. */
  kind?: DoubaoErrorKind;
}
declare class DoubaoUpstreamError extends Error {
  readonly code?: number | undefined;
  readonly rateLimited: boolean;
  readonly httpStatus: number | undefined;
  readonly transport: boolean;
  readonly truncated: boolean;
  readonly kindHint: DoubaoErrorKind | undefined;
  constructor(message: string, code?: number | undefined, rateLimited?: boolean, meta?: DoubaoUpstreamErrorMeta);
}
/** Per-request knobs. Every field is optional and every default reproduces the
 *  desktop app's own behaviour, so an un-parameterised call is unchanged. */
interface ChatRequestOptions {
  /** Continue an existing conversation instead of opening a new one. */
  conversationId?: string;
  /**
   * The `model_item_key` to request — one of {@link DOUBAO_MODELS}.
   *
   * Defaults to 自动, matching what the app sends when the user has not chosen.
   * Forwarded VERBATIM: the values are a mix of string slugs and numeric enums,
   * so they must never be parsed to a number.
   */
  modelKey?: string;
  /**
   * Doubao SKILL to run the turn under — the capability axis.
   *
   * Orthogonal to `modelKey`: `imageGen` (3) makes Doubao answer with a
   * creation block (real generated images) while still riding the chat
   * endpoint. Verified live 2026-11-02: `input_skill: {skill_id:"3",
   * skill_type:3}` returns `rc_gen_image/*.jpeg` from Seedream 5.0.
   */
  skill?: DoubaoSkillName;
  /**
   * Reasoning effort: `low` | `mid` | `high`, mapping to `reasoning_effort`
   * 3 / 4 / 5.
   *
   * Defaults to 高 (5), the level the desktop app itself starts on. All three
   * values were read off the running client — see {@link DOUBAO_REASONING_LEVELS}.
   */
  reasoningLevel?: 'low' | 'mid' | 'high' | 'xhigh' | 'max';
  /**
   * `option.agent_mode` / `ext.agent_mode`.
   *
   * VERIFIED: the desktop app sends 1 for BOTH ordinary chat and a 「工作任务」
   * (a real 2026-09-15 task request carries 1). Kept explicit so these small
   * integers are never confused with the numeric model keys, which are also
   * small integers.
   */
  agentMode?: number;
  /**
   * Send the request as a 「工作任务 · 本地电脑」 instead of a plain chat.
   *
   * DEFAULTS TO TRUE. The whole point of this route is that the executing
   * machine is this one, which is where the Harness already runs its tools; the
   * cloud VM runtime (`runtime_type: 1`) puts execution somewhere we cannot
   * reach.
   *
   * What travels: `ext.general_task_param` as a JSON *string* — the client's own
   * shape, transcribed from a captured request. Its presence is what makes the
   * server treat the turn as a task (the client's `is_general_task` check is
   * `!!ext.general_task_param`); `agent_mode` stays 1.
   *
   * Set `DSH_DOUBAO_TASK=0` in the host environment to fall back to plain chat
   * without a rebuild — the escape hatch for a server-side rejection.
   */
  taskMode?: boolean;
  /**
   * Ask for the 深度思考 pass (probe knob; see `buildChatBody`).
   */
  deepThink?: boolean;
  /**
   * Continue the conversation named by {@link ChatRequestOptions.conversationId}
   * instead of opening a new one.
   *
   * The client sends `need_create_conversation: false` plus the id it got back;
   * omitting both starts a fresh thread. Set by the shim from its own
   * conversation store (see `doubao-session.ts`).
   */
  continueConversation?: boolean;
  /**
   * Directory the task declares as its workspace.
   *
   * The cloud plans against these paths, so they must be real on THIS machine.
   * Defaults to `DSH_DOUBAO_WORKSPACE`, then `process.cwd()`.
   */
  workspace?: string;
}
/** Whether a request asks for local-PC task mode. Default: OFF — see below. */
declare function taskModeEnabled(options: ChatRequestOptions): boolean;
/** The directory this machine declares to the task runtime. */
declare function taskWorkspaceOf(options: ChatRequestOptions): string;
/**
 * Build `ext.general_task_param` — the field that makes a turn a 工作任务.
 *
 * Transcribed field-for-field from a real 「工作任务 · 本地电脑」 request the
 * desktop client sent on 2026-09-15 (recovered from the app's own IndexedDB
 * message store), then reduced to what is portable:
 *
 *   thread_local_message_id  the local message id being submitted
 *   client_option            the workspace and the sandbox/authorisation policy
 *   runtime_type             2 — Local_PC; the cloud VM would be 1
 *   agent_task_param         the same facts again, device-side
 *   agent_task_param_change  all false: nothing is being switched mid-thread
 *
 * Paths are computed from THIS machine rather than copied, because the cloud
 * plans against them: a workspace that does not exist here would make the task
 * fail inside the runtime instead of at submit time. `local_device_id` and
 * `local_app_id` reuse the frozen client identity already in {@link CLIENT_PARAMS}
 * — the captured request carries the same two values, so they are the same
 * install identity and not per-request state.
 */
declare function buildGeneralTaskParam(localMessageId: string, workspace: string, prompt?: string): Record<string, unknown>;
/**
 * Build the request body Doubao's chat endpoint expects.
 *
 * The model and the reasoning effort are each written at TWO locations, because
 * that is what the app does and what upstream reads. Writing only one is
 * silently ignored — the request succeeds and the answer comes from whatever
 * the server last used.
 *
 * `general_task_param` is deliberately absent: it carries the desktop app's
 * local sandbox and workspace paths, none of which apply to an external client,
 * and the endpoint has been observed answering correctly without it.
 */
/**
 * Add the 「生成图片：」 prefix that Doubao's image skill requires.
 *
 * The desktop app gets this for free: its `chat_ability.ability_param` carries
 * `reply_message_format: "生成图片：%s"`, which rewrites the outgoing text before
 * the request leaves. An external client has no such hook, so the same rewrite
 * happens here. Without it the server treats the turn as ordinary chat and
 * answers with prose instead of drawing.
 *
 * Deliberately ONLY the prefix: appending extra instructions makes Doubao read
 * them as part of the subject and drop the picture entirely (measured).
 */
declare function withImagePrefix(prompt: string, options?: ChatRequestOptions): string;
declare function buildChatBody(prompt: string, options?: ChatRequestOptions): {
  messages: {
    local_message_id: `${string}-${string}-${string}-${string}-${string}`;
    message_status: number;
    content_block: {
      block_type: number;
      block_id: `${string}-${string}-${string}-${string}-${string}`;
      parent_id: string;
      meta_info: never[];
      append_fields: never[];
      content: {
        text_block: {
          text: string;
          icon_url: string;
          icon_url_dark: string;
          summary: string;
        };
        pc_event_block: string;
      };
    }[];
  }[];
  option: {
    conversation_init_ext: {
      model_item_key: string;
      reasoning_effort: string;
      mode_id: string;
    };
    regen_query_id: never[];
    edit_query_id: never[];
    regen_instruction: string;
    no_replace_for_regen: boolean;
    message_from: number;
    shared_app_name: string;
    shared_app_id: string;
    sse_recv_event_options: {
      support_chunk_delta: boolean;
    };
    support_lazy_fetch_stream: boolean;
    is_ai_playground: boolean;
    is_old_user: boolean;
    general_task_param: Record<string, unknown> | {
      server_do_compare: boolean;
    };
    recovery_option: {
      is_recovery: boolean;
      req_create_time_sec: number;
      append_sse_event_scene: number;
    };
    message_storage_type: number;
    related_deleted_message_ids: {};
    connector_info_list: never[];
    model_config: {
      model_item_key: string;
      model_extra_params: Record<string, string>;
      reasoning_effort: number;
    };
    aggregate_params: {
      mention_skill_list: string;
      mention_plugin_list: string;
      mention_ext: string;
      conversation_mode: string;
      mode_id: string;
      model_item_key: string;
      agent_mode: string;
      reasoning_effort: string;
      provider_id: string;
    };
    conversation_mode?: number;
    send_message_scene: string;
    create_time_ms: number;
    collect_id: string;
    is_audio: boolean;
    answer_with_suggest: boolean;
    agent_mode: number;
    tts_switch: boolean;
    need_deep_think: number;
    click_clear_context: boolean;
    from_suggest: boolean;
    is_regen: boolean;
    is_replace: boolean;
    is_from_click_option: boolean;
    is_from_click_softlink: boolean;
    disable_sse_cache: boolean;
    select_text_action: string;
    is_select_text: boolean;
    resend_for_regen: boolean;
    scene_type: number;
    unique_key: `${string}-${string}-${string}-${string}-${string}`;
    start_seq: number;
    need_create_conversation: boolean;
    conversation_init_option: {
      need_ack_conversation: boolean;
    };
  };
  client_meta: {
    local_conversation_id: string;
    conversation_id: string;
    bot_id: string;
    last_section_id: string;
    last_message_index: null;
    local_permissions: {
      permission_name: string;
      status: number;
    }[];
  };
  user_context: never[];
  ext: {
    input_skill?: never;
    agent_mode: string;
    use_deep_think: string;
    sub_conv_firstmet_type: string;
    general_task_param: string;
    collection_id: string;
    is_finish: string;
    conversation_init_option: string;
    commerce_credit_config_enable: string;
  } | {
    input_skill: string;
    agent_mode: string;
    use_deep_think: string;
    sub_conv_firstmet_type: string;
    general_task_param: string;
    collection_id: string;
    is_finish: string;
    conversation_init_option: string;
    commerce_credit_config_enable: string;
  };
};
interface StreamFrame {
  id?: string;
  event?: string;
  data: string;
}
/**
 * Parse ByteDance's three-line streaming frames out of a decoded text buffer.
 *
 * A frame is `id:` then `event:` then `data:` then a blank line. Standard SSE
 * also permits comment lines (`:`), so those are skipped. Returns the frames
 * plus whatever tail did not yet form a complete frame.
 */
declare function parseFrames(buffer: string): {
  frames: StreamFrame[];
  rest: string;
};
interface BlockCollectState {
  thinkingIds: Set<string>;
  /** Active target for id-less `CHUNK_DELTA` frames across SSE events. */
  activeTarget?: 'thinking' | 'answer';
  /** Last seen title per thinking block id. */
  lastTitles?: Map<string, string>;
  /** Normalized thinking titles already emitted in this stream. */
  seenTitles?: Set<string>;
  /** Last seen cumulative/snapshot `text_block.summary` per block id. */
  lastSummaries?: Map<string, string>;
  /** True once full CoT `text_block.text` has appeared for a thinking block. */
  hasFullThinkingText?: boolean;
  /** True when a `10040` thinking container or thinking content appeared. */
  sawThinkingBlock?: boolean;
  hasEmittedThinking?: boolean;
  trailingNewlines?: number;
}
declare function createBlockCollectState(): BlockCollectState;
declare function collectBlocks(node: unknown, into: {
  answer: string[];
  thinking: string[];
  images?: DoubaoImage[];
}, thinkingIdsOrState: Set<string> | BlockCollectState, depth?: number): void;
/** Read the model identifier the server actually used for a reply. */
declare function extractModel(payload: unknown): string | undefined;
interface StreamCallbacks {
  onText?: (delta: string) => void;
  /** Private reasoning deltas (deep-think turns); never part of the answer. */
  onThinking?: (delta: string) => void;
  onEvent?: (event: string) => void;
  /** Turn identity from `SSE_ACK`; feeds the server-side stop request. */
  onTurnIds?: (ids: {
    conversationId?: string | undefined;
    questionId?: string | undefined;
  }) => void;
}
/**
 * Stream one completion and return the assembled reply.
 *
 * Rejects with `DoubaoUpstreamError` when the server answers with a business
 * error frame — notably `710022004 rate limited`, which is risk control asking
 * for a slider CAPTCHA rather than an authentication failure.
 *
 * TASK MODE FALLBACK. Since 0.4.1 a task-mode turn is served by the
 * `tool_local` responder above, so it normally completes. This is now a
 * last-resort net: if the responder cannot satisfy the runtime (upstream change,
 * network failure), the server answers with `710010702 system error` instead of
 * a reply (verified: the stream still names `Agent-GeneralTask`, so the mode
 * itself was accepted). Rather than hand that placeholder to the user, the call
 * is retried ONCE as plain chat — and only when the failed attempt emitted no
 * text, so a fallback can never duplicate a partially streamed answer.
 */
declare function streamChat(prompt: string, options?: ChatRequestOptions & {
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
  credentials?: DoubaoCredentials;
}): Promise<DoubaoChatResult>;
/**
 * Drop every rotated cookie this module has absorbed.
 *
 * MUST be called together with `invalidateCredentialCache()`. The two caches
 * hold halves of one credential: the auth cache holds what was decrypted from
 * disk, and `renewals` holds what the server rotated onto us afterwards
 * (`x-ms-token`, `bd_sso_hi3jfd`). Clearing one without the other leaves the
 * stale half behind — after a credential refresh the freshly-read cookies
 * would immediately be overwritten by values from the previous session, and
 * the user would be told to sign in again for no real reason.
 */
declare function invalidateRenewals(): void;
/** Cookie header with any rotated values overlaid. Values never leave memory. */
declare function applyRenewals(header: string): string;
/**
 * Ask Doubao to stop generating the current turn server-side — the same
 * request the web client's stop button sends (`cmd 2240`).
 *
 * Closing our socket does NOT stop the model: it keeps thinking and burning
 * credits until the server-side turn ends on its own. `reply_msg_id` must be
 * the USER question message id captured from this turn's `SSE_ACK`
 * (`query_list[0].question_id`); `message_id` stays empty per the wire
 * format. Fire-and-forget from the caller's view — rejects so the caller can
 * log, never throws into a response path it has already left.
 */
declare function stopGeneration(credentials: DoubaoCredentials, ids: {
  conversationId: string;
  questionId: string;
}): Promise<void>;
/**
 * Join the two halves of a reply.
 *
 * The opening of every answer arrives in STREAM_MSG_NOTIFY and the remainder as
 * patch deltas in STREAM_CHUNK. Reading only the chunks swallowed the first
 * character of EVERY reply — 「1+1等于2。」 came back as 「+1等于2。」, 「我是豆包」
 * as 「是豆包」 — and nothing failed loudly, which is exactly why it survived.
 *
 * A cumulative chunk stream (one that re-sends what was already delivered)
 * already starts with the notification text; that case is detected rather than
 * concatenated twice. Exported so the rule can be tested without a live stream.
 */
declare function assembleReplyText(notifyText: string, chunkText: string): string;
/**
 * Collect a complete reply. Convenience wrapper over `streamChat` for callers
 * that do not need incremental deltas.
 */
declare function chat(prompt: string, options?: ChatRequestOptions & {
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<DoubaoChatResult>;
/**
 * Doubao's failure classes.
 *
 * Deliberately five, not the seven the WorkBuddy route needs: Doubao has a
 * single account with no pool to rotate through, so there is nothing to fail
 * over to and no failover path to classify.
 *
 *   rate_limited     710022004 — risk control wants a slider CAPTCHA. NOT a
 *                    bandwidth limit and NOT transient: the user must clear it
 *                    once in the Doubao client. Retrying in place makes the
 *                    challenge stricter, so this never enters the retry set.
 *   quota_exhausted  the account's 5-hour or weekly window is spent.
 *   session_dead     credentials unreadable, or the server answers with its
 *                    "session expired" business code. Fix: sign in again.
 *   network          transport failure or timeout.
 *   upstream         anything else Doubao returns.
 */
type DoubaoErrorKind = 'rate_limited' | 'quota_exhausted' | 'session_dead' | 'network' | 'upstream' |
/**
 * The account is routing to the 「工作任务」 agent, whose executing runtime is
 * the desktop app's own process.
 *
 * Kept as its own class because the fix is a single toggle, and calling it
 * `network` (which is where the old classifier dropped it) sends the user to
 * check their Wi-Fi for a problem that is one switch away from solved.
 */
'task_runtime_unavailable';
/**
 * Whether the upstream rejected the request parameters outright.
 *
 * Callers that were continuing a remembered conversation should drop the id
 * after this failure — keeping it would repeat the same rejection for the rest
 * of the session TTL instead of opening a fresh thread on the next turn.
 */
declare function isInvalidParamFailure(error: unknown): boolean;
/**
 * Map one upstream error onto its class.
 *
 * Order matters: the explicit evidence (code, hint, HTTP status) is consulted
 * before the generic `upstream` bucket, and the old catch-all was wrong — every
 * unrecognised failure was reported as `network`, i.e. "check your connection",
 * for HTTP 400s and business errors that a retry cannot fix.
 */
declare function classifyDoubaoFailure(error: DoubaoUpstreamError): DoubaoErrorKind;
/**
 * Whether the host should retry this failure.
 *
 * Deliberately narrow. Re-sending a turn costs quota AND opens a server-side
 * thread, so only a failure that provably never produced an answer qualifies:
 * a transport error before any bytes, or a 5xx. A truncated stream is NOT
 * retryable here — the retry would be a fresh conversation that silently
 * abandons the half-received one, so the user is told instead.
 */
declare function isRetryableFailure(error: unknown): boolean;
/**
 * User-facing text per class.
 *
 * The slider wording matters: it is the one failure the user can actually fix,
 * and the only place they can fix it is the Doubao desktop client — retrying
 * from the Harness will never clear it.
 */
declare const DOUBAO_ERROR_HINTS: Readonly<Record<DoubaoErrorKind, string>>;
/** Build a user-facing message for a Doubao failure. */
declare function describeDoubaoFailure(error: unknown): string;
/** Quick reachability probe that does not consume any inference quota. */
declare function probeAccount(credentials: DoubaoCredentials): Promise<{
  ok: boolean;
  detail: string;
}>;
//#endregion
export { DOUBAO_CONTEXT_WINDOW as $, buildHeaders as A, isTaskModel as At, isRetryableFailure as B, hasBrowserCredentials as Bt, TOOL_LOCAL_ACK_ENDPOINT as C, discoverDoubaoModels as Ct, assembleReplyText as D, findReasoningLevel as Dt, applyRenewals as E, findDoubaoModel as Et, createBlockCollectState as F, CREDENTIAL_TTL_MS as Ft, taskModeEnabled as G, probeAccount as H, loadBrowserCredentials as Ht, describeDoubaoFailure as I, DoubaoCredentials as It, CHAT_AGENT_MODE as J, taskWorkspaceOf as K, extractModel as L, REQUIRED_COOKIE_NAMES as Lt, chat as M, needDeepThinkValue as Mt, classifyDoubaoFailure as N, reasoningLevelOf as Nt, buildChatBody as O, inputSkillOf as Ot, collectBlocks as P, supportsReasoning as Pt, DEFAULT_REASONING_LEVEL_ID as Q, invalidateRenewals as R, clearBrowserCredentials as Rt, StreamCallbacks as S, TASK_SANDBOX_AUTH_ALLOW_ALL as St, TOOL_LOCAL_UPLOAD_ENDPOINT as T, enabledModelsOf as Tt, stopGeneration as U, loadDoubaoCredentials as Ut, parseFrames as V, invalidateCredentialCache as Vt, streamChat as W, saveBrowserCredentials as Wt, DEEP_THINK_OFF as X, CREATION_BLOCK_TYPE as Y, DEEP_THINK_ON as Z, DoubaoUpstreamErrorMeta as _, NO_THINKING_MODEL_IDS as _t, CHAT_ENDPOINT as a, DOUBAO_PROVIDER as at, QUOTA_ENDPOINT as b, TASK_RUNTIME_CLOUD_VM as bt, DEFAULT_BOT_ID as c, DOUBAO_SKILLS as ct, DoubaoChatResult as d, DoubaoCatalogEntry as dt, DOUBAO_DEFAULT_MODEL_ID as et, DoubaoContextWindowUsage as f, DoubaoModelInfo as ft, DoubaoUpstreamError as g, DoubaoSkillName as gt, DoubaoMessage as h, DoubaoReasoningOption as ht, BlockCollectState as i, DOUBAO_MODELS as it, buildQueryUrl as j, levelIdOf as jt, buildGeneralTaskParam as k, isKnownModelId as kt, DOUBAO_ERROR_HINTS as l, DOUBAO_UNAVAILABLE_MODELS as lt, DoubaoImage as m, DoubaoReasoningLevel as mt, ACTION_BAR_BRIEF_LIST_ENDPOINT as n, DOUBAO_IMAGE_MODEL_NAME as nt, CLIENT_PARAMS as o, DOUBAO_PROVIDER_DISPLAY_NAME as ot, DoubaoErrorKind as p, DoubaoModelRate as pt, withImagePrefix as q, BREAK_STREAM_ENDPOINT as r, DOUBAO_MAX_TOKENS as rt, ChatRequestOptions as s, DOUBAO_REASONING_LEVELS as st, ACCOUNT_ENDPOINT as t, DOUBAO_IMAGE_MODEL_ID as tt, DOUBAO_VERSION as u, DiscoveredDoubaoModel as ut, DoubaoUpstreamTelemetry as v, SKILL_CARRIER_MODEL_ID as vt, TOOL_LOCAL_COMPLETE_ENDPOINT as w, doubaoCatalogEntries as wt, RUNTIME_VERSION as x, TASK_RUNTIME_LOCAL_PC as xt, DoubaoUsage as y, TASK_AGENT_MODE as yt, isInvalidParamFailure as z, clearCredentialCache as zt };