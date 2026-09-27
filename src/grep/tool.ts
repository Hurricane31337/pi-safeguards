/**
 * The `grep` tool, registered under pi's own name so it replaces the built-in.
 *
 * pi's grep hands rg the pattern and prints whatever comes back, which on a
 * tree mixing UTF-8 and Windows-1252 means silent false negatives for every
 * non-ASCII pattern and `J?rg`-style output for legacy lines - and pi's
 * `GrepOperations` seam only covers reading context lines, not the search. So
 * this is a second deliberate reimplementation (after bash, see tool.ts in
 * shell/), keeping pi's contract where one exists: same name, same original
 * parameters (all additions optional), pi's renderers, pi's line and byte
 * truncation, and the same `details` fields the renderers read.
 *
 * What it adds, all of it from agent feedback on a real mixed-encoding repo:
 * per-file encoding (search.ts), count / filesWithMatches modes, maxCount,
 * separate before/after context that never eats the match budget, totals and
 * an explicit truncated flag in every result, deterministic path order,
 * `path:line:text` with no extra space (the emulator's grep format), paths
 * relative to the project root, a path-syntax check, and a wall-clock cap.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createGrepToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	type ToolDefinition,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	displayPath,
	type EncodingMode,
	type FileHit,
	needsLegacyPass,
	resolveRipgrepPath,
	runSearchAsync,
	SearchError,
	type SearchOutcome,
} from "./search.ts";

const DEFAULT_LIMIT = 100;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const TIMEOUT_MS = 60_000;
const MAX_LISTED_BINARIES = 10;
const MAX_LISTED_WARNINGS = 5;

/** A string enum as plain JSON schema (`enum`), which every provider accepts - pi-ai's StringEnum, inlined. */
function stringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const MODES = ["content", "count", "filesWithMatches"] as const;
const ENCODINGS = ["auto", "utf-8", "windows-1252"] as const;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (ripgrep/Rust regex, or plain text with literal=true)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search, relative to the project (default: project root)" }),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.vb' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Lines of context before and after each match (default: 0; content mode only)" }),
	),
	before: Type.Optional(Type.Number({ description: "Lines of context before each match; overrides context" })),
	after: Type.Optional(Type.Number({ description: "Lines of context after each match; overrides context" })),
	limit: Type.Optional(
		Type.Number({
			description: `Maximum matches (content mode) or files (count / filesWithMatches) to list (default: ${DEFAULT_LIMIT}). Totals are always reported in full.`,
		}),
	),
	mode: Type.Optional(
		stringEnum(
			MODES,
			"content: matching lines (default); count: matching lines per file as path:N; filesWithMatches: one path per line",
		),
	),
	maxCount: Type.Optional(Type.Number({ description: "Stop after this many matching lines per file" })),
	includeIgnored: Type.Optional(
		Type.Boolean({ description: "Also search files excluded by .gitignore/.ignore (default: false)" }),
	),
	encoding: Type.Optional(
		stringEnum(
			ENCODINGS,
			"auto (default): each file as UTF-8/UTF-16 when it has a BOM or is valid UTF-8, else as Windows-1252; utf-8 or windows-1252 forces one decoding for every file",
		),
	),
});

export type SafeguardGrepInput = Static<typeof grepSchema>;

export interface SafeguardGrepDetails {
	/** Matching lines across all text files (maxCount-capped when maxCount is set). */
	totalMatches: number;
	/** Text files with at least one match. */
	totalFiles: number;
	/** Binary files that matched; named, never printed. */
	binaryFiles: string[];
	/** Something was left out: the limit, the byte cap, or the time cap. */
	truncated: boolean;
	timedOut?: boolean;
	// The fields pi's own grep renderer reads.
	matchLimitReached?: number;
	truncation?: ReturnType<typeof truncateHead>;
	linesTruncated?: boolean;
}

