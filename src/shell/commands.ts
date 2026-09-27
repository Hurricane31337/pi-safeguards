/**
 * The emulated commands themselves — pure Node, no shell, no child processes
 * except git (see git.ts).
 *
 * Every one of these takes the sandbox root and refuses to touch anything
 * outside it, which is what makes the whitelist a containment boundary rather
 * than a convenience: there is no interpreter here that could be talked into
 * reading a path we did not resolve ourselves.
 */

import {
	closeSync,
	cpSync,
	type Dirent,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isBlocked, isOutside, isSpilled, pathKey } from "../paths.ts";
import { globToRegex, parseLineCount } from "./parse.ts";
import { execRipgrepGrep } from "./ripgrep.ts";

/**
 * Expand a single glob argument (`*.py`) against the directory it names,
 * relative to `cwd`. A pattern with no glob characters, or one that matches
 * nothing, is returned unchanged — the same "stays literal" fallback a real
 * shell has, and what lets error messages still name the argument the model
 * wrote.
 */
function expandGlob(pattern: string, cwd: string): string[] {
	if (!/[*?]/.test(pattern)) return [pattern];

	const full = resolve(cwd, pattern);
	const dir = dirname(full);
	const regex = globToRegex(basename(full));

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [pattern];
	}

	const matches = entries.filter((entry) => regex.test(entry)).sort();
	if (matches.length === 0) return [pattern];

	const dirArg = dirname(pattern);
	return matches.map((match) => (dirArg === "." ? match : `${dirArg}/${match}`));
}

/**
 * The letters bundled in a single-dash flag argument (`-rn` -> "r", "n"), or
 * "" for a double-dash one. A GNU long option (`--include=*.ts`, `--force`)
 * must never be decomposed the same way `.slice(1)` alone would: iterating
 * "-include=*.ts"'s characters happens to walk straight through every short
 * flag this emulator recognises purely because the option's own spelling
 * contains those letters ("include" has i/n/c/l - one letter short of
 * setting every grep flag there is). That silently turned an unsupported
 * `--include=GLOB` into `-cnli`, replacing a real recursive search with a
 * per-file match count across the entire tree, and would just as easily
 * turn `rm --force` into `rm -rf` by way of the "r" in "force". An
 * unsupported long option must be a no-op, not a random walk through the
 * short-flag switch below it.
 */
function shortFlags(arg: string): string {
	return arg.startsWith("--") ? "" : arg.slice(1);
}

/** Expand every non-flag argument's glob, in place order. */
function expandArgs(args: string[], cwd: string): string[] {
	const result: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("-")) result.push(arg);
		else result.push(...expandGlob(arg, cwd));
	}
	return result;
}

/** Line count that treats "" as zero lines, matching real `wc -l` (`split("\n")` alone is off by one on empty input). */
function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Decode a file's raw bytes for grep/cat/etc. Real source trees mix UTF-8
 * (with or without a BOM) and legacy Windows-1252 - this used to assume
 * latin1 unconditionally, which is a no-op on ASCII but silently mangles
 * every UTF-8 multi-byte sequence into two-or-three garbage latin1
 * characters (`für` -> `fÃ¼r`), and made every non-ASCII grep pattern match
 * zero lines since the pattern itself (already a correct JS string) was
 * compared against that mangled text. Detection order, matching what a real
 * text editor does: a UTF-16 BOM is unambiguous and decoded as such; a UTF-8
 * BOM is unambiguous and decoded as UTF-8; with no BOM, a buffer that
 * round-trips cleanly through UTF-8 is almost certainly UTF-8 (Windows-1252
 * bytes 0x80-0x9F/0xFF are not valid UTF-8 continuation patterns in the vast
 * majority of real text), so only a buffer that fails that round-trip falls
 * back to latin1 (a byte-for-byte stand-in for Windows-1252 on the ASCII
 * range this project mostly cares about). The BOM itself is stripped so a
 * `^` anchor still matches the true first line and callers never print it.
 */
function decodeFileBuffer(buffer: Buffer): string {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.toString("utf8", 3);
	}
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.toString("utf16le", 2);
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const swapped = Buffer.from(buffer.subarray(2));
		swapped.swap16();
		return swapped.toString("utf16le");
	}
	const asUtf8 = buffer.toString("utf8");
	if (Buffer.from(asUtf8, "utf8").equals(buffer)) return asUtf8;
	return buffer.toString("latin1");
}

/** First 8KB, sniffed for a NUL byte - the same binary heuristic GNU grep/git use. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * True when the file's leading bytes contain a NUL, i.e. it is not text. A
 * leading UTF-8/UTF-16 BOM is decided as text unconditionally and skips the
 * NUL sniff entirely - UTF-16 text is full of NUL bytes (every ASCII
 * character's high byte) and would otherwise be misclassified as binary.
 */
