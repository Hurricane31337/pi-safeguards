/**
 * The control layer of the emulator: variables, `for` loops, and `&&` / `||`
 * that honour exit status, on top of the hand-written commands.
 *
 * One interpreter, two modes. executeShellCommand (execute.ts) runs a script
 * with real hooks; confirm-guard.ts runs the *same* walk in plan mode, where
 * nothing executes and every program that would run is recorded instead. That is
 * the point of sharing it: a guard that parses a script its own way will sooner
 * or later disagree with the executor about what a script does, and the gap is
 * exactly where a "deny"/"ask" policy leaks.
 *
 * What is supported - deliberately small:
 *   NAME=value            persistent shell variable (also `export NAME=value`)
 *   $NAME ${NAME} ${NAME:-default} $?     expansion, in words and double quotes
 *   for NAME in WORDS; do ...; done       nestable; WORDS may use globs (*.py)
 *   a && b   a || b   a; b   a | b        status-aware, left to right
 * Everything else a shell has (if/while/case, functions, $(...), subshells) is
 * refused with a message instead of being passed on as a bogus program name.
 *
 * Three rules keep this from becoming an escape route:
 *   - A variable's value is data. Statements, pipes and redirects are found in
 *     the script text *before* anything is expanded, so `X="a; rm -rf ."` followed
 *     by `echo $X` prints text and runs nothing.
 *   - Variables are not exported: child processes get the Node process's own
 *     environment, so `PATH=...` cannot redirect which program a name resolves to.
 *   - A command name taken from a value that came out of a glob (`for f in *;
 *     do $f; done`) is refused when running, and counted as an unknown program
 *     (so under the default policy) when planning.
 */

import { readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isOutside } from "../paths.ts";
import {
	type Connector,
	extractHeredocs,
	extractRedirect,
	globToRegex,
	heredocBodyFor,
	type Item,
	type RedirectSpec,
	splitByPipes,
	splitItems,
	splitTimePrefix,
} from "./parse.ts";

/** Raised for a script the emulator cannot interpret; the message is shown to the model. */
export class ScriptError extends Error {}

/** One command-line word after expansion. */
export interface Word {
	text: string;
	/** Part of it came from a value that originated in a glob expansion. */
	tainted: boolean;
}

export interface SegmentResult {
	output: string;
	status: number;
}

export interface CdResult {
	cwd: string;
	output: string | null;
	status: number;
}

/** What the interpreter needs the host to do; the run and the plan implement it differently. */
export interface Hooks {
	/** One pipeline stage. */
	segment(words: Word[], stdin: string | null, cwd: string): SegmentResult;
	cd(arg: string | undefined, cwd: string): CdResult;
	/** Performs a redirect; returns an error message, or null. */
	redirect(spec: RedirectSpec, content: string, cwd: string): string | null;
	/** A statement prefixed with `time`: returns the lines to emit (the statement's own output included). */
	timed(posix: boolean, run: () => string | null): string[];
}

/** Stands for "some file name" while planning, where the filesystem is not consulted. */
export const GLOB_PLACEHOLDER = "\u0000glob";

const MAX_STEPS = 5000;
const MAX_LOOP_ITEMS = 2000;
const MAX_GLOB_RESULTS = 2000;

/** Shell constructs the emulator does not implement. */
const UNSUPPORTED_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"case",
	"esac",
	"select",
	"function",
]);

// --- Parsing ---------------------------------------------------------------------------

type Node = { kind: "simple"; text: string } | { kind: "for"; variable: string; wordsRaw: string; body: Block };

type Block = Array<{ node: Node; connector: Connector }>;

const FOR_HEADER = /^for\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+in(?:\s+(.*))?)?$/s;

function firstWord(text: string): string {
	return text.split(/\s+/, 1)[0] ?? "";
}

