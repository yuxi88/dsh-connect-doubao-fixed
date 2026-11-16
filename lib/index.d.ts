import { $ as DOUBAO_CONTEXT_WINDOW, A as buildHeaders, At as isTaskModel, B as isRetryableFailure, Bt as hasBrowserCredentials, C as TOOL_LOCAL_ACK_ENDPOINT, Ct as discoverDoubaoModels, D as assembleReplyText, Dt as findReasoningLevel, E as applyRenewals, Et as findDoubaoModel, F as createBlockCollectState, Ft as CREDENTIAL_TTL_MS, G as taskModeEnabled, H as probeAccount, Ht as loadBrowserCredentials, I as describeDoubaoFailure, It as DoubaoCredentials, J as CHAT_AGENT_MODE, K as taskWorkspaceOf, L as extractModel, Lt as REQUIRED_COOKIE_NAMES, M as chat, Mt as needDeepThinkValue, N as classifyDoubaoFailure, Nt as reasoningLevelOf, O as buildChatBody, Ot as inputSkillOf, P as collectBlocks, Pt as supportsReasoning, Q as DEFAULT_REASONING_LEVEL_ID, R as invalidateRenewals, Rt as clearBrowserCredentials, S as StreamCallbacks, St as TASK_SANDBOX_AUTH_ALLOW_ALL, T as TOOL_LOCAL_UPLOAD_ENDPOINT, Tt as enabledModelsOf, U as stopGeneration, Ut as loadDoubaoCredentials, V as parseFrames, Vt as invalidateCredentialCache, W as streamChat, Wt as saveBrowserCredentials, X as DEEP_THINK_OFF, Y as CREATION_BLOCK_TYPE, Z as DEEP_THINK_ON, _ as DoubaoUpstreamErrorMeta, _t as NO_THINKING_MODEL_IDS, a as CHAT_ENDPOINT, at as DOUBAO_PROVIDER, b as QUOTA_ENDPOINT, bt as TASK_RUNTIME_CLOUD_VM, c as DEFAULT_BOT_ID, ct as DOUBAO_SKILLS, d as DoubaoChatResult, dt as DoubaoCatalogEntry, et as DOUBAO_DEFAULT_MODEL_ID, f as DoubaoContextWindowUsage, ft as DoubaoModelInfo, g as DoubaoUpstreamError, gt as DoubaoSkillName, h as DoubaoMessage, ht as DoubaoReasoningOption, i as BlockCollectState, it as DOUBAO_MODELS, j as buildQueryUrl, jt as levelIdOf, k as buildGeneralTaskParam, kt as isKnownModelId, l as DOUBAO_ERROR_HINTS, lt as DOUBAO_UNAVAILABLE_MODELS, m as DoubaoImage, mt as DoubaoReasoningLevel, n as ACTION_BAR_BRIEF_LIST_ENDPOINT, nt as DOUBAO_IMAGE_MODEL_NAME, o as CLIENT_PARAMS, ot as DOUBAO_PROVIDER_DISPLAY_NAME, p as DoubaoErrorKind, pt as DoubaoModelRate, q as withImagePrefix, r as BREAK_STREAM_ENDPOINT, rt as DOUBAO_MAX_TOKENS, s as ChatRequestOptions, st as DOUBAO_REASONING_LEVELS, t as ACCOUNT_ENDPOINT, tt as DOUBAO_IMAGE_MODEL_ID, u as DOUBAO_VERSION, ut as DiscoveredDoubaoModel, v as DoubaoUpstreamTelemetry, vt as SKILL_CARRIER_MODEL_ID, w as TOOL_LOCAL_COMPLETE_ENDPOINT, wt as doubaoCatalogEntries, x as RUNTIME_VERSION, xt as TASK_RUNTIME_LOCAL_PC, y as DoubaoUsage, yt as TASK_AGENT_MODE, z as isInvalidParamFailure, zt as clearCredentialCache } from "./doubao-upstream-BALD8tSO.js";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import z from "@deepseek-ai/schemastery";
//#region src/doubao-profile.d.ts
/** Where a candidate path came from. Reported by `doctor` so failures are diagnosable. */
type ProfileSource = 'manual' | 'env' | 'process' | 'appdata' | 'scan';
interface DoubaoProfileLocation {
  /** Absolute path of the `User Data` directory (the one containing `Default`). */
  dir: string;
  source: ProfileSource;
}
interface ProfileProbeDeps {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Overrides the `powershell.exe` probe. Returns raw command lines. */
  processCommandLines?: () => string[];
  /** Directories to append `Doubao/User Data` to. Defaults to LOCALAPPDATA/APPDATA/C:\Users\*. */
  appDataBases?: string[];
  /** Drive roots for the fallback scan. Defaults to every existing `X:\`. */
  scanRoots?: string[];
  /** Wall-clock budget for the scan, in ms. Defaults to 1500. */
  scanBudgetMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Overrides {@link setProfileOverride}, for tests. */
  manual?: string;
}
/** Env var a user can set to point at their profile (the folder holding `Default`). */
declare const PROFILE_ENV = "DSH_DOUBAO_PROFILE";
/**
 * Point the resolver at a user-chosen directory.
 *
 * Call with `undefined` to go back to automatic detection. Invalid paths are
 * ignored here rather than stored, so a folder that was later deleted or
 * renamed falls back to detection instead of breaking sign-in outright.
 */