export function isBinaryFile(path: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return false;
	}
	try {
		const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
		const bytesRead = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
		const sniffed = buffer.subarray(0, bytesRead);
		const hasBom =
			(sniffed.length >= 3 && sniffed[0] === 0xef && sniffed[1] === 0xbb && sniffed[2] === 0xbf) ||
			(sniffed.length >= 2 && sniffed[0] === 0xff && sniffed[1] === 0xfe) ||
			(sniffed.length >= 2 && sniffed[0] === 0xfe && sniffed[1] === 0xff);
		if (hasBom) return false;
		return sniffed.includes(0);
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/**
 * Read a file's text content, decoding source files with `decodeFileBuffer`
 * and the temp logs we spilled ourselves as plain UTF-8 (they are only ever
 * written by this extension, never a developer's own encoding).
 */
export function readFileSafe(path: string): string | null {
	try {
		if (isSpilled(path)) return readFileSync(path, "utf8");
		return decodeFileBuffer(readFileSync(path));
	} catch {
		return null;
	}
}

interface GrepFlags {
	recursive: boolean;
	lineNumbers: boolean;
	filesOnly: boolean;
	invert: boolean;
	countOnly: boolean;
	onlyMatching: boolean;
	/** `-m`/`--max-count`: stop after this many matching lines, per file. null means unlimited. */
	maxCount: number | null;
}

function grepInPath(
	path: string,
	pattern: RegExp,
	flags: GrepFlags,
	root: string,
	results: string[],
	showFile: boolean,
	includeGlob: RegExp | null,
	excludeDirGlob: RegExp | null,
	// The operand as typed (cwd-relative), or null for an entry reached by
	// recursing rather than named directly - only the former gets the
	// "Is a directory" message, using the same cwd-relative, echo-the-operand
	// convention every other error in this emulator uses (cat/wc/uniq/sort/
	// head/tail/ls/rm), not match output's root-relative "./" labeling.
	topLevelLabel: string | null,
): void {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		return;
	}

	if (stat.isDirectory()) {
		if (!flags.recursive) {
			// A directory reached while already recursing (flags.recursive is
			// true there, so this branch never runs for it) is meant to be
			// walked, not reported. Real grep says the same thing and refuses
			// to search a directory without -r; this used to be a silent
			// no-op indistinguishable from "no matches", which made `grep foo
			// src/` (forgetting -r, the single most common grep typo) look
			// like a confident, wrong "not found".
			if (topLevelLabel !== null) results.push(`grep: ${topLevelLabel}: Is a directory`);
			return;
		}
		let entries: string[];
		try {
			entries = readdirSync(path);
		} catch {
			return;
		}
		for (const entry of entries) {
			// Real grep -r descends into dot-directories too; only .git is
			// excluded here (a deliberate, narrow exception - not a blanket
			// "skip anything hidden" the way ripgrep defaults to - since real
			// grep would otherwise be a trap: `.claude/`, `.github/`, any
			// dot-config directory used to be silently invisible to -r).
			if (entry === ".git" || entry === "node_modules") continue;
			if (excludeDirGlob?.test(entry)) continue;
			grepInPath(join(path, entry), pattern, flags, root, results, showFile, includeGlob, excludeDirGlob, null);
		}
		return;
	}
	const rel = `./${relative(root, path).replace(/\\/g, "/")}`;
	// --include filters files only, never the directories on the way to them -
	// same as real grep, where the glob matches basenames of things it would
	// otherwise search, not the path it walks to get there.
	if (includeGlob && !includeGlob.test(basename(path))) return;
	if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return;

	// GNU grep's own binary heuristic: a NUL byte in the leading block means
	// "not text". A binary met while walking a directory is skipped, the way
	// rg (the -r fast path) and the grep tool skip it - otherwise the same
	// search saw different files depending on whether -o/-c/-lv routed it
	// here. A binary named directly is searched: -l/-c answer normally and a
	// match prints GNU grep's one-line notice, never the content.
	const binary = isBinaryFile(path);
	if (binary && topLevelLabel === null) return;

	const content = readFileSafe(path);
	if (!content) return;
	const lines = content.split("\n");
	// A trailing newline terminates the last line, it does not start an empty
	// one - without this, a pattern that matches an empty string (an empty
	// pattern, or e.g. ".*") would report one bogus extra match per file.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	const isMatch = (line: string) => pattern.test(line) !== flags.invert;

	// -l wins over -c when both are given, like real grep (this used to check
	// countOnly first, so `grep -lc` printed counts instead of just names).
	// Binary status never changes -l/-c - a binary file matches or doesn't
	// and has a count exactly like a text one, the same way real grep behaves.
	if (flags.filesOnly) {
		if (lines.some(isMatch)) results.push(rel);
		return;
	}

	if (flags.countOnly) {
		let count = 0;
		for (const line of lines) {
			if (flags.maxCount !== null && count >= flags.maxCount) break;
			if (isMatch(line)) count++;
		}
		results.push(showFile ? `${rel}:${count}` : String(count));
		return;
	}

	// A binary match prints GNU grep's own one-line notice instead of the raw
	// (likely NUL-laden, multi-megabyte) content - the content itself is
	// never emitted for a binary file outside -l/-c.
	if (binary) {
		if (lines.some(isMatch)) results.push(`grep: ${rel}: binary file matches`);
		return;
	}

	let printed = 0;
	for (let i = 0; i < lines.length; i++) {
		if (flags.maxCount !== null && printed >= flags.maxCount) break;
		if (!isMatch(lines[i])) continue;
		printed++;
		if (flags.onlyMatching) {
			for (const match of lines[i].matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
				let line = "";
				if (showFile) line += `${rel}:`;
				if (flags.lineNumbers) line += `${i + 1}:`;
				results.push(line + match[0]);
			}
			continue;
		}
		let line = "";
		if (showFile) line += `${rel}:`;
		if (flags.lineNumbers) line += `${i + 1}:`;
		results.push(line + lines[i]);
	}
}

