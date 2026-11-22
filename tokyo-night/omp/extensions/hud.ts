/**
 * HUD for the omp TUI.
 *
 * Status line (`status` segment, statusLine.preset: custom):
 *   context used/total, one robot per spawned subagent.
 * Panel below the editor (one widget, so the order is fixed):
 *   "Session resume" box with a bullet list of what the session has done,
 *   then one line with Claude / OpenAI / Cursor subscription limits.
 *
 * The resume is updated after every prompt finishes by a separate, lean
 * `omp -p` run on the cheapest model of the session model's family (see
 * CHEAP_MODELS). It only sees the previous resume plus the activity since,
 * and is persisted in the session file so a resumed session shows it again.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { theme, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { UsageProvider } from "@oh-my-pi/pi-ai";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

const KEY_CONTEXT = "hud-1-context";
const KEY_AGENTS = "hud-2-agents";
const WIDGET_PANEL = "hud-panel";
const RESUME_ENTRY = "arara.hud.session-resume";

const CONTEXT_POLL_MS = 2_000;
const LIMITS_POLL_MS = 3 * 60_000;
const USAGE_TIMEOUT_MS = 30_000;
const RESUME_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_TOOL_ARGS_CHARS = 300;
const MAX_ROBOTS = 12;
const MAX_BULLETS = 8;
const ROBOT = "🤖";

/** Limits shown per provider: `match` selects the report limit, `label` is what the panel prints. */
const PROVIDERS = [
	{
		id: "anthropic",
		label: "Claude",
		windows: [
			{ match: "anthropic:5h", label: "5h" },
			{ match: "anthropic:7d", label: "7d" },
		],
	},
	{
		id: "openai-codex",
		label: "OpenAI",
		windows: [
			{ match: "openai-codex:primary", label: "5h" },
			{ match: "openai-codex:secondary", label: "7d" },
		],
	},
	{
		id: "cursor",
		label: "Cursor",
		windows: [
			{ match: "cursor:usd:individual-auto", label: "models" },
			{ match: "cursor:usd:individual-api", label: "other" },
		],
	},
] as const;

/**
 * Resume model per session-model provider. `latest` takes the highest version
 * among matching ids; `cheapest` takes the lowest input+output price, ties to
 * the highest version. Providers not listed fall back to the session model.
 */
const CHEAP_MODELS = [
	{ provider: "anthropic", pattern: /^claude-haiku-\d+(?:-\d+)?$/, pick: "latest" },
	{ provider: "openai-codex", pattern: /^gpt-[\d.]+-luna$/, pick: "latest" },
	{ provider: "cursor", pattern: /grok/, pick: "cheapest" },
] as const;
const RESUME_THINKING = "low";

const RESUME_SYSTEM = "You maintain the short 'session resume' of a coding session: a bullet list of what has been accomplished.";

const RESUME_RULES = `Return the updated session resume.
Rules:
- Keep the existing bullets unless the new activity changes them; add bullets for newly finished work.
- Only work that is done (files written, features implemented, bugs fixed, tests added, decisions made). No plans, next steps, or open questions.
- At most ${MAX_BULLETS} bullets, oldest first, each at most 8 words, past tense, no trailing period. Merge related steps.
- Reply with the bullet list only ("- " per line), nothing else.`;

type ModelInfo = { provider: string; id: string; cost?: { input?: number; output?: number } };
type ResumeState = { bullets: string[]; through?: string };

type Limit = { id?: string; amount?: { usedFraction?: number } };
type Report = { provider: string; limits?: Limit[] };

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function levelColor(fraction: number): "success" | "warning" | "error" {
	if (fraction >= 0.9) return "error";
	if (fraction >= 0.7) return "warning";
	return "success";
}

const OMP_BINARY = basename(process.execPath).startsWith("omp") ? process.execPath : "omp";