declare function setProfileOverride(raw: string | undefined): void;
/** A directory is a profile only if the cookie jar is really there. */
declare function looksLikeProfile(dir: string): boolean;
/**
 * Resolve one user-supplied path.
 *
 * Accepts either the `User Data` directory itself or its parent (`E:\Doubao`),
 * because both are reasonable readings of "where my data is".
 */
declare function resolveUserProvided(raw: string): string | undefined;
/**
 * Pull `--user-data-dir=` out of one command line.
 *
 * The argument arrives in two shapes and both occur in real Doubao output:
 *
 *   --user-data-dir=C:\path\to\User Data        (cut at whitespace)
 *   "--user-data-dir=C:\path with space"        (quoted as a whole)
 *
 * An empty value is treated as absent: `--user-data-dir=""` means "use the
 * Chromium default", not "the current directory".
 */
declare function extractUserDataDir(commandLine: string): string | undefined;
/**
 * Every plausible profile, best first.
 *
 * Deduplicated case-insensitively (Windows paths are case-insensitive, and the
 * process probe and scan can easily report the same directory). A later source
 * never overrides an earlier one, so `env` always wins.
 */
declare function listDoubaoProfiles(deps?: ProfileProbeDeps): DoubaoProfileLocation[];
/** Best guess for the profile directory, or `undefined`. */
declare function findDoubaoUserDataDir(deps?: ProfileProbeDeps): string | undefined;
/** Where the profile was found and how — what `doctor` prints. */
declare function describeProfileLocation(deps?: ProfileProbeDeps): string;
//#endregion
//#region src/doubao-config.d.ts
/** The single settings field. Mirrored by the card as `enabledModelIds`. */
declare const ENABLED_MODEL_IDS_FIELD = "enabledModelIds";
/** Shape of this plugin's settings. */
interface DoubaoSettings {
  /**
   * Catalog ids the user has ticked.
   *
   * Defaults to `[]` — which means "NOT YET CONFIGURED" rather than "ticked
   * nothing". The two are separated by {@link isConfigured}, which treats a
   * never-saved field the same as an empty one; schemastery 3.18.4 has no
   * `.optional()` and folds an `undefined` default into a NULLABLE field, which
   * would add a third state (`null`) for the card to disambiguate. The reference
   * connector uses the same default-plus-explicit-seeding approach.
   *
   * An empty list therefore serves the WHOLE catalog, so a first-run install
   * shows its models. Collapsing the two states would instead silently re-publish
   * every entry for a user who had deliberately ticked none — which is why
   * `enabledModelsOf` keys off {@link isConfigured} rather than off emptiness.
   */
  enabledModelIds: string[];
  /**
   * Simulate tool calling in the prompt so Doubao can drive the Harness tools.
   *
   * OFF by default. Doubao's endpoint ignores a `tools` array outright (measured
   * 2026-10-22: it answered with its OWN server-side search skill and never
   * referenced our declarations), so the only channel available is the prompt:
   * describe the tools, then parse a fenced block back into `tool_calls`.
   *
   * Measured 2026-11-02 with a two-tool sandbox loop: 9/9 calls well-formed,
   * 5/5 rounds converged, ~11.5s per round, one duplicate call. That is enough
   * to be useful and not enough to be trusted silently — hence opt-in.
   */
  toolEmulation: boolean;
  /**
   * Absolute path to the Doubao profile, or `''` for "detect it yourself".
   *
   * Only needed when the app keeps `User Data` somewhere the four automatic
   * strategies cannot reach — an external drive that is not mounted at scan
   * time, a redirected folder, or a copy the user moved by hand. The card
   * offers a picker for it; the value is validated host-side (it must contain
   * `Default\Network\Cookies`) before it is stored.
   */
  profileDir: string;
}
/** The settings field holding the tool-emulation switch. */
declare const TOOL_EMULATION_FIELD = "toolEmulation";
/** The settings field holding a manually chosen profile directory. */
declare const PROFILE_DIR_FIELD = "profileDir";
/** Read the chosen profile directory, or `undefined` when it is not set. */
declare function profileDirOf(config: unknown): string | undefined;
/** Read the switch out of an arbitrary config snapshot; default true. */
declare function toolEmulationOf(config: unknown): boolean;
/** Whether the user has ever saved a selection (i.e. the field is not the default). */
declare function isConfigured(config: unknown): boolean;
declare const Config: z<DoubaoSettings>;
/**
 * The ticked ids, or `undefined` when the field is ABSENT.
 *
 * The absent case is what `enabledModelsOf` keys off to mean "never
 * configured"; a present-but-empty array is a real (empty) selection.
 */
declare function enabledIdsOf(config: unknown): string[] | undefined;
/**
 * The ids the adapter should filter by, or `undefined` for "serve everything".
 *
 * Normalises the schemastery default (`[]`, meaning not-yet-configured) into
 * the `undefined` that `enabledModelsOf` reads as "serve the whole catalog".
 * Without this the default would read as a user who ticked nothing, and a
 * first-run install would show an empty model picker.
 */
