/**
 * Deny/ask enforcement, driven by settings.ts's per-command `commands` map and
 * `defaultPolicy`: a command's effective state ("deny"/"ask"/"allow", see
 * commandState()) decides whether it is blocked outright with no prompt at
 * all, prompted via the confirm dialog, or let straight through.
 *
 * Two tool_call cases, because grep/find/ls exist twice over: pi-label_intern
 * activates them as native tools *and* the bash emulator can run them as
 * shell commands, and a model asked to "search for X" or "list files"
 * reaches for the native tool, not bash - the emulator's own refusal
 * message even points it there ("Oder nutze die nativen pi-Tools: read,
 * write, edit, grep, find, ls"). rm/mv/cd/etc. have no native equivalent, so
 * they can only arrive via the bash case; grep/find/ls need both cases
 * checked or a "deny"/"ask" state on them would silently never apply.
 *
 * pi's tool_call hook is awaited before the tool runs (see pi's own shipped
 * examples/extensions/permission-gate.ts), and ctx.ui.confirm() works
 * identically in RPC mode - the Visual Studio host already renders the
 * confirm dialog for the extension_ui_request/response protocol. So this
 * needs no host-side or core changes: it is exactly the pattern pi's docs
 * list "confirm dangerous commands" as an extension use case for.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandState, loadSafeguardsSettings, REDIRECT_COMMAND, type SafeguardsSettings } from "./settings.ts";
import { SUPPORTED_COMMANDS } from "./shell/execute.ts";
import {
	extractHeredocs,
	extractRedirect,
	heredocBodyFor,
	parseArgs,
	splitByPipes,
	splitStatements,
	splitTimePrefix,
} from "./shell/parse.ts";

/** Native pi tool names that duplicate an emulated bash command (see module doc). */
const NATIVE_TOOLS_WITH_BASH_EQUIVALENT = new Set(["grep", "find", "ls"]);

/** `/dev/null` and Windows' `nul` both mean "discard", not a real write worth asking about. */
function isNullTarget(target: string): boolean {
	return target === "/dev/null" || target.toLowerCase() === "nul";
}

/**
 * Every program name a command string would invoke, including `cd` and, for
 * a real (non-null) `>`/`>>` target, the pseudo-program "redirect" - the
 * same name execute.ts's applyRedirect() checks commandState() against, so a
 * command that would write a file is asked/denied exactly like any other
 * command, not silently exempted because it arrives as shell syntax rather
 * than a program name. Must mirror execute.ts's heredoc/redirect handling
 * exactly (extractHeredocs before splitStatements, extractRedirect per
 * statement) - two independent implementations of "what will this command
 * actually do" is exactly the kind of drift that quietly reopens the gap
 * this function exists to close.
 */
function programsIn(command: string): string[] {
	const programs: string[] = [];
	const { rewritten, bodies } = extractHeredocs(command);
	for (const timedStatement of splitStatements(rewritten)) {
		const statement = splitTimePrefix(timedStatement).rest;
		const cdMatch = statement.match(/^cd(?:\s+.+)?$/s);
		if (cdMatch) {
			programs.push("cd");
			continue;
		}

		const redirect = extractRedirect(statement);
		if (redirect && !isNullTarget(redirect.target)) programs.push(REDIRECT_COMMAND);
		const toInspect = redirect ? redirect.command : statement;

		for (const segment of splitByPipes(toInspect)) {
			const { cleaned } = heredocBodyFor(segment, bodies);
			const withoutStderrRedirect = cleaned
				.replace(/\s+2>\/dev\/null/g, "")
				.replace(/\s+2>\s*nul\b/gi, "")
				.trim();
			const args = parseArgs(withoutStderrRedirect);
			if (args.length > 0) programs.push(args[0]);
		}
	}
	return programs;
}

/** Asks the user, failing closed with no UI to ask; shared by both tool_call cases. */
async function confirmOrBlock(
	ctx: ExtensionContext,
	message: string,
): Promise<{ block: true; reason: string } | undefined> {
	// No host to ask means no way to get a real answer - fail closed rather than
	// either hang or silently run something the user asked to be asked about
	// (the same fallback pi's own permission-gate.ts example uses).
	if (!ctx.hasUI) {
		return { block: true, reason: "Bestätigung erforderlich, aber keine UI verfügbar - Befehl abgelehnt." };
	}
	const approved = await ctx.ui.confirm("Befehl bestätigen", message);
	return approved ? undefined : { block: true, reason: "Vom Benutzer abgelehnt." };
}

function state(program: string, settings: SafeguardsSettings) {
	return commandState(program, settings, SUPPORTED_COMMANDS);
}

export function registerConfirmGuard(pi: ExtensionAPI, settingsPath?: string): void {
	pi.on("tool_call", async (event, ctx) => {
		// settingsPath is a test seam (defaults to the real settings.json path via
		// loadSafeguardsSettings's own default parameter); production never passes it.
		const settings = loadSafeguardsSettings(settingsPath);

		if (event.toolName === "bash") {
			const input = event.input as { command?: string } | undefined;
			const command = input?.command?.trim();
			if (!command) return undefined;

			const programs = programsIn(command);
			const states = programs.map((program) => state(program, settings));

			// A denied program blocks the whole command immediately, no prompt at
			// all - the point of "deny" is exactly to avoid ever waiting on a human
			// for this one; execute.ts refuses it too (defense in depth), but
			// stopping here also skips a pointless dialog for a command that could
			// never have run anyway.
			const deniedAt = states.indexOf("deny");
			if (deniedAt !== -1) {
				return { block: true, reason: `'${programs[deniedAt]}' ist deaktiviert (Einstellungen).` };
			}

			if (!states.includes("ask")) return undefined;
			return confirmOrBlock(ctx, `Der Agent möchte ausführen:\n\n${command}`);
		}

		if (NATIVE_TOOLS_WITH_BASH_EQUIVALENT.has(event.toolName)) {
			const toolState = state(event.toolName, settings);
			if (toolState === "deny") {
				return { block: true, reason: `'${event.toolName}' ist deaktiviert (Einstellungen).` };
			}
			if (toolState !== "ask") return undefined;

			const argsText = JSON.stringify(event.input ?? {}, null, 2);
			return confirmOrBlock(ctx, `Der Agent möchte das Werkzeug "${event.toolName}" aufrufen:\n\n${argsText}`);
		}

		return undefined;
	});
}
