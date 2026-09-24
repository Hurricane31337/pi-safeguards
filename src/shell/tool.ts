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
	if (settings.commandPolicy === "allow-all") {
		return "Command policy: ALL commands are currently allowed to run (no whitelist), per user settings.";
	}
	if (settings.allowedCommands.length > 0) {
		return `Additionally allowed by user settings: ${settings.allowedCommands.join(", ")}.`;
	}
	return "";
}

export function createEmulatedBashTool(root: string): ToolDefinition<typeof bashSchema, BashDetails> {
	const policyNote = describeCommandPolicy();
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute shell commands using a built-in emulator (no bash required on Windows). " +
			`Supported commands: ${SUPPORTED_COMMANDS.join(", ")} — grep [-rnilv], sed -n 'X,Yp', wc -l, ` +
			"head -n, tail -n, find [-name] [-type f/d] [-maxdepth], cat, ls, cd, rm [-rf], mv, echo, pwd. " +
			"Glob patterns like *.py are expanded for wc, rm and mv. " +
			"git is forwarded to the system-installed git executable (requires git on PATH). " +
			"Pipe chaining with | is supported, and ; / && / newlines separate statements " +
			"(cd changes the directory for statements after it in the same command). " +
			"cd, rm and mv can only reach the project directory and below. " +
			(policyNote ? `${policyNote} ` : "") +
			"Some commands may require user confirmation before running, per user settings. " +
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
