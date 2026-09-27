/**
 * Optional ripgrep-backed fast path for the emulator's recursive `grep -r`,
 * on top of the engine the `grep` tool uses (grep/search.ts).
 *
 * Used only for the recursive multi-file walk (`grep -r`), where a
 * directory tree's worth of files makes ripgrep's parallel walk actually pay
 * for itself; a single file or a piped-stdin search is already fast enough
 * in plain JS and never reaches this module (see execGrep in commands.ts).
 *
 * Whenever ripgrep can't be found, or the pattern is something its regex
 * engine refuses even with PCRE2, this returns null and the caller falls back
 * to the pure-JS walk. Both paths decode UTF-8 (BOM or not) and Windows-1252
 * per file, and both report a binary file instead of printing it, so a caller
 * sees the same result whichever one ran.
 */

import { relative } from "node:path";
import { runSearchSync } from "../grep/search.ts";

export { setRipgrepPathForTests } from "../grep/search.ts";

export interface RipgrepGrepOptions {
	ignoreCase: boolean;
	invert: boolean;
	lineNumbers: boolean;
	filesOnly: boolean;
	/** `--include=GLOB` text, passed straight through - rg's --glob already speaks gitignore-style globs, no translation needed. */
	includeGlob: string | null;
	/** `--exclude-dir=GLOB` text, passed straight through as a negated --glob, same as includeGlob. */
	excludeDirGlob: string | null;
	/** Whether to prefix each match with its file path - commands.ts's own showFile, honoring -h/-H. */
	showFile: boolean;
	/** `-m`/`--max-count`: stop after this many matching lines, per file. null means unlimited. */
	maxCount: number | null;
}

/** Same 10MB cap grepInPath applies in the JS walk (commands.ts), spelled out in raw bytes for rg. */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** The emulator is synchronous; a search that runs this long is stopped and says so. */
const TIMEOUT_MS = 60_000;

/**
 * Runs ripgrep over `targets` (already sandbox-checked, absolute paths) and
 * returns output lines in the exact same shape `grepInPath` would have
 * produced, or null when the JS walk should run instead. Only `.git` and
 * `node_modules` are excluded, matching grepInPath's own filter - not
 * .gitignore, which the JS walk never consults either, and not other
 * dot-directories, which real grep -r does descend into.
 */
export function execRipgrepGrep(
	patternSource: string,
	targets: string[],
	root: string,
	options: RipgrepGrepOptions,
): string[] | null {
	const globs = ["!node_modules", "!.git"];
	if (options.includeGlob) globs.push(options.includeGlob);
	if (options.excludeDirGlob) globs.push(`!${options.excludeDirGlob}`);

	let outcome: ReturnType<typeof runSearchSync>;
	try {
		outcome = runSearchSync({
			pattern: patternSource,
			targets,
			ignoreCase: options.ignoreCase,
			literal: false,
			invert: options.invert,
			globs,
			respectIgnore: false,
			hidden: true,
			maxCount: options.maxCount,
			before: 0,
			after: 0,
			maxFileSize: MAX_FILE_SIZE_BYTES,
			encoding: "auto",
			storeMatches: Number.POSITIVE_INFINITY,
			timeoutMs: TIMEOUT_MS,
		});
	} catch {
		// A pattern rg refuses even with PCRE2 (SearchError), or rg failing to
		// start: the JS walk uses a JS RegExp and needs neither.
		return null;
	}
	if (!outcome) return null;

	const label = (path: string) => `./${relative(root, path).replace(/\\/g, "/")}`;
	const output: string[] = [];
	for (const file of outcome.files) {
		if (options.filesOnly) {
			output.push(label(file.path));
			continue;
		}
		if (file.binary) {
			output.push(`grep: ${label(file.path)}: binary file matches`);
			continue;
		}
		for (const hit of file.lines) {
			let entry = "";
			if (options.showFile) entry += `${label(file.path)}:`;
			if (options.lineNumbers) entry += `${hit.line}:`;
			output.push(entry + hit.text);
		}
	}
	for (const warning of outcome.warnings) output.push(warning.replace(/^rg:/, "grep:"));
	if (outcome.timedOut) output.push(`grep: search stopped after ${TIMEOUT_MS / 1000}s - results are incomplete`);
	return output;
}
