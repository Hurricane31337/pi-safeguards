/**
 * `/safeguards` — the only way to change the bash-emulator command policy
 * from a terminal session (see TODO-safeguards-slash-command.md for why this
 * was missing: the IDE's Model Settings panel and hand-editing safeguards.json
 * were previously the only two options, and pi-safeguards is explicitly meant
 * to also run standalone in the TUI).
 *
 * Syntax:
 *   /safeguards                    - show the current policy
 *   /safeguards <command>          - show one command's effective state
 *   /safeguards <command> <state>  - set an override (state: deny/ask/allow)
 *   /safeguards <command> clear    - remove the override, falling back to the
 *                                    built-in default or defaultPolicy
 *   /safeguards default <state>    - set defaultPolicy itself
 *
 * loadSafeguardsSettings() re-reads the file on every tool_call (see
 * settings.ts), so a change made here takes effect on the very next
 * bash/grep/find/ls call, no restart needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CommandState,
	commandState,
	loadSafeguardsSettings,
	type SafeguardsSettings,
	saveSafeguardsSettings,
} from "./settings.ts";
import { SUPPORTED_COMMANDS } from "./shell/execute.ts";

const STATES: readonly CommandState[] = ["deny", "ask", "allow"];

function isCommandState(value: string): value is CommandState {
	return (STATES as readonly string[]).includes(value);
}

function describePolicy(settings: SafeguardsSettings): string {
	const entries = Object.entries(settings.commands).sort(([a], [b]) => a.localeCompare(b));
	const lines = [`defaultPolicy: ${settings.defaultPolicy}`];
	if (entries.length === 0) {
		lines.push("No per-command overrides set.");
	} else {
		lines.push("Overrides:");
		for (const [name, state] of entries) lines.push(`  ${name}: ${state}`);
	}
	return lines.join("\n");
}

export function registerSafeguardsCommand(pi: ExtensionAPI, settingsPath?: string): void {
	pi.registerCommand("safeguards", {
		description: "View or change the bash-emulator command policy (deny/ask/allow)",

		getArgumentCompletions: (argumentPrefix) => {
			const trimmed = argumentPrefix.replace(/^\s+/, "");
			const spaceIndex = trimmed.indexOf(" ");

			if (spaceIndex === -1) {
				const known = new Set<string>(["default", ...SUPPORTED_COMMANDS]);
				for (const name of Object.keys(loadSafeguardsSettings(settingsPath).commands)) known.add(name);
				const candidates = [...known].filter((name) => name.startsWith(trimmed)).sort();
				return candidates.length > 0 ? candidates.map((value) => ({ value, label: value })) : null;
			}

			const command = trimmed.slice(0, spaceIndex);
			const statePrefix = trimmed.slice(spaceIndex + 1);
			const options = command === "default" ? STATES : [...STATES, "clear"];
			const candidates = options.filter((state) => state.startsWith(statePrefix));
			return candidates.length > 0
				? candidates.map((state) => ({ value: `${command} ${state}`, label: `${command} ${state}` }))
				: null;
		},

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const settings = loadSafeguardsSettings(settingsPath);

			if (parts.length === 0) {
				ctx.ui.notify(describePolicy(settings), "info");
				return;
			}

			const [name, rawState] = parts;

			if (name === "default") {
				if (!rawState) {
					ctx.ui.notify(`defaultPolicy is currently "${settings.defaultPolicy}".`, "info");
					return;
				}
				if (!isCommandState(rawState)) {
					ctx.ui.notify(`Invalid state "${rawState}" - use deny, ask, or allow.`, "error");
					return;
				}
				settings.defaultPolicy = rawState;
				saveSafeguardsSettings(settings, settingsPath);
				ctx.ui.notify(`defaultPolicy set to "${rawState}".`, "info");
				return;
			}

			if (!rawState) {
				const explicit = settings.commands[name];
				const effective = commandState(name, settings, SUPPORTED_COMMANDS);
				ctx.ui.notify(
					explicit
						? `'${name}' is explicitly set to "${explicit}".`
						: `'${name}' has no override - effective state is "${effective}" (${
								(SUPPORTED_COMMANDS as readonly string[]).includes(name) ? "built-in default" : "defaultPolicy"
							}).`,
					"info",
				);
				return;
			}

			if (rawState === "clear" || rawState === "reset") {
				if (name in settings.commands) {
					delete settings.commands[name];
					saveSafeguardsSettings(settings, settingsPath);
					ctx.ui.notify(`Override for '${name}' removed.`, "info");
				} else {
					ctx.ui.notify(`'${name}' has no override to remove.`, "info");
				}
				return;
			}

			if (!isCommandState(rawState)) {
				ctx.ui.notify(`Invalid state "${rawState}" - use deny, ask, allow, or clear.`, "error");
				return;
			}

			settings.commands[name] = rawState;
			saveSafeguardsSettings(settings, settingsPath);
			ctx.ui.notify(`'${name}' set to "${rawState}".`, "info");
		},
	});
}