/** Runs `omp usage --json`; shape comes from omp's own CLI, so only the top-level array is checked. */
function fetchUsage(): Promise<Report[]> {
	const { promise, resolve } = Promise.withResolvers<Report[]>();
	execFile(
		OMP_BINARY,
		// This file is loaded so the Cursor usage override below also applies to the report.
		["usage", "--json", "--no-extensions", "-e", fileURLToPath(import.meta.url)],
		{ timeout: USAGE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
		(error, stdout) => {
			if (error) return resolve([]);
			try {
				const parsed: unknown = JSON.parse(stdout);
				const reports =
					parsed && typeof parsed === "object" && "reports" in parsed && Array.isArray(parsed.reports)
						? parsed.reports
						: [];
				resolve(reports);
			} catch {
				resolve([]);
			}
		},
	);
	return promise;
}

function renderLimits(reports: Report[]): string | undefined {
	const parts: string[] = [];
	for (const provider of PROVIDERS) {
		const report = reports.find(r => r.provider === provider.id);
		if (!report) continue;
		const windows: string[] = [];
		for (const { match, label } of provider.windows) {
			const used = report.limits?.find(l => l.id === match)?.amount?.usedFraction;
			if (used === undefined) continue;
			windows.push(`${theme.fg("dim", label)} ${theme.fg(levelColor(used), `${Math.round(used * 100)}%`)}`);
		}
		if (windows.length > 0) parts.push(`${theme.fg("accent", provider.label)} ${windows.join(" ")}`);
	}
	return parts.length > 0 ? parts.join("  ") : undefined;
}

function parseBullets(reply: string): string[] {
	const lines = reply.split("\n").map(l => l.trim()).filter(Boolean);
	const bullets: string[] = [];
	for (const line of lines) {
		const match = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
		if (match) bullets.push(match[1]);
	}
	return (bullets.length > 0 ? bullets : lines)
		.map(b => b.replace(/\*\*|`/g, "").replace(/\.$/, ""))
		.slice(-MAX_BULLETS);
}

function versionOf(id: string): number[] {
	return (id.match(/\d+/g) ?? []).map(Number);
}

/** Positive when `a` has the higher version. */
function compareVersions(a: string, b: string): number {
	const va = versionOf(a);
	const vb = versionOf(b);
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const diff = (va[i] ?? -1) - (vb[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** `provider/id` of the resume model for the session model's family, or the session model itself. */
function pickResumeModel(current: ModelInfo, available: readonly ModelInfo[]): string {
	const rule = CHEAP_MODELS.find(r => r.provider === current.provider);
	const candidates = rule ? available.filter(m => m.provider === rule.provider && rule.pattern.test(m.id)) : [];
	if (!rule || candidates.length === 0) return `${current.provider}/${current.id}`;
	const price = (m: ModelInfo) => (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
	const best = candidates.reduce((a, b) => {
		if (rule.pick === "cheapest" && price(a) !== price(b)) return price(a) < price(b) ? a : b;
		return compareVersions(a.id, b.id) >= 0 ? a : b;
	});
	return `${best.provider}/${best.id}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block ? String(block.text) : ""))
		.filter(Boolean)
		.join("\n");
}

/** Conversation after `throughId` (whole branch when absent) as plain text, newest part kept when too long. */
function transcriptSince(entries: readonly SessionEntry[], throughId: string | undefined): { text: string; lastId?: string } {
	const start = throughId ? entries.findIndex(e => e.id === throughId) + 1 : 0;
	const lines: string[] = [];
	let lastId: string | undefined;
	for (const entry of entries.slice(start)) {
		lastId = entry.id;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text) lines.push(`USER: ${text}`);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) lines.push(`ASSISTANT: ${block.text}`);
				if (block.type === "toolCall") {
					lines.push(`TOOL ${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, MAX_TOOL_ARGS_CHARS)}`);
				}
			}
		} else if (message.role === "toolResult" && message.isError) {
			lines.push(`TOOL ERROR in ${message.toolName}`);
		}
	}
	const text = lines.join("\n");
	return { text: text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text, lastId };
}

/** Latest persisted resume; `through` defaults to the marker itself for entries written without it. */
function resumeState(entries: readonly SessionEntry[]): ResumeState {
	let state: ResumeState = { bullets: [] };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RESUME_ENTRY) continue;
		const data: unknown = entry.data;
		if (!data || typeof data !== "object" || !("bullets" in data) || !Array.isArray(data.bullets)) continue;
		const through = "through" in data && typeof data.through === "string" ? data.through : entry.id;
		state = { bullets: data.bullets.filter((b): b is string => typeof b === "string"), through };
	}
	return state;
}

/**
 * Cursor usage from DashboardService/GetCurrentPeriodUsage, which reports the
 * current included-usage period (weekly on the current plans). omp's built-in
 * Cursor reporter reads the monthly usage-summary, which stays at 0% while the
 * weekly allowance is exhausted. Same limit ids as the built-in reporter.
 */