function parseBlock(items: Item[], start: number, inLoop: boolean): { block: Block; next: number } {
	const block: Block = [];
	let i = start;
	while (i < items.length) {
		const item = items[i];
		const word = firstWord(item.text);

		if (word === "done") {
			if (!inLoop) throw new ScriptError("'done' ohne zugehöriges 'for'.");
			if (item.text !== "done")
				throw new ScriptError("Hinter 'done' darf nichts auf derselben Zeile stehen, außer && || oder ;.");
			return { block, next: i };
		}
		if (word === "do") throw new ScriptError("'do' ohne zugehöriges 'for'.");

		if (word === "for") {
			const header = FOR_HEADER.exec(item.text);
			if (!header)
				throw new ScriptError("Ungültige for-Schleife. Unterstützt wird: for NAME in WORTE; do ...; done");
			i++;
			if (i >= items.length || firstWord(items[i].text) !== "do") throw new ScriptError("'for' ohne 'do'.");
			// `do cmd` carries the first body command on the same line.
			const remainder = items[i].text.replace(/^do\s*/, "");
			if (remainder.length > 0) items[i] = { text: remainder, connector: items[i].connector };
			else i++;

			const inner = parseBlock(items, i, true);
			if (inner.next >= items.length) throw new ScriptError("'for' ohne 'done'.");
			block.push({
				node: { kind: "for", variable: header[1], wordsRaw: header[2] ?? "", body: inner.block },
				connector: items[inner.next].connector,
			});
			i = inner.next + 1;
			continue;
		}

		if (UNSUPPORTED_KEYWORDS.has(word)) {
			throw new ScriptError(
				`'${word}' wird vom Emulator nicht unterstützt. Verfügbar: for-Schleifen, Variablen (NAME=wert, $NAME), ; && || und Pipes.`,
			);
		}
		block.push({ node: { kind: "simple", text: item.text }, connector: item.connector });
		i++;
	}
	return { block, next: i };
}

function parseScript(rewritten: string): Block {
	const items = splitItems(rewritten);
	const { block, next } = parseBlock(items, 0, false);
	if (next < items.length) throw new ScriptError("Unerwartetes Ende der Schleife.");
	return block;
}

// --- Expansion --------------------------------------------------------------------------

interface Variable {
	value: string;
	tainted: boolean;
}

interface Reference {
	/** Index just past the reference in the raw text. */
	end: number;
	name: string;
	fallback?: string;
}

/** `$NAME`, `${NAME}`, `${NAME:-default}` or `$?` starting at raw[at] (a `$`), else null. */
function readReference(raw: string, at: number): Reference | null {
	const next = raw[at + 1];
	if (next === "?") return { end: at + 2, name: "?" };
	if (next === "{") {
		const close = raw.indexOf("}", at + 2);
		if (close === -1) return null;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s.exec(raw.slice(at + 2, close));
		return match ? { end: close + 1, name: match[1], fallback: match[2] } : null;
	}
	if (next !== undefined && /[A-Za-z_]/.test(next)) {
		let end = at + 2;
		while (end < raw.length && /[A-Za-z0-9_]/.test(raw[end])) end++;
		return { end, name: raw.slice(at + 1, end) };
	}
	return null;
}

interface Scope {
	vars: Map<string, Variable>;
	status: number;
}

interface RawWord {
	text: string;
	/** An unquoted * or ? appeared in it. */
	glob: boolean;
}

/**
 * Tokenises `raw` into words like parseArgs does (quotes group and are removed, an
 * empty quoted token survives) and expands variables on the way. An unquoted
 * expansion is split into words at whitespace; one in double quotes stays whole;
 * nothing in single quotes expands. `\$` is left as it is, as the emulator
 * always passed it on. `split: false` yields one word (an assignment's value).
 */
function expandRaw(raw: string, scope: Scope, split: boolean): RawWord[] & { tainted: boolean[] } {
	const words: RawWord[] & { tainted: boolean[] } = Object.assign([] as RawWord[], { tainted: [] as boolean[] });
	let current = "";
	let hasToken = false;
	let tainted = false;
	let glob = false;
	let inSingle = false;
	let inDouble = false;

	const push = () => {
		if (hasToken) {
			words.push({ text: current, glob });
			words.tainted.push(tainted);
		}
		current = "";
		hasToken = false;
		tainted = false;
		glob = false;
	};

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			hasToken = true;
		} else if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			hasToken = true;
		} else if (char === " " && !inSingle && !inDouble && split) {
			push();
		} else if (char === "\\" && raw[i + 1] === "$" && !inSingle) {
			current += "\\$";
			hasToken = true;
			i++;
		} else if (char === "$" && !inSingle) {
			const ref = readReference(raw, i);
			if (!ref) {
				current += char;
				hasToken = true;
				continue;
			}
			i = ref.end - 1;
			let value: string;
			let valueTainted = false;
			if (ref.name === "?") {
				value = String(scope.status);
			} else {
				const variable = scope.vars.get(ref.name);
				value = variable?.value ?? "";
				valueTainted = variable?.tainted ?? false;
				if (value === "" && ref.fallback !== undefined) value = ref.fallback;
			}
			if (inDouble || !split) {
				current += value;
				hasToken = true;
				if (valueTainted) tainted = true;
			} else {
				// Unquoted: word splitting, like a shell.
				for (const c of value) {
					if (/\s/.test(c)) {
						push();
					} else {
						current += c;
						hasToken = true;
						if (valueTainted) tainted = true;
					}
				}
			}
		} else {
			current += char;
			hasToken = true;
			if ((char === "*" || char === "?") && !inSingle && !inDouble) glob = true;
		}
	}
	push();
	return words;
}

