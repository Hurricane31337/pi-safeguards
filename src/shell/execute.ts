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
import { execCat, execFind, execGrep, execHead, execLs, execSed, execTail, execWc } from "./commands.ts";
import { execGit } from "./git.ts";
import { parseArgs, splitByPipes } from "./parse.ts";

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

function executeSegment(segment: string, cwd: string, root: string, stdin: string | null): string {
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

	if (BLOCKED.has(program)) {
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
				return (
					`[bash-emulator] '${program}' wird nicht unterstuetzt.\n` +
					`Verfuegbar: ${SUPPORTED_COMMANDS.join(", ")}`
				);
		}
	} catch (error) {
		return `Error in ${program}: ${(error as Error).message}`;
	}
}

/**
 * Execute a full command string. Supports `cd DIR && rest` (the cd applies to
 * the rest of the line) and `|` chaining; everything else is a single segment.
 */
export function executeShellCommand(input: string, cwd: string, root: string): string {
	let command = input.trim().replace(/;$/, "");
	let workingDir = cwd;

	const cdAnd = command.match(/^cd\s+(.+?)\s+&&\s+(.+)$/s);
	if (cdAnd) {
		const target = resolve(workingDir, cdAnd[1].trim());
		if (!isOutside(target, root)) workingDir = target;
		command = cdAnd[2];
	}

	let result: string | null = null;
	for (const segment of splitByPipes(command)) {
		result = executeSegment(segment, workingDir, root, result);
	}
	return result ?? "";
}