/** Syntax that can only be a mistake, checked before anything touches the disk. */
export function pathSyntaxError(path: string): string | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\x00-\x1f]/.test(path)) return "it contains control characters";
	if (process.platform === "win32") {
		const rest = path.replace(/^(\\\\\?\\)?[A-Za-z]:/, "");
		if (rest.includes(":")) return 'it contains ":" after the drive prefix (a malformed path like "C:/:/x")';
		if (/[<>"|?*]/.test(rest)) return 'it contains one of < > " | ? * (use the glob parameter for wildcards)';
	}
	return null;
}

function nonNegativeInt(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

/**
 * pi downloads rg the first time its own grep runs, via `ensureTool` - which
 * is not exported. Running pi's grep once over an empty directory triggers
 * exactly that download, after which the binary is where search.ts looks.
 */
async function bootstrapRipgrep(cwd: string): Promise<string | null> {
	const empty = mkdtempSync(join(tmpdir(), "pi-grep-bootstrap-"));
	try {
		await createGrepToolDefinition(cwd).execute(
			"rg-bootstrap",
			{ pattern: "x", path: empty },
			undefined,
			undefined,
			undefined as never,
		);
	} catch {
		// Offline or blocked: reported below as "not available".
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
	return resolveRipgrepPath();
}

interface FormatInput {
	outcome: SearchOutcome;
	mode: (typeof MODES)[number];
	limit: number;
	after: number;
	grouped: boolean;
	cwd: string;
	pattern: string;
	literal: boolean;
	encoding: EncodingMode;
	maxCount: number | null;
}

function formatResult(input: FormatInput): { text: string; details: SafeguardGrepDetails } {
	const { outcome, mode, limit, cwd } = input;
	const textFiles = outcome.files.filter((file) => !file.binary);
	const binaryFiles = outcome.files.filter((file) => file.binary).map((file) => displayPath(file.path, cwd));
	const totalMatches = textFiles.reduce((sum, file) => sum + file.matchCount, 0);
	const details: SafeguardGrepDetails = {
		totalMatches,
		totalFiles: textFiles.length,
		binaryFiles,
		truncated: false,
	};

	const body: string[] = [];
	let shown = 0;
	if (mode === "content") shown = formatContent(textFiles, input, body, details);
	else {
		for (const file of textFiles.slice(0, limit)) {
			const rel = displayPath(file.path, cwd);
			body.push(mode === "count" ? `${rel}:${file.matchCount}` : rel);
		}
		shown = Math.min(limit, textFiles.length);
		if (textFiles.length > limit) {
			details.truncated = true;
			details.matchLimitReached = limit;
		}
	}

	const notes: string[] = [];
	let text = "";
	if (body.length > 0) {
		const truncation = truncateHead(body.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		text = truncation.content;
		if (truncation.truncated) {
			details.truncated = true;
			details.truncation = truncation;
			notes.push(`output cut at ${formatSize(DEFAULT_MAX_BYTES)}; narrow path/glob/pattern or lower limit`);
		}
	}

	// The summary line: always there, so "no more results" is never a guess.
	const capped = input.maxCount !== null ? ` (at most ${input.maxCount} per file, maxCount)` : "";
	const lowerBound = outcome.timedOut ? "at least " : "";
	let summary: string;
	if (totalMatches === 0 && binaryFiles.length === 0) {
		summary = "No matches found";
		if (outcome.legacyPassRan) summary += " (searched both UTF-8 and Windows-1252 decodings)";
	} else if (mode === "content") {
		summary = `${lowerBound}${plural(totalMatches, "matching line")}${capped} in ${lowerBound}${plural(textFiles.length, "file")}`;
		if (shown < totalMatches)
			summary += `; showing the first ${shown}. truncated=true - use limit=${limit * 2}, mode=count, or narrow path/glob/pattern`;
		else summary += "; truncated=false";
	} else {
		summary = `${lowerBound}${plural(totalMatches, "matching line")}${capped} in ${lowerBound}${plural(textFiles.length, "file")}`;
		if (shown < textFiles.length)
			summary += `; listing ${shown} of them. truncated=true - use limit=${limit * 2} or narrow path/glob`;
		else summary += "; truncated=false";
	}
	if (details.truncated && !summary.includes("truncated=true")) summary += " (output truncated=true)";

	if (binaryFiles.length > 0) {
		const listed = binaryFiles.slice(0, MAX_LISTED_BINARIES).join(", ");
		const more =
			binaryFiles.length > MAX_LISTED_BINARIES ? ` (+${binaryFiles.length - MAX_LISTED_BINARIES} more)` : "";
		notes.push(
			`${plural(binaryFiles.length, "binary file")} also ${binaryFiles.length === 1 ? "matches" : "match"}, content not shown: ${listed}${more}`,
		);
	}
	if (details.linesTruncated) notes.push("some lines cut at 500 chars; use the read tool for the full line");
	if (outcome.usedPcre2) notes.push("pattern needs look-around/backreferences: searched with PCRE2");
	if (input.encoding === "utf-8" && needsLegacyPass(input.pattern, input.literal)) {
		notes.push(
			"warning: encoding=utf-8 - Windows-1252 files were searched as raw bytes, so non-ASCII text in them cannot match; use encoding=auto",
		);
	}
	if (outcome.timedOut) {
		details.truncated = true;
		details.timedOut = true;
		notes.push(
			`warning: search stopped after ${TIMEOUT_MS / 1000}s - results and totals are incomplete; narrow path/glob`,
		);
	}
	for (const warning of outcome.warnings.slice(0, MAX_LISTED_WARNINGS)) notes.push(`warning: ${warning}`);
	if (outcome.warnings.length > MAX_LISTED_WARNINGS) {
		notes.push(`warning: ${outcome.warnings.length - MAX_LISTED_WARNINGS} more rg messages not shown`);
	}

	const footer = [`[${summary}]`, ...notes.map((note) => `[${note}]`)].join("\n");
	return { text: text ? `${text}\n\n${footer}` : footer, details };
}

/** Content mode: the first `limit` matches, their context, `--` between non-adjacent groups. Returns matches shown. */
function formatContent(files: FileHit[], input: FormatInput, body: string[], details: SafeguardGrepDetails): number {
	let shown = 0;
	for (const file of files) {
		if (shown >= input.limit) break;
		const rel = displayPath(file.path, input.cwd);
		let previous = -1;
		let lastMatch = -1;
		for (const hit of file.lines) {
			if (hit.kind === "match") {
				if (shown >= input.limit) break;
				shown++;
				lastMatch = hit.line;
			} else if (shown >= input.limit && !(lastMatch >= 0 && hit.line <= lastMatch + input.after)) {
				break;
			}
			if (input.grouped && body.length > 0 && (previous === -1 || hit.line > previous + 1)) body.push("--");
			const { text, wasTruncated } = truncateLine(hit.text);
			if (wasTruncated) details.linesTruncated = true;
			body.push(hit.kind === "match" ? `${rel}:${hit.line}:${text}` : `${rel}-${hit.line}-${text}`);
			previous = hit.line;
		}
	}
	const total = files.reduce((sum, file) => sum + file.matchCount, 0);
	if (shown < total) {
		details.truncated = true;
		details.matchLimitReached = input.limit;
	}
	return shown;
}

export function createSafeguardGrepTool(root: string): ToolDefinition<typeof grepSchema, SafeguardGrepDetails> {
	const piGrep = createGrepToolDefinition(root);
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with ripgrep. Content mode returns `path:line:text` lines (paths relative to the " +
			"project directory, forward slashes, no ./ prefix, CRLF normalised); context lines are `path-line-text`, " +
			"with `--` between non-adjacent groups. Every result ends with a bracketed summary: total matching " +
			"lines and files, and truncated=true/false. " +
			"Encoding: each file is decoded on its own - UTF-8 with or without BOM, UTF-16 with BOM, or " +
			"Windows-1252 (legacy ANSI) - so a non-ASCII pattern such as Einträge matches in all of them in one " +
			"call, and output is always decoded text. " +
			"mode=count prints path:N (matching lines per file); mode=filesWithMatches prints one path per line; " +
			`limit caps matches in content mode and files in the other modes (default ${DEFAULT_LIMIT}), and ` +
			"context lines never count against it; maxCount stops after N matching lines per file. Results are in " +
			"stable path order. " +
			"Respects .gitignore while walking, but a path that names an ignored directory directly is still " +
			"searched; includeIgnored=true walks ignored files too. Hidden files are searched, .git is not. " +
			"A binary file named in path (or one whose NUL byte comes after a match) is reported in the summary, " +
			"never printed; binary files met while walking a directory are skipped, as rg does. " +
			"Regex dialect is ripgrep's (Rust regex), not PCRE or JavaScript: | alternation, groups, [classes], " +
			"\\b \\d \\w \\s (Unicode-aware); matching is per line and . never matches a newline. Case-sensitive " +
			"unless ignoreCase=true (no smart-case); case folding is simple, so ß does not match SS. Look-around " +
			"and backreferences are not part of the dialect - such a pattern is retried with PCRE2 and the result " +
			"says so. literal=true searches plain text with no escaping. Lines are cut at 500 chars and output at " +
			`${DEFAULT_MAX_BYTES / 1024}KB; a search running over ${TIMEOUT_MS / 1000}s is stopped and reported as incomplete.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore; UTF-8 and Windows-1252 files)",
		parameters: grepSchema,
		renderCall: piGrep.renderCall as ToolDefinition<typeof grepSchema, SafeguardGrepDetails>["renderCall"],
		renderResult: piGrep.renderResult as ToolDefinition<typeof grepSchema, SafeguardGrepDetails>["renderResult"],

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? root;
			const requested = params.path?.trim() || ".";
			const syntaxError = pathSyntaxError(requested);
			if (syntaxError) throw new Error(`Invalid path "${requested}": ${syntaxError}.`);
			const searchPath = resolve(cwd, requested);
			try {
				statSync(searchPath);
			} catch {
				throw new Error(`Path not found: ${requested}`);
			}

			const mode = params.mode ?? "content";
			const limit = Math.max(1, nonNegativeInt(params.limit) ?? DEFAULT_LIMIT);
			const context = nonNegativeInt(params.context) ?? 0;
			const before = mode === "content" ? (nonNegativeInt(params.before) ?? context) : 0;
			const after = mode === "content" ? (nonNegativeInt(params.after) ?? context) : 0;
			const maxCount = nonNegativeInt(params.maxCount) || null;
			const encoding = params.encoding ?? "auto";
			const literal = params.literal ?? false;

			const rgPath = resolveRipgrepPath() ?? (await bootstrapRipgrep(cwd));
			if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");

			let outcome: SearchOutcome;
			try {
				outcome = await runSearchAsync(
					{
						pattern: params.pattern,
						targets: [searchPath],
						ignoreCase: params.ignoreCase ?? false,
						literal,
						invert: false,
						globs: params.glob ? [params.glob, "!.git"] : ["!.git"],
						respectIgnore: !params.includeIgnored,
						hidden: true,
						maxCount,
						before,
						after,
						maxFileSize: null,
						encoding,
						storeMatches: mode === "content" ? limit : 0,
						timeoutMs: TIMEOUT_MS,
					},
					rgPath,
					signal,
				);
			} catch (error) {
				if (error instanceof SearchError) throw new Error(`Invalid pattern: ${error.message}`);
				throw error;
			}

			const { text, details } = formatResult({
				outcome,
				mode,
				limit,
				after,
				grouped: before > 0 || after > 0,
				cwd,
				pattern: params.pattern,
				literal,
				encoding,
				maxCount,
			});
			return { content: [{ type: "text", text }], details };
		},
	};
}
