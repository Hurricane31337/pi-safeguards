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

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	 * emulated command (today's default), or to defaultPolicy for anything
	 * else — there is deliberately no separate hardcoded interpreter
	 * blocklist any more: defaultPolicy "deny" (the shipped default) already
	 * refuses python/node/curl/etc. exactly as before, and a specific one of
	 * them can be allowed or asked about individually here without having to
	 * loosen the policy for everything else.
	 */
	commands: Record<string, CommandState>;
	/** Governs any command that is neither a built-in emulated one nor named in `commands`. */
	defaultPolicy: CommandState;
}

export const DEFAULT_SAFEGUARDS_SETTINGS: SafeguardsSettings = {
	commands: {},
	defaultPolicy: "deny",
};

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
			defaultPolicy: isCommandState(parsed.defaultPolicy) ? parsed.defaultPolicy : "deny",
		};
	} catch {
		return DEFAULT_SAFEGUARDS_SETTINGS;
	}
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