/**
 * Real BRE grep treats `( ) { } | + ?` as literal characters and only their
 * escaped form (`\(` `\)` `\{` `\}` `\|` `\+` `\?`) as the special ERE-style
 * meaning - the exact opposite of a JS RegExp, which already treats the bare
 * form as special and the escaped form as literal. Translating only the
 * escaped forms (unescaping them to bare/special) used to leave the other
 * half of that swap undone: an unescaped `(` still hit JS's native "this is
 * a group" handling, so there was no way to write a literal parenthesis,
 * pipe, brace or plus/question mark at all - grep 'a(b)c' matched "abc"
 * instead of the literal text "a(b)c" a real BRE grep would find, with no
 * escaping fix available since `\(` just produced the same group. This walks
 * the pattern once and swaps both directions: bare -> escaped (literal),
 * escaped -> bare (special). Everything else (`\d`, `\1` backreferences,
 * `\.`, `\\`, and the JS-native handling of unescaped `.` `*` `^` `$` `[]`,
 * which BRE and ERE already agree on) passes through untouched.
 */
function bareGrepEscapesToRegex(pattern: string): string {
	const special = "(){}|+?";
	let result = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\" && i + 1 < pattern.length) {
			const next = pattern[i + 1];
			result += special.includes(next) ? next : ch + next;
			i++;
		} else if (special.includes(ch)) {
			result += `\\${ch}`;
		} else {
			result += ch;
		}
	}
	return result;
}