declare function effectiveIds(config: unknown): string[] | undefined;
//#endregion
//#region src/doubao-quota.d.ts
/** Quota results are cached briefly so a chatty session does not hammer the API. */
declare const QUOTA_TTL_MS: number;
type QuotaWindowType = 'five_hour' | 'weekly' | 'incentive';
interface QuotaWindow {
  type: QuotaWindowType;
  /** Raw window_type from the server. */
  windowType: number;
  /** Percent of this window already consumed, 0-100. */
  usedPercent: number;
  /** Percent still available, 0-100. */
  remainingPercent: number;
  /** Epoch ms when this window resets. Drives the countdown. */
  resetsAt: number;
  /** Epoch ms when the window opened. */
  startedAt: number;
  /** Window length in ms, derived from the server's own timestamps. */
  windowMs: number;
  /**
   * True when the server sent NO window timestamps at all.
   *
   * Doubao zeroes `start_time`/`end_time` for some plans, and silently
   * inventing "opened when you looked, resets one period from now" produced a
   * countdown that was wrong by up to a week — the user reads "resets in 6 days"
   * for a window that may reset in twenty minutes. When the instant is unknown
   * the UI says so instead.
   */
  resetUnknown?: boolean;
  /** Raw consumed amount, when the server reports it (a "2,100"-style string). */
  usedAmount?: number;
  /** Server-provided group name, e.g. 「活动赠送额度」. */
  label?: string;
  /**
   * True when the window has no start instant because it begins counting on
   * first use. Doubao renders this as 「开始使用后计时」.
   */
  startsOnUse?: boolean;
  /** Raw entitlement total, same shape as {@link usedAmount}. */
  totalAmount?: number;
}
interface DoubaoQuota {
  /** True when Doubao reports all entitlements exhausted. */
  exhausted: boolean;
  windows: QuotaWindow[];
  /** Subscription identity, when the account has one. */
  plan?: string;
  planActive?: boolean;
  /** Epoch ms when this reading was taken. */
  fetchedAt: number;
  /** Populated when the quota could not be read. */
  error?: string;
}
interface RawWindowLimit {
  window_type?: number;
  item_type?: number;
  used_percent?: number;
  less_than_one_percent?: boolean;
  start_time?: number;
  end_time?: number;
  /** Formatted strings, e.g. "2,100". Present even when used_percent is not. */
  total_amount?: string | number;
  used_amount?: string | number;
}
/**
 * Convert one server window into the shape the UI consumes.
 *
 * Three shapes are observed:
 *
 * - both timestamps present: a rolling window with a real reset instant;
 * - both zero: the window has not started yet (Doubao renders
 *   「开始使用后计时」); the reset instant is unknown and MUST NOT be invented;
 * - only `end_time`: a promotional grant with an expiry but no start.
 *
 * Reconstructing a missing start from the nominal window length used to make
 * the card count down to a moment the server never sent — off by up to a week.
 */
declare function normalizeWindow(raw: RawWindowLimit, label?: string): QuotaWindow | undefined;
/**
 * Read the account's current quota.
 *
 * Never throws: an unreachable endpoint yields a `DoubaoQuota` carrying an
 * `error`, because a quota panel failure must not take down a chat request.
 */
interface RawQuotaData {
  window_limit_section?: {
    usage_exhausted?: boolean;
    window_limit_groups?: Array<{
      feature_group_name?: string;
      window_limits?: RawWindowLimit[];
    }>;
  };
  enterprise_window_limit_section?: {
    usage_exhausted?: boolean;
    window_limit_groups?: Array<{
      feature_group_name?: string;
      window_limits?: RawWindowLimit[];
    }>;
  };
  incentive_quota_section?: {
    usage_exhausted?: boolean;
    window_limit_groups?: Array<{
      feature_group_name?: string;
      window_limits?: RawWindowLimit[];
    }>;
  };
  current_subscription?: {
    display?: {
      short_name?: string;
      product_name?: string;
    };
  };
  member_info?: {
    hasActiveSubscription?: boolean;
  };
}
/**
 * Only report the account as exhausted when all active quota entitlements say
 * so: an exhausted promotional bonus must not block turns while the main
 * window still has headroom.
 */
declare function evaluateQuotaExhausted(data: RawQuotaData | undefined): boolean;
declare function fetchQuota(options?: {
  force?: boolean;
}): Promise<DoubaoQuota>;
/** Drop the cached reading so the next call hits the server. */
declare function invalidateQuotaCache(): void;
/** Convenience lookup for a specific window. */
declare function findWindow(quota: DoubaoQuota, type: QuotaWindowType): QuotaWindow | undefined;
/**
 * Milliseconds until a window resets, clamped at zero.
 * Drives the countdown the user asked for.
 */
