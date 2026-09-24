/**
 * The dispatcher: one command string in, one output string out.
 *
 * The whitelist is the security boundary. A program that is not in the switch
 * below simply does not run — there is no fallback to a real shell — so the
 * model cannot reach the filesystem except through the commands here, all of
 * which are anchored to the sandbox root.
 */

import { resolve } from "node:path";
import { isOutside } from "../paths.ts";
import { loadSafeguardsSettings, type SafeguardsSettings } from "../settings.ts";
import {
	execCat,
	execFind,
	execGrep,
	execHead,
	execLs,
	execMv,
	execRm,
	execSed,
	execTail,
	execWc,
} from "./commands.ts";
import { execExternal } from "./external.ts";
import { execGit } from "./git.ts";
import { parseArgs, splitByPipes, splitStatements } from "./parse.ts";

/** Commands available in the emulator, for the tool description and the refusal message. */
export const SUPPORTED_COMMANDS = [
	"grep",
	"sed",
	"wc",
	"head",
	"tail",
	"find",
	"cat",
	"ls",
	"echo",
	"pwd",
	"cd",
	"rm",
	"mv",
	"git",
] as const;

/**
 * Interpreters and shells that could execute arbitrary code or reach around the
 * path sandbox. They are named explicitly so the refusal says *why* and the
 * model stops looking for a workaround, rather than falling through to the
 * generic "not supported" message.
 */
const BLOCKED = new Set([
	"python",
	"python3",
	"python2",
	"py",
	"pip",
	"pip3",
	"node",
	"npm",
	"npx",
	"ruby",
	"perl",
	"php",
	"powershell",
	"pwsh",
	"cmd",
	"sh",
	"bash",
	"zsh",
	"fish",
	"curl",
	"wget",
	"Invoke-WebRequest",
]);

function executeSegment(
	segment: string,
	cwd: string,
	root: string,
	stdin: string | null,
	settings: SafeguardsSettings,
): string {
	// Redirections the emulator has no concept of; dropping them keeps the
	// common "2>/dev/null" idiom from turning into a bogus argument.
	const command = segment
		.replace(/\s+2>\/dev\/null/g, "")
		.replace(/\s+>\s*\/dev\/null/g, "")
		.replace(/\s+2>\s*nul\b/gi, "")
		.replace(/\s+>\s*nul\b/gi, "")
		.trim();

	const args = parseArgs(command);
	if (args.length === 0) return stdin ?? "";
	const program = args[0];

	// Naming a command in allowedCommands is an explicit per-command opt-in and
	// wins even over the interpreter refusal below - that refusal exists to stop
	// an unconsidered command from running, not to override a deliberate choice.
	const explicitlyAllowed = settings.allowedCommands.includes(program);

	if (BLOCKED.has(program) && !explicitlyAllowed && settings.commandPolicy !== "allow-all") {
		return (
			`[bash-emulator] '${program}' ist nicht verfuegbar.\n` +
			`Verwende stattdessen die eingebauten Werkzeuge: ${SUPPORTED_COMMANDS.join(", ")}\n` +
			"Oder nutze die nativen pi-Tools: read, write, edit, grep, find, ls"
		);
	}

	try {
		switch (program) {
			case "grep":
				return execGrep(args, cwd, root, stdin);
			case "sed":
				return execSed(args, cwd, root, stdin);
			case "wc":
				return execWc(args, cwd, root, stdin);
			case "head":
				return execHead(args, stdin);
			case "tail":
				return execTail(args, stdin);
			case "find":
				return execFind(args, cwd, root);
			case "cat":
				return execCat(args, cwd, root);
			case "ls":
				return execLs(args, cwd, root);
			case "rm":
				return execRm(args, cwd, root);
			case "mv":
				return execMv(args, cwd, root);
			case "echo":
				return args.slice(1).join(" ");
			case "pwd":
				return cwd.replace(/\\/g, "/");
			case "true":
			case "false":
				return "";
			case "printf":
				return args.slice(1).join(" ");
			case "git":
				return execGit(args, cwd, stdin);
			default:
				// Anything else: run for real, without a shell, only when settings
				// say to - either this exact name was opted into, or every command
				// is allowed. Otherwise it is simply not a command this emulator runs.
				if (explicitlyAllowed || settings.commandPolicy === "allow-all") {
					return execExternal(args, cwd, stdin);
				}
				return (
					`[bash-emulator] '${program}' wird nicht unterstuetzt.\n` +
					`Verfuegbar: ${SUPPORTED_COMMANDS.join(", ")}`
				);
		}
	} catch (error) {
		return `Error in ${program}: ${(error as Error).message}`;
	}
}

/** Strip one matching pair of surrounding quotes, e.g. from `cd "My Dir"`. */
function unquote(text: string): string {
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
	}
	return text;
}

/**
 * Execute a full command string. Statements are split on `;`, newlines and
 * `&&` (see splitStatements); `cd DIR` changes the working directory for every
 * statement after it in the same call — this is the only state the emulator
 * carries between statements, and it never survives past this one call, since
 * each tool invocation is re-anchored to the session's cwd (see tool.ts).
 * Within a statement, `|` chains segments through stdin as before.
 */
export function executeShellCommand(
	input: string,
	cwd: string,
	root: string,
	// Overridable so tests can inject a policy without touching the real
	// settings file; production callers (tool.ts) never pass this.
	settings: SafeguardsSettings = loadSafeguardsSettings(),
): string {
	let workingDir = cwd;
	const outputs: string[] = [];

	for (const statement of splitStatements(input)) {
		const cdMatch = statement.match(/^cd(?:\s+(.+))?$/s);
		if (cdMatch) {
			const arg = unquote((cdMatch[1] ?? "").trim());
			if (arg) {
				const target = resolve(workingDir, arg);
				// Silently ignored, like a `cd` that would leave the root always was:
				// the model gets an unrelated tool call to explain the containment,
				// not this one, since a refusal message here quotes the walked path.
				if (!isOutside(target, root)) workingDir = target;
			}
			continue;
		}

		let stdin: string | null = null;
		for (const segment of splitByPipes(statement)) {
			stdin = executeSegment(segment, workingDir, root, stdin, settings);
		}
		if (stdin !== null) outputs.push(stdin);
	}

	return outputs.join("\n");
}
