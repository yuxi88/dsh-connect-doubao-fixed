import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
//#region src/doubao-catalog.ts
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
const DOUBAO_PROVIDER = "doubao";
/** Shown in the DSH model picker. */
const DOUBAO_PROVIDER_DISPLAY_NAME = "豆包（Doubao）";
/** How much context a Doubao conversation holds. */
const DOUBAO_CONTEXT_WINDOW = 256e3;
/** Generous output ceiling; the subscription quota, not this, is the real bound. */
const DOUBAO_MAX_TOKENS = 32e3;
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
const CHAT_AGENT_MODE = 2;
/** 「工作任务」 mode. Requires the `tool_local` responder — see `doubao-upstream.ts`. */
const TASK_AGENT_MODE = 1;
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
const TASK_RUNTIME_CLOUD_VM = 1;
const TASK_RUNTIME_LOCAL_PC = 2;
/**
* Sandbox authorisation level.
*
* `2` is what the client sends with its 「全部允许」 authorisation setting (read
* off the same captured task request). The cloud uses it to decide how freely it
* may plan file and command actions inside the declared workspace.
*/
const TASK_SANDBOX_AUTH_ALLOW_ALL = 2;
const DOUBAO_REASONING_LEVELS = [
	{
		id: "low",
		name: "低",
		level: 3,
		verified: true
	},
	{
		id: "mid",
		name: "中",
		level: 4,
		verified: true
	},
	{
		id: "high",
		name: "高",
		level: 5,
		verified: true
	},
	{
		id: "xhigh",
		name: "极高",
		level: 6,
		verified: false
	},
	{
		id: "max",
		name: "最高",
		level: 7,
		verified: false
	}
];
/** The level used when a request names none. Verified on the wire. */
const DEFAULT_REASONING_LEVEL_ID = "high";
/** Reasoning level for an id, falling back to the default. */
function findReasoningLevel(id) {
	const known = DOUBAO_REASONING_LEVELS.find((level) => level.id === id);
	if (known !== void 0) return known;
	if (id !== void 0 && /^\d{1,3}$/.test(id)) {
		const ordinal = Number(id);
		const named = DOUBAO_REASONING_LEVELS.find((level) => level.level === ordinal);
		if (named !== void 0) return named;
		return {
			id,
			name: String(ordinal),
			level: ordinal,
			verified: false
		};
	}
	return DOUBAO_REASONING_LEVELS.find((level) => level.id === DEFAULT_REASONING_LEVEL_ID);
}
/** The catalog entry for a wire ordinal, or undefined for one it does not know. */
function reasoningLevelOf(ordinal) {
	if (ordinal === void 0) return void 0;
	return DOUBAO_REASONING_LEVELS.find((level) => level.level === ordinal);
}
/**
* The wire spelling of an ordinal.
*
* `model_extra_params.reasoning_effort` for 2.1 Lite is a STRING in the captured
* request, and that string is the level's name-id, not its number. An ordinal
* with no catalog entry falls back to its own decimal form, so a level Doubao
* adds later still travels instead of snapping back to 高.
*/
function levelIdOf(ordinal) {
	return reasoningLevelOf(ordinal)?.id ?? String(ordinal);
}
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
const DEEP_THINK_OFF = 0;
const DEEP_THINK_ON = 3;
/** `need_deep_think` value for the switch state. */
function needDeepThinkValue(deepThink) {
	return deepThink ? 3 : 0;
}
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
const DOUBAO_SKILLS = {
	freeChat: 0,
	write: 2,
	imageGen: 3,
	search: 4,
	translate: 5,
	read: 6,
	webpage: 7,
	deepSearch: 8,
	musicGen: 9,
	edu: 11,
	codeInterpreter: 13,
	codeAssistant: 16,
	videoGeneration: 17,
	aiPPT: 18
};
/** The `ext.input_skill` JSON string for a skill; undefined means plain chat. */
function inputSkillOf(skill) {
	if (skill === void 0 || skill === "freeChat") return void 0;
	const type = DOUBAO_SKILLS[skill];
	return JSON.stringify({
		skill_id: String(type),
		skill_type: type,
		variables: {}
	});
}
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
const CREATION_BLOCK_TYPE = 2074;
/**
* DSH-side alias for "generate an image".
*
* NOT a Doubao `model_item_key` — Doubao has no model by this name. Selecting it
* makes the shim send an ordinary chat turn with `input_skill: imageGen`, and
* Doubao answers with Seedream. Keeping it in the catalog is what puts 生图 in
* DSH's model picker without inventing a second UI.
*/
const DOUBAO_IMAGE_MODEL_ID = "image-gen";
/**
* IMAGEGEN_LABEL_OVERLAY: 生图版本名以插件根目录的 image-models.json 为准，
* 该文件由 doubao_imagemodels.py --sync 从服务端 get_item_conf 生成。
*/
function imageModelLabelFromOverlay() {
	try {
		const url = new URL("../image-models.json", import.meta.url);
		const parsed = JSON.parse(readFileSync(url, "utf8"));
		return typeof parsed.label === "string" && parsed.label !== "" ? parsed.label : void 0;
	} catch {
		return;
	}
}
const DOUBAO_IMAGE_MODEL_NAME = imageModelLabelFromOverlay() ?? "豆包 生图（Seedream 5.5）";
/** The chat model a skill turn rides on: the app's own default. */
const SKILL_CARRIER_MODEL_ID = "0";
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
const DOUBAO_MODELS = [
	{
		id: "0",
		name: "豆包 快速",
		reasoning: false
	},
	{
		id: "3",
		name: "豆包 2.1 Turbo",
		badge: "专家",
		reasoning: true
	},
	{
		id: "seed-lite-7b",
		name: "豆包 2.1 Lite",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: "5",
		name: "豆包 2.1 Pro",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: "9",
		name: "自动",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: DOUBAO_IMAGE_MODEL_ID,
		name: DOUBAO_IMAGE_MODEL_NAME,
		reasoning: true
	}
];
/** True when `id` is a 「工作任务」-mode model (`seed-lite-7b`, `5`, `9`). */
function isTaskModel(id) {
	if (id === void 0) return false;
	return DOUBAO_MODELS.some((model) => model.id === id && model.taskMode === true);
}
/**
* Entries that exist in the desktop app but are deliberately NOT offered here.
*
* Kept as data rather than a comment so the README and any future UI can state
* the reason from one place — and so re-adding one is a deliberate act that has
* to confront this note.
*/
const DOUBAO_UNAVAILABLE_MODELS = [{
	id: "4",
	name: "豆包 2.1 Turbo（即将下线）",
	reason: "客户端已用「即将下线」标注，不引导用户选择"
}];
/**
* The model used when a request names none.
*
* 「豆包 快速」 is the app's own chat-mode default — `menuConfV2`'s
* `default_select_mode_map.chat` points at it — so leaving it unnamed here
* reproduces what the desktop app would have done. Spelled out rather than
* taken from `DOUBAO_MODELS[0]`, so reordering the list cannot silently change
* which model an unconfigured session gets.
*/
const DOUBAO_DEFAULT_MODEL_ID = "0";
/**
* Catalog entry for a model id, falling back to {@link DOUBAO_DEFAULT_MODEL_ID}.
*
* An id the catalog does not know resolves to the default rather than throwing:
* a stale id in a saved session should degrade to a working model, not break
* the request. `describeRequestedModel` in the shim is what surfaces the miss.
*/
function findDoubaoModel(id) {
	if (id === void 0) return DOUBAO_MODELS.find((model) => model.id === "0");
	const known = DOUBAO_MODELS.find((model) => model.id === id);
	if (known !== void 0) return known;
	return {
		id,
		name: id,
		reasoning: true
	};
}
/** True when the key is a catalog entry this release knows by name. */
function isKnownModelId(id) {
	return id !== void 0 && DOUBAO_MODELS.some((model) => model.id === id);
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
const NO_THINKING_MODEL_IDS = /* @__PURE__ */ new Set(["0"]);
/** Whether a model can think, by measurement rather than by menu declaration. */
function supportsReasoning(id) {
	return !NO_THINKING_MODEL_IDS.has(id);
}
/**
* Publish the catalog as pi-ai model descriptors.
*
* `models` defaults to the static list but is normally the DISCOVERED one — the
* caller passes whatever the client cache currently reports, so a model Doubao
* ships appears without a plugin release.
*/
function discoverDoubaoModels(models = DOUBAO_MODELS) {
	return models.map((model) => ({
		id: model.id,
		name: model.badge === void 0 ? model.name : `${model.name} · ${model.badge}`,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		inputModalities: ["text"],
		reasoning: model.reasoning
	}));
}
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
function enabledModelsOf(enabledIds, models = DOUBAO_MODELS) {
	if (enabledIds === void 0 || enabledIds.length === 0) return [...models];
	const wanted = new Set(enabledIds);
	const known = new Set(DOUBAO_MODELS.map((model) => model.id));
	return models.filter((model) => wanted.has(model.id) || !known.has(model.id));
}
function doubaoCatalogEntries(models = DOUBAO_MODELS) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		badge: model.badge ?? null,
		rate: model.rate ?? null,
		reasoningLevels: model.reasoning ? model.reasoningOptions !== void 0 && model.reasoningOptions.length > 0 ? model.reasoningOptions.map((option) => ({
			id: levelIdOf(option.level),
			name: option.name,
			level: option.level,
			verified: reasoningLevelOf(option.level)?.verified ?? false
		})) : DOUBAO_REASONING_LEVELS.filter((level) => level.verified).map((level) => ({
			id: level.id,
			name: level.name,
			level: level.level,
			verified: level.verified
		})) : []
	}));
}
//#endregion
//#region src/doubao-profile.ts
/**
* Where the Doubao app keeps its Chromium profile.
*
* The app installs wherever the user wants (`E:\Doubao` is normal), but its
* profile normally lands under `%LOCALAPPDATA%\Doubao\User Data`. Plenty of
* people move it — the installer offers a "data directory" choice, and some
* move it after the fact to keep C: small. A hardcoded `AppData` path then
* fails with "profile not found" on an otherwise perfectly working install.
*
* Strategies, most explicit first:
*
*   0. the directory the user picked in the settings card — stored in this
*      plugin's own settings file and applied through {@link setProfileOverride}
*   1. `DSH_DOUBAO_PROFILE`  — escape hatch, for scripted setups.
*   2. AppData candidates    — the default layout, and free (four `existsSync`)
*   3. process command line  — `Doubao.exe --user-data-dir=…`, authoritative
*                              but costs a `powershell.exe` (≈0.8 s), so it is
*                              only consulted once the cheap paths miss
*   4. bounded scan          — depth-4 walk of every fixed drive for a
*                              `User Data\Default\Network\Cookies`, time-boxed
*
* Order is cheapest-first rather than strongest-first on purpose: the common
* case must not pay 0.8 s on every cold start.
*
* The result is a LIST, not a single path, because a stale leftover profile can
* shadow the live one — someone who copied rather than moved leaves an empty
* jar in AppData. `loadDoubaoCredentials` walks the list and keeps the first
* profile that actually decrypts into a usable session.
*
* @module dsh-connect-doubao/profile
*/
/** Env var a user can set to point at their profile (the folder holding `Default`). */
const PROFILE_ENV = "DSH_DOUBAO_PROFILE";
/**
* The directory the user picked in the settings card, if any.
*
* Module-level because the card's choice has to reach every caller of
* `loadDoubaoCredentials` (quota, shim, upstream) without threading a parameter
* through four layers. `apply` seeds it once at startup from the settings file
* and re-seeds it whenever the card saves a new path.
*/
let manualOverride;
/**
* Point the resolver at a user-chosen directory.
*
* Call with `undefined` to go back to automatic detection. Invalid paths are
* ignored here rather than stored, so a folder that was later deleted or
* renamed falls back to detection instead of breaking sign-in outright.
*/
function setProfileOverride(raw) {
	if (raw === void 0) {
		manualOverride = void 0;
		return;
	}
	manualOverride = resolveUserProvided(raw);
}
/** A directory is a profile only if the cookie jar is really there. */
function looksLikeProfile(dir) {
	return existsSync(join(dir, "Default", "Network", "Cookies"));
}
/**
* Resolve one user-supplied path.
*
* Accepts either the `User Data` directory itself or its parent (`E:\Doubao`),
* because both are reasonable readings of "where my data is".
*/
function resolveUserProvided(raw) {
	const trimmed = raw.trim().replace(/^"|"$/g, "");
	if (trimmed === "") return void 0;
	if (looksLikeProfile(trimmed)) return trimmed;
	const nested = join(trimmed, "User Data");
	if (looksLikeProfile(nested)) return nested;
}
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
function extractUserDataDir(commandLine) {
	const at = commandLine.indexOf("--user-data-dir=");
	if (at < 0) return void 0;
	const start = at + 16;
	let value;
	if (commandLine[start] === "\"") {
		const end = commandLine.indexOf("\"", start + 1);
		if (end < 0) return void 0;
		value = commandLine.slice(start + 1, end);
	} else if (commandLine[at - 1] === "\"") {
		const end = commandLine.indexOf("\"", start);
		if (end < 0) return void 0;
		value = commandLine.slice(start, end);
	} else {
		const end = commandLine.indexOf(" ", start);
		value = end < 0 ? commandLine.slice(start) : commandLine.slice(start, end);
	}
	const cleaned = value.trim();
	return cleaned === "" ? void 0 : cleaned;
}
/**
* Read the live client's `--user-data-dir`, if the client is running.
*
* `Get-CimInstance` rather than `Get-Process`: the latter only exposes
* `CommandLine` on PowerShell 7, and Windows still ships 5.1.
*/
function probeProcessCommandLines() {
	const script = "Get-CimInstance Win32_Process -Filter \"Name='Doubao.exe'\" | ForEach-Object { $_.CommandLine }";
	try {
		const result = spawnSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			encoding: "utf8",
			timeout: 8e3,
			windowsHide: true
		});
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}
/** Default AppData candidates: the documented layout, plus every user profile. */
function defaultAppDataBases(env) {
	const candidates = [env.LOCALAPPDATA, env.APPDATA].filter((entry) => typeof entry === "string" && entry !== "").map((base) => join(base, "Doubao", "User Data"));
	const usersRoot = "C:\\Users";
	if (existsSync(usersRoot)) try {
		for (const user of readdirSync(usersRoot)) candidates.push(join(usersRoot, user, "AppData", "Local", "Doubao", "User Data"));
	} catch {}
	return candidates;
}
/** Directories that never contain a Doubao profile and are expensive to walk. */
const SCAN_SKIP = /* @__PURE__ */ new Set([
	"windows",
	"windows.old",
	"$recycle.bin",
	"system volume information",
	"node_modules",
	".git",
	"programdata",
	"recovery",
	"perflogs",
	"msocache"
]);
/** Every existing fixed-drive root, `C:\` style. */
function defaultScanRoots() {
	const roots = [];
	for (let code = 65; code <= 90; code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (existsSync(root)) roots.push(root);
	}
	return roots;
}
/**
* Bounded breadth-first search for a `User Data\Default\Network\Cookies`.
*
* Depth 4 covers `D:\Doubao\User Data` (2) and `D:\Apps\Doubao\User Data` (3)
* with slack, and a directory-name check keeps it from examining every file.
* The clock check runs per directory so a sprawling D: cannot stall startup.
*/
function scanForProfiles(roots, budgetMs, now) {
	const deadline = now() + budgetMs;
	const found = [];
	const seen = /* @__PURE__ */ new Set();
	const queue = roots.map((root) => ({
		dir: root,
		depth: 0
	}));
	while (queue.length > 0) {
		if (now() > deadline) break;
		const item = queue.shift();
		if (item === void 0) break;
		let entries;
		try {
			entries = readdirSync(item.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = entry.name.toLowerCase();
			if (SCAN_SKIP.has(name)) continue;
			const child = join(item.dir, entry.name);
			const key = child.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			if (looksLikeProfile(child)) {
				found.push({
					dir: child,
					source: "scan"
				});
				continue;
			}
			if (item.depth + 1 < 4) queue.push({
				dir: child,
				depth: item.depth + 1
			});
		}
	}
	return found;
}
/**
* Every plausible profile, best first.
*
* Deduplicated case-insensitively (Windows paths are case-insensitive, and the
* process probe and scan can easily report the same directory). A later source
* never overrides an earlier one, so `env` always wins.
*/
function listDoubaoProfiles(deps = {}) {
	if ((deps.platform ?? process.platform) !== "win32") return [];
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (dir, source) => {
		if (dir === void 0) return;
		const key = dir.toLowerCase().replace(/[\\/]+$/, "");
		if (seen.has(key)) return;
		seen.add(key);
		out.push({
			dir,
			source
		});
	};
	const manual = deps.manual ?? manualOverride;
	if (manual !== void 0) push(resolveUserProvided(manual), "manual");
	const override = env[PROFILE_ENV];
	if (typeof override === "string") push(resolveUserProvided(override), "env");
	for (const base of deps.appDataBases ?? defaultAppDataBases(env)) if (looksLikeProfile(base)) push(base, "appdata");
	const lines = deps.processCommandLines ? deps.processCommandLines() : probeProcessCommandLines();
	for (const line of lines) {
		const dir = extractUserDataDir(line);
		if (dir !== void 0 && looksLikeProfile(dir)) push(dir, "process");
	}
	if (out.length === 0) {
		const roots = deps.scanRoots ?? defaultScanRoots();
		for (const hit of scanForProfiles(roots, deps.scanBudgetMs ?? 1500, now)) push(hit.dir, hit.source);
	}
	return out;
}
/** Best guess for the profile directory, or `undefined`. */
function findDoubaoUserDataDir(deps = {}) {
	return listDoubaoProfiles(deps)[0]?.dir;
}
/** Where the profile was found and how — what `doctor` prints. */
function describeProfileLocation(deps = {}) {
	const profile = listDoubaoProfiles(deps)[0];
	return profile === void 0 ? "<not found>" : `${profile.dir} (via ${profile.source})`;
}
//#endregion
//#region src/doubao-auth.ts
/**
* Doubao credentials — the sealed browser session and its platform sealing helpers.
*
* WHY THERE IS ONLY ONE SOURCE
*
* This module used to decrypt the desktop client's cookie jar: read the DPAPI
* master key out of `<User Data>\Local State`, open
* `<User Data>\Default\Network\Cookies` as SQLite, AES-GCM each `v10` value and
* strip Chrome's host-binding prefix. It was removed, not merely deprecated,
* because of a defect that no amount of care could fix from outside the app:
*
*   the client holds `Default\Network\Cookies` with an EXCLUSIVE lock while it
*   runs, and this plugin exists precisely for an account whose app IS running.
*   So the live read failed in the normal case, the code fell back to a 12-hour
*   sealed copy, and once the server rotated the session every request was
*   rejected upstream — with a local state that still looked "signed in", and
*   therefore no local explanation for the user.
*
* The browser sign-in in `./doubao-auth-browser.ts` has neither of those
* failure modes: it captures the cookies over CDP from a throwaway Chromium
* profile, so there is no lock to lose, and what this module seals is exactly
* what was just captured, so there is no stale copy to prefer. One source also
* means one account: no fallback can silently serve whoever else happened to be
* signed in somewhere on this machine.
*
* SECURITY: cookie values live in this process's memory and in one file that is
* sealed before it touches disk — Windows DPAPI (current-user scope) on win32,
* AES-256-GCM with a local 0600 key file elsewhere. Nothing here is logged, and
* nothing leaves except the outbound request's `Cookie:` header.
*
* @module dsh-connect-doubao/auth
*/
/**
* How long a loaded session stays in the process cache.
*
* Not a security boundary: unsealing costs a child process on Windows (DPAPI), and
* every upstream call wants the header, so the cache is what keeps a chat turn
* from spawning one process per request. Doubao rotates its own cookies
* server-side; the first rejected request is the accurate expiry signal.
*/
const CREDENTIAL_TTL_MS = 6e5;
/**
* Cookie names Doubao's chat backend actually needs for authentication.
* Verified in M1/M2: this exact set authenticated while the app was closed.
*/
const REQUIRED_COOKIE_NAMES = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"sid_guard",
	"uid_tt",
	"ttwid",
	"odin_tt",
	"passport_csrf_token",
	"s_v_web_id"
];
/**
* Absolute path to Windows PowerShell, or the bare name as a last resort.
*
* Resolving through PATH means a planted `powershell.exe` earlier in the search
* order receives this call's input on stdin — which is a session cookie or the
* DPAPI master key. The system copy lives at a fixed location, so ask for it.
*/
function powershellPath() {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const direct = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(direct) ? direct : "powershell.exe";
}
/**
* The environment handed to the DPAPI helper.
*
* An explicit allow-list rather than a spread of the host environment: that
* environment carries every API key this DSH install has, and none of them has
* any business in a process whose only job is one crypt32 call.
*/
function dpapiChildEnv() {
	const env = {};
	for (const name of [
		"SystemRoot",
		"windir",
		"SystemDrive",
		"ComSpec",
		"PATH",
		"PATHEXT",
		"TEMP",
		"TMP",
		"USERPROFILE"
	]) {
		const value = process.env[name];
		if (value !== void 0) env[name] = value;
	}
	if (env.SystemRoot === void 0 && env.windir !== void 0) env.SystemRoot = env.windir;
	return env;
}
/**
* Call CryptProtectData / CryptUnprotectData via a short-lived PowerShell child.
*
* Node has no built-in DPAPI binding and the plugin must not pull in a native
* addon, so we shell out to the Windows Data Protection API. The payload travels
* over stdin and stdout and never touches disk.
*/
function dpapiCall(mode, blob) {
	const script = [
		"param([string]$Mode = \"unprotect\")",
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = \"SilentlyContinue\"",
		"$cs = 'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptProtectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }'",
		"Add-Type -TypeDefinition $cs",
		"$in = [Console]::In.ReadToEnd()",
		"$bytes = [System.Convert]::FromBase64String($in.Trim())",
		"$len = [int]$bytes.Length",
		"$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)",
		"[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)",
		"$inBlob = New-Object DshDataBlob",
		"$inBlob.cbData = $len",
		"$inBlob.pbData = $mem",
		"$outBlob = New-Object DshDataBlob",
		"if ($Mode -eq 'protect') {",
		"  $ok = [DshCrypt]::CryptProtectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"} else {",
		"  $ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"}",
		"if (-not $ok) { [Console]::Out.Write('DPAPI_CALL_FAILED'); exit 3 }",
		"$res = New-Object byte[] $outBlob.cbData",
		"[Runtime.InteropServices.Marshal]::Copy($outBlob.pbData, $res, 0, $outBlob.cbData)",
		"[Console]::Out.Write([System.Convert]::ToBase64String($res))",
		""
	].join("\r\n");
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-dpapi-"));
	const scriptPath = join(scratch, "unprotect.ps1");
	try {
		writeFileSync(scriptPath, script, "utf8");
		const result = spawnSync(powershellPath(), [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			mode
		], {
			encoding: "utf8",
			maxBuffer: 1 << 24,
			windowsHide: true,
			input: blob.toString("base64"),
			env: dpapiChildEnv()
		});
		const stdout = result.stdout ?? "";
		if (stdout.trim() === "") {
			const stderr = result.stderr ?? "";
			throw new Error(`Windows DPAPI helper produced no output (status=${result.status}, stdout=${JSON.stringify(stdout.slice(0, 120))}, stderr=${JSON.stringify(stderr.slice(-400))})`);
		}
		for (const line of stdout.split(/\r?\n/).reverse()) {
			const candidate = line.trim();
			if (!candidate || candidate.startsWith("#") || candidate.startsWith("<")) continue;
			if (candidate === "DPAPI_CALL_FAILED") throw new Error("Windows DPAPI rejected the blob (CryptUnprotectData returned false)");
			const decoded = Buffer.from(candidate, "base64");
			if (decoded.length > 0) return decoded;
		}
		throw new Error("DPAPI helper returned no usable output");
	} finally {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
/**
* Sealing backend for non-Windows platforms.
*
* Windows uses DPAPI (current-user scope, implemented above). Node has no
* DPAPI binding on macOS / Linux, so those platforms use AES-256-GCM with a
* 32-byte key kept in a 0600 file under ~/.dsh. That is the same trust
* boundary: another local account (or another machine) cannot open the
* session, and the key never leaves this user's home directory.
*
* The sealed blob carries a short version magic so a stale DPAPI blob — or a
* future format change — is rejected as an unknown-format blob instead of
* being misread. loadBrowserCredentials() already turns any decrypt failure
* into not-signed-in, which is exactly the right recovery (a fresh QR scan).
*/
const SEAL_KEY_FILENAME = "doubao-credentials.key";
const SEAL_MAGIC = Buffer.from("DSHD1:", "latin1");
const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;
function sealKeyPath() {
	return join(homedir(), ".dsh", SEAL_KEY_FILENAME);
}
/** Read the local key, creating it (0600) on first use. */
function sealKey() {
	try {
		const existing = readFileSync(sealKeyPath());
		if (existing.length === 32) return existing;
	} catch {}
	const key = randomBytes(32);
	mkdirSync(dirname(sealKeyPath()), { recursive: true });
	writeFileSync(sealKeyPath(), key, { mode: 384 });
	return key;
}
/** Seal a plaintext blob for this machine (DPAPI on win32, AES-GCM elsewhere). */
function sealBlob(plaintext) {
	if (process.platform === "win32") return dpapiCall("protect", plaintext);
	const iv = randomBytes(SEAL_IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([
		SEAL_MAGIC,
		iv,
		cipher.getAuthTag(),
		body
	]);
}
/** Reverse sealBlob; throws on an unknown format or a failed auth tag. */
function unsealBlob(sealed) {
	if (process.platform === "win32") return dpapiCall("unprotect", sealed);
	const header = SEAL_MAGIC.length + SEAL_IV_BYTES + SEAL_TAG_BYTES;
	if (sealed.length < header || !sealed.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) throw new Error("unknown sealed-session format");
	let off = SEAL_MAGIC.length;
	const iv = sealed.subarray(off, off + SEAL_IV_BYTES);
	off += SEAL_IV_BYTES;
	const tag = sealed.subarray(off, off + SEAL_TAG_BYTES);
	off += SEAL_TAG_BYTES;
	const decipher = createDecipheriv("aes-256-gcm", sealKey(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(sealed.subarray(off)), decipher.final()]);
}
/**
* Where the one usable session lives.
*
* The file name keeps the `-browser` suffix it was introduced with so an
* existing sealed session survives the upgrade that removed the client path.
*
* There is no TTL here, on purpose: the session lives ~30 days server-side and
* the FIRST rejected request is the accurate expiry signal. A clock on top of
* that could only invent failures for a session that still works.
*/
const BROWSER_CACHE_FILENAME = "doubao-credentials-browser.dpapi";
function browserCachePath() {
	return join(homedir(), ".dsh", BROWSER_CACHE_FILENAME);
}
/** Seal browser-harvested cookies to disk. Throws if sealing fails. */
function saveBrowserCredentials(pairs) {
	const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	const payload = JSON.stringify({
		savedAt: Date.now(),
		source: "browser",
		header,
		pairs: [...pairs.entries()]
	});
	const sealed = sealBlob(Buffer.from(payload, "utf8"));
	mkdirSync(dirname(browserCachePath()), { recursive: true });
	writeFileSync(browserCachePath(), sealed, { mode: 384 });
}
/** Read the sealed browser session, or `undefined` when absent/unusable. */
function loadBrowserCredentials() {
	try {
		const json = unsealBlob(readFileSync(browserCachePath())).toString("utf8");
		const parsed = JSON.parse(json);
		if (typeof parsed.header !== "string" || !Array.isArray(parsed.pairs)) return void 0;
		const pairs = /* @__PURE__ */ new Map();
		for (const entry of parsed.pairs) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [name, value] = entry;
			if (typeof name === "string" && typeof value === "string" && name !== "") pairs.set(name, value);
		}
		if (REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name)).length > 0) return void 0;
		return {
			ok: true,
			header: parsed.header,
			pairs
		};
	} catch {
		return;
	}
}
/** True when a sealed browser session exists on disk. */
function hasBrowserCredentials() {
	return loadBrowserCredentials() !== void 0;
}
/** Drop the sealed session (a re-login always overwrites it). */
function clearBrowserCredentials() {
	try {
		unlinkSync(browserCachePath());
	} catch {}
}
let cached$1;
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
function loadDoubaoCredentials(options = {}) {
	const now = Date.now();
	if (!options.force && cached$1 !== void 0 && now - cached$1.at < 6e5) return cached$1.credentials;
	const credentials = loadBrowserCredentials() ?? {
		ok: false,
		reason: "还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。",
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	cached$1 = {
		at: now,
		credentials
	};
	return credentials;
}
/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
function invalidateCredentialCache() {
	cached$1 = void 0;
}
/**
* Revoke the sealed session on disk as well.
*
* Called when the server refuses the session. Replacing it needs a fresh QR
* scan, so keeping the file would only make every later request fail the same
* way while the card still showed a signed-in account — the user's fix
* (「重新登录」) would then look like it had no effect. Deleting it makes the
* next request say "log in", which is the truth.
*/
function clearCredentialCache() {
	cached$1 = void 0;
	clearBrowserCredentials();
}
//#endregion
//#region src/doubao-upstream.ts
/**
* Doubao upstream client.
*
* Endpoint: POST https://www.doubao.com/chat/completion
*
* Three request details decide whether the call succeeds or is challenged with
* a slider CAPTCHA (verified in M2 — getting any of them wrong silently turns a
* working session into `710022004 rate limited`):
*
*   1. User-Agent must carry the `SamanthaDoubao/<version>` suffix.
*   2. Referer must be the `chrome://doubao-chat/` scheme, NOT an https URL.
*   3. sec-ch-ua must use the real client-hints brand string.
*
* No `a_bogus` signature is required; the server accepts a cookie-authenticated
* request without it.
*
* The response is a ByteDance-specific streaming variant, NOT standard SSE.
* Frames are three lines — `id:`, `event:`, `data:` — followed by a blank
* line, so a generic `data:`-only SSE parser silently drops everything.
*/
const CHAT_ENDPOINT = "https://www.doubao.com/chat/completion";
const QUOTA_ENDPOINT = "https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/";
const ACCOUNT_ENDPOINT = "https://www.doubao.com/passport/account/info/v2/";
const TOOL_LOCAL_ACK_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/ack";
const TOOL_LOCAL_UPLOAD_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/upload_command_result";
const TOOL_LOCAL_COMPLETE_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/complete";
const ACTION_BAR_BRIEF_LIST_ENDPOINT = "https://www.doubao.com/alice/slot/action_bar_v3/brief_list";
const BREAK_STREAM_ENDPOINT = "https://www.doubao.com/im/message/break_stream_msg";
/** Own timeout for the fire-and-forget stop; never inherits the turn's signal. */
const STOP_GENERATION_TIMEOUT_MS = 5e3;
/**
* Client version strings. These are the desktop app build this was last
* verified against (M9), and they MOVE with every Doubao release — a newer app
* sends different values here and a very old one will eventually stop being
* accepted. Re-check them whenever Doubao auto-updates; the risk-control layer
* compares them against the session it sees.
*/
const DOUBAO_VERSION = "2.31.4";
const RUNTIME_VERSION = "3.39.0";
/**
* Frozen, non-secret client identity.
*
* These are constant across Doubao sessions and are NOT credentials. Keeping
* them fixed is what makes an external request look like the same install to
* the risk-control layer.
*/
const CLIENT_PARAMS = {
	aid: "582478",
	real_aid: "582478",
	version_code: "20800",
	pc_version: DOUBAO_VERSION,
	device_id: "2697515174213273",
	tea_uuid: "2697515174213273",
	web_id: "7677868049198630415",
	fp: "verify_2697515174213273",
	chromium_version: "147.0.7727.149",
	runtime_version: RUNTIME_VERSION,
	channel: "win",
	language: "zh",
	region: "CN",
	sys_region: "CN",
	tz_name: "Asia/Shanghai",
	pkg_type: "release_version",
	client_platform: "pc_client",
	device_platform: "web",
	doubao_device_platform: "desktop",
	web_platform: "desktop",
	samantha_web: "1",
	"use-olympus-account": "1"
};
/** The default Doubao assistant; content routing means the model is chosen server-side. */
const DEFAULT_BOT_ID = "7338286299411103781";
/** Headers that make an external request indistinguishable from the app's. */
function buildHeaders(credentials, extra = {}) {
	return {
		"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${DOUBAO_VERSION}`,
		Referer: "chrome://doubao-chat/",
		accept: "*/*",
		"accept-language": "zh-CN,zh;q=0.9",
		"sec-ch-ua": "\"Chromium\";v=\"147\", \"Not.A/Brand\";v=\"8\"",
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": "\"Windows\"",
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		"agw-js-conv": "str",
		"x-flow-trace": `${randomUUID().replace(/-/g, "")}-${randomUUID().replace(/-/g, "")}-01`,
		"last-event-id": "undefined",
		cookie: applyRenewals(credentials.header),
		...extra
	};
}
function buildQueryUrl(endpoint, msToken) {
	const params = new URLSearchParams({
		...CLIENT_PARAMS,
		web_tab_id: randomUUID()
	});
	if (msToken) params.set("msToken", msToken);
	return `${endpoint}?${params.toString()}`;
}
var DoubaoUpstreamError = class extends Error {
	code;
	rateLimited;
	httpStatus;
	transport;
	truncated;
	kindHint;
	constructor(message, code, rateLimited = false, meta = {}) {
		super(message);
		this.code = code;
		this.rateLimited = rateLimited;
		this.name = "DoubaoUpstreamError";
		this.httpStatus = meta.httpStatus;
		this.transport = meta.transport === true;
		this.truncated = meta.truncated === true;
		this.kindHint = meta.kind;
	}
};
/**
* Stable-per-process id that rides along as `client_env_id`.
*
* The client generates one per app environment; ours is per host process so a
* restart looks like a new environment, which is exactly what it is.
*/
const CLIENT_ENV_ID = randomUUID();
/** Whether a request asks for local-PC task mode. Default: OFF — see below. */
function taskModeEnabled(options) {
	if (options.taskMode !== void 0) return options.taskMode;
	if (isTaskModel(options.modelKey)) return true;
	const flag = process.env.DSH_DOUBAO_TASK;
	return flag === void 0 ? false : /^(1|true|on|yes)$/i.test(flag.trim());
}
/** The directory this machine declares to the task runtime. */
function taskWorkspaceOf(options) {
	return options.workspace ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd();
}
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
function buildGeneralTaskParam(localMessageId, workspace, prompt) {
	const userData = findDoubaoUserDataDir();
	const agentWorkspace = userData === void 0 ? join(tmpdir(), "dsh-doubao-agent-workspace") : join(userData, "Default", ".doubao", "agent_mode", "workspace");
	return {
		thread_local_message_id: [localMessageId],
		client_option: {
			shared_folder_path: [workspace, agentWorkspace],
			enable_sandbox: true,
			os: process.platform === "win32" ? "Windows" : process.platform,
			client_env_id: CLIENT_ENV_ID,
			sandbox_id: `route-${randomUUID()}`,
			workspace,
			agent_workspace: {
				agent_workspace: agentWorkspace,
				local_skill_paths: [join(homedir(), "Doubao", "skills"), join(homedir(), ".agents", "skills")]
			},
			sandbox_auth_type: 2
		},
		runtime_type: 2,
		need_modify_conversation: false,
		agent_task_param: {
			runtime_type: 2,
			device_name: hostname(),
			workspace,
			local_device_id: CLIENT_PARAMS.device_id,
			local_app_id: CLIENT_PARAMS.aid,
			sandbox_auth_type: 2
		},
		agent_task_param_change: {
			runtime_changed: false,
			device_changed: false,
			sandbox_auth_type_changed: false
		},
		...prompt !== void 0 ? { task_input_json: JSON.stringify({
			text: prompt,
			files: [],
			skills: []
		}) } : {}
	};
}
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
function withImagePrefix(prompt, options = {}) {
	if (!(options.skill === "imageGen" || options.modelKey === "image-gen")) return prompt;
	if (/^\s*(生成图片|生成一张|画一张|画个|绘制)/.test(prompt)) return prompt;
	return `生成图片：${prompt}`;
}
function buildChatBody(prompt, options = {}) {
	prompt = withImagePrefix(prompt, options);
	const model = findDoubaoModel(options.modelKey);
	const level = findReasoningLevel(options.reasoningLevel);
	const task = taskModeEnabled(options);
	const taskModelSelected = isTaskModel(model.id) || options.taskMode === true;
	/**
	* Deep-thinking toggle, for probing only.
	*
	* The captured ordinary turn sends `need_deep_think: 0`; the client's 深度思考
	* switch is what turns this on, and the value it sends there has NOT been
	* captured yet. `DSH_DOUBAO_DEEP_THINK=1` reproduces the old 10000+level shape
	* so the resulting stream can be inspected.
	*
	* In 「工作任务」 mode (`seed-lite-7b`, `5`, `9`), captured requests send `10001`.
	*/
	const deepThink = options.deepThink === true || options.deepThink === void 0 && process.env.DSH_DOUBAO_DEEP_THINK === "1";
	const needDeepThink = taskModelSelected && options.deepThink === void 0 ? 10001 : needDeepThinkValue(deepThink);
	/**
	* 2 = 普通对话, 1 = 「工作任务」.
	*
	* CDP-captured from the running client on 2026-10-22. This constant was the
	* bug: the plugin sent 1 for chat, so the server answered every turn as a work
	* task — `Agent-GeneralTask`, then `710010702` because the task runtime used
	* to be the desktop app's own CUA process. Task turns now complete through the
	* `tool_local` responder, which is why `TASK_AGENT_MODE` is safe to send.
	*/
	const agentMode = options.agentMode ?? (task ? 1 : 2);
	const localMessageId = randomUUID();
	/**
	* Mode id the model picker groups by. The captured chat request carries "1" in
	* BOTH `conversation_init_ext` and `aggregate_params`, whereas 「工作任务」
	* models (`seed-lite-7b`, `5`, `9`) carry "3".
	*/
	const modeId = (process.env.DSH_DOUBAO_MODE_ID ?? "").trim() || (task ? "3" : "1");
	const taskParam = task ? buildGeneralTaskParam(localMessageId, taskWorkspaceOf(options), taskModelSelected ? prompt : void 0) : { server_do_compare: true };
	const modelExtraParams = taskModelSelected ? {
		input_token_limit: "256k",
		...model.id === "seed-lite-7b" ? { reasoning_effort: levelIdOf(level.level) } : {}
	} : {};
	return {
		messages: [{
			local_message_id: localMessageId,
			message_status: 0,
			content_block: [{
				block_type: 1e4,
				block_id: randomUUID(),
				parent_id: "",
				meta_info: [],
				append_fields: [],
				content: {
					text_block: {
						text: prompt,
						icon_url: "",
						icon_url_dark: "",
						summary: ""
					},
					pc_event_block: ""
				}
			}]
		}],
		option: {
			send_message_scene: "",
			create_time_ms: Date.now(),
			collect_id: "",
			is_audio: false,
			answer_with_suggest: false,
			agent_mode: agentMode,
			tts_switch: false,
			need_deep_think: needDeepThink,
			click_clear_context: false,
			from_suggest: false,
			is_regen: false,
			is_replace: false,
			is_from_click_option: false,
			is_from_click_softlink: false,
			disable_sse_cache: false,
			select_text_action: "",
			is_select_text: false,
			resend_for_regen: false,
			scene_type: 0,
			unique_key: randomUUID(),
			start_seq: 0,
			need_create_conversation: options.continueConversation !== true,
			conversation_init_option: { need_ack_conversation: true },
			...taskModelSelected && options.continueConversation !== true ? { conversation_mode: 2 } : {},
			conversation_init_ext: {
				model_item_key: model.id,
				reasoning_effort: String(level.level),
				mode_id: modeId
			},
			regen_query_id: [],
			edit_query_id: [],
			regen_instruction: "",
			no_replace_for_regen: false,
			message_from: 0,
			shared_app_name: "",
			shared_app_id: "",
			sse_recv_event_options: { support_chunk_delta: true },
			support_lazy_fetch_stream: true,
			is_ai_playground: false,
			is_old_user: true,
			general_task_param: taskParam,
			recovery_option: {
				is_recovery: false,
				req_create_time_sec: Math.floor(Date.now() / 1e3),
				append_sse_event_scene: 0
			},
			message_storage_type: 0,
			related_deleted_message_ids: {},
			connector_info_list: [],
			model_config: {
				model_item_key: model.id,
				model_extra_params: modelExtraParams,
				reasoning_effort: level.level
			},
			aggregate_params: {
				mention_skill_list: "[]",
				mention_plugin_list: "[]",
				mention_ext: "[{}]",
				conversation_mode: taskModelSelected && options.continueConversation !== true ? "2" : deepThink ? "1" : "",
				mode_id: modeId,
				model_item_key: model.id,
				agent_mode: String(agentMode),
				reasoning_effort: String(level.level),
				provider_id: ""
			}
		},
		client_meta: {
			local_conversation_id: `local_${randomUUID()}`,
			conversation_id: options.conversationId ?? "",
			bot_id: DEFAULT_BOT_ID,
			last_section_id: "",
			last_message_index: null,
			local_permissions: [
				{
					permission_name: "ACCESS_COARSE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_FINE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_BACKGROUND_LOCATION",
					status: 1
				}
			]
		},
		user_context: [],
		ext: {
			agent_mode: String(agentMode),
			use_deep_think: String(needDeepThink),
			sub_conv_firstmet_type: "1",
			general_task_param: JSON.stringify(taskParam),
			collection_id: "",
			is_finish: "1",
			conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
			commerce_credit_config_enable: "0",
			...(() => {
				const encoded = inputSkillOf(options.skill);
				return encoded === void 0 ? {} : { input_skill: encoded };
			})()
		}
	};
}
/**
* Parse ByteDance's three-line streaming frames out of a decoded text buffer.
*
* A frame is `id:` then `event:` then `data:` then a blank line. Standard SSE
* also permits comment lines (`:`), so those are skipped. Returns the frames
* plus whatever tail did not yet form a complete frame.
*/
function parseFrames(buffer) {
	const frames = [];
	let rest = buffer;
	while (true) {
		const boundary = rest.search(/\r?\n\r?\n/);
		if (boundary < 0) break;
		const block = rest.slice(0, boundary);
		rest = rest.slice(boundary).replace(/^\r?\n\r?\n/, "");
		const frame = { data: "" };
		const dataLines = [];
		for (const line of block.split(/\r?\n/)) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "id") frame.id = value;
			else if (field === "event") frame.event = value;
			else if (field === "data") dataLines.push(value);
		}
		if (dataLines.length > 0 || frame.event) {
			frame.data = dataLines.join("\n");
			frames.push(frame);
		}
	}
	return {
		frames,
		rest
	};
}
/**
* Collect answer text and thinking text, separated by block ownership.
*
* A deep-think reply carries a `block_type: 10040` container (the visible
* 「正在思考 / 已完成思考」 shell) and then streams the reasoning as ordinary
* `block_type: 10000` blocks whose `parent_id` is that container's id. The shell
* and its children both point at `Deep_Think.png`, but `parent_id` is the
* reliable discriminator, so it is what this uses.
*
* Treating every `text` as answer text — what the previous revision did — mixes
* the model's private reasoning into the reply the user sees.
*/
const PLACEHOLDER_THINKING_TITLE_RE = /^(?:正在思考(?:中)?|思考中|已(?:完成)?(?:深度)?思考(?:\s*[（(].*[)）])?|深度思考(?:中)?|思考完成|正在(?:生成图片|生图)|已完成(?:图片生成|生图)|thinking|thought)(?:[.。…]+)?$/i;
function nonPlaceholderTitle(raw) {
	if (typeof raw !== "string") return void 0;
	const trimmed = raw.trim();
	if (trimmed === "" || PLACEHOLDER_THINKING_TITLE_RE.test(trimmed)) return void 0;
	return trimmed;
}
function trailingNewlineCount(text, fallback = 0) {
	if (text === "") return fallback;
	if (/(?:\r?\n){2}$/.test(text)) return 2;
	if (/\r?\n$/.test(text)) return 1;
	return 0;
}
function createBlockCollectState() {
	return {
		thinkingIds: /* @__PURE__ */ new Set(),
		lastTitles: /* @__PURE__ */ new Map(),
		seenTitles: /* @__PURE__ */ new Set(),
		lastSummaries: /* @__PURE__ */ new Map(),
		hasFullThinkingText: false,
		sawThinkingBlock: false,
		hasEmittedThinking: false,
		trailingNewlines: 2
	};
}
function pushThinkingPiece(state, into, piece, discrete) {
	if (piece === "") return;
	if (!discrete) {
		into.thinking.push(piece);
		state.hasEmittedThinking = true;
		state.trailingNewlines = trailingNewlineCount(piece, state.trailingNewlines ?? 0);
		return;
	}
	const nl = state.trailingNewlines ?? 0;
	const out = `${!state.hasEmittedThinking ? "" : nl >= 2 ? "" : nl === 1 ? "\n" : "\n\n"}${piece}`;
	into.thinking.push(out);
	state.hasEmittedThinking = true;
	state.trailingNewlines = trailingNewlineCount(out, nl);
}
function collectBlocks(node, into, thinkingIdsOrState, depth = 0) {
	const state = thinkingIdsOrState instanceof Set ? { thinkingIds: thinkingIdsOrState } : thinkingIdsOrState;
	const thinkingIds = state.thinkingIds;
	if (Array.isArray(node)) {
		for (const item of node) collectBlocks(item, into, state, depth);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node;
	const blockType = record.block_type;
	if (typeof blockType === "number") {
		const blockId = typeof record.block_id === "string" && record.block_id !== "" ? record.block_id : void 0;
		const parentId = typeof record.parent_id === "string" ? record.parent_id : "";
		const isThinking = blockType === THINKING_BLOCK_TYPE || parentId !== "" && thinkingIds.has(parentId);
		if (blockType === THINKING_BLOCK_TYPE) {
			if (blockId !== void 0) thinkingIds.add(blockId);
		}
		if (blockType === 2074) {
			state.activeTarget = "answer";
			if (into.images !== void 0) {
				const creations = record.content?.creation_block?.creations;
				if (Array.isArray(creations)) for (const raw of creations) {
					const image = toDoubaoImage(raw);
					if (image !== void 0) into.images.push(image);
				}
			}
		}
		const content = record.content;
		const thinkingBlock = content?.thinking_block;
		const text = content?.text_block?.text;
		const summary = content?.text_block?.summary;
		if (isThinking) {
			if (thinkingBlock !== void 0 && typeof thinkingBlock === "object" && thinkingBlock !== null && thinkingBlock.empty_disable_click !== true) {
				const isSummaryStyle = thinkingBlock.cot_ui_style === "summary";
				if (!state.hasFullThinkingText || isSummaryStyle) {
					const title = nonPlaceholderTitle(thinkingBlock.finish_title) ?? nonPlaceholderTitle(thinkingBlock.unfold_streaming_title) ?? nonPlaceholderTitle(thinkingBlock.streaming_title);
					if (title !== void 0) {
						state.sawThinkingBlock = true;
						state.seenTitles ??= /* @__PURE__ */ new Set();
						state.lastTitles ??= /* @__PURE__ */ new Map();
						const titleKey = blockId ?? "__thinking_title__";
						if (!state.seenTitles.has(title) && state.lastTitles.get(titleKey) !== title) {
							state.seenTitles.add(title);
							state.lastTitles.set(titleKey, title);
							pushThinkingPiece(state, into, `${title}\n\n`, true);
						}
					}
				}
			}
			if (typeof text === "string" && text !== "") {
				state.hasFullThinkingText = true;
				state.sawThinkingBlock = true;
				pushThinkingPiece(state, into, text, false);
			} else if (typeof summary === "string" && summary.trim() !== "") {
				const trimmedSummary = summary.trim();
				if (!PLACEHOLDER_THINKING_TITLE_RE.test(trimmedSummary)) {
					state.sawThinkingBlock = true;
					state.seenTitles ??= /* @__PURE__ */ new Set();
					state.lastSummaries ??= /* @__PURE__ */ new Map();
					const summaryKey = blockId ?? (parentId !== "" ? `${parentId}:summary` : "__thinking_summary__");
					const prev = state.lastSummaries.get(summaryKey) ?? "";
					if (prev === "" && state.seenTitles.has(trimmedSummary)) state.lastSummaries.set(summaryKey, summary);
					else if (summary !== prev) {
						state.lastSummaries.set(summaryKey, summary);
						if (prev !== "" && summary.startsWith(prev)) pushThinkingPiece(state, into, summary.slice(prev.length), false);
						else {
							state.seenTitles.add(trimmedSummary);
							pushThinkingPiece(state, into, summary, true);
						}
					}
				}
			}
			if (typeof text === "string" && text !== "" && record.is_finish !== true) state.activeTarget = "thinking";
			else if (blockType !== THINKING_BLOCK_TYPE && record.is_finish !== true) state.activeTarget = "thinking";
			else if (blockType === THINKING_BLOCK_TYPE && state.activeTarget === void 0 && record.is_finish !== true) state.activeTarget = "thinking";
		} else {
			if (typeof text === "string" && text !== "") into.answer.push(text);
			if (content?.text_block !== void 0) state.activeTarget = "answer";
		}
	} else if (typeof record.text === "string" && record.text !== "" && !("content_block" in record) && !("message" in record) && (typeof record.id === "string" || depth === 0 && !("block_type" in record) && !("icon_url" in record))) {
		if (typeof record.id === "string" ? thinkingIds.has(record.id) : state.activeTarget === "thinking") {
			state.sawThinkingBlock = true;
			pushThinkingPiece(state, into, record.text, false);
		} else into.answer.push(record.text);
		return;
	}
	for (const value of Object.values(record)) collectBlocks(value, into, state, depth + 1);
}
/**
* Turn one `creations[]` entry into an image, or undefined when it carries no
* usable URL yet (the placeholder stage).
*
* URL preference is original → preview → thumb: `image_ori` is the full-
* resolution artefact, the others are watermarked/derivative variants the app
* uses for lists and thumbnails.
*/
function toDoubaoImage(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const creation = raw;
	const image = creation.image;
	if (image === void 0) return void 0;
	const pick = (key) => {
		const value = image[key];
		if (typeof value !== "object" || value === null) return void 0;
		const url = value.url;
		if (typeof url !== "string" || url === "") return void 0;
		return value;
	};
	const best = pick("image_ori_raw") ?? pick("image_ori") ?? pick("image_preview") ?? pick("image_thumb");
	if (best === void 0) return void 0;
	const taskId = typeof creation.id === "string" ? creation.id : typeof creation.id === "number" ? String(creation.id) : void 0;
	const out = { url: best.url };
	if (taskId !== void 0) out.taskId = taskId;
	if (typeof image.key === "string") out.key = image.key;
	if (typeof best.width === "number") out.width = best.width;
	if (typeof best.height === "number") out.height = best.height;
	return out;
}
/** Read the model identifier the server actually used for a reply. */
function extractModel(payload) {
	const seen = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (node === null || typeof node !== "object") return void 0;
		if (Array.isArray(node)) {
			for (const item of node) {
				const found = walk(item);
				if (found) return found;
			}
			return;
		}
		const record = node;
		for (const key of [
			"model",
			"model_name",
			"model_id",
			"llm_model_type",
			"model_type"
		]) {
			const value = record[key];
			if (typeof value === "string" && value && !seen.has(value)) {
				seen.add(value);
				return value;
			}
			if (typeof value === "number" && value) {
				const text = String(value);
				if (!seen.has(text)) {
					seen.add(text);
					return text;
				}
			}
		}
		for (const value of Object.values(record)) {
			const found = walk(value);
			if (found) return found;
		}
	};
	return walk(payload);
}
/** True when the reply came from a reasoning-capable model. */
function extractThinking(payload) {
	const record = payload;
	const ext = record?.message?.ext ?? record?.ext;
	if (ext && typeof ext === "object") {
		const useDeepThink = ext.use_deep_think;
		if (useDeepThink === "1" || useDeepThink === 1) return true;
		if (typeof useDeepThink === "string" && useDeepThink !== "" && useDeepThink !== "0") return true;
	}
	return false;
}
/**
* Local workspace HTTP responder for 「工作任务」 (`Agent-GeneralTask`) turns.
*
* When a task-mode turn starts with `option.unique_key = <U>`, the server's
* `Agent-GeneralTask` dispatches sequential local workspace commands with
* deterministic IDs: `${uniqueKey}:${device_id}:${aid}:message:${seq}` for
* `seq = 0, 1, 2, ...`.
*
* CRITICAL: `POST /alice/office/tool_local/msg/ack` MUST be called with a
* SINGLE `msg_id` (`{ msg_ids: [msgId] }`). If `msg_ids` contains any `seq`
* that has not been created on the server yet, the entire `msg/ack` batch fails
* with `710010702`. Polling one `seq` at a time and replying to `cmd_call`
* (`command: 6003`, e.g. `local.workspace.apply`) via `upload_command_result`
* + `msg/complete` until `agent_finished` (`command: 6004`) satisfies the server
* runtime without requiring the Doubao desktop CUA process.
*/
async function runToolLocalResponder(uniqueKey, credentials, isStreamDone, signal) {
	const msToken = credentials.pairs.get("msToken");
	const postToolJson = async (endpoint, payload) => {
		const url = buildQueryUrl(endpoint, msToken);
		const headers = buildHeaders(credentials, {
			"content-type": "application/json",
			accept: "application/json, text/plain, */*"
		});
		delete headers["last-event-id"];
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			...signal ? { signal } : {}
		});
		absorbSetCookies(res.headers);
		const text = await res.text();
		return JSON.parse(text);
	};
	let seq = 0;
	let postStreamPolls = 0;
	while (!signal?.aborted) {
		if (isStreamDone()) {
			if (seq === 0 || postStreamPolls >= 8) break;
			postStreamPolls += 1;
		}
		const msgId = `${uniqueKey}:${CLIENT_PARAMS.device_id}:${CLIENT_PARAMS.aid}:message:${seq}`;
		let ack;
		try {
			ack = await postToolJson(TOOL_LOCAL_ACK_ENDPOINT, { msg_ids: [msgId] });
		} catch {
			return;
		}
		const msg = ack?.code === 0 ? ack?.data?.msgs?.[0] : void 0;
		if (msg !== void 0) {
			const cmdCall = msg?.body?.cmd_call;
			const agentFinished = msg?.body?.agent_finished;
			if (cmdCall !== void 0) {
				let inputObj = {};
				try {
					inputObj = JSON.parse(cmdCall.input ?? "{}");
				} catch {
					inputObj = {};
				}
				const results = (Array.isArray(inputObj.operations) ? inputObj.operations : []).map((op) => ({
					...op.sequence !== void 0 ? { sequence: op.sequence } : {},
					id: op.id,
					type: op.type,
					path: op.path,
					status: "success"
				}));
				const outputObj = {
					request_id: inputObj.request_id ?? "",
					status: "success",
					results
				};
				try {
					await postToolJson(TOOL_LOCAL_UPLOAD_ENDPOINT, {
						cmd_id: cmdCall.cmd_id,
						session_id: msg.session_id,
						msg_id: msgId,
						output: JSON.stringify(outputObj)
					});
					await postToolJson(TOOL_LOCAL_COMPLETE_ENDPOINT, { msg_id: msgId });
				} catch {
					return;
				}
				seq += 1;
				continue;
			}
			if (agentFinished !== void 0) return;
			seq += 1;
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, 180));
	}
}
/**
* One attempt, no fallback. Split out so {@link streamChat} can retry a
* task-mode call as plain chat when the task runtime is not attached.
*/
async function streamOnce(prompt, options = {}) {
	const credentials = options.credentials ?? loadDoubaoCredentials();
	if (!credentials.ok) throw new DoubaoUpstreamError(credentials.reason ?? "Doubao credentials unavailable.", void 0, false, { kind: "session_dead" });
	const missing = REQUIRED_COOKIE_NAMES.filter((name) => !credentials.pairs.get(name));
	if (missing.length > 0) throw new DoubaoUpstreamError(`Doubao session cookies missing: ${missing.join(", ")}`, void 0, false, { kind: "session_dead" });
	const msToken = credentials.pairs.get("msToken");
	const url = buildQueryUrl(CHAT_ENDPOINT, msToken);
	const headers = buildHeaders(credentials, { "content-type": "application/json" });
	const bodyObj = buildChatBody(prompt, options);
	const uniqueKey = bodyObj.option.unique_key;
	const body = JSON.stringify(bodyObj);
	const isTask = taskModeEnabled(options);
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers,
			body,
			...options.signal ? { signal: options.signal } : {}
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new DoubaoUpstreamError(`Doubao request did not reach the server: ${error.message}`, void 0, false, { transport: true });
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new DoubaoUpstreamError(`Doubao chat request failed with HTTP ${response.status}. ${detail.slice(0, 200)}`, void 0, false, { httpStatus: response.status });
	}
	absorbSetCookies(response.headers);
	let streamDone = false;
	const responderPromise = isTask ? runToolLocalResponder(uniqueKey, credentials, () => streamDone, options.signal).catch(() => {}) : Promise.resolve();
	try {
		return await consumeStream(response, options.callbacks, { harvestNotifyText: isTask });
	} finally {
		streamDone = true;
		await responderPromise;
	}
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
async function streamChat(prompt, options = {}) {
	let emittedText = false;
	const wrapped = {
		onText: (delta) => {
			if (delta) emittedText = true;
			options.callbacks?.onText?.(delta);
		},
		onThinking: (delta) => options.callbacks?.onThinking?.(delta),
		onEvent: (event) => options.callbacks?.onEvent?.(event),
		onTurnIds: (ids) => options.callbacks?.onTurnIds?.(ids)
	};
	const wanted = taskModeEnabled(options);
	const call = (taskMode) => streamOnce(prompt, {
		...options,
		callbacks: wrapped,
		taskMode
	});
	try {
		return await call(wanted);
	} catch (error) {
		const taskRuntimeMissing = error instanceof DoubaoUpstreamError && (error.code === CODE_TASK_RUNTIME_UNAVAILABLE || /agent_err_real_answer/.test(error.message));
		if (!wanted || !taskRuntimeMissing || emittedText) throw error;
		return call(false);
	}
}
const renewals = /* @__PURE__ */ new Map();
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
function invalidateRenewals() {
	renewals.clear();
}
/** Record rotated cookies (`x-ms-token`, `bd_sso_hi3jfd`) for the next request. */
function absorbSetCookies(headers) {
	const msToken = headers.get("x-ms-token");
	if (msToken) renewals.set("msToken", msToken);
	const setCookie = headers.get("set-cookie");
	if (!setCookie) return;
	for (const part of setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/)) {
		const [pair] = part.split(";");
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (name && value) renewals.set(name, value);
	}
}
/** Cookie header with any rotated values overlaid. Values never leave memory. */
function applyRenewals(header) {
	if (renewals.size === 0) return header;
	const pairs = /* @__PURE__ */ new Map();
	for (const part of header.split(/;\s*/)) {
		const eq = part.indexOf("=");
		if (eq > 0) pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1));
	}
	for (const [name, value] of renewals) pairs.set(name, value);
	return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
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
async function stopGeneration(credentials, ids) {
	const msToken = credentials.pairs.get("msToken");
	const url = buildQueryUrl(BREAK_STREAM_ENDPOINT, msToken);
	const headers = buildHeaders(credentials, { "content-type": "application/json; encoding=utf-8" });
	delete headers["last-event-id"];
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cmd: 2240,
			uplink_body: { break_stream_msg_uplink_body: {
				reply_msg_id: ids.questionId,
				message_id: "",
				conversation_id: ids.conversationId,
				conversation_type: 3,
				break_reason: 7
			} },
			sequence_id: randomUUID(),
			channel: 2,
			version: "1"
		}),
		signal: AbortSignal.timeout(STOP_GENERATION_TIMEOUT_MS)
	});
	absorbSetCookies(res.headers);
	const text = await res.text();
	if (!res.ok) throw new Error(`Doubao break_stream_msg failed with HTTP ${res.status}.`);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Doubao break_stream_msg returned a non-JSON response.");
	}
	if (parsed.status_code !== 0) throw new Error(`Doubao break_stream_msg refused to stop the turn (status_code=${String(parsed.status_code)}).`);
}
async function consumeStream(response, callbacks, options = {}) {
	const reader = response.body?.getReader();
	if (!reader) throw new DoubaoUpstreamError("Doubao returned an empty response body.");
	const decoder = new TextDecoder();
	let buffer = "";
	const texts = [];
	/** Text carried by STREAM_MSG_NOTIFY instead of by chunk deltas. */
	const notifyTexts = [];
	/** Generated images, in arrival order (may repeat a task while it streams). */
	const images = [];
	/** Private reasoning (deep-think turns), kept out of the answer. */
	const reasoningParts = [];
	/** Shared per-stream state across `10040` / `10000` / `CHUNK_DELTA` frames. */
	const blockState = createBlockCollectState();
	let conversationId;
	let messageId;
	/**
	* USER question id from SSE_ACK, kept apart from `messageId` (later frames
	* overwrite that with the assistant reply id): break_stream_msg addresses
	* the turn by the question id, never by the reply.
	*/
	let questionId;
	let model;
	let thinking = false;
	let lastEventId;
	let ended = false;
	/**
	* Every event name seen, in arrival order (deduped).
	*
	* Task mode answers with a richer event vocabulary than chat, so an empty
	* completion is usually "the text lives in an event we do not harvest yet"
	* rather than "the server said nothing". Naming the events turns an opaque
	* failure into a next step.
	*/
	function toFiniteNumber(value) {
		if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : void 0;
		}
	}
	function parseJsonObject(value) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
		if (typeof value !== "string" || value.trim() === "") return void 0;
		try {
			const parsed = JSON.parse(value);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {}
	}
	function parseContextWindowUsage(raw) {
		const obj = parseJsonObject(raw);
		if (obj === void 0) return void 0;
		const systemPrompt = toFiniteNumber(obj.system_prompt);
		const messages = toFiniteNumber(obj.messages);
		const skills = toFiniteNumber(obj.skills);
		const tools = toFiniteNumber(obj.tools);
		const totalWindowSize = toFiniteNumber(obj.total_window_size);
		if (systemPrompt === void 0 && messages === void 0 && skills === void 0 && tools === void 0 && totalWindowSize === void 0) return;
		const s = Math.max(0, systemPrompt ?? 0);
		const m = Math.max(0, messages ?? 0);
		const k = Math.max(0, skills ?? 0);
		const t = Math.max(0, tools ?? 0);
		return {
			systemPrompt: s,
			messages: m,
			skills: k,
			tools: t,
			totalWindowSize: Math.max(0, totalWindowSize ?? 0),
			totalUsed: s + m + k + t
		};
	}
	function collectTelemetryFromExt(ext, target) {
		const record = parseJsonObject(ext);
		if (record === void 0) return;
		const contextWindow = parseContextWindowUsage(record.context_window_usage);
		if (contextWindow !== void 0) target.contextWindowUsage = contextWindow;
		const teaCost = parseJsonObject(record.tea_tags_time_cost);
		if (teaCost !== void 0) {
			const ack = toFiniteNumber(teaCost.ack_cost_time);
			if (ack !== void 0 && ack >= 0) target.ackCostMs = ack;
			const firstPacket = toFiniteNumber(teaCost.first_packet_cost_time);
			if (firstPacket !== void 0 && firstPacket >= 0) target.firstPacketCostMs = firstPacket;
		}
		const finishTime = toFiniteNumber(record.finish_time_ms);
		if (finishTime !== void 0 && finishTime >= 0) target.finishTimeMs = finishTime;
		if (typeof record.finish_reason_chat === "string" && record.finish_reason_chat !== "") target.finishReasonChat = record.finish_reason_chat;
	}
	function collectTelemetry(payload, target) {
		if (payload === null || typeof payload !== "object") return;
		const record = payload;
		collectTelemetryFromExt(record.ext, target);
		collectTelemetryFromExt(record.content?.ext, target);
		collectTelemetryFromExt(record.message?.ext, target);
		if (Array.isArray(record.patch_op)) for (const op of record.patch_op) collectTelemetryFromExt(op?.patch_value?.ext, target);
	}
	const events = /* @__PURE__ */ new Set();
	/** The agent that served this turn, when the server names one. */
	let intentionAgent;
	/** Server-side timing & context window telemetry harvested across SSE frames. */
	const telemetry = {};
	/**
	* `expose_reason` of a task turn whose runtime was unreachable.
	*
	* Recorded instead of surfacing its placeholder text (「出了点问题，请稍后重试。」),
	* which reads like a transient glitch and hides the actual cause.
	*/
	let taskAgentError;
	const handle = (frame) => {
		const name = frame.event ?? "";
		if (name) events.add(name);
		if (process.env.DSH_DOUBAO_DEBUG_FRAMES === "1" && frame.data) process.stderr.write(`[frame ${name || "(none)"}] ${frame.data.slice(0, 1500)}\n`);
		if (name && callbacks?.onEvent) callbacks.onEvent(name);
		if (frame.id) lastEventId = frame.id;
		if (!frame.data) return;
		let payload;
		try {
			payload = JSON.parse(frame.data);
		} catch {
			return;
		}
		collectTelemetry(payload, telemetry);
		if (name === "STREAM_ERROR") {
			const record = payload;
			const code = record.error_code;
			const message = record.error_msg ?? "unknown stream error";
			const rateLimited = code === 710022004 || /rate limit/i.test(message);
			throw new DoubaoUpstreamError(rateLimited ? "Doubao risk control challenged this request (710022004). Slow down and retry later." : `Doubao stream error ${code ?? "?"}: ${message}`, code, rateLimited);
		}
		if (name === "SSE_ACK") {
			const ack = payload;
			conversationId = ack.ack_client_meta?.conversation_id ?? conversationId;
			questionId = ack.query_list?.[0]?.question_id ?? questionId;
			messageId = ack.query_list?.[0]?.question_id ?? messageId;
			callbacks?.onTurnIds?.({
				conversationId,
				questionId
			});
			return;
		}
		if (name === "FULL_MSG_NOTIFY" || name === "STREAM_MSG_NOTIFY") {
			const record = payload;
			messageId = record.message?.message_id ?? messageId;
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const ext = record.content?.ext ?? record.message?.ext ?? record.ext;
			if (ext !== void 0 && ext !== null && typeof ext === "object") {
				const agent = ext.intention_agent_name;
				if (typeof agent === "string" && agent !== "") intentionAgent = agent;
				const reason = ext.expose_reason;
				if (typeof reason === "string" && /agent_err_real_answer/.test(reason)) taskAgentError = reason;
			}
			if (name === "STREAM_MSG_NOTIFY") {
				thinking = thinking || extractThinking(payload);
				const acc = {
					answer: [],
					thinking: [],
					images
				};
				collectBlocks(record.content?.content_block, acc, blockState);
				const joinedAccThinking = acc.thinking.join("");
				const priorThinking = reasoningParts.join("");
				if (!(joinedAccThinking !== "" && priorThinking !== "" && joinedAccThinking === priorThinking)) for (const piece of acc.thinking) {
					if (!piece) continue;
					reasoningParts.push(piece);
					if (callbacks?.onThinking) callbacks.onThinking(piece);
				}
				for (const piece of acc.answer) {
					if (!piece) continue;
					notifyTexts.push(piece);
					if (callbacks?.onText) callbacks.onText(piece);
				}
			}
			return;
		}
		if (name === "STREAM_CHUNK" || name === "CHUNK_DELTA") {
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const acc = {
				answer: [],
				thinking: [],
				images
			};
			collectBlocks(payload, acc, blockState);
			for (const piece of acc.thinking) {
				if (!piece) continue;
				reasoningParts.push(piece);
				if (callbacks?.onThinking) callbacks.onThinking(piece);
			}
			for (const text of acc.answer) {
				if (!text) continue;
				if (callbacks?.onText) callbacks.onText(text);
				texts.push(text);
			}
			return;
		}
		if (name === "SSE_REPLY_END") ended = true;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { frames, rest } = parseFrames(buffer);
			buffer = rest;
			for (const frame of frames) handle(frame);
			if (ended) break;
		}
		const tail = decoder.decode();
		if (tail) {
			const { frames, rest } = parseFrames(buffer + tail);
			buffer = rest;
			for (const frame of frames) handle(frame);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const chunkText = texts.join("");
	const text = stripPromptEcho(assembleReplyText(notifyTexts.join(""), chunkText));
	if (taskAgentError !== void 0) throw new DoubaoUpstreamError(`Doubao accepted the task but its executing runtime was unreachable (${taskAgentError}). The 「工作任务」 runtime is attached by the desktop client; without it the agent has nowhere to run.`, CODE_TASK_RUNTIME_UNAVAILABLE);
	if (!ended) {
		const received = texts.join("").length + notifyTexts.join("").length;
		throw new DoubaoUpstreamError(`Doubao closed the stream before the reply finished${received > 0 ? ` after ${received} characters` : ""}; the answer is incomplete. Retry the turn.`, void 0, false, { truncated: true });
	}
	const uniqueImages = [...new Map(images.map((image) => [image.url, image])).values()];
	if (!text && uniqueImages.length === 0) {
		const seen = [...events];
		throw new DoubaoUpstreamError(`Doubao returned an empty completion${lastEventId ? ` (last event id ${lastEventId})` : ""}${seen.length > 0 ? `; events seen: ${seen.join(", ")}` : "; no events at all"}.`);
	}
	return {
		text,
		...model !== void 0 ? { model } : {},
		...conversationId !== void 0 ? { conversationId } : {},
		...messageId !== void 0 ? { messageId } : {},
		...reasoningParts.length > 0 ? { reasoningText: reasoningParts.join("") } : {},
		...intentionAgent !== void 0 ? { intentionAgent } : {},
		...Object.keys(telemetry).length > 0 ? { telemetry } : {},
		images: uniqueImages,
		thinking: thinking || blockState.sawThinkingBlock === true || reasoningParts.length > 0
	};
}
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
function assembleReplyText(notifyText, chunkText) {
	if (notifyText === "") return chunkText;
	if (chunkText === "") return notifyText;
	return chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText;
}
/**
* Remove the echoed user prompt from the front of the assembled text.
*
* Doubao's first chunk replays the inbound message; keeping it would make every
* reply appear to start with the user's own words.
*/
function stripPromptEcho(raw) {
	return raw.trimStart();
}
/**
* Collect a complete reply. Convenience wrapper over `streamChat` for callers
* that do not need incremental deltas.
*/
async function chat(prompt, options = {}) {
	return streamChat(prompt, options);
}
/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001;
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004;
/**
* `block_type` of the deep-think container.
*
* A 深度思考 turn opens one `10040` block (the 「正在思考 / 已完成思考」 shell) and
* then streams the reasoning as `10000` blocks whose `parent_id` is its id.
* Captured 2026-10-23.
*/
const THINKING_BLOCK_TYPE = 10040;
/**
* The server's business code when a 「工作任务」 was accepted but its executing
* runtime could not be reached (`expose_reason: agent_err_real_answer`).
*
* This is the signature of "the mode is right, the local runtime is not
* attached" — the desktop client's CUA runtime registers itself; an external
* client has nothing to register, so the agent has nowhere to run.
*/
const CODE_TASK_RUNTIME_UNAVAILABLE = 710010702;
/**
* The server's business code for "common invalid param".
*
* Observed on a CONTINUATION turn whose remembered `conversation_id` the
* server no longer accepts (the thread expired or was deleted upstream): the id
* is the only parameter that differs from a fresh-conversation request, and the
* same request then fails identically on every retry.
*/
const CODE_INVALID_PARAM = 710020202;
/**
* Whether the upstream rejected the request parameters outright.
*
* Callers that were continuing a remembered conversation should drop the id
* after this failure — keeping it would repeat the same rejection for the rest
* of the session TTL instead of opening a fresh thread on the next turn.
*/
function isInvalidParamFailure(error) {
	return error instanceof DoubaoUpstreamError && error.code === CODE_INVALID_PARAM;
}
/**
* Map one upstream error onto its class.
*
* Order matters: the explicit evidence (code, hint, HTTP status) is consulted
* before the generic `upstream` bucket, and the old catch-all was wrong — every
* unrecognised failure was reported as `network`, i.e. "check your connection",
* for HTTP 400s and business errors that a retry cannot fix.
*/
function classifyDoubaoFailure(error) {
	if (error.kindHint !== void 0) return error.kindHint;
	if (error.rateLimited || error.code === CODE_RATE_LIMITED) return "rate_limited";
	if (error.code === CODE_TASK_RUNTIME_UNAVAILABLE) return "task_runtime_unavailable";
	if (error.code === CODE_SESSION_DEAD) return "session_dead";
	if (error.httpStatus === 401 || error.httpStatus === 403) return "session_dead";
	if (error.httpStatus === 429) return "quota_exhausted";
	if (error.transport) return "network";
	return "upstream";
}
/**
* Whether the host should retry this failure.
*
* Deliberately narrow. Re-sending a turn costs quota AND opens a server-side
* thread, so only a failure that provably never produced an answer qualifies:
* a transport error before any bytes, or a 5xx. A truncated stream is NOT
* retryable here — the retry would be a fresh conversation that silently
* abandons the half-received one, so the user is told instead.
*/
function isRetryableFailure(error) {
	if (!(error instanceof DoubaoUpstreamError)) return false;
	if (error.transport) return true;
	if (error.httpStatus !== void 0) return error.httpStatus >= 500;
	return false;
}
/**
* User-facing text per class.
*
* The slider wording matters: it is the one failure the user can actually fix,
* and the only place they can fix it is the Doubao desktop client — retrying
* from the Harness will never clear it.
*/
const DOUBAO_ERROR_HINTS = {
	rate_limited: "豆包触发了风控验证（710022004）。请打开豆包客户端，手动发送一条消息完成滑块验证，然后再回到这里重试。反复重试只会让验证更严格。",
	quota_exhausted: "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端查看「订阅与额度管理」。",
	session_dead: "豆包登录态失效。请在豆包客户端重新登录，然后重试。",
	network: "连接豆包失败（网络或超时）。请检查网络后重试。",
	task_runtime_unavailable: "豆包把这个账号路由到了「工作任务」代理，而该任务的执行运行时只存在于豆包客户端进程里，外部客户端接不上。请打开豆包客户端，把输入框上方的开关切回「对话」，然后重试；需要多步执行的话，交给 DSH 自己的工具来做。",
	upstream: "豆包返回了错误响应（不是网络问题，重试通常无效）。"
};
/** Build a user-facing message for a Doubao failure. */
function describeDoubaoFailure(error) {
	if (error instanceof DoubaoUpstreamError) return `${DOUBAO_ERROR_HINTS[classifyDoubaoFailure(error)]}（${error.message}）`;
	return `豆包请求失败：${error?.message ?? String(error)}`;
}
/** Quick reachability probe that does not consume any inference quota. */
async function probeAccount(credentials) {
	if (!credentials.ok) return {
		ok: false,
		detail: credentials.reason ?? "no credentials"
	};
	const url = buildQueryUrl(ACCOUNT_ENDPOINT);
	const headers = buildHeaders(credentials);
	delete headers["content-type"];
	delete headers["last-event-id"];
	try {
		const response = await fetch(url, {
			method: "GET",
			headers
		});
		const payload = await response.json();
		if (!response.ok) return {
			ok: false,
			detail: `HTTP ${response.status}`
		};
		if (payload.data?.name) return {
			ok: true,
			detail: "signed in"
		};
		return {
			ok: false,
			detail: "session rejected by server"
		};
	} catch (error) {
		return {
			ok: false,
			detail: error.message
		};
	}
}
//#endregion
//#region src/doubao-quota.ts
/**
* Doubao quota.
*
* Doubao does NOT expose rate-limit headers on the chat endpoint — there is no
* `x-ratelimit-*` and no `x-event-states-limit`. The authoritative source is a
* separate summary endpoint that the desktop app calls on launch.
*
* It reports `window_limit_groups[].window_limits[]`, where each entry is one
* rolling consumption window:
*
*   window_type 1 -> 5-hour limit   (verified: end_time - start_time = 18e6 ms)
*   window_type 2 -> weekly quota    (verified: end_time - start_time = 604.8e6 ms)
*   window_type 3 -> bonus quota     (a promotional grant from `incentive_quota_section`,
*                                     with an expiry but no start: "activity bonus quota")
*
* The window length was confirmed arithmetically from the server's own
* timestamps rather than inferred from the UI, so the mapping is pinned.
*/
/** Quota results are cached briefly so a chatty session does not hammer the API. */
const QUOTA_TTL_MS = 3e5;
/**
* Parse one of the server's amount fields.
*
* They arrive as formatted strings ("2,100"), and they are the only source of a
* percentage for the plans that omit `used_percent`. Returns undefined rather
* than NaN so callers can tell "no data" from "zero".
*/
function parseAmount(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return void 0;
	const digits = value.replace(/[^0-9.]/g, "");
	if (digits === "") return void 0;
	const parsed = Number(digits);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function mapWindowType(value) {
	if (value === 1) return "five_hour";
	if (value === 2) return "weekly";
	if (value === 3) return "incentive";
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
function normalizeWindow(raw, label) {
	const type = raw.window_type === void 0 ? void 0 : mapWindowType(raw.window_type);
	if (!type) return void 0;
	const start = raw.start_time ?? 0;
	const end = raw.end_time ?? 0;
	const usedAmount = parseAmount(raw.used_amount);
	const totalAmount = parseAmount(raw.total_amount);
	const fromAmounts = usedAmount !== void 0 && totalAmount !== void 0 && totalAmount > 0 ? Math.min(100, Math.max(0, usedAmount / totalAmount * 100)) : void 0;
	const used = typeof raw.used_percent === "number" ? raw.used_percent : fromAmounts ?? 0;
	const base = {
		type,
		windowType: raw.window_type,
		usedPercent: used,
		remainingPercent: Math.max(0, 100 - used),
		...label === void 0 || label === "" ? {} : { label },
		...usedAmount === void 0 ? {} : { usedAmount },
		...totalAmount === void 0 ? {} : { totalAmount }
	};
	if (end <= 0) return {
		...base,
		resetsAt: 0,
		startedAt: 0,
		windowMs: 0,
		resetUnknown: true,
		startsOnUse: true
	};
	return {
		...base,
		...start <= 0 ? { startsOnUse: true } : {},
		resetsAt: end,
		startedAt: start > 0 ? start : 0,
		windowMs: start > 0 && end > start ? end - start : 0
	};
}
/**
* How long a FAILED reading is reused.
*
* The quota endpoint is consulted before every chat turn, and a failure used to
* be forgotten immediately — so an outage cost every single turn another round
* trip that was going to fail the same way, on the request's critical path. The
* window is short enough that a recovery is invisible (a turn later) and long
* enough to stop that fan-out.
*/
const QUOTA_FAILURE_TTL_MS = 3e4;
/**
* Remember a failed reading, and return it.
*
* One helper because all three failure exits (no credentials, HTTP error,
* thrown) must go through it: a failure that skips the memo is exactly the bug
* this exists to prevent.
*/
function rememberFailure(quota) {
	cachedFailure = quota;
	cachedFailureAt = Date.now();
	return quota;
}
/**
* Only report the account as exhausted when all active quota entitlements say
* so: an exhausted promotional bonus must not block turns while the main
* window still has headroom.
*/
function evaluateQuotaExhausted(data) {
	const hasActiveGroups = (section) => Boolean(section?.window_limit_groups?.some((g) => (g.window_limits?.length ?? 0) > 0));
	const windowExhausted = data?.window_limit_section?.usage_exhausted;
	const enterpriseExhausted = data?.enterprise_window_limit_section?.usage_exhausted;
	const incentiveExhausted = data?.incentive_quota_section?.usage_exhausted;
	const activeFlags = [];
	if (typeof windowExhausted === "boolean") activeFlags.push(windowExhausted);
	if (typeof enterpriseExhausted === "boolean" && hasActiveGroups(data?.enterprise_window_limit_section)) activeFlags.push(enterpriseExhausted);
	if (typeof incentiveExhausted === "boolean" && hasActiveGroups(data?.incentive_quota_section)) activeFlags.push(incentiveExhausted);
	const fallbackFlags = [
		windowExhausted,
		enterpriseExhausted,
		incentiveExhausted
	].filter((flag) => typeof flag === "boolean");
	const flags = activeFlags.length > 0 ? activeFlags : fallbackFlags;
	return flags.length > 0 && flags.every(Boolean);
}
async function fetchQuota(options = {}) {
	const now = Date.now();
	if (!options.force && cached && now - cached.fetchedAt < 3e5) return cached;
	if (!options.force && cachedFailure !== void 0 && now - cachedFailureAt < QUOTA_FAILURE_TTL_MS) return cachedFailure;
	const credentials = loadDoubaoCredentials();
	if (!credentials.ok) return rememberFailure({
		exhausted: false,
		windows: [],
		fetchedAt: now,
		error: credentials.reason ?? "Doubao credentials unavailable."
	});
	try {
		const response = await fetch(buildQueryUrl(QUOTA_ENDPOINT, credentials.pairs.get("msToken")), {
			method: "POST",
			headers: buildHeaders(credentials, { "content-type": "application/json" }),
			body: JSON.stringify({ product_line: "membership" })
		});
		if (!response.ok) return rememberFailure({
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: `HTTP ${response.status}`
		});
		const payload = await response.json();
		const sections = [payload.data?.window_limit_section, payload.data?.incentive_quota_section];
		const windows = [];
		for (const section of sections) for (const group of section?.window_limit_groups ?? []) for (const limit of group.window_limits ?? []) {
			const normalized = normalizeWindow(limit, group.feature_group_name);
			if (normalized) windows.push(normalized);
		}
		const quota = {
			exhausted: evaluateQuotaExhausted(payload.data),
			windows,
			fetchedAt: now
		};
		const plan = payload.data?.current_subscription?.display?.short_name;
		if (plan) quota.plan = plan;
		if (payload.data?.member_info?.hasActiveSubscription !== void 0) quota.planActive = payload.data.member_info.hasActiveSubscription;
		cached = quota;
		cachedFailure = void 0;
		return quota;
	} catch (error) {
		return rememberFailure({
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: error.message
		});
	}
}
let cached;
/** The last FAILED reading, reused for {@link QUOTA_FAILURE_TTL_MS}. */
let cachedFailure;
let cachedFailureAt = 0;
/** Drop the cached reading so the next call hits the server. */
function invalidateQuotaCache() {
	cached = void 0;
	cachedFailure = void 0;
	cachedFailureAt = 0;
}
/** Convenience lookup for a specific window. */
function findWindow(quota, type) {
	return quota.windows.find((window) => window.type === type);
}
/**
* Milliseconds until a window resets, clamped at zero.
* Drives the countdown the user asked for.
*/
function millisUntilReset(window, now = Date.now()) {
	if (window.resetUnknown === true) return 0;
	return Math.max(0, window.resetsAt - now);
}
/** Human-readable duration, e.g. `4h 12m`. */
function formatDuration(ms) {
	const total = Math.floor(ms / 1e3);
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (!days && !hours && seconds) parts.push(`${seconds}s`);
	return parts.join(" ") || "0s";
}
//#endregion
export { saveBrowserCredentials as $, classifyDoubaoFailure as A, discoverDoubaoModels as At, stopGeneration as B, reasoningLevelOf as Bt, applyRenewals as C, DOUBAO_UNAVAILABLE_MODELS as Ct, buildHeaders as D, TASK_RUNTIME_CLOUD_VM as Dt, buildGeneralTaskParam as E, TASK_AGENT_MODE as Et, invalidateRenewals as F, inputSkillOf as Ft, CREDENTIAL_TTL_MS as G, taskModeEnabled as H, isInvalidParamFailure as I, isKnownModelId as It, clearCredentialCache as J, REQUIRED_COOKIE_NAMES as K, isRetryableFailure as L, isTaskModel as Lt, createBlockCollectState as M, enabledModelsOf as Mt, describeDoubaoFailure as N, findDoubaoModel as Nt, buildQueryUrl as O, TASK_RUNTIME_LOCAL_PC as Ot, extractModel as P, findReasoningLevel as Pt, loadDoubaoCredentials as Q, parseFrames as R, levelIdOf as Rt, TOOL_LOCAL_UPLOAD_ENDPOINT as S, DOUBAO_SKILLS as St, buildChatBody as T, SKILL_CARRIER_MODEL_ID as Tt, taskWorkspaceOf as U, streamChat as V, supportsReasoning as Vt, withImagePrefix as W, invalidateCredentialCache as X, hasBrowserCredentials as Y, loadBrowserCredentials as Z, DoubaoUpstreamError as _, DOUBAO_MAX_TOKENS as _t, formatDuration as a, looksLikeProfile as at, TOOL_LOCAL_ACK_ENDPOINT as b, DOUBAO_PROVIDER_DISPLAY_NAME as bt, normalizeWindow as c, CHAT_AGENT_MODE as ct, BREAK_STREAM_ENDPOINT as d, DEEP_THINK_ON as dt, PROFILE_ENV as et, CHAT_ENDPOINT as f, DEFAULT_REASONING_LEVEL_ID as ft, DOUBAO_VERSION as g, DOUBAO_IMAGE_MODEL_NAME as gt, DOUBAO_ERROR_HINTS as h, DOUBAO_IMAGE_MODEL_ID as ht, findWindow as i, listDoubaoProfiles as it, collectBlocks as j, doubaoCatalogEntries as jt, chat as k, TASK_SANDBOX_AUTH_ALLOW_ALL as kt, ACCOUNT_ENDPOINT as l, CREATION_BLOCK_TYPE as lt, DEFAULT_BOT_ID as m, DOUBAO_DEFAULT_MODEL_ID as mt, evaluateQuotaExhausted as n, extractUserDataDir as nt, invalidateQuotaCache as o, resolveUserProvided as ot, CLIENT_PARAMS as p, DOUBAO_CONTEXT_WINDOW as pt, clearBrowserCredentials as q, fetchQuota as r, findDoubaoUserDataDir as rt, millisUntilReset as s, setProfileOverride as st, QUOTA_TTL_MS as t, describeProfileLocation as tt, ACTION_BAR_BRIEF_LIST_ENDPOINT as u, DEEP_THINK_OFF as ut, QUOTA_ENDPOINT as v, DOUBAO_MODELS as vt, assembleReplyText as w, NO_THINKING_MODEL_IDS as wt, TOOL_LOCAL_COMPLETE_ENDPOINT as x, DOUBAO_REASONING_LEVELS as xt, RUNTIME_VERSION as y, DOUBAO_PROVIDER as yt, probeAccount as z, needDeepThinkValue as zt };