const cursorPeriodUsage: UsageProvider = {
	id: "cursor",
	cacheVersion: 1001,
	supports: params => params.provider === "cursor" && params.credential.type === "oauth" && Boolean(params.credential.accessToken),
	async fetchUsage(params, { fetch }) {
		const token = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
		if (!token) return null;
		const response = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/json",
			},
			body: "{}",
			signal: params.signal,
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("planUsage" in body) || !body.planUsage || typeof body.planUsage !== "object") {
			return null;
		}
		const plan = body.planUsage;
		const percent = (key: string): number | undefined => {
			const value: unknown = Reflect.get(plan, key);
			return typeof value === "number" ? value : undefined;
		};
		const total = percent("totalPercentUsed");
		const auto = percent("autoPercentUsed") ?? total;
		const api = percent("apiPercentUsed") ?? total;
		const start = "billingCycleStart" in body ? Number(body.billingCycleStart) : NaN;
		const end = "billingCycleEnd" in body ? Number(body.billingCycleEnd) : NaN;
		const window = {
			id: "weekly",
			label: "Weekly",
			...(Number.isFinite(start) && Number.isFinite(end) ? { durationMs: end - start } : {}),
			...(Number.isFinite(end) ? { resetsAt: end } : {}),
		};
		const limits = [
			{ id: "cursor:usd:individual-auto", label: "Cursor Models", used: auto },
			{ id: "cursor:usd:individual-api", label: "Other Models", used: api },
		].flatMap(({ id, label, used }) => {
			if (used === undefined) return [];
			const usedFraction = Math.max(0, used) / 100;
			return [
				{
					id,
					label,
					scope: { provider: "cursor", windowId: window.id },
					window,
					amount: {
						used: Math.max(0, used),
						limit: 100,
						remaining: Math.max(0, 100 - used),
						usedFraction,
						remainingFraction: Math.max(0, 1 - usedFraction),
						unit: "percent" as const,
					},
					status: usedFraction >= 1 ? ("exhausted" as const) : usedFraction >= 0.9 ? ("warning" as const) : ("ok" as const),
				},
			];
		});
		return limits.length > 0 ? { provider: "cursor", fetchedAt: Date.now(), limits } : null;
	},
};