export function execGrep(args: string[], cwd: string, root: string, stdin: string | null): string {
	const flags: GrepFlags = {
		recursive: false,
		lineNumbers: false,
		filesOnly: false,
		invert: false,
		countOnly: false,
		onlyMatching: false,
		maxCount: null,
	};
	let ignoreCase = false;
	let extendedRegex = false;
	let wordBoundary = false;
	let quiet = false;
	let unsupportedOption: string | null = null;
	// "auto" is the existing recursive-or-multi-file heuristic; -h/-H pin it
	// either way regardless of target count, like real grep.
	let filenamePrefix: "auto" | "always" | "never" = "auto";
	const patterns: string[] = [];
	let positionalPatternTaken = false;
	const targets: string[] = [];
	let includeGlobText: string | null = null;
	let excludeDirGlobText: string | null = null;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") continue;
		if (arg === "--version") {
			return "grep (pi-safeguards bash emulator, not GNU grep): BRE by default, -E for ERE; UTF-8 and Windows-1252 decoded per file. The grep tool has count/files modes, context and totals.";
		}
		if (arg === "-e" && i + 1 < args.length) {
			patterns.push(args[++i]);
			positionalPatternTaken = true;
			continue;
		}
		if (arg.startsWith("--include=")) {
			includeGlobText = arg.slice("--include=".length);
			continue;
		}
		if (arg === "--include" && i + 1 < args.length) {
			includeGlobText = args[++i];
			continue;
		}
		if (arg.startsWith("--exclude-dir=")) {
			excludeDirGlobText = arg.slice("--exclude-dir=".length);
			continue;
		}
		if (arg === "--exclude-dir" && i + 1 < args.length) {
			excludeDirGlobText = args[++i];
			continue;
		}
		// --word-regexp is -w's long form; without this it silently did
		// nothing while -w worked, so the same search gave two different
		// answers depending only on which spelling was used.
		if (arg === "--word-regexp") {
			wordBoundary = true;
			continue;
		}
		// -m/--max-count is implemented (below); -A/-B/-C (context lines) are
		// not, and silently swallowing them used to make a caller typing `-C 3`
		// believe it got context when it got an unfiltered dump instead - so
		// they're now a visible, immediate error rather than a silent no-op.
		// Matches both `-A 2` and the attached `-A2` form real grep accepts.
		if (arg === "--max-count" && i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
			flags.maxCount = Number.parseInt(args[++i], 10);
			continue;
		}
		if (arg.startsWith("--max-count=") && /^\d+$/.test(arg.slice("--max-count=".length))) {
			flags.maxCount = Number.parseInt(arg.slice("--max-count=".length), 10);
			continue;
		}
		if (arg === "-m" && i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
			flags.maxCount = Number.parseInt(args[++i], 10);
			continue;
		}
		if (/^-m\d+$/.test(arg)) {
			flags.maxCount = Number.parseInt(arg.slice(2), 10);
			continue;
		}
		if (/^-[ABC]$/.test(arg) && i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
			unsupportedOption ??= arg;
			i++;
			continue;
		}
		if (/^-[ABC]\d+$/.test(arg)) {
			unsupportedOption ??= arg.slice(0, 2);
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "r" || flag === "R") flags.recursive = true;
				else if (flag === "n") flags.lineNumbers = true;
				else if (flag === "i") ignoreCase = true;
				else if (flag === "l") flags.filesOnly = true;
				else if (flag === "v") flags.invert = true;
				else if (flag === "c") flags.countOnly = true;
				else if (flag === "E") extendedRegex = true;
				else if (flag === "w") wordBoundary = true;
				else if (flag === "o") flags.onlyMatching = true;
				else if (flag === "q") quiet = true;
				else if (flag === "h") filenamePrefix = "never";
				else if (flag === "H") filenamePrefix = "always";
				// unknown flags are ignored
			}
		} else if (!positionalPatternTaken) {
			patterns.push(arg);
			positionalPatternTaken = true;
		} else {
			// A shell expands `dir/*.vb` before grep ever sees it; nothing did
			// here, so the literal name was reported as "No such file".
			for (const expanded of expandGlob(arg, cwd)) targets.push(resolve(cwd, expanded));
		}
	}

	if (unsupportedOption) {
		return `grep: unsupported option: ${unsupportedOption} (for context lines use the grep tool's before/after/context parameters)`;
	}

	// No patterns at all (never a bare "-e", never a positional one) means no
	// pattern was given; an explicitly empty pattern ("" from -e or as the
	// positional) is a real, meaningful invocation - an empty regex matches
	// every line, so grep -c "" should count all of them, not print nothing.
	if (patterns.length === 0) return "(grep: no pattern)";

	// Multiple -e patterns OR together, same as real grep; each is wrapped in
	// its own non-capturing group so one pattern's alternation can't bleed
	// into another's. -E (ERE) means JS's own regex dialect already matches -
	// no BRE translation needed, and skipping it is also what keeps -E
	// correct now that the default (BRE) path applies one (see
	// bareGrepEscapesToRegex): without this branch, -E patterns would get the
	// BRE swap applied too and `grep -E 'fo+'` would stop meaning "one or
	// more o" once bare `+` became literal by default.
	const translate = (p: string) => (extendedRegex ? p : bareGrepEscapesToRegex(p));
	const combined = patterns.map((p) => `(?:${translate(p)})`).join("|");
	// -w wraps the whole alternation in word boundaries, the same way real
	// GNU grep implements it - without this, `grep -w alph` matched "alpha"
	// (alph is a substring, not a whole word).
	const withBoundary = (source: string) => (wordBoundary ? `\\b(?:${source})\\b` : source);
	let regex: RegExp;
	try {
		regex = new RegExp(withBoundary(combined), ignoreCase ? "i" : "");
	} catch {
		const literal = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
		regex = new RegExp(withBoundary(literal), ignoreCase ? "i" : "");
	}
	const includeGlob = includeGlobText !== null ? globToRegex(includeGlobText) : null;
	const excludeDirGlob = excludeDirGlobText !== null ? globToRegex(excludeDirGlobText) : null;

	const results: string[] = [];
	if (targets.length === 0 && stdin !== null) {
		const lines = stdin.split("\n");
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		// `cat some.dll | grep x` used to print the raw line; real grep says this.
		if (stdin.includes("\0") && !flags.countOnly) {
			const matched = lines.some((line) => regex.test(line) !== flags.invert);
			return quiet || !matched ? "" : "grep: (standard input): binary file matches";
		}
		if (flags.countOnly) {
			let count = 0;
			for (const line of lines) {
				if (flags.maxCount !== null && count >= flags.maxCount) break;
				if (regex.test(line) === flags.invert) continue;
				count++;
			}
			return quiet ? "" : String(count);
		}
		let printed = 0;
		for (let i = 0; i < lines.length; i++) {
			if (flags.maxCount !== null && printed >= flags.maxCount) break;
			if (regex.test(lines[i]) === flags.invert) continue;
			printed++;
			if (flags.onlyMatching) {
				for (const match of lines[i].matchAll(new RegExp(regex.source, `${regex.flags.replace("g", "")}g`))) {
					results.push(flags.lineNumbers ? `${i + 1}:${match[0]}` : match[0]);
				}
				continue;
			}
			results.push(flags.lineNumbers ? `${i + 1}:${lines[i]}` : lines[i]);
		}
	} else {
		// -h/-H pin the filename prefix either way; otherwise the existing
		// recursive-or-multi-file heuristic decides.
		const showFile =
			filenamePrefix === "always" || (filenamePrefix === "auto" && (flags.recursive || targets.length > 1));
		// Recursive multi-file scans are the only case worth ripgrep's process
		// overhead; countOnly is excluded because rg's --count silently omits
		// files with zero matches while grepInPath always reports them, and
		// invert+filesOnly is excluded as too rare a combination to be worth
		// replicating rg's different "file has an inverted match" semantics for.
		// -o also stays on the JS path - rg's --json output already gives
		// exact match spans, but reusing them would need a second output
		// format in ripgrep.ts for a flag this rare.
		// Every other error message in this emulator (cat/wc/uniq/sort/head/
		// tail/ls/rm's own "Is a directory") echoes the operand as typed,
		// cwd-relative - not the root-relative "./" form match output uses.
		const shownOf = (target: string) => relative(cwd, target).replace(/\\/g, "/") || target;
		// Checked before either search runs: a missing target used to be
		// silent in the JS walk (indistinguishable from "no matches") and,
		// once -r went through rg, surfaced as rg's raw "IO error ... (os
		// error 2)" with the absolute path.
		const existingTargets: string[] = [];
		for (const target of targets) {
			if (isBlocked(target, root)) continue;
			try {
				statSync(target);
				existingTargets.push(target);
			} catch {
				results.push(`grep: ${shownOf(target)}: No such file or directory`);
			}
		}
		let usedRipgrep = false;
		if (flags.recursive && !flags.countOnly && !(flags.invert && flags.filesOnly) && !flags.onlyMatching) {
			if (existingTargets.length > 0) {
				const fast = execRipgrepGrep(regex.source, existingTargets, root, {
					ignoreCase,
					invert: flags.invert,
					lineNumbers: flags.lineNumbers,
					filesOnly: flags.filesOnly,
					includeGlob: includeGlobText,
					excludeDirGlob: excludeDirGlobText,
					showFile,
					maxCount: flags.maxCount,
				});
				if (fast !== null) {
					results.push(...fast);
					usedRipgrep = true;
				}
			}
		}
		if (!usedRipgrep) {
			for (const target of existingTargets) {
				grepInPath(target, regex, flags, root, results, showFile, includeGlob, excludeDirGlob, shownOf(target));
			}
		}
		// The ripgrep fast path walks a directory tree in parallel, so the same
		// recursive grep can come back in a different file order on every run
		// even with nothing on disk changed - real grep's own directory walk is
		// sequential and stable. Sort by the leading path (Array#sort is a
		// stable sort per spec, so lines from the same file keep their original,
		// correctly-ascending line order) to make recursive output
		// deterministic regardless of which path produced it.
		if (flags.recursive)
			results.sort((a, b) => (a.split(":")[0] < b.split(":")[0] ? -1 : a.split(":")[0] > b.split(":")[0] ? 1 : 0));
	}
	return quiet ? "" : results.join("\n");
}

