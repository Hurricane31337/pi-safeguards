/**
 * The dispatcher: one command string in, one output string out.
 *
 * The whitelist is the security boundary. A program that is not in the switch
 * below simply does not run — there is no fallback to a real shell — so the
 * model cannot reach the filesystem except through the commands here, all of
 * which are anchored to the sandbox root.
 *
 * Control flow (variables, `for`, `&&`/`||` by exit status) lives in
 * interpreter.ts; this file supplies what the interpreter runs *with*: the
 * commands, their exit statuses, `cd`, redirects and `time`. confirm-guard.ts
 * walks the very same interpreter with hooks that record instead of run.
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBlocked, isOutside } from "../paths.ts";
import { commandState, loadSafeguardsSettings, REDIRECT_COMMAND, type SafeguardsSettings } from "../settings.ts";
import {
	execCat,
	execCp,
	execFind,
	execGrep,
	execHead,
	execLs,
	execMkdir,
	execMv,
	execPrintf,
	execRm,
	execSed,
	execSort,
	execTail,
	execUniq,
	execWc,
} from "./commands.ts";
import { execExternalResult } from "./external.ts";
import { execGitResult } from "./git.ts";
import { type CdResult, type Hooks, interpret, type SegmentResult, type Word } from "./interpreter.ts";
import { commandChain, type RedirectSpec } from "./parse.ts";
import { execWhich } from "./which.ts";

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
	"cp",
	"mkdir",
	"time",
	"git",
	"which",
] as const;

/** Commands whose output is whatever the model told them to print, not a report that could be an error. */
const ECHOING_COMMANDS = new Set(["echo", "printf", "pwd", "true", "false"]);

/**
 * Exit status of an emulated command. The command implementations return text
 * only, so this reads the text the way a shell script's author would: an error
 * report leads a line with the command's name (`cat: x: No such file`), and grep
 * exits 1 when nothing matched.
 */
function builtinStatus(program: string, output: string): number {
	if (/^(Error in |\[bash-emulator\]|Access denied)/.test(output)) return 1;
	if (program === "grep" && output === "") return 1;
	if (!ECHOING_COMMANDS.has(program) && output.split("\n").some((line) => line.startsWith(`${program}: `))) return 1;
	return 0;
}

function executeSegment(
	words: Word[],
	cwd: string,
	root: string,
	stdin: string | null,
	settings: SafeguardsSettings,
): SegmentResult {
	const args = words.map((word) => word.text);
	if (args.length === 0) return { output: stdin ?? "", status: 0 };
	const program = args[0];
	const chain = commandChain(args);

	// A name that came out of a glob is whatever file happens to exist; the policy
	// the guard asked about was for "some file", so it must not become a command.
	if (words[0].tainted || (chain.length > 1 && words.some((word) => word.tainted))) {
		return {
			output:
				"[bash-emulator] Ein Befehlsname darf nicht aus einem Glob-Ergebnis stammen (z.B. for f in *; do $f; done).",
			status: 1,
		};
	}

	// "ask" reaches here only after confirm-guard.ts's tool_call hook already
	// asked and the user approved - by this point it must run exactly like
	// "allow" would. Only whether a prompt happened first differs between the
	// two, and that decision was already made upstream. Every program in the
	// chain is checked: `env python` must not run a denied python.
	const denied = chain.find((name) => commandState(name, settings, SUPPORTED_COMMANDS) === "deny");
	if (denied) return { output: deniedMessage(denied), status: 1 };

	// `a | time b`: bash hands this to /usr/bin/time, which times b alone.
	if (program === "time") {
		const posix = args[1] === "-p";
		const rest = words.slice(posix ? 2 : 1);
		const started = performance.now();
		const inner = rest.length > 0 ? executeSegment(rest, cwd, root, stdin, settings) : { output: "", status: 0 };
		const elapsed = formatElapsed((performance.now() - started) / 1000, posix);
		return { output: inner.output ? `${inner.output}\n${elapsed}` : elapsed, status: inner.status };
	}

	try {
		let output: string;
		switch (program) {
			case "grep":
				output = execGrep(args, cwd, root, stdin);
				break;
			case "sed":
				output = execSed(args, cwd, root, stdin);
				break;
			case "wc":
				output = execWc(args, cwd, root, stdin);
				break;
			case "uniq":
				output = execUniq(args, cwd, root, stdin);
				break;
			case "sort":
				output = execSort(args, cwd, root, stdin);
				break;
			case "head":
				output = execHead(args, cwd, root, stdin);
				break;
			case "tail":
				output = execTail(args, cwd, root, stdin);
				break;
			case "find":
				output = execFind(args, cwd, root);
				break;
			case "cat":
				output = execCat(args, cwd, root, stdin);
				break;
			case "ls":
				output = execLs(args, cwd, root);
				break;
			case "rm":
				output = execRm(args, cwd, root);
				break;
			case "mv":
				output = execMv(args, cwd, root);
				break;
			case "cp":
				output = execCp(args, cwd, root);
				break;
			case "mkdir":
				output = execMkdir(args, cwd, root);
				break;
			case "echo":
				output = args.slice(1).join(" ");
				break;
			case "pwd":
				output = cwd.replace(/\\/g, "/");
				break;
			case "true":
				return { output: "", status: 0 };
			case "false":
				return { output: "", status: 1 };
			case "printf":
				output = execPrintf(args);
				break;
			case "which":
				return execWhich(args, cwd, SUPPORTED_COMMANDS);
			case "git":
				return execGitResult(args, cwd, stdin);
			default:
				// Not one of the emulated commands, and not denied (checked above) -
				// so its state is "ask" (already approved) or "allow": run it for
				// real, without a shell.
				return execExternalResult(args, cwd, stdin);
		}
		return { output, status: builtinStatus(program, output) };
	} catch (error) {
		return { output: `Error in ${program}: ${(error as Error).message}`, status: 1 };
	}
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

	const path = resolve(cwd, redirect.target);
	if (isBlocked(path, root)) {
		return `Access denied: "${redirect.target}" is outside the project directory.`;
	}
	// Every command's return value in this emulator is captured like $(...) -
	// its own trailing newline stripped, with call sites (statement joining,
	// `time`'s report) re-adding "\n" themselves where display needs it. A
	// real redirect instead writes the command's actual stdout bytes, which
	// for line-oriented output (echo above all) end in a newline; reinstating
	// it here is what a real `>`/`>>` would have written, and is why `>>`
	// used to glue consecutive echoes onto one line instead of appending a
	// new one.
	const text = content && !content.endsWith("\n") ? `${content}\n` : content;
	try {
		if (redirect.append) appendFileSync(path, text, "utf8");
		else writeFileSync(path, text, "utf8");
	} catch (error) {
		return `Error writing '${redirect.target}': ${(error as Error).message}`;
	}
	return null;
}

