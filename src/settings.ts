/**
 * User-configurable policy for the bash emulator, read from
 * <agent config dir>/safeguards.json — the same directory pi itself keeps
 * models.json/auth.json/settings.json in (getAgentDir()), so this file lands
 * in the right place whether pi-safeguards runs standalone in a terminal or
 * inside the IDE, and follows the branded config-dir patches automatically.
 *
 * There is no pi-core API for extension settings (see pi-improved and
 * pi-label_intern for the same non-pattern); this is a hand-rolled file this
 * extension owns entirely, mirroring how the IDE already treats models.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CommandPolicy = "whitelist" | "allow-all";

export interface SafeguardsSettings {
	/**
	 * "whitelist" (default): only the built-in emulated commands, plus
	 * anything named in allowedCommands, may run. "allow-all": any command
	 * name is spawned via argv (still no real shell — no pipes/redirects/
	 * subshells beyond what the emulator itself parses) — including the
	 * interpreters normally refused (python, node, curl, sh, ...). This is a
	 * deliberate escape hatch for a fully-trusted setup, not a safer default.
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
	return join(getAgentDir(), "safeguards.json");
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
			commandPolicy: parsed.commandPolicy === "allow-all" ? "allow-all" : "whitelist",
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
