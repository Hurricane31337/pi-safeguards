/**
 * Optional ripgrep-backed fast path for the emulator's recursive `grep -r`.
 *
 * pi core's own `grep` tool already downloads and caches a private ripgrep
 * binary the first time the model calls it (`ensureTool("rg")` in pi core's
 * utils/tools-manager.ts), at `<agent dir>/bin/rg[.exe]`. By the time a
 * session reaches for `grep -r` inside bash, that binary is already on disk
 * on essentially every machine that has used this agent at all - reusing it
 * here avoids bundling or downloading a second copy. `getAgentDir()` is the
 * one piece of that machinery pi core actually exports, and unlike
 * getModelsPath()/getAuthPath()/getSettingsPath(), the branded
 * 0003-flat-config-layout patch (pi-IDE-Extensions) does not redirect the
 * tools directory - tools-manager.ts's TOOLS_DIR is untouched by that patch,
 * so plain getAgentDir() + "bin" is correct on every branch, not just `main`.
 *
 * Used only for the recursive multi-file walk (`grep -r`), where a
 * directory tree's worth of files makes ripgrep's parallel walk actually pay
 * for itself; a single file or a piped-stdin search is already fast enough
 * in plain JS and never reaches this module (see execGrep in commands.ts).
 *
 * Whenever ripgrep can't be found, or the pattern is something its regex
 * engine does not accept (JS lookahead/lookbehind/backreferences, none of
 * which the plain JS path is restricted to), this returns null and the
 * caller falls back to the pure-JS walk. This is a pure optimisation, never
 * a behaviour change: a caller that gets null must see the exact same
 * result it would have gotten had this module not existed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let cachedPath: string | null | undefined;

/** Test seam: bypass the real lookup with a fixed path (or null to force "not found"). */
let pathOverride: string | null | undefined;

/** Resolved once per process and cached either way - existsSync is cheap, but this runs on every recursive grep. */
function resolveRipgrepPath(): string | null {
	if (pathOverride !== undefined) return pathOverride;
	if (cachedPath !== undefined) return cachedPath;
	const candidate = join(getAgentDir(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
	cachedPath = existsSync(candidate) ? candidate : null;
	return cachedPath;
}

/** Test seam: force resolveRipgrepPath()'s answer, bypassing getAgentDir()/existsSync entirely. */
export function setRipgrepPathForTests(path: string | null | undefined): void {
	pathOverride = path;
}

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

interface RgMatchEvent {
	type: string;
	data: {
		path: { text: string };
		line_number: number;
		lines: { text: string };
	};
}

/** Same 10MB cap grepInPath applies in the JS walk (commands.ts), spelled out in raw bytes for rg. */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Runs ripgrep over `targets` (already sandbox-checked, absolute paths) and
 * returns output lines in the exact same shape `grepInPath` would have
 * produced, or null on anything that should fall back to the JS walk:
 * ripgrep missing, a regex it refuses, or a process-level failure. Only
 * `.git` and `node_modules` are excluded, matching grepInPath's own filter -
 * not .gitignore, which the JS walk never consults either, and not other
 * dot-directories, which real grep -r does descend into (rg's own default is
 * the opposite - hidden files/dirs excluded unless --hidden is passed - so
 * --hidden is required here specifically to match grep, not rg's defaults).
 */
export function execRipgrepGrep(
	patternSource: string,
	targets: string[],
	root: string,
	options: RipgrepGrepOptions,
): string[] | null {
	const rgPath = resolveRipgrepPath();
	if (!rgPath) return null;

	const args = [
		"--no-config",
		"--no-ignore",
		"--hidden",
		"--max-filesize",
		String(MAX_FILE_SIZE_BYTES),
		"--glob",
		"!node_modules",
		"--glob",
		"!.git",
	];
	if (options.includeGlob) args.push("--glob", options.includeGlob);
	if (options.excludeDirGlob) args.push("--glob", `!${options.excludeDirGlob}`);
	if (options.filesOnly) args.push("--files-with-matches");
	else args.push("--json");
	if (options.ignoreCase) args.push("--ignore-case");
	if (options.invert) args.push("--invert-match");
	if (options.maxCount !== null) args.push("--max-count", String(options.maxCount));
	args.push("-e", patternSource, "--", ...targets);

	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(rgPath, args, {
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return null;
	}
	// 0 = matches found, 1 = ran fine but no matches, 2 = usage/regex error -
	// only the last (and a spawn-level failure) means "fall back to JS".
	if (result.error || result.status === 2 || result.status === null) return null;

	if (options.filesOnly) {
		return String(result.stdout ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((path) => `./${relative(root, path).replace(/\\/g, "/")}`);
	}

	const output: string[] = [];
	for (const line of String(result.stdout ?? "").split("\n")) {
		if (!line.trim()) continue;
		let event: RgMatchEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		// rg's own binary detection (a NUL byte in the leading block) reports a
		// "binary" event instead of "match" - surfaced the same way
		// grepInPath's JS walk reports it, so a caller sees identical output
		// whichever path actually ran the search.
		if (event.type === "binary") {
			output.push(`grep: ./${relative(root, event.data.path.text).replace(/\\/g, "/")}: binary file matches`);
			continue;
		}
		if (event.type !== "match") continue;
		let entry = "";
		if (options.showFile) entry += `./${relative(root, event.data.path.text).replace(/\\/g, "/")}:`;
		if (options.lineNumbers) entry += `${event.data.line_number}:`;
		entry += event.data.lines.text.replace(/\r?\n$/, "");
		output.push(entry);
	}
	return output;
}