export function execSed(args: string[], cwd: string, root: string, stdin: string | null): string {
	let script: string | null = null;
	let path: string | null = null;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg.length === 2) continue; // -n and unknown short flags
		if (script === null) script = arg;
		else path = resolve(cwd, arg);
	}

	if (!script) return "(sed: no script)";

	// Supported: 'X,Yp' and 'X,$p' (line range).
	const range = script.match(/^(\d+),(\$|\d+)p$/);
	if (!range) {
		return `[bash-emulator] sed: only line-range form 'X,Yp' is supported (got: ${script})`;
	}

	let content: string;
	if (path) {
		if (isBlocked(path, root)) return "Access denied: path outside project.";
		const read = readFileSafe(path);
		if (read === null) return `sed: cannot read ${path}`;
		content = read;
	} else if (stdin !== null) {
		content = stdin;
	} else {
		return "(sed: no input)";
	}

	const start = Number.parseInt(range[1], 10);
	const end = range[2] === "$" ? Number.POSITIVE_INFINITY : Number.parseInt(range[2], 10);
	const lines = content.split("\n");
	return lines.slice(start - 1, Number.isFinite(end) ? end : undefined).join("\n");
}

/** Word count matching real `wc -w`: runs of non-whitespace. */
function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * `-l`/`-w`/`-c` select which counts to print, combinable (`-lc`) like real
 * `wc`; with none given, all three print, in `lines words bytes` order,
 * matching real `wc`'s bare behaviour. Each was previously ignored and every
 * invocation silently returned line count alone, however the flags read.
 */
export function execWc(args: string[], cwd: string, root: string, stdin: string | null): string {
	let showLines = false;
	let showWords = false;
	let showBytes = false;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "l") showLines = true;
				else if (flag === "w") showWords = true;
				else if (flag === "c") showBytes = true;
			}
		}
	}
	if (!showLines && !showWords && !showBytes) {
		showLines = true;
		showWords = true;
		showBytes = true;
	}

	function counts(lines: number, words: number, bytes: number): string {
		const parts: string[] = [];
		if (showLines) parts.push(String(lines).padStart(8));
		if (showWords) parts.push(String(words).padStart(8));
		if (showBytes) parts.push(String(bytes).padStart(8));
		return parts.join("");
	}

	const files = expandArgs(args.slice(1), cwd).filter((arg) => !arg.startsWith("-"));

	if (files.length > 0) {
		const rows: string[] = [];
		let totalLines = 0;
		let totalWords = 0;
		let totalBytes = 0;
		for (const file of files) {
			const path = resolve(cwd, file);
			if (isBlocked(path, root)) {
				rows.push(`Access denied: ${file}`);
				continue;
			}
			const content = readFileSafe(path);
			if (content === null) {
				rows.push(`wc: ${file}: No such file or directory`);
				continue;
			}
			const lines = countLines(content);
			const words = countWords(content);
			const bytes = Buffer.byteLength(content, isSpilled(path) ? "utf8" : "latin1");
			totalLines += lines;
			totalWords += words;
			totalBytes += bytes;
			rows.push(`${counts(lines, words, bytes)} ${file}`);
		}
		if (files.length > 1) rows.push(`${counts(totalLines, totalWords, totalBytes)} total`);
		return rows.join("\n");
	}
	if (stdin !== null) {
		return counts(countLines(stdin), countWords(stdin), Buffer.byteLength(stdin, "utf8"));
	}
	return "0";
}

/** `-c` prefixes each output line with its run length, like real `uniq -c`. `-d`/`-u` filter to only duplicated/only unique runs. */
export function execUniq(args: string[], cwd: string, root: string, stdin: string | null): string {
	let count = false;
	let duplicatesOnly = false;
	let uniqueOnly = false;
	let file: string | null = null;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "c") count = true;
				else if (flag === "d") duplicatesOnly = true;
				else if (flag === "u") uniqueOnly = true;
			}
		} else file = arg;
	}

	let content: string;
	if (file) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) return "Access denied: path outside project.";
		const read = readFileSafe(path);
		if (read === null) return `uniq: ${file}: No such file or directory`;
		content = read;
	} else if (stdin !== null) {
		content = stdin;
	} else {
		return "(uniq: no input)";
	}

	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	const output: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i;
		while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
		const runLength = j - i + 1;
		if (!(duplicatesOnly && runLength < 2) && !(uniqueOnly && runLength > 1)) {
			output.push(count ? `${String(runLength).padStart(7)} ${lines[i]}` : lines[i]);
		}
		i = j + 1;
	}
	return output.join("\n");
}