declare function millisUntilReset(window: QuotaWindow, now?: number): number;
/** Human-readable duration, e.g. `4h 12m`. */
declare function formatDuration(ms: number): string;
//#endregion
//#region src/doubao-discovery.d.ts
/** How long a discovery result is reused before re-reading the cache. */
declare const DISCOVERY_TTL_MS: number;
interface DiscoveredEntry {
  key: string;
  name: string;
  /** True when the client's own name marks it as a 工作任务-only model. */
  taskOnly: boolean;
  /**
   * The mode the app files this model under: '1' = 对话, '3' = 工作任务.
   *
   * Only the Preferences source carries it, so it is optional. It matters: the
   * third-party models (DeepSeek / Kimi / GLM) arrive with a plain product name
   * and no 「工作任务」 prefix, so `taskOnly` alone would route them as ordinary
   * chat turns when the app itself runs them in task mode.
   */
  mode?: string;
  /**
   * The menu's status tag: either a billing multiplier ("0.65x") or a campaign
   * label ("限时优惠 0.01x"). Only the Preferences source carries it.
   */
  rate?: {
    text: string;
    kind: 'ratio' | 'promo';
  };
  /**
   * The thinking levels this model offers, in the menu's own order.
   *
   * Only the Preferences source carries it, and it is PER MODEL: GLM publishes
   * 低/高/最高 while 2.1 Lite publishes 低/中/高, so a shared list is wrong for at
   * least one of them.
   */
  reasoningOptions?: Array<{
    level: number;
    name: string;
  }>;
}
/**
 * All (key, name) pairs the client currently knows, task-only ones included.
 *
 * Exported for the diagnostics path — it is the raw view, useful when a model
 * shows up in the app but not in DSH and the question is "did we not see it, or
 * did we see it and classify it away".
 */
declare function discoverAllCachedModels(): DiscoveredEntry[];
/**
 * The models DSH may offer: everything the client lists that is NOT task-only,
 * plus the image-generation alias.
 *
 * Returns undefined when the cache yielded nothing usable, so the caller keeps
 * the static catalog. Names are taken verbatim from the client, which is the
 * whole point: when Doubao renames or adds a chat model, it shows up here
 * without a plugin release.
 */
declare function discoverModels(now?: number): DoubaoModelInfo[] | undefined;
/**
 * The catalog to use right now: discovered models when the cache yields them,
 * otherwise the static list, re-read at most once per {@link DISCOVERY_TTL_MS}.
 *
 * Every consumer (picker, adapter, card) goes through this one function so the
 * three views can never disagree about which models exist.
 */
declare function liveModels(now?: number): DoubaoModelInfo[];
/**
 * Refresh the model catalog over HTTP from Doubao's `brief_list` endpoint.
 *
 * Pure browser-login installs have no desktop `Preferences` cache at all, so
 * without this HTTP step they stay stuck on the 6-model static fallback.
 * Errors fall back quietly to cached / static models and never throw.
 */
declare function refreshDiscovery(options?: {
  force?: boolean;
  now?: number;
}): Promise<DoubaoModelInfo[]>;
/** Forget the memo — used by the card's refresh and by tests. */
declare function invalidateDiscovery(): void;
//#endregion
//#region src/doubao-tokens.d.ts
/**
 * Deterministic token estimation and OpenAI-compatible usage accounting for
 * Doubao shim responses.
 *
 * WHY ESTIMATED ON-SHIM. Doubao's `/chat/completion` endpoint emits optional
 * server-side `context_window_usage` snapshots inside `Agent-GeneralTask` turns
 * (covering Doubao's own hidden workspace prompt + built-in tool schemas), but
 * does not report per-request OpenAI `prompt_tokens` / `completion_tokens` or
 * plain-chat token counts.
 *
 * Computing OpenAI `usage` from DSH's actual inbound `messages` / `tools` and
 * the streamed `reasoning` + `text` + emulated `tool_calls` ensures:
 *
 *   1. DSH's native `tokenUsage`, `contextPressure`, `ContextMeter`,
 *      `UsagePill`, `sessionStats`, `ActivityPill`, and `StatsView` populate
 *      reliably across all Doubao models (chat, deep-think, task 2.1, image);
 *   2. CJK text (~1 tok/char) and ASCII code/prose (~3.7 chars/tok) are priced
 *      realistically while mathematically staying >= DSH's 4-chars/token floor
 *      (`@deepseek-ai/dsh-token-meter`), so `TokenMeter.measure()` accepts the
 *      reported `usage` instead of falling back to heuristic mode;
 *   3. Server-side `conversation_id` continuations surface the already-uploaded
 *      transcript prefix honestly as `prompt_tokens_details.cached_tokens`.
 *
 * @module dsh-connect-doubao/tokens
 */
interface TokenizableToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}
interface TokenizableMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly TokenizableToolCall[];
}
interface TokenizableTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}
interface UsageBreakdown {
  promptTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  answerTokens: number;
  toolCallTokens: number;
  totalTokens: number;
  openai: OpenAIUsage;
}
interface ResolveChatUsageInput {
  messages: readonly TokenizableMessage[];
  tools?: readonly TokenizableTool[];
  /** Tool contract prose appended when tool emulation is active. */
  emulatedContractText?: string;
  /** Leading message count already resident on upstream `conversation_id`. */
  cachedPrefixMessages?: number;
  answerText: string;
  reasoningText?: string;
  toolCalls?: ReadonlyArray<{
    name: string;
    arguments: string;
  }>;
}
/**
 * Single-pass O(n) token count estimator tuned for mixed Chinese/English/code.
 *
 * Every code-unit weight is >= 0.25, guaranteeing `estimateTextTokens(s) >=
 * Math.ceil(s.length / 4)` for any non-empty string.
 */