function toWords(raw: string, scope: Scope): Word[] {
	const expanded = expandRaw(raw, scope, true);
	return expanded.map((word, index) => ({ text: word.text, tainted: expanded.tainted[index] }));
}

/** One string out of one raw word (assignment value, cd target, redirect target). */
function expandOne(raw: string, scope: Scope): { text: string; tainted: boolean } {
	const expanded = expandRaw(raw, scope, false);
	return { text: expanded[0]?.text ?? "", tainted: expanded.tainted[0] ?? false };
}

/** Raw words of a statement, quotes kept, split at unquoted spaces. */
function splitRawWords(text: string): string[] {
	const words: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (const char of text) {
		if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === '"' && !inSingle) inDouble = !inDouble;
		if (char === " " && !inSingle && !inDouble) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** Files matching a glob word, relative to `cwd`, inside the sandbox; the word itself when nothing matches (as in bash). */
function expandGlob(pattern: string, cwd: string, root: string): string[] {
	const normalised = pattern.replace(/\\/g, "/");
	const absolute = isAbsolute(pattern);
	const parts = normalised.split("/");
	let prefixes: string[];
	if (absolute) {
		prefixes = [parts[0] === "" ? "/" : `${parts[0]}/`];
		parts.shift();
	} else {
		prefixes = [""];
	}

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const last = index === parts.length - 1;
		const next: string[] = [];
		for (const prefix of prefixes) {
			if (!/[*?]/.test(part)) {
				next.push(`${prefix}${part}${last ? "" : "/"}`);
				continue;
			}
			let names: string[];
			try {
				const dir = resolve(cwd, prefix || ".");
				names = readdirSync(dir, { withFileTypes: true })
					.filter((entry) => last || entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				continue;
			}
			const matcher = globToRegex(part);
			for (const name of names.sort()) {
				if (name.startsWith(".") && !part.startsWith(".")) continue;
				if (matcher.test(name)) next.push(`${prefix}${name}${last ? "" : "/"}`);
			}
		}
		prefixes = next;
		if (prefixes.length > MAX_GLOB_RESULTS) prefixes = prefixes.slice(0, MAX_GLOB_RESULTS);
	}

	const found = prefixes.filter((candidate) => {
		const path = resolve(cwd, candidate);
		if (isOutside(path, root)) return false;
		try {
			statSync(path);
			return true;
		} catch {
			return false;
		}
	});
	return found.length > 0 ? found : [pattern];
}

// --- Interpreter -------------------------------------------------------------------------

interface Run {
	hooks: Hooks;
	root: string;
	plan: boolean;
	scope: Scope;
	cwd: string;
	steps: number;
	outputs: string[];
	bodies: Map<string, string>;
}

const NULL_REDIRECT = /\s+2>\/dev\/null|\s+>\s*\/dev\/null|\s+2>\s*nul\b|\s+>\s*nul\b/gi;

function runBlock(block: Block, run: Run): void {
	for (let i = 0; i < block.length; i++) {
		if (!run.plan && i > 0) {
			// bash: the connector BEFORE this node decides whether it runs, judged by the
			// status of whatever ran last.
			const before = block[i - 1].connector;
			if (before === "&&" && run.scope.status !== 0) continue;
			if (before === "||" && run.scope.status === 0) continue;
		}
		const { node } = block[i];
		if (node.kind === "for") runFor(node, run);
		else runSimple(node.text, run);
	}
}

function runFor(node: Extract<Node, { kind: "for" }>, run: Run): void {
	const values: Array<{ text: string; tainted: boolean }> = [];
	const raw = expandRaw(node.wordsRaw, run.scope, true);
	raw.forEach((word, index) => {
		const tainted = raw.tainted[index];
		if (!word.glob) {
			values.push({ text: word.text, tainted });
		} else if (run.plan) {
			values.push({ text: GLOB_PLACEHOLDER, tainted: true });
		} else {
			for (const match of expandGlob(word.text, run.cwd, run.root)) values.push({ text: match, tainted: true });
		}
	});
	if (values.length > MAX_LOOP_ITEMS) {
		throw new ScriptError(`Die Schleife hat mehr als ${MAX_LOOP_ITEMS} Durchläufe.`);
	}

	run.scope.status = 0;
	for (const value of values) {
		run.scope.vars.set(node.variable, { value: value.text, tainted: value.tainted });
		runBlock(node.body, run);
	}
}

function runSimple(text: string, run: Run): void {
	if (++run.steps > MAX_STEPS) throw new ScriptError(`Das Skript führt mehr als ${MAX_STEPS} Anweisungen aus.`);

	const { timed, posix, rest } = splitTimePrefix(text);
	if (!timed) {
		const output = runStatement(text, run);
		// A statement that printed nothing (a grep without a match, an assignment) leaves no blank line.
		if (output !== null && output !== "") run.outputs.push(output);
		return;
	}
	run.outputs.push(...run.hooks.timed(posix, () => (rest ? runStatement(rest, run) : null)));
}

/** One statement's output, or null for none. */
function runStatement(statement: string, run: Run): string | null {
	const cdMatch = statement.match(/^cd(?:\s+(.+))?$/s);
	if (cdMatch) {
		const target = cdMatch[1] === undefined ? undefined : expandOne(cdMatch[1].trim(), run.scope).text;
		const result = run.hooks.cd(target, run.cwd);
		run.cwd = result.cwd;
		run.scope.status = result.status;
		return result.output;
	}

	// `export` only sets variables here (they are never passed on to programs).
	const rawWords = splitRawWords(statement);
	if (rawWords[0] === "export") {
		for (const word of rawWords.slice(1)) {
			const match = ASSIGNMENT.exec(word);
			if (!match) continue; // `export NAME`: nothing to do
			const value = expandOne(match[2], run.scope);
			run.scope.vars.set(match[1], { value: value.text, tainted: value.tainted });
		}
		run.scope.status = 0;
		return null;
	}

	// Leading NAME=value words: all of them make a variable assignment; followed by a
	// command, the assignments are applied and the command runs (without them in its
	// environment, since the emulator does not hand variables on to programs).
	let skip = 0;
	while (skip < rawWords.length) {
		const match = ASSIGNMENT.exec(rawWords[skip]);
		if (!match) break;
		const value = expandOne(match[2], run.scope);
		run.scope.vars.set(match[1], { value: value.text, tainted: value.tainted });
		skip++;
	}
	if (skip > 0) {
		if (skip >= rawWords.length) {
			run.scope.status = 0;
			return null;
		}
		statement = rawWords.slice(skip).join(" ");
	}

	const redirect = extractRedirect(statement);
	const toRun = redirect ? redirect.command : statement;

	let stdin: string | null = null;
	for (const segment of splitByPipes(toRun)) {
		const heredoc = heredocBodyFor(segment, run.bodies);
		const cleaned = heredoc.cleaned.replace(NULL_REDIRECT, "").trim();
		const words = toWords(cleaned, run.scope);
		let result: SegmentResult;
		if (words.length === 0) result = { output: heredoc.body ?? stdin ?? "", status: 0 };
		else result = run.hooks.segment(words, heredoc.body ?? stdin, run.cwd);
		stdin = result.output;
		run.scope.status = result.status;
	}

	if (redirect) {
		const target = expandOne(redirect.target, run.scope).text;
		const error = run.hooks.redirect({ ...redirect, target }, stdin ?? "", run.cwd);
		if (error !== null) run.scope.status = 1;
		return error;
	}
	return stdin;
}

/**
 * Interprets a script. Returns its output (statements joined by newlines), or, for
 * a script that cannot be interpreted, a message saying why - nothing runs then.
 */
export function interpret(input: string, cwd: string, root: string, hooks: Hooks, plan: boolean): string {
	const { rewritten, bodies } = extractHeredocs(input);
	let block: Block;
	try {
		block = parseScript(rewritten);
	} catch (error) {
		if (error instanceof ScriptError) return `[bash-emulator] ${error.message}`;
		throw error;
	}

	const run: Run = {
		hooks,
		root,
		plan,
		scope: { vars: new Map(), status: 0 },
		cwd,
		steps: 0,
		outputs: [],
		bodies,
	};
	try {
		runBlock(block, run);
	} catch (error) {
		if (!(error instanceof ScriptError)) throw error;
		run.outputs.push(`[bash-emulator] ${error.message}`);
	}
	return run.outputs.join("\n");
}
