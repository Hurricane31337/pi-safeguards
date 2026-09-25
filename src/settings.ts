/**
 * User-configurable policy for the bash emulator, read from safeguards.json.
 *
 * There is no pi-core API for extension settings (see pi-improved and
 * pi-label_intern for the same non-pattern); this is a hand-rolled file this
 * extension owns entirely, mirroring how the IDE already treats models.json.
 *
 * Location: PI_SAFEGUARDS_JSON_PATH when set, else <getAgentDir()>/safeguards.json.
 * The env var exists because getAgentDir() is *not* aware of patch
 * 0003-flat-config-layout (pi-IDE-Extensions Label/RepoChat branches): that
 * patch moves models.json/auth.json/settings.json to a flat directory but
 * leaves getAgentDir() itself returning the old nested .../agent/ path (see
 * that patch's config.ts diff — getModelsPath()/getAuthPath() bypass
 * getAgentDir() entirely, but nothing else does). Deriving the same
 * branch-specific split independently here previously landed on the wrong
 * directory on those two branches, silently no-opping every setting. The
 * IDE host sets the env var to AgentPaths.SafeguardsJsonPath, which is
 * already correct per branch; a terminal session has no host to set it and
 * falls back to getAgentDir(), which is correct there since unpatched pi
 * never runs under a branded config layout.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * "deny": refused outright, no prompt, ever.
 * "ask": prompted via confirm-guard.ts's dialog; runs (via argv, no shell for
 *   an external command) only on approval.
 * "allow": runs immediately, no prompt.
 */
export type CommandState = "deny" | "ask" | "allow";

export interface SafeguardsSettings {
	/**
	 * Explicit per-command override, keyed by program name (e.g. "rm", "npm",
	 * "python") — the single place to make one specific command possible or
	 * not, and if possible, ask or always allow. Applies to a built-in
	 * emulated command exactly the same as an external one: naming "rm" here
	 * with "deny" refuses it even though it is normally always available, and
	 * naming "npm" with "allow" runs it (via argv, no shell) without asking,
	 * even though it is not built in.
	 *
	 * A name absent from this map falls back to "allow" for a built-in
	 * emulated command, or to defaultPolicy for anything else — there is
	 * deliberately no separate hardcoded interpreter blocklist: defaultPolicy
	 * governs python/node/curl/etc., and a specific one of them can be
	 * allowed or asked about individually here without having to loosen the
	 * policy for everything else.
	 */
	commands: Record<string, CommandState>;
	/** Governs any command that is neither a built-in emulated one nor named in `commands`. */
	defaultPolicy: CommandState;
}

/**
 * The shipped baseline: every built-in emulated command explicit (even the
 * ones that would resolve to "allow" anyway, since that is only true as long
 * as it stays a built-in - see commandState()), `git`/`mv`/`rm` requiring
 * confirmation as the destructive/networked ones, and defaultPolicy "ask" so
 * an unlisted command (python, npm, curl, …) is confirmed rather than
 * silently refused or silently run. This is what a fresh install starts
 * from - loadSafeguardsSettings() falls back to it verbatim when
 * safeguards.json is missing or malformed, and /safeguards edits it from
 * there.
 */
export const DEFAULT_SAFEGUARDS_SETTINGS: SafeguardsSettings = {
	commands: {
		cat: "allow",
		cd: "allow",
		echo: "allow",
		find: "allow",
		git: "ask",
		grep: "allow",
		head: "allow",
		ls: "allow",
		mv: "ask",
		pwd: "allow",
		rm: "ask",
		sed: "allow",
		sort: "allow",
		tail: "allow",
		uniq: "allow",
		wc: "allow",
	},
	defaultPolicy: "ask",
};

/**
 * "Program" names commandState() accepts that are not something a model
 * would ever type as argv[0] - they name an emulator *behaviour* instead,
 * gated by the exact same deny/ask/allow machinery as a real command so it
 * doesn't become an ungoverned special case. "redirect" is the only one
 * today: a `>`/`>>` write (execute.ts's applyRedirect(), confirm-guard.ts's
 * programsIn()). Listed here, not just used as a string literal at each call
 * site, so /safeguards' no-args listing (command.ts's describePolicy) can
 * surface it even with no override set - otherwise a pseudo-command with no
 * entry in `commands` is invisible to a user who has no way to guess it
 * exists.
 */
export const REDIRECT_COMMAND = "redirect";
export const PSEUDO_COMMANDS = [REDIRECT_COMMAND] as const;

export function getSafeguardsJsonPath(): string {
	return process.env.PI_SAFEGUARDS_JSON_PATH || join(getAgentDir(), "safeguards.json");
}

function isCommandState(value: unknown): value is CommandState {
	return value === "deny" || value === "ask" || value === "allow";
}

/**
 * Re-read on every call rather than cached: settings can change while a
 * session is running (edited through the IDE's settings panel), and the
 * file is small enough that a sync read costs nothing next to spawning a
 * process. A missing or malformed file quietly falls back to the shipped
 * defaults — this is a convenience knob, not something that should be able
 * to break the tool by being absent or briefly invalid mid-edit.
 */
export function loadSafeguardsSettings(path: string = getSafeguardsJsonPath()): SafeguardsSettings {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<Record<keyof SafeguardsSettings, unknown>>;

		const commands: Record<string, CommandState> = {};
		if (parsed.commands && typeof parsed.commands === "object") {
			for (const [name, state] of Object.entries(parsed.commands as Record<string, unknown>)) {
				const trimmed = name.trim();
				if (trimmed && isCommandState(state)) commands[trimmed] = state;
			}
		}

		return {
			commands,
			defaultPolicy: isCommandState(parsed.defaultPolicy)
				? parsed.defaultPolicy
				: DEFAULT_SAFEGUARDS_SETTINGS.defaultPolicy,
		};
	} catch {
		// A fresh copy, not the DEFAULT_SAFEGUARDS_SETTINGS singleton itself:
		// the /safeguards command mutates the settings it gets back before
		// saving, and callers comparing against DEFAULT_SAFEGUARDS_SETTINGS
		// (toEqual, not toBe) must not be able to corrupt it by reference.
		return {
			commands: { ...DEFAULT_SAFEGUARDS_SETTINGS.commands },
			defaultPolicy: DEFAULT_SAFEGUARDS_SETTINGS.defaultPolicy,
		};
	}
}

/**
 * Persists settings to disk, creating the config directory if it does not
 * exist yet (a fresh install has no safeguards.json until something writes
 * one). The only caller today is the `/safeguards` command; nothing else in
 * this extension mutates settings, and loadSafeguardsSettings() keeps
 * re-reading the file rather than caching it, so a save here is visible to
 * the very next tool_call.
 */
export function saveSafeguardsSettings(settings: SafeguardsSettings, path: string = getSafeguardsJsonPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}

/**
 * Resolves the effective state for one command name. `builtins` is passed in
 * (rather than imported from shell/execute.ts) to avoid a circular import -
 * execute.ts already imports this module for SafeguardsSettings itself.
 */
export function commandState(program: string, settings: SafeguardsSettings, builtins: readonly string[]): CommandState {
	const explicit = settings.commands[program];
	if (explicit) return explicit;
	return builtins.includes(program) ? "allow" : settings.defaultPolicy;
}