declare function estimateTextTokens(text: string): number;
/** Estimate tokens for an inbound OpenAI message `content` field. */
declare function estimateContentTokens(content: unknown): number;
/** Estimate tokens for one OpenAI chat message including role & tool calls. */
declare function estimateMessageTokens(message: TokenizableMessage): number;
/** Estimate tokens consumed by tool definitions or their emulated prompt block. */
declare function estimateToolsTokens(tools: readonly TokenizableTool[] | undefined, emulatedContractText?: string): number;
/** Build full usage metrics + OpenAI wire `usage` payload for one chat completion. */
declare function resolveChatUsage(input: ResolveChatUsageInput): UsageBreakdown;
//#endregion
//#region src/doubao-stats.d.ts
declare const DOUBAO_STATS_MAX_SESSIONS = 64;
interface DoubaoModelStatsView {
  model: string;
  requests: number;
  succeeded: number;
  failed: number;
  promptTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}
interface DoubaoSessionStatsEntryView {
  sessionKey: string;
  lastModel: string;
  turns: number;
  continuations: number;
  promptTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  lastTtftMs: number | null;
  lastTps: number | null;
  lastActiveAt: number;
}
interface DoubaoLastTurnStatsView {
  at: number;
  model: string;
  stream: boolean;
  continuation: boolean;
  promptTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  ttftMs: number | null;
  durationMs: number;
  decodeMs: number;
  tps: number | null;
  upstreamContextWindow: DoubaoContextWindowUsage | null;
  upstreamFirstPacketMs: number | null;
  upstreamAckMs: number | null;
}
interface DoubaoStatsView {
  ok: boolean;
  startedAt: number;
  updatedAt: number;
  activeConversations: number;
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    continuations: number;
    promptTokens: number;
    uncachedInputTokens: number;
    cachedInputTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheHitRate: number | null;
    avgTtftMs: number | null;
    avgTps: number | null;
    totalDurationMs: number;
    decodeMs: number;
    decodeTokens: number;
  };
  byModel: DoubaoModelStatsView[];
  sessions: DoubaoSessionStatsEntryView[];
  lastTurn: DoubaoLastTurnStatsView | null;
}
interface RecordSuccessInput {
  model: string;
  sessionKey?: string;
  stream: boolean;
  continuation: boolean;
  usage: UsageBreakdown;
  ttftMs: number | null;
  durationMs: number;
  decodeMs: number;
  upstreamContextWindow?: DoubaoContextWindowUsage;
  upstreamFirstPacketMs?: number;
  upstreamAckMs?: number;
  now?: number;
}
interface RecordFailureInput {
  model: string;
  durationMs: number;
  now?: number;
}
/** Tracks runtime token usage and session statistics across Doubao turns. */
declare class DoubaoStatsTracker {
  private readonly maxSessions;
  private startedAt;
  private updatedAt;
  private requests;
  private succeeded;
  private failed;
  private continuations;
  private promptTokens;
  private uncachedInputTokens;
  private cachedInputTokens;
  private completionTokens;
  private reasoningTokens;
  private totalTokens;
  private ttftSumMs;
  private ttftSamples;
  private decodeMs;
  private decodeTokens;
  private totalDurationMs;
  private lastTurn;
  private readonly byModel;
  private readonly sessions;
  constructor(maxSessions?: number, now?: number);
  private getOrInitModel;
  recordSuccess(input: RecordSuccessInput): void;
  recordFailure(input: RecordFailureInput): void;
  reset(now?: number): void;
  snapshot(activeConversations?: number): DoubaoStatsView;
}
//#endregion
//#region src/doubao-shim.d.ts
interface DoubaoShim {
  /**
   * Origin pi-ai should point its OpenAI client at.
   *
   * Awaits the listening socket. `server.listen()` is asynchronous, so a
   * caller that reads `server.address()` immediately gets `null` — which is
   * exactly what happens when the adapter builds its first model snapshot
   * during registration, moments after the shim is created. Callers must
   * await this rather than assume the port is already bound.
   */
  baseUrl(): Promise<string>;
  /** Per-process shared secret, handed to pi-ai as the OpenAI apiKey. */
  token(): string;
  /**
   * Origin, or `undefined` while the socket is still binding.
   *
   * pi-ai's `getModels` is synchronous, so the adapter cannot await the port.
   * This is the sync view it reads; `baseUrl()` is the awaitable one used by
   * callers that can wait (the doctor, and the adapter's own warm-up).
   */
  baseUrlSync(): string | undefined;
  /** Current session & token usage snapshot recorded by this shim. */
  stats(): DoubaoStatsView;
  /** Clear accumulated runtime session & token statistics. */
  resetStats(): void;
  /** Release the port. */
  close(): Promise<void>;
}
interface DoubaoShimOptions {
  /** Resolve credentials per request, so a re-login is picked up without a restart. */
  resolveCredentials?: () => DoubaoCredentials;
  /**
   * Whether to simulate tool calling in the prompt.
   *
   * Read per request (not once at construction) because the user can flip the
   * setting without restarting the host.
   */
  toolEmulation?: () => boolean;
  /** Optional shared stats tracker; defaults to a per-shim instance. */
  stats?: DoubaoStatsTracker;
}
declare function createDoubaoShim(options?: DoubaoShimOptions): DoubaoShim;
//#endregion
//#region src/doubao-adapter.d.ts
/** Provider idle ceiling while one stream read is outstanding. */
declare const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 300000;
interface DoubaoAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog change. */
  invalidate: () => void;
  /**
   * Replace the ticked catalog ids and rebuild the snapshot.
   *
   * This is the ONLY effect the card's checklist has: it decides which entries
   * exist in DSH's model picker. Which one is actually used is the session's
   * choice, sent per request as `model_item_key`.
   *
   * `undefined` means "never configured" and serves the whole catalog; `[]`
   * serves nothing, which is a legitimate user choice.
   */
  setEnabledModelIds(ids: string[] | undefined): void;
}
interface DoubaoAdapterOptions {
  shim: DoubaoShim;
  /** Initial ticked ids, or undefined for "never configured". */
  enabledModelIds?: string[] | undefined;
  /**
   * Where the current catalog comes from. Defaults to the static list; the
   * plugin passes the DISCOVERED list so a model Doubao ships reaches this
   * provider without waiting for a plugin release. Called on every rebuild, so
   * it must be cheap — `liveModels()` memoises it.
   */
  modelsProvider?: () => readonly DoubaoModelInfo[];
  /**
   * Fires once after an initially-unbound loopback shim settles on its port,
   * so callers can re-emit adapter availability (`adapterRelease.replace`).
   */
  onBaseUrlReady?: () => void;
}
/**
 * Assemble the adapter.
 *
 * Every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup.
 */
