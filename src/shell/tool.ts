/**
 * The `bash` tool, registered under pi's own name so it replaces the built-in.
 *
 * This is the one place where the design rule ("never reimplement a pi
 * behaviour we only want to adjust") is deliberately broken: pi's bash spawns a
 * real shell, and the whole point here is that no real shell exists. What we do
 * keep is pi's *contract* — same tool name, same parameters, same truncation
 * and temp-file spill (see output.ts) — so a session behaves the same whether
 * or not this extension is loaded, right up to the moment a command outside the
 * whitelist is attempted.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { loadSafeguardsSettings } from "../settings.ts";
import { executeShellCommand, SUPPORTED_COMMANDS } from "./execute.ts";
import { truncateShellOutput } from "./output.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "The shell command to execute." }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout ms (not enforced in emulation, accepted for API compatibility)." }),
	),
});

export type SafeguardBashInput = Static<typeof bashSchema>;

interface BashDetails {
	command: string;
	error?: string;
}

/**
 * Describes exactly what this session's settings.json currently permits, read
 * once at tool registration (session start). If settings.json changes while
 * the session is running, enforcement (execute.ts) picks it up immediately,
 * but this description does not update until the next restart - the same
 * lag the IDE's model/thinking-level settings already have.
 */
function describeCommandPolicy(): string {
	const settings = loadSafeguardsSettings();
	const denied = Object.entries(settings.commands)
		.filter(([, s]) => s === "deny")
		.map(([name]) => name);
	const asked = Object.entries(settings.commands)
		.filter(([, s]) => s === "ask")
		.map(([name]) => name);
	const allowed = Object.entries(settings.commands)
		.filter(([, s]) => s === "allow")
		.map(([name]) => name);

	const parts: string[] = [];
	if (denied.length > 0) parts.push(`disabled: ${denied.join(", ")}`);
	if (asked.length > 0) parts.push(`require approval: ${asked.join(", ")}`);
	if (allowed.length > 0) parts.push(`explicitly allowed: ${allowed.join(", ")}`);

	const defaultNote =
		settings.defaultPolicy === "allow"
			? "Any other command not built in is also allowed to run."
			: settings.defaultPolicy === "ask"
				? "Any other command not built in requires approval first."
				: "Any other command not built in is refused.";

	return parts.length > 0 ? `Command policy, per user settings: ${parts.join("; ")}. ${defaultNote}` : defaultNote;
}

export function createEmulatedBashTool(root: string): ToolDefinition<typeof bashSchema, BashDetails> {
	const policyNote = describeCommandPolicy();
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute shell commands using a built-in emulator (no bash required on Windows). " +
			`Supported commands: ${SUPPORTED_COMMANDS.join(", ")} — grep [-rnilvc] [-e PATTERN]... [--include=GLOB] ` +
			'(-c with an empty pattern counts every line, like real grep -c ""; \\( \\) \\{ \\} \\| \\+ \\? act ' +
			"as the special ERE form even without -E, like real BRE grep; repeating -e ORs the patterns " +
			"together; other GNU long options like --word-regexp or --context are not implemented and are " +
			"silently ignored rather than erroring - stick to the flags listed here), " +
			"sed -n 'X,Yp', wc -l, uniq [-c] [-d] [-u], sort [-r] [-u] [-n], printf 'fmt' [args...] " +
			"(\\n/\\t escapes and %s/%d/%f/%o/%x/%X substitution, repeating the format over extra args like " +
			"real printf), head -n, tail -n (accept one or more file arguments, or stdin, with an " +
			"==> name <== header per file when given more than one), find [-name] [-type f/d] [-maxdepth] " +
			"(paths are root-relative, like ./src/x), cat (reads stdin when given no file, like real cat in " +
			"a `x | cat` pass-through), ls [-d], cd, rm [-rf], mv, echo, pwd. " +
			"Glob patterns like *.py are expanded for wc, rm and mv. " +
			"git is forwarded to the system-installed git executable (requires git on PATH). " +
			"Pipe chaining with | is supported, and ; / && / newlines separate statements " +
			"(cd changes the directory for statements after it in the same command); there are no exit " +
			"codes, so && never skips a later statement even if an earlier one failed. " +
			"cd, rm and mv can only reach the project directory and below; cd to a nonexistent path or a " +
			'file reports "cd: no such file or directory" and does not move, same as real cd. ' +
			"There is no $VAR expansion or FOO=bar assignment syntax anywhere - a literal $VAR or " +
			"FOO=bar in a command is passed through as-is, not expanded or executed as an assignment. " +
			"Output redirection with > (overwrite) and >> (append) is supported and stays inside the " +
			"project directory like every other command; writes are UTF-8 — for a file that must keep " +
			"its original encoding, use the write/edit tools instead. Only stdout redirection is " +
			"recognised (not 2> to a real file). " +
			"A heredoc (<<'EOF' ... EOF) is supported as a command's stdin, e.g. for piping a script " +
			"into python -; it must be the last thing on its line and needs a line containing only the " +
			"delimiter (whitespace trimmed) to close it - the whole block, including the closing " +
			"delimiter, may be indented for readability, and that indent is stripped from the body. " +
			"For writing a file's contents, prefer the write/edit tools. " +
			(policyNote ? `${policyNote} ` : "") +
			"Some commands may require user confirmation before running, per user settings - this " +
			'includes redirecting output to a file, governed the same way as any other command under the name "redirect". ' +
			"Output is truncated to the last 2000 lines or 50KB (whichever is hit first); when that " +
			"happens the full output is written to a temp file named in the result, which you can " +
			"inspect with read or sed -n 'X,Yp'.",
		parameters: bashSchema,

		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const command = (params.command ?? "").trim();
			// The sandbox root follows the session cwd, so opening another
			// solution in the IDE re-anchors it without restarting the agent.
			const cwd = ctx?.cwd ?? root;
			try {
				// Pipe stages see the full stream; only the final result is capped.
				const output = truncateShellOutput(executeShellCommand(command, cwd, cwd));
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { command },
				};
			} catch (error) {
				const message = (error as Error).message;
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { command, error: message },
				};
			}
		},
	};
}
