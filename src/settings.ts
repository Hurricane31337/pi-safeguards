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

export type CommandPolicy = "whitelist" | "ask" | "allow-all";

export interface SafeguardsSettings {
	/**
	 * Governs any command that is neither one of the built-in emulated ones
	 * nor named in allowedCommands:
	 *   - "whitelist" (default): refused outright, no prompt. Fully autonomous,
	 *     but limited to the built-in set plus whatever was named ahead of time.
	 *   - "ask": prompted via the same confirm dialog as confirmCommands/
	 *     confirmAll, run (via argv, no shell) only on approval. Interactive,
	 *     but nothing runs unattended that was not explicitly pre-approved.
	 *   - "allow-all": run immediately, no prompt — including the interpreters
	 *     normally refused (python, node, curl, sh, ...). A deliberate escape
	 *     hatch for a fully-trusted setup, not a safer default.
	 * "ask" and "allow-all" both bypass the interpreter refusal in execute.ts;
	 * they differ only in whether confirm-guard.ts asks first.
	 */
	commandPolicy: CommandPolicy;
	/**
	 * Extra command names allowed to run (spawned via argv) even in
	 * "whitelist" mode. Naming one explicitly here overrides the interpreter
	 * refusal for that name specifically — this is the "only allow certain
	 * commands" knob, distinct from the all-or-nothing commandPolicy switch.
	 */
	allowedCommands: string[];
	/** Command names that always prompt for confirmation before running. */
	confirmCommands: string[];
	/** Prompt before every bash call, regardless of confirmCommands. */
	confirmAll: boolean;
}

export const DEFAULT_SAFEGUARDS_SETTINGS: SafeguardsSettings = {
	commandPolicy: "whitelist",
	allowedCommands: [],
	confirmCommands: [],
	confirmAll: false,
};

export function getSafeguardsJsonPath(): string {
	return process.env.PI_SAFEGUARDS_JSON_PATH || join(getAgentDir(), "safeguards.json");
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
		const parsed = JSON.parse(raw) as Partial<SafeguardsSettings>;
		return {
			commandPolicy:
				parsed.commandPolicy === "allow-all" ? "allow-all" : parsed.commandPolicy === "ask" ? "ask" : "whitelist",
			allowedCommands: Array.isArray(parsed.allowedCommands)
				? parsed.allowedCommands.filter((c) => typeof c === "string")
				: [],
			confirmCommands: Array.isArray(parsed.confirmCommands)
				? parsed.confirmCommands.filter((c) => typeof c === "string")
				: [],
			confirmAll: parsed.confirmAll === true,
		};
	} catch {
		return DEFAULT_SAFEGUARDS_SETTINGS;
	}
}