declare function createDoubaoAdapter(options: DoubaoAdapterOptions): DoubaoAdapter;
//#endregion
//#region src/doubao-status.d.ts
/** Route path, relative to the plugin mount point. */
declare const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
/** Route serving the model checklist's catalog. */
declare const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
/** Route serving live runtime session & token usage statistics. */
declare const DOUBAO_STATS_PATH = "/plugins/dsh-connect-doubao/stats";
/**
 * One window as the card sees it.
 *
 * `resetsAt`/`resetsInMs` are null when Doubao sent no timestamps: a made-up
 * countdown is worse than an honest "unknown", because the user plans around it.
 */
interface QuotaWindowView {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  resetsInMs: number | null;
  /** Server-provided group name, e.g. 「活动赠送额度」. */
  label: string | null;
  /** True when the window only starts counting on first use. */
  startsOnUse: boolean;
  /** Raw amounts, when the plan reports them instead of a percentage. */
  usedAmount: number | null;
  totalAmount: number | null;
}
interface DoubaoQuotaView {
  ok: boolean;
  profile: string;
  plan: string | null;
  exhausted: boolean;
  windows: {
    fiveHour: QuotaWindowView | null;
    weekly: QuotaWindowView | null;
    /** Promotional grants ("活动赠送额度"); usually zero or one. */
    incentive: QuotaWindowView[];
  };
  fetchedAt: number;
  error: string | null;
}
declare function doubaoQuotaView(options?: {
  force?: boolean;
}): Promise<DoubaoQuotaView>;
/** Minimal shape of the `webServer` service this route needs. */
interface WebServerLike {
  register(route: {
    kind: 'exact';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}
/** Route the card writes settings through. */
declare const DOUBAO_SAVE_PATH = "/plugins/dsh-connect-doubao/__save";
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
declare function registerDoubaoSaveRoute(ctx: {
  webServer: WebServerLike;
}, deps: {
  /** Where the plugin keeps its own settings file. */
  write: (field: string, value: unknown) => void;
  /** Read it back, so the card renders what is actually on disk. */
  read: () => unknown;
  onApplied?: (field: string, value: unknown) => void;
  /**
   * Where the host-settings registration got to. Reported alongside a
   * successful write because it explains WHY this route exists at all: the
   * host namespace is missing and every write through it is dropped.
   */
  diagnostics?: () => unknown;
}): () => void;
/** Register the quota route. Returns a disposer. */
declare function registerDoubaoQuotaRoute(ctx: {
  webServer: WebServerLike;
}, deps?: {
  onRefresh?: () => void;
}): () => void;
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
declare function registerDoubaoCatalogRoute(ctx: {
  webServer: WebServerLike;
}, deps?: {
  modelsProvider?: () => readonly DoubaoModelInfo[];
  refreshModels?: () => Promise<void> | void;
  onRefreshed?: () => void;
}): () => void;
/** Route the card reads the session state through, and starts a sign-in on. */
declare const DOUBAO_AUTH_PATH = "/plugins/dsh-connect-doubao/auth";
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
declare function registerDoubaoAuthRoute(ctx: {
  webServer: WebServerLike;
}, deps?: {
  onSignedIn?: () => void;
}): () => void;
/**
 * Register the runtime session & token usage statistics route.
 *
 * GET returns aggregate counts, per-model breakdown, opaque session summaries,
 * and last-turn telemetry (including upstream `context_window_usage` when
 * reported). POST `{"action":"reset"}` clears accumulated counters.
 */
declare function registerDoubaoStatsRoute(ctx: {
  webServer: WebServerLike;
}, deps: {
  read: () => DoubaoStatsView;
  reset?: () => void;
}): () => void;
//#endregion
//#region src/index.d.ts
declare const PLUGIN_ID = "dsh-connect-doubao";
declare const PLUGIN_NAME = "DSH Connect Doubao";
/**
 * Diagnostic trail for the settings-presentation registration.
 *
 * `settings.configure()` is what makes this plugin a settings namespace, and it
 * can fail in four completely different places without raising: the inject
 * child never runs (no `settings` service), `ctx.effect` never runs, the call
 * itself throws, or it succeeds and the host still does not list us. Those look
 * identical from the outside — a missing namespace — so each step records
 * whether it was reached and the save route reports the trail.
 */
declare const presentationDiag: {
  injectRan?: boolean;
  hasSettings?: boolean;
  hasFiber?: boolean;
  effectRan?: boolean;
  configureRan?: boolean;
  error?: string;
  /** Entry ids the host's config editor actually holds, as seen from the settings service. */
  editorEntries?: string[];
  /** Why enumerating them failed, when it did. */
  editorError?: string;
  /** `ctx.fiber.entry.options.id` — the id `settings.mutate()` resolves against. */
  fiberEntryId?: string;
  /** The namespace this plugin asks the save route to write into. */
  settingsNs?: string;
};
/**
 * The plugin's Cordis name — the value the Loader and the Settings service key
 * on. It must be the ENTRY ID, not a human-readable title.
 *
 * Two working siblings prove the rule: `dsh-connect-trae` and
 * `dsh-connect-workbuddy` both export `name === their entry id`, and both have
 * a namespace in `settings.describe()`. This plugin exported
 * `'DSH Connect Doubao'`, and its namespace was the ONE absent from a 28-entry
 * `describe()` list even though it calls `settings.configure()` exactly like
 * they do. A display title is not an identifier; the settings row never existed
 * because nothing registered under that name.
 */
declare const name = "dsh-connect-doubao";
/**
 * Settings namespace for this provider's configurable entry.
 *
 * DEPRECATED as a name to use: the Host resolves a provider's namespace by
 * EXACT match against the Loader entry id, which a profile chooses. Use
 * {@link settingsNamespaceOf}, which reads the entry the Loader actually made.
 * Kept as a documented fallback for hosts that expose no entry id.
 */
declare const DOUBAO_SETTINGS_NS = "llm:doubao";
/**
 * Minimal structural type for the context this plugin touches.
 *
 * Declared structurally rather than imported from `@deepseek-ai/cordis` so the
 * package builds and typechecks without the peer dependency installed. At
 * runtime Cordis passes a real `Context`, which satisfies this shape.
 */
type DoubaoAdapterRelease = (() => void) & {
  replace?: (ids: string[]) => void;
};
interface DoubaoPluginContext {
  llm: {
    registerAdapter(ids: string[], adapter: unknown): DoubaoAdapterRelease;
    registerConfigurableProviders(entries: Array<{
      provider: string;
      displayName: string;
      settingsNs: string;
      settingsPath: string[];
      declared: boolean;
    }>): () => void;
    registerModelDiscovery(ns: string, fn: (request: {
      provider?: string;
    }) => Promise<Array<{
      id: string;
      name: string;
      contextWindow: number;
      maxTokens: number;
      inputModalities: ('text' | 'image')[];
    }>>): () => void;
  };
  inject(names: string[], apply: (webCtx: never) => void): void;
  on(name: string, listener: (config?: DoubaoSettings) => void): unknown;
  effect(fn: () => (() => void) | void): void;
  logger: {
    error(message: string, error?: unknown): void;
    warn?(message: string, error?: unknown): void;
  };
  get?(name: string): unknown;
}
/**
 * A bare `apply` export (not a `plugin = { ... }` object): the Loader reads
 * `name` / `inject` / `Config` / `apply` as named exports of the entry module.
 * `name` is exported above, next to PLUGIN_ID, which is what it must equal.
 */
/**
 * Services required before the provider may register.
 *
 * `inject: ['llm']` is REQUIRED, not decorative. Cordis only exposes a service
 * to a plugin that declared it, and touching `ctx.llm` without the declaration
 * throws `cannot get property "llm" without inject` from inside `apply()` — which
 * takes the whole plugin down silently: no provider, no quota route, and only a
 * log line to show for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
 *
 * `webServer` is deliberately NOT listed: it mounts later, and on Desktop it may
 * never appear, so listing it would hold the entire plugin back forever. The
 * quota route waits on a NESTED `ctx.inject(['webServer'], ...)` instead.
 *
 * `settings` is a soft probe (`ctx.get`), not an inject entry: the settings
 * surface differs by host line, and Cordis' gate is hard enough that naming a
 * service this host does not provide stops `apply` from ever running.
 */
declare const inject: string[];
/**
 * The namespace the HOST actually serves this plugin's config under.
 *
 * The Host resolves a provider's namespace by EXACT match, and the namespace it
 * serves is the Loader entry id — which a profile may mount as
 * `dsh-connect-doubao` or, as the live Desktop host does, as an include. A
 * guessed name that misses makes the config entry read as unconfigured and the
 * model's settings disappear. So ask the Loader entry, with the declared id as
 * the documented fallback.
 */
declare function settingsNamespaceOf(ctx: unknown): string;
/**
 * Wire the provider and the read-only routes.
 *
 * `apply` wires every disposer into one `ctx.effect`, so unloading the plugin
 * releases the shim's port, the adapter, the directory entry, the discovery
 * callback and the HTTP routes — nothing outlives the plugin.
 */
declare function apply(ctx: DoubaoPluginContext, config?: DoubaoSettings): void;
declare const _default: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { ACCOUNT_ENDPOINT, ACTION_BAR_BRIEF_LIST_ENDPOINT, BREAK_STREAM_ENDPOINT, BlockCollectState, CHAT_AGENT_MODE, CHAT_ENDPOINT, CLIENT_PARAMS, CREATION_BLOCK_TYPE, CREDENTIAL_TTL_MS, ChatRequestOptions, Config, DEEP_THINK_OFF, DEEP_THINK_ON, DEFAULT_BOT_ID, DEFAULT_REASONING_LEVEL_ID, DISCOVERY_TTL_MS, DOUBAO_AUTH_PATH, DOUBAO_CATALOG_PATH, DOUBAO_CONTEXT_WINDOW, DOUBAO_DEFAULT_MODEL_ID, DOUBAO_ERROR_HINTS, DOUBAO_IMAGE_MODEL_ID, DOUBAO_IMAGE_MODEL_NAME, DOUBAO_MAX_TOKENS, DOUBAO_MODELS, DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, DOUBAO_QUOTA_PATH, DOUBAO_REASONING_LEVELS, DOUBAO_SAVE_PATH, DOUBAO_SETTINGS_NS, DOUBAO_SKILLS, DOUBAO_STATS_MAX_SESSIONS, DOUBAO_STATS_PATH, DOUBAO_STREAM_IDLE_TIMEOUT_MS, DOUBAO_UNAVAILABLE_MODELS, DOUBAO_VERSION, DiscoveredDoubaoModel, DoubaoAdapterRelease, DoubaoCatalogEntry, DoubaoChatResult, DoubaoContextWindowUsage, DoubaoCredentials, DoubaoErrorKind, DoubaoImage, DoubaoLastTurnStatsView, DoubaoMessage, DoubaoModelInfo, DoubaoModelRate, DoubaoModelStatsView, DoubaoPluginContext, type DoubaoProfileLocation, DoubaoQuota, DoubaoReasoningLevel, DoubaoReasoningOption, DoubaoSessionStatsEntryView, DoubaoSettings, type DoubaoShim, DoubaoSkillName, DoubaoStatsTracker, DoubaoStatsView, DoubaoUpstreamError, DoubaoUpstreamErrorMeta, DoubaoUpstreamTelemetry, DoubaoUsage, ENABLED_MODEL_IDS_FIELD, NO_THINKING_MODEL_IDS, OpenAIUsage, PLUGIN_ID, PLUGIN_NAME, PROFILE_DIR_FIELD, PROFILE_ENV, type ProfileSource, QUOTA_ENDPOINT, QUOTA_TTL_MS, QuotaWindow, QuotaWindowType, REQUIRED_COOKIE_NAMES, RUNTIME_VERSION, RawQuotaData, RecordFailureInput, RecordSuccessInput, ResolveChatUsageInput, SKILL_CARRIER_MODEL_ID, StreamCallbacks, TASK_AGENT_MODE, TASK_RUNTIME_CLOUD_VM, TASK_RUNTIME_LOCAL_PC, TASK_SANDBOX_AUTH_ALLOW_ALL, TOOL_EMULATION_FIELD, TOOL_LOCAL_ACK_ENDPOINT, TOOL_LOCAL_COMPLETE_ENDPOINT, TOOL_LOCAL_UPLOAD_ENDPOINT, TokenizableMessage, TokenizableTool, TokenizableToolCall, UsageBreakdown, apply, applyRenewals, assembleReplyText, buildChatBody, buildGeneralTaskParam, buildHeaders, buildQueryUrl, chat, classifyDoubaoFailure, clearBrowserCredentials, clearCredentialCache, collectBlocks, createBlockCollectState, createDoubaoAdapter, createDoubaoShim, _default as default, describeDoubaoFailure, describeProfileLocation, discoverAllCachedModels, discoverDoubaoModels, discoverModels, doubaoCatalogEntries, doubaoQuotaView, effectiveIds, enabledIdsOf, enabledModelsOf, estimateContentTokens, estimateMessageTokens, estimateTextTokens, estimateToolsTokens, evaluateQuotaExhausted, extractModel, extractUserDataDir, fetchQuota, findDoubaoModel, findDoubaoUserDataDir, findReasoningLevel, findWindow, formatDuration, hasBrowserCredentials, inject, inputSkillOf, invalidateCredentialCache, invalidateDiscovery, invalidateQuotaCache, invalidateRenewals, isConfigured, isInvalidParamFailure, isKnownModelId, isRetryableFailure, isTaskModel, levelIdOf, listDoubaoProfiles, liveModels, loadBrowserCredentials, loadDoubaoCredentials, looksLikeProfile, millisUntilReset, name, needDeepThinkValue, normalizeWindow, parseFrames, presentationDiag, probeAccount, profileDirOf, reasoningLevelOf, refreshDiscovery, registerDoubaoAuthRoute, registerDoubaoCatalogRoute, registerDoubaoQuotaRoute, registerDoubaoSaveRoute, registerDoubaoStatsRoute, resolveChatUsage, resolveUserProvided, saveBrowserCredentials, setProfileOverride, settingsNamespaceOf, stopGeneration, streamChat, supportsReasoning, taskModeEnabled, taskWorkspaceOf, toolEmulationOf, withImagePrefix };