/**
 * Every positional file argument for head/tail, skipping over -n's own value
 * (`-n 3 file.txt`) and the old-style `-N` count form (`-3 file.txt`) so
 * neither is mistaken for a filename. Real head/tail accept more than one
 * file and print an `==> name <==` header before each when there is more
 * than one - single-file output stays bare, unchanged from before.
 */
function fileArgsFor(args: string[]): string[] {
	const files: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-n") {
			i++; // skip its value
			continue;
		}
		if (/^-\d+$/.test(arg)) continue;
		if (arg.startsWith("-")) continue;
		files.push(arg);
	}
	return files;
}

export function execHead(args: string[], cwd: string, root: string, stdin: string | null): string {
	const files = fileArgsFor(args);
	const count = parseLineCount(args, 10);
	if (files.length === 0) {
		return (stdin ?? "").split("\n").slice(0, count).join("\n");
	}

	const sections: string[] = [];
	for (const file of files) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) {
			sections.push("Access denied: path outside project.");
			continue;
		}
		const content = readFileSafe(path);
		if (content === null) {
			sections.push(`head: ${file}: No such file or directory`);
			continue;
		}
		const lines = content.split("\n");
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		const body = lines.slice(0, count).join("\n");
		sections.push(files.length > 1 ? `==> ${file} <==\n${body}` : body);
	}
	return sections.join("\n\n");
}

export function execTail(args: string[], cwd: string, root: string, stdin: string | null): string {
	const files = fileArgsFor(args);
	const count = parseLineCount(args, 10);
	if (files.length === 0) {
		const lines = (stdin ?? "").split("\n");
		// A trailing newline terminates the last line, it does not start an
		// empty one — counting it would shift the window by one against what
		// tail prints.
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		return lines.slice(Math.max(0, lines.length - count)).join("\n");
	}

	const sections: string[] = [];
	for (const file of files) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) {
			sections.push("Access denied: path outside project.");
			continue;
		}
		const read = readFileSafe(path);
		if (read === null) {
			sections.push(`tail: ${file}: No such file or directory`);
			continue;
		}
		const lines = read.split("\n");
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		const body = lines.slice(Math.max(0, lines.length - count)).join("\n");
		sections.push(files.length > 1 ? `==> ${file} <==\n${body}` : body);
	}
	return sections.join("\n\n");
}

/** `-r` reverses, `-u` dedupes adjacent-after-sort lines, `-n` compares numerically instead of lexically. */
export function execSort(args: string[], cwd: string, root: string, stdin: string | null): string {
	let reverse = false;
	let unique = false;
	let numeric = false;
	let file: string | null = null;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "r") reverse = true;
				else if (flag === "u") unique = true;
				else if (flag === "n") numeric = true;
			}
		} else file = arg;
	}

	let content: string;
	if (file) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) return "Access denied: path outside project.";
		const read = readFileSafe(path);
		if (read === null) return `sort: ${file}: No such file or directory`;
		content = read;
	} else if (stdin !== null) {
		content = stdin;
	} else {
		return "(sort: no input)";
	}

	let lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	lines = [...lines].sort(numeric ? (a, b) => Number.parseFloat(a) - Number.parseFloat(b) : undefined);
	if (reverse) lines.reverse();
	if (unique) lines = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);

	return lines.join("\n");
}

const PRINTF_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0" };

/** One pass over the format string, consuming args for each %-specifier it hits. */
function applyPrintfFormat(
	format: string,
	args: readonly string[],
	startIndex: number,
): { output: string; nextIndex: number } {
	let output = "";
	let argIndex = startIndex;
	let i = 0;
	while (i < format.length) {
		const char = format[i];
		if (char === "\\" && i + 1 < format.length && format[i + 1] in PRINTF_ESCAPES) {
			output += PRINTF_ESCAPES[format[i + 1]];
			i += 2;
			continue;
		}
		if (char === "%" && i + 1 < format.length) {
			const spec = format[i + 1];
			if (spec === "%") {
				output += "%";
				i += 2;
				continue;
			}
			if ("sdioxXf".includes(spec)) {
				const arg = args[argIndex] ?? "";
				argIndex++;
				if (spec === "s") output += arg;
				else if (spec === "f") output += String(Number.parseFloat(arg) || 0);
				else {
					const n = Number.parseInt(arg, 10) || 0;
					if (spec === "o") output += n.toString(8);
					else if (spec === "x") output += n.toString(16);
					else if (spec === "X") output += n.toString(16).toUpperCase();
					else output += String(n); // d, i
				}
				i += 2;
				continue;
			}
		}
		output += char;
		i++;
	}
	return { output, nextIndex: argIndex };
}

/**
 * Real printf semantics, not a plain arg-join: the format string interprets
 * \n/\t/\\/\"/\'/\0, and %s/%d/%i/%o/%x/%X/%f/%% substitute from the
 * remaining arguments. If there are more arguments than the format
 * consumes, the whole format is reapplied against the leftover arguments
 * (what real printf does with e.g. `printf '%s\n' a b c`); a format with no
 * specifiers at all still runs once even with extra arguments, rather than
 * looping forever with nothing left to consume.
 */