/** One-shot `omp -p` with tools, extensions, context files and session saving off. */
function runResumeModel(model: string, prompt: string, signal: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = execFile(
		OMP_BINARY,
		[
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-tools",
			"--no-lsp",
			"--no-skills",
			"--no-rules",
			"--no-context-files",
			"--no-title",
			"--model",
			model,
			"--thinking",
			RESUME_THINKING,
			"--system-prompt",
			RESUME_SYSTEM,
			prompt,
		],
		{ timeout: RESUME_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
		(error, stdout) => (error ? reject(error) : resolve(stdout)),
	);
	// `omp -p` also reads a piped stdin until EOF; close it so the prompt argument is used right away.
	child.stdin?.end();
	return promise;
}

/** Box with a title in the top border, sized to its content and clamped to the terminal width. */
function renderResumeBox(bullets: readonly string[], width: number): string[] {
	const title = " Session resume ";
	const rows = bullets.map(b => `${theme.fg("accent", "•")} ${b}`);
	const contentWidth = Math.max(visibleWidth(title) + 1, ...rows.map(r => visibleWidth(r)));
	const inner = Math.max(visibleWidth(title) + 1, Math.min(contentWidth, width - 4));
	const border = (s: string) => theme.fg("borderMuted", s);
	const lines = [
		border("╭─") + theme.fg("accent", title) + border(`${"─".repeat(Math.max(0, inner - visibleWidth(title)))}─╮`),
	];
	for (const row of rows) {
		const cell = truncateToWidth(row, inner);
		lines.push(`${border("│")} ${cell}${" ".repeat(Math.max(0, inner - visibleWidth(cell)))} ${border("│")}`);
	}
	lines.push(border(`╰${"─".repeat(inner + 2)}╯`));
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("cursor", { usage: cursorPeriodUsage });

	const spawned = new Set<string>();
	let anonymousSpawns = 0;
	let limitsInFlight = false;
	let limitsLine: string | undefined;
	let bullets: string[] = [];
	let resumeAbort: AbortController | undefined;
	const lastStatus = new Map<string, string | undefined>();

	const setStatus = (ctx: ExtensionContext, key: string, text: string | undefined) => {
		if (lastStatus.has(key) && lastStatus.get(key) === text) return;
		lastStatus.set(key, text);
		ctx.ui.setStatus(key, text);
	};

	const isMainTui = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui" && ctx.agent?.kind !== "sub";

	const renderPanel = (ctx: ExtensionContext) => {
		if (bullets.length === 0 && limitsLine === undefined) {
			ctx.ui.setWidget(WIDGET_PANEL, undefined);
			return;
		}
		const snapshot = { bullets: [...bullets], limitsLine };
		ctx.ui.setWidget(
			WIDGET_PANEL,
			() => ({
				render(width: number): string[] {
					const lines = snapshot.bullets.length > 0 ? renderResumeBox(snapshot.bullets, width) : [];
					if (snapshot.limitsLine) lines.push(truncateToWidth(` ${snapshot.limitsLine}`, width));
					return lines;
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	};

	const renderContext = (ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (!window) return setStatus(ctx, KEY_CONTEXT, undefined);
		const used = usage?.tokens;
		const level = used === undefined ? "success" : levelColor(used / window);
		const color = level === "success" ? "statusLineContext" : level;
		const text = `${used === undefined ? "?" : formatTokens(used)}/${formatTokens(window)}`;
		setStatus(ctx, KEY_CONTEXT, `${theme.fg("dim", "ctx")} ${theme.fg(color, text)}`);
	};

	const renderAgents = (ctx: ExtensionContext) => {
		const count = spawned.size + anonymousSpawns;
		if (count === 0) return setStatus(ctx, KEY_AGENTS, undefined);
		const robots = count <= MAX_ROBOTS ? ROBOT.repeat(count) : `${ROBOT}×${count}`;
		setStatus(ctx, KEY_AGENTS, `${robots} ${theme.fg("statusLineSubagents", `${count}`)}`);
	};

	const refreshLimits = async (ctx: ExtensionContext) => {
		if (limitsInFlight) return;
		limitsInFlight = true;
		try {
			const line = renderLimits(await fetchUsage());
			if (line === limitsLine) return;
			limitsLine = line;
			renderPanel(ctx);
		} finally {
			limitsInFlight = false;
		}
	};

	const refreshResume = async (ctx: ExtensionContext) => {
		const current = ctx.model;
		if (!current) return;
		const entries = ctx.sessionManager.getBranch();
		const state = resumeState(entries);
		const { text, lastId } = transcriptSince(entries, state.through);
		if (!text.trim() || !lastId) return;
		const model = pickResumeModel(current, ctx.models.list());
		const prompt = `Current session resume:\n${state.bullets.length > 0 ? state.bullets.map(b => `- ${b}`).join("\n") : "(empty)"}\n\nNew activity since the current resume:\n${text}\n\n${RESUME_RULES}`;
		resumeAbort?.abort();
		const abort = new AbortController();
		resumeAbort = abort;
		try {
			const next = parseBullets(await runResumeModel(model, prompt, abort.signal));
			if (abort.signal.aborted || next.length === 0) return;
			bullets = next;
			pi.appendEntry(RESUME_ENTRY, { bullets, through: lastId } satisfies ResumeState);
			renderPanel(ctx);
		} catch {
			// Failed, timed out, or superseded by a newer run: keep the previous resume.
		} finally {
			if (resumeAbort === abort) resumeAbort = undefined;
		}
	};

	/** Rebuilds per-session state: subagent count restarts, the resume is read back from the session file. */
	const loadSession = (ctx: ExtensionContext) => {
		resumeAbort?.abort();
		spawned.clear();
		anonymousSpawns = 0;
		bullets = resumeState(ctx.sessionManager.getBranch()).bullets;
		renderAgents(ctx);
		renderContext(ctx);
		renderPanel(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!isMainTui(ctx)) return;
		loadSession(ctx);
		void refreshLimits(ctx);
		ctx.setInterval(() => renderContext(ctx), CONTEXT_POLL_MS);
		ctx.setInterval(() => refreshLimits(ctx), LIMITS_POLL_MS);
	});

	for (const name of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(name, async (_event, ctx) => {
			if (isMainTui(ctx)) loadSession(ctx);
		});
	}

	pi.on("session_shutdown", async () => {
		resumeAbort?.abort();
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (!isMainTui(ctx)) return;
		if (event.spawnKey) spawned.add(event.spawnKey);
		else anonymousSpawns++;
		renderAgents(ctx);
	});

	for (const name of ["turn_end", "tool_execution_end", "session_compact", "session_clear"] as const) {
		pi.on(name, async (_event, ctx) => {
			if (isMainTui(ctx)) renderContext(ctx);
		});
	}

	pi.on("agent_end", async (_event, ctx) => {
		if (!isMainTui(ctx)) return;
		renderContext(ctx);
		void refreshLimits(ctx);
		void refreshResume(ctx);
	});
}