function deniedMessage(program: string): string {
	return (
		`[bash-emulator] '${program}' ist deaktiviert (Einstellungen).\n` +
		`Verfuegbar: ${SUPPORTED_COMMANDS.join(", ")}\n` +
		"Oder nutze die nativen pi-Tools: read, write, edit, grep, find, ls"
	);
}

/** `time`'s report: bash's `real\t0m1.234s`, or POSIX `real 1.23` for `time -p`. */
function formatElapsed(seconds: number, posix: boolean): string {
	if (posix) return `real ${seconds.toFixed(2)}`;
	const minutes = Math.floor(seconds / 60);
	return `\nreal\t${minutes}m${(seconds - minutes * 60).toFixed(3)}s`;
}

/** `cd DIR`: the only state a statement leaves behind for the next one. */
function changeDirectory(arg: string | undefined, cwd: string, root: string, settings: SafeguardsSettings): CdResult {
	if (commandState("cd", settings, SUPPORTED_COMMANDS) === "deny") {
		return { cwd, output: "[bash-emulator] 'cd' ist deaktiviert (Einstellungen).", status: 1 };
	}
	if (!arg) return { cwd, output: null, status: 0 };

	const target = resolve(cwd, arg);
	// Silently ignored, like a `cd` that would leave the root always was:
	// the model gets an unrelated tool call to explain the containment,
	// not this one, since a refusal message here quotes the walked path.
	// A target *inside* the sandbox gets no such pass, though - a typo'd
	// or nonexistent directory needs to say so, or every relative path
	// after it fails with a confusing "No such file" that names the
	// wrong command, while the cd itself silently "succeeded".
	if (isOutside(target, root)) return { cwd, output: null, status: 0 };
	let isDir = false;
	try {
		isDir = statSync(target).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) return { cwd, output: `cd: no such file or directory: ${arg}`, status: 1 };
	return { cwd: target, output: null, status: 0 };
}

/**
 * Execute a full command string. Statements are separated by `;`, newlines,
 * `&&` and `||`, the last two by the previous command's exit status; `cd DIR`
 * changes the working directory for every statement after it in the same call —
 * together with variables, the only state the emulator carries between
 * statements, and it never survives past this one call, since each tool
 * invocation is re-anchored to the session's cwd (see tool.ts). Within a
 * statement, `|` chains segments through stdin.
 *
 * Heredocs (`<<'EOF' … EOF`) are unwrapped once up front so a multi-line body
 * never gets shredded into statements; a segment carrying that body's marker
 * feeds it in as that segment's stdin, overriding anything piped in (matching
 * real shell precedence - a heredoc IS the command's stdin).
 */
export function executeShellCommand(
	input: string,
	cwd: string,
	root: string,
	// Overridable so tests can inject a policy without touching the real
	// settings file; production callers (tool.ts) never pass this.
	settings: SafeguardsSettings = loadSafeguardsSettings(),
): string {
	const hooks: Hooks = {
		segment: (words, stdin, workingDir) => executeSegment(words, workingDir, root, stdin, settings),
		cd: (arg, workingDir) => changeDirectory(arg, workingDir, root, settings),
		redirect: (spec, content, workingDir) => applyRedirect(spec, content, workingDir, root, settings),
		timed: (posix, run) => {
			if (commandState("time", settings, SUPPORTED_COMMANDS) === "deny") return [deniedMessage("time")];
			const started = performance.now();
			const output = run();
			const lines: string[] = [];
			if (output !== null && output !== "") lines.push(output);
			// bash's format. Only wall-clock time is reported: user/sys would be
			// this Node process alone, not the rg/git children doing the work, and
			// a made-up 0.000s is worse than leaving them out.
			lines.push(formatElapsed((performance.now() - started) / 1000, posix));
			return lines;
		},
	};
	return interpret(input, cwd, root, hooks, false);
}