export function execPrintf(args: string[]): string {
	const format = args[1] ?? "";
	const values = args.slice(2);

	let result = "";
	let index = 0;
	do {
		const { output, nextIndex } = applyPrintfFormat(format, values, index);
		result += output;
		if (nextIndex === index) break; // format consumes no args - one pass is all there is
		index = nextIndex;
	} while (index < values.length);

	return result;
}

function findWalk(
	dir: string,
	nameRegex: RegExp | null,
	typeFilter: string | null,
	maxDepth: number,
	depth: number,
	root: string,
	results: string[],
): void {
	if (depth > maxDepth) return;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Matches grepInPath's own exclusion (see its comment): real find
		// descends into dot-directories too, so only .git and node_modules are
		// skipped - not every hidden entry. This used to disagree with grep -r
		// on the exact same tree (find . -name h.txt found nothing for a file
		// grep -r could see).
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (isOutside(full, root)) continue;
		const isDir = entry.isDirectory();
		const typeOk = !typeFilter || (typeFilter === "f" && entry.isFile()) || (typeFilter === "d" && isDir);
		const nameOk = !nameRegex || nameRegex.test(entry.name);
		if (typeOk && nameOk) results.push(`./${relative(root, full).replace(/\\/g, "/")}`);
		if (isDir) findWalk(full, nameRegex, typeFilter, maxDepth, depth + 1, root, results);
	}
}

export function execFind(args: string[], cwd: string, root: string): string {
	let dir = cwd;
	let nameRegex: RegExp | null = null;
	let typeFilter: string | null = null;
	let maxDepth = 20;

	for (let i = 1; i < args.length; i++) {
		if (args[i] === "-name" && i + 1 < args.length) nameRegex = globToRegex(args[++i]);
		else if (args[i] === "-type" && i + 1 < args.length) typeFilter = args[++i];
		else if (args[i] === "-maxdepth" && i + 1 < args.length) maxDepth = Number.parseInt(args[++i], 10);
		else if (!args[i].startsWith("-")) {
			const candidate = resolve(cwd, args[i]);
			if (!isOutside(candidate, root)) dir = candidate;
		}
	}

	const results: string[] = [];
	findWalk(dir, nameRegex, typeFilter, maxDepth, 0, root, results);
	return results.join("\n");
}

export function execCat(args: string[], cwd: string, root: string, stdin: string | null): string {
	const files = args.slice(1).filter((arg) => !arg.startsWith("-"));
	// Real cat with no file operands reads stdin - the classic `x | cat` or
	// `x | cat -A` pass-through. Without this, piping into cat with nothing
	// else silently produced no output at all.
	if (files.length === 0) return stdin ?? "";
	return files
		.map((file) => {
			const path = resolve(cwd, file);
			if (isBlocked(path, root)) return `Access denied: ${file}`;
			return readFileSafe(path) ?? `cat: ${file}: No such file or directory`;
		})
		.join("\n");
}

export function execLs(args: string[], cwd: string, root: string): string {
	const dirOnly = args.slice(1).some((arg) => arg.startsWith("-") && arg !== "-" && arg.includes("d"));
	const target = args.find((arg, i) => i > 0 && !arg.startsWith("-"));
	const path = resolve(cwd, target ?? ".");
	if (isBlocked(path, root)) return "Access denied: path outside project.";
	try {
		const stat = statSync(path);
		// readdirSync on a file throws ENOTDIR - that reads as "does not exist"
		// to a model, even though the file is right there; real `ls` on a file
		// argument just echoes its name back. -d asks for the same treatment on
		// a directory too: name it, don't list what's inside it.
		if (dirOnly || !stat.isDirectory()) return target ?? ".";
		return readdirSync(path, { withFileTypes: true })
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.join("\n");
	} catch {
		return `ls: ${target ?? "."}: No such file or directory`;
	}
}

/** `-r`/`-R` recurses into directories, `-f` silences missing/blocked targets. */
export function execRm(args: string[], cwd: string, root: string): string {
	let recursive = false;
	let force = false;
	const targets: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "r" || flag === "R") recursive = true;
				else if (flag === "f") force = true;
			}
		} else targets.push(arg);
	}
	if (targets.length === 0) return force ? "" : "rm: missing operand";

	const rows: string[] = [];
	for (const target of expandArgs(targets, cwd)) {
		const path = resolve(cwd, target);
		if (isBlocked(path, root)) {
			if (!force) rows.push(`Access denied: "${target}" is outside the project directory.`);
			continue;
		}
		try {
			const stat = statSync(path);
			if (stat.isDirectory() && !recursive) {
				rows.push(`rm: cannot remove '${target}': Is a directory`);
				continue;
			}
			rmSync(path, { recursive, force });
		} catch (error) {
			if (!force) rows.push(`rm: cannot remove '${target}': ${(error as Error).message}`);
		}
	}
	return rows.join("\n");
}

/**
 * `mkdir [-p] DIR...`. Without -p, an existing directory or a missing parent
 * is an error, like real mkdir; with -p both are fine.
 */
