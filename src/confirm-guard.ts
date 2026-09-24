/**
 * Confirmation prompts, configured through settings.ts: confirmCommands /
 * confirmAll always ask about the commands named there, and commandPolicy
 * "ask" additionally asks about any bash command that is neither built in
 * nor explicitly named in allowedCommands (as opposed to "whitelist", which
 * refuses those outright, or "allow-all", which runs them without asking).
 *
 * Two tool_call cases, because grep/find/ls exist twice over: pi-label_intern
 * activates them as native tools *and* the bash emulator can run them as
 * shell commands, and a model asked to "search for X" or "list files"
 * reaches for the native tool, not bash - the emulator's own refusal
 * message even points it there ("Oder nutze die nativen pi-Tools: read,
 * write, edit, grep, find, ls"). rm/mv/cd/etc. have no native equivalent, so
 * they can only arrive via the bash case; grep/find/ls need both cases
 * checked or "confirm before grep" would silently never fire.
 *
 * pi's tool_call hook is awaited before the tool runs (see pi's own shipped
 * examples/extensions/permission-gate.ts), and ctx.ui.confirm() works
 * identically in RPC mode - the Visual Studio host already renders the
 * confirm dialog for the extension_ui_request/response protocol. So this
 * needs no host-side or core changes: it is exactly the pattern pi's docs
 * list "confirm dangerous commands" as an extension use case for.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSafeguardsSettings } from "./settings.ts";
import { SUPPORTED_COMMANDS } from "./shell/execute.ts";
import { parseArgs, splitByPipes, splitStatements } from "./shell/parse.ts";

/** Native pi tool names that duplicate an emulated bash command (see module doc). */
const NATIVE_TOOLS_WITH_BASH_EQUIVALENT = new Set(["grep", "find", "ls"]);

/** Every program name a command string would invoke, including `cd`. */
function programsIn(command: string): string[] {
	const programs: string[] = [];
	for (const statement of splitStatements(command)) {
		const cdMatch = statement.match(/^cd(?:\s+.+)?$/s);
		if (cdMatch) {
			programs.push("cd");
			continue;
		}
		for (const segment of splitByPipes(statement)) {
			const cleaned = segment
				.replace(/\s+2>\/dev\/null/g, "")
				.replace(/\s+>\s*\/dev\/null/g, "")
				.replace(/\s+2>\s*nul\b/gi, "")
				.replace(/\s+>\s*nul\b/gi, "")
				.trim();
			const args = parseArgs(cleaned);
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

			// "ask": anything neither built in nor explicitly pre-approved (allowedCommands)
			// gets a prompt here; execute.ts's dispatcher treats "ask" as unrestricted for
			// commands that get this far, since by then the user has already approved it.
			const isUnlisted = (program: string) =>
				!(SUPPORTED_COMMANDS as readonly string[]).includes(program) && !settings.allowedCommands.includes(program);
			const needsAskForUnlisted = settings.commandPolicy === "ask" && programs.some(isUnlisted);

			const needsConfirmation =
				settings.confirmAll ||
				programs.some((program) => settings.confirmCommands.includes(program)) ||
				needsAskForUnlisted;
			if (!needsConfirmation) return undefined;

			return confirmOrBlock(ctx, `Der Agent möchte ausführen:\n\n${command}`);
		}

		if (NATIVE_TOOLS_WITH_BASH_EQUIVALENT.has(event.toolName)) {
			const needsConfirmation = settings.confirmAll || settings.confirmCommands.includes(event.toolName);
			if (!needsConfirmation) return undefined;

			const argsText = JSON.stringify(event.input ?? {}, null, 2);
			return confirmOrBlock(ctx, `Der Agent möchte das Werkzeug "${event.toolName}" aufrufen:\n\n${argsText}`);
		}

		return undefined;
	});
}
