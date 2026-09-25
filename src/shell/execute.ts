/**
 * The dispatcher: one command string in, one output string out.
 *
 * The whitelist is the security boundary. A program that is not in the switch
 * below simply does not run — there is no fallback to a real shell — so the
 * model cannot reach the filesystem except through the commands here, all of
 * which are anchored to the sandbox root.
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBlocked, isOutside } from "../paths.ts";
import { commandState, loadSafeguardsSettings, REDIRECT_COMMAND, type SafeguardsSettings } from "../settings.ts";
import {
	execCat,
	execFind,
	execGrep,
	execHead,
	execLs,
	execMv,
	execPrintf,
	execRm,
	execSed,
	execSort,
	execTail,
	execUniq,
	execWc,
} from "./commands.ts";
import { execExternal } from "./external.ts";
import { execGit } from "./git.ts";
import {
	extractHeredocs,
	extractRedirect,
	heredocBodyFor,
	parseArgs,
	type RedirectSpec,
	splitByPipes,
	splitStatements,
} from "./parse.ts";

/** Commands available in the emulator, for the tool description and the refusal message. */
export const SUPPORTED_COMMANDS = [
	"grep",
	"sed",
	"wc",
	"uniq",
	"sort",
	"printf",
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

	// "ask" reaches here only after confirm-guard.ts's tool_call hook already
	// asked and the user approved - by this point it must run exactly like
	// "allow" would. Only whether a prompt happened first differs between the
	// two, and that decision was already made upstream.
	if (commandState(program, settings, SUPPORTED_COMMANDS) === "deny") {
		return (
			`[bash-emulator] '${program}' ist deaktiviert (Einstellungen).\n` +
			`Verfuegbar: ${SUPPORTED_COMMANDS.join(", ")}\n` +
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
			case "uniq":
				return execUniq(args, cwd, root, stdin);
			case "sort":
				return execSort(args, cwd, root, stdin);
			case "head":
				return execHead(args, cwd, root, stdin);
			case "tail":
				return execTail(args, cwd, root, stdin);
			case "find":
				return execFind(args, cwd, root);
			case "cat":
				return execCat(args, cwd, root, stdin);
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
				return execPrintf(args);
			case "git":
				return execGit(args, cwd, stdin);
			default:
				// Not one of the emulated commands, and not denied (checked above) -
				// so its state is "ask" (already approved) or "allow": run it for
				// real, without a shell.
				return execExternal(args, cwd, stdin);
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

/** `/dev/null` and Windows' `nul` both mean "discard", not "write a file named that". */
function isNullTarget(target: string): boolean {
	return target === "/dev/null" || target.toLowerCase() === "nul";
}

/**
 * Performs a `>`/`>>` redirect once the piped command has produced its
 * output. Gated by commandState("redirect", …) the same way any other
 * command is - confirm-guard.ts's tool_call hook asks/denies it under that
 * same pseudo-program name before the tool ever runs, so by the time this
 * runs a non-deny state has already been approved (see the "ask" comment on
 * executeSegment). The sandbox path check is unconditional regardless of
 * that policy: redirect being "allow" opts out of being asked, never out of
 * containment.
 */
function applyRedirect(
	redirect: RedirectSpec,
	content: string,
	cwd: string,
	root: string,
	settings: SafeguardsSettings,
): string | null {
	if (isNullTarget(redirect.target)) return null;

	if (commandState(REDIRECT_COMMAND, settings, SUPPORTED_COMMANDS) === "deny") {
		return "[bash-emulator] '>' ist deaktiviert (Einstellungen).";
	}

	const path = resolve(cwd, unquote(redirect.target));
	if (isBlocked(path, root)) {
		return `Access denied: "${redirect.target}" is outside the project directory.`;
	}
	try {
		if (redirect.append) appendFileSync(path, content, "utf8");
		else writeFileSync(path, content, "utf8");
	} catch (error) {
		return `Error writing '${redirect.target}': ${(error as Error).message}`;
	}
	return null;
}

/**
 * Execute a full command string. Statements are split on `;`, newlines and
 * `&&` (see splitStatements); `cd DIR` changes the working directory for every
 * statement after it in the same call — this is the only state the emulator
 * carries between statements, and it never survives past this one call, since
 * each tool invocation is re-anchored to the session's cwd (see tool.ts).
 * Within a statement, `|` chains segments through stdin as before.
 *
 * Heredocs (`<<'EOF' … EOF`) are unwrapped once up front via
 * extractHeredocs() so a multi-line body never gets shredded by
 * splitStatements; a segment carrying that body's marker feeds it in as
 * that segment's stdin, overriding anything piped in (matching real shell
 * precedence - a heredoc IS the command's stdin).
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
	const { rewritten, bodies } = extractHeredocs(input);

	for (const statement of splitStatements(rewritten)) {
		const cdMatch = statement.match(/^cd(?:\s+(.+))?$/s);
		if (cdMatch) {
			if (commandState("cd", settings, SUPPORTED_COMMANDS) === "deny") {
				outputs.push("[bash-emulator] 'cd' ist deaktiviert (Einstellungen).");
				continue;
			}
			const arg = unquote((cdMatch[1] ?? "").trim());
			if (arg) {
				const target = resolve(workingDir, arg);
				// Silently ignored, like a `cd` that would leave the root always was:
				// the model gets an unrelated tool call to explain the containment,
				// not this one, since a refusal message here quotes the walked path.
				// A target *inside* the sandbox gets no such pass, though - a typo'd
				// or nonexistent directory needs to say so, or every relative path
				// after it fails with a confusing "No such file" that names the
				// wrong command, while the cd itself silently "succeeded".
				if (!isOutside(target, root)) {
					let isDir = false;
					try {
						isDir = statSync(target).isDirectory();
					} catch {
						isDir = false;
					}
					if (!isDir) {
						outputs.push(`cd: no such file or directory: ${arg}`);
						continue;
					}
					workingDir = target;
				}
			}
			continue;
		}

		const redirect = extractRedirect(statement);
		const toRun = redirect ? redirect.command : statement;

		let stdin: string | null = null;
		for (const segment of splitByPipes(toRun)) {
			const heredoc = heredocBodyFor(segment, bodies);
			stdin = executeSegment(heredoc.cleaned, workingDir, root, heredoc.body ?? stdin, settings);
		}

		if (redirect) {
			const message = applyRedirect(redirect, stdin ?? "", workingDir, root, settings);
			if (message) outputs.push(message);
			continue;
		}

		if (stdin !== null) outputs.push(stdin);
	}

	return outputs.join("\n");
}