export function execMkdir(args: string[], cwd: string, root: string): string {
	let parents = false;
	const targets: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--parents") parents = true;
		else if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) if (flag === "p") parents = true;
		} else targets.push(arg);
	}
	if (targets.length === 0) return "mkdir: missing operand";

	const rows: string[] = [];
	for (const target of targets) {
		const path = resolve(cwd, target);
		if (isBlocked(path, root)) {
			rows.push(`Access denied: "${target}" is outside the project directory.`);
			continue;
		}
		let existing: ReturnType<typeof statSync> | null = null;
		try {
			existing = statSync(path);
		} catch {
			existing = null;
		}
		if (existing) {
			if (!parents || !existing.isDirectory()) rows.push(`mkdir: cannot create directory '${target}': File exists`);
			continue;
		}
		try {
			mkdirSync(path, { recursive: parents });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const reason = code === "ENOENT" ? "No such file or directory" : (error as Error).message;
			rows.push(`mkdir: cannot create directory '${target}': ${reason}`);
		}
	}
	return rows.join("\n");
}

/**
 * `cp [-r] [-n] SOURCE... DEST`: one source to a file or directory, or several
 * into an existing directory. Bytes are copied as they are, so a
 * Windows-1252 file stays Windows-1252. A directory needs -r, like real cp;
 * -n never overwrites an existing file.
 */
export function execCp(args: string[], cwd: string, root: string): string {
	let recursive = false;
	let noClobber = false;
	const operands: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--recursive") recursive = true;
		else if (arg === "--no-clobber") noClobber = true;
		else if (arg.startsWith("-") && arg !== "-") {
			for (const flag of shortFlags(arg)) {
				if (flag === "r" || flag === "R" || flag === "a") recursive = true;
				else if (flag === "n") noClobber = true;
				// -f, -p, -v: accepted, nothing to do - cp already overwrites and never prints
			}
		} else operands.push(arg);
	}
	const positional = expandArgs(operands, cwd);
	if (positional.length === 0) return "cp: missing file operand";
	if (positional.length === 1) return `cp: missing destination file operand after '${positional[0]}'`;

	const dest = positional[positional.length - 1];
	const sources = positional.slice(0, -1);
	const destPath = resolve(cwd, dest);
	if (isBlocked(destPath, root)) return `Access denied: "${dest}" is outside the project directory.`;

	let destIsDir = false;
	try {
		destIsDir = statSync(destPath).isDirectory();
	} catch {
		destIsDir = false;
	}
	if (sources.length > 1 && !destIsDir) return `cp: target '${dest}' is not a directory`;

	const rows: string[] = [];
	for (const source of sources) {
		const sourcePath = resolve(cwd, source);
		if (isBlocked(sourcePath, root)) {
			rows.push(`Access denied: "${source}" is outside the project directory.`);
			continue;
		}
		let sourceStat: ReturnType<typeof statSync>;
		try {
			sourceStat = statSync(sourcePath);
		} catch {
			rows.push(`cp: cannot stat '${source}': No such file or directory`);
			continue;
		}
		if (sourceStat.isDirectory() && !recursive) {
			rows.push(`cp: -r not specified; omitting directory '${source}'`);
			continue;
		}
		const targetPath = destIsDir ? join(destPath, basename(sourcePath)) : destPath;
		if (isBlocked(targetPath, root)) {
			rows.push(`Access denied: "${dest}" is outside the project directory.`);
			continue;
		}
		if (!isOutside(targetPath, sourcePath) && sourceStat.isDirectory()) {
			rows.push(`cp: cannot copy a directory, '${source}', into itself, '${dest}'`);
			continue;
		}
		if (pathKey(targetPath) === pathKey(sourcePath)) {
			rows.push(`cp: '${source}' and '${dest}' are the same file`);
			continue;
		}
		try {
			cpSync(sourcePath, targetPath, { recursive, force: !noClobber, errorOnExist: false });
		} catch (error) {
			rows.push(`cp: cannot copy '${source}' to '${dest}': ${(error as Error).message}`);
		}
	}
	return rows.join("\n");
}

/** Single source -> dest, or multiple sources -> an existing directory. No flags. */
export function execMv(args: string[], cwd: string, root: string): string {
	const positional = expandArgs(
		args.slice(1).filter((arg) => !arg.startsWith("-")),
		cwd,
	);
	if (positional.length < 2) return "mv: missing file operand";

	const dest = positional[positional.length - 1];
	const sources = positional.slice(0, -1);
	const destPath = resolve(cwd, dest);
	if (isBlocked(destPath, root)) return `Access denied: "${dest}" is outside the project directory.`;

	let destIsDir = false;
	try {
		destIsDir = statSync(destPath).isDirectory();
	} catch {
		destIsDir = false;
	}
	if (sources.length > 1 && !destIsDir) return `mv: target '${dest}' is not a directory`;

	const rows: string[] = [];
	for (const source of sources) {
		const sourcePath = resolve(cwd, source);
		if (isBlocked(sourcePath, root)) {
			rows.push(`Access denied: "${source}" is outside the project directory.`);
			continue;
		}
		const targetPath = destIsDir ? join(destPath, basename(sourcePath)) : destPath;
		if (isBlocked(targetPath, root)) {
			rows.push(`Access denied: "${dest}" is outside the project directory.`);
			continue;
		}
		try {
			renameSync(sourcePath, targetPath);
		} catch (error) {
			rows.push(`mv: cannot move '${source}' to '${dest}': ${(error as Error).message}`);
		}
	}
	return rows.join("\n");
}
