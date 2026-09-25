/**
 * The emulated commands themselves — pure Node, no shell, no child processes
 * except git (see git.ts).
 *
 * Every one of these takes the sandbox root and refuses to touch anything
 * outside it, which is what makes the whitelist a containment boundary rather
 * than a convenience: there is no interpreter here that could be talked into
 * reading a path we did not resolve ourselves.
 */

import { type Dirent, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isBlocked, isOutside, isSpilled } from "../paths.ts";
import { globToRegex, parseLineCount } from "./parse.ts";

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
 * Read a file as latin1 so Windows-1252 sources survive the round trip; the
 * temp logs we spilled ourselves are UTF-8. (Encoding-correct reading and
 * writing of source files is pi-improved's job — this is only for grep/cat.)
 */
export function readFileSafe(path: string): string | null {
	try {
		return readFileSync(path, isSpilled(path) ? "utf8" : "latin1");
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
}

function grepInPath(
	path: string,
	pattern: RegExp,
	flags: GrepFlags,
	root: string,
	results: string[],
	showFile: boolean,
): void {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		return;
	}

	if (stat.isDirectory()) {
		if (!flags.recursive) return;
		let entries: string[];
		try {
			entries = readdirSync(path);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			grepInPath(join(path, entry), pattern, flags, root, results, showFile);
		}
		return;
	}
	if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return;

	const content = readFileSafe(path);
	if (!content) return;
	const lines = content.split("\n");
	const rel = `./${relative(root, path).replace(/\\/g, "/")}`;

	if (flags.countOnly) {
		let count = 0;
		for (const line of lines) {
			if (pattern.test(line) === flags.invert) continue;
			count++;
		}
		results.push(showFile ? `${rel}:${count}` : String(count));
		return;
	}

	for (let i = 0; i < lines.length; i++) {
		if (pattern.test(lines[i]) === flags.invert) continue;
		if (flags.filesOnly) {
			if (!results.includes(rel)) results.push(rel);
			return;
		}
		let line = "";
		if (showFile) line += `${rel}:`;
		if (flags.lineNumbers) line += `${i + 1}:`;
		results.push(line + lines[i]);
	}
}

export function execGrep(args: string[], cwd: string, root: string, stdin: string | null): string {
	const flags: GrepFlags = { recursive: false, lineNumbers: false, filesOnly: false, invert: false, countOnly: false };
	let ignoreCase = false;
	let pattern: string | null = null;
	const targets: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") continue;
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of arg.slice(1)) {
				if (flag === "r" || flag === "R") flags.recursive = true;
				else if (flag === "n") flags.lineNumbers = true;
				else if (flag === "i") ignoreCase = true;
				else if (flag === "l") flags.filesOnly = true;
				else if (flag === "v") flags.invert = true;
				else if (flag === "c") flags.countOnly = true;
				// unknown flags are ignored
			}
		} else if (pattern === null) pattern = arg;
		else targets.push(resolve(cwd, arg));
	}

	if (!pattern) return "(grep: no pattern)";

	let regex: RegExp;
	try {
		regex = new RegExp(pattern, ignoreCase ? "i" : "");
	} catch {
		regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
	}

	const results: string[] = [];
	if (targets.length === 0 && stdin !== null) {
		const lines = stdin.split("\n");
		if (flags.countOnly) {
			let count = 0;
			for (const line of lines) {
				if (regex.test(line) === flags.invert) continue;
				count++;
			}
			return String(count);
		}
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i]) === flags.invert) continue;
			results.push(flags.lineNumbers ? `${i + 1}:${lines[i]}` : lines[i]);
		}
	} else {
		const showFile = flags.recursive || targets.length > 1;
		for (const target of targets) {
			if (isBlocked(target, root)) continue;
			grepInPath(target, regex, flags, root, results, showFile);
		}
	}
	return results.join("\n");
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

export function execWc(args: string[], cwd: string, root: string, stdin: string | null): string {
	const files = expandArgs(args.slice(1), cwd).filter((arg) => !arg.startsWith("-"));

	if (files.length > 0) {
		const rows: string[] = [];
		let total = 0;
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
			const count = countLines(content);
			total += count;
			rows.push(`${String(count).padStart(8)} ${file}`);
		}
		if (files.length > 1) rows.push(`${String(total).padStart(8)} total`);
		return rows.join("\n");
	}
	if (stdin !== null) {
		return String(countLines(stdin)).padStart(8);
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
			for (const flag of arg.slice(1)) {
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
 * The positional file argument for head/tail, skipping over -n's own value
 * (`-n 3 file.txt`) and the old-style `-N` count form (`-3 file.txt`) so
 * neither is mistaken for a filename.
 */
function fileArgFor(args: string[]): string | null {
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-n") {
			i++; // skip its value
			continue;
		}
		if (/^-\d+$/.test(arg)) continue;
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return null;
}

export function execHead(args: string[], cwd: string, root: string, stdin: string | null): string {
	const file = fileArgFor(args);
	if (file) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) return "Access denied: path outside project.";
		const content = readFileSafe(path);
		if (content === null) return `head: ${file}: No such file or directory`;
		const lines = content.split("\n");
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		return lines.slice(0, parseLineCount(args, 10)).join("\n");
	}
	return (stdin ?? "").split("\n").slice(0, parseLineCount(args, 10)).join("\n");
}

export function execTail(args: string[], cwd: string, root: string, stdin: string | null): string {
	const file = fileArgFor(args);
	let content: string;
	if (file) {
		const path = resolve(cwd, file);
		if (isBlocked(path, root)) return "Access denied: path outside project.";
		const read = readFileSafe(path);
		if (read === null) return `tail: ${file}: No such file or directory`;
		content = read;
	} else {
		content = stdin ?? "";
	}
	const lines = content.split("\n");
	// A trailing newline terminates the last line, it does not start an empty
	// one — counting it would shift the window by one against what tail prints.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(Math.max(0, lines.length - parseLineCount(args, 10))).join("\n");
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
			for (const flag of arg.slice(1)) {
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
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (isOutside(full, root)) continue;
		const isDir = entry.isDirectory();
		const typeOk = !typeFilter || (typeFilter === "f" && entry.isFile()) || (typeFilter === "d" && isDir);
		const nameOk = !nameRegex || nameRegex.test(entry.name);
		if (typeOk && nameOk) results.push(full.replace(/\\/g, "/"));
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

export function execCat(args: string[], cwd: string, root: string): string {
	return args
		.slice(1)
		.filter((arg) => !arg.startsWith("-"))
		.map((file) => {
			const path = resolve(cwd, file);
			if (isBlocked(path, root)) return `Access denied: ${file}`;
			return readFileSafe(path) ?? `cat: ${file}: No such file or directory`;
		})
		.join("\n");
}

export function execLs(args: string[], cwd: string, root: string): string {
	const target = args.find((arg, i) => i > 0 && !arg.startsWith("-"));
	const path = resolve(cwd, target ?? ".");
	if (isBlocked(path, root)) return "Access denied: path outside project.";
	try {
		const stat = statSync(path);
		// readdirSync on a file throws ENOTDIR - that reads as "does not exist"
		// to a model, even though the file is right there; real `ls` on a file
		// argument just echoes its name back.
		if (!stat.isDirectory()) return basename(path);
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
			for (const flag of arg.slice(1)) {
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
