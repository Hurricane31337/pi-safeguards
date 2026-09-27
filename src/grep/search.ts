/**
 * The ripgrep search engine shared by the `grep` tool (grep/tool.ts) and the
 * emulated bash's `grep -r` (shell/ripgrep.ts).
 *
 * The one thing rg cannot do on its own is what this project exists for:
 * search a tree that mixes UTF-8 (with and without BOM) and Windows-1252.
 * rg decodes a file as UTF-8 unless a BOM says otherwise, so a non-ASCII
 * pattern (`Einträge`, `[äöü]`, even `Eintr.ge`) never matches the CP1252
 * bytes of a legacy file - a silent false negative - and a matched legacy
 * line comes back in `--json` as base64 `lines.bytes` instead of `lines.text`
 * (which is what crashed the emulator: `lines.text.replace` on undefined).
 * `--encoding windows-1252` fixes the legacy files and breaks every UTF-8 one
 * instead, including UTF-8 *with* BOM (rg's explicit encoding wins over it).
 *
 * So `encoding: "auto"` runs two passes - rg's default, and windows-1252 - and
 * takes every file from exactly one of them: a file with a BOM or valid UTF-8
 * content from the first, anything else from the second (`classifyFile`,
 * cached, only ever called for files that produced a hit). The second pass is
 * skipped when the pattern provably cannot tell the two decodings apart
 * (`needsLegacyPass`: pure ASCII, and nothing like `.`/`[..]`/`\w` that could
 * consume a non-ASCII character), in which case legacy lines are decoded from
 * `lines.bytes` here instead.
 *
 * Two drivers feed the same collector: `runSearchSync` (spawnSync - the shell
 * emulator is synchronous end to end) and `runSearchAsync` (streaming, with
 * abort; what the tool uses so a long search never blocks the RPC loop).
 */

import { isUtf8 } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type EncodingMode = "auto" | "utf-8" | "windows-1252";
type Pass = "default" | "legacy";

export interface SearchSpec {
	pattern: string;
	/** Absolute paths - rg then prints absolute paths back. */
	targets: string[];
	ignoreCase: boolean;
	literal: boolean;
	invert: boolean;
	/** rg `--glob` values, negations included (`!node_modules`). */
	globs: string[];
	/** false = `--no-ignore` (walk past .gitignore/.ignore). */
	respectIgnore: boolean;
	hidden: boolean;
	maxCount: number | null;
	before: number;
	after: number;
	maxFileSize: number | null;
	encoding: EncodingMode;
	/**
	 * Match lines to keep text for: the first N in path order, across all
	 * files. Every file is still counted; only line text past the first N is
	 * dropped. Infinity keeps everything.
	 */
	storeMatches: number;
	/** Wall-clock budget for the whole search (all passes), in ms. */
	timeoutMs: number;
}

export interface HitLine {
	kind: "match" | "context";
	line: number;
	text: string;
}

export interface FileHit {
	/** Absolute path, as rg printed it. */
	path: string;
	/** rg found a NUL byte: counted and reported, never printed. */
	binary: boolean;
	/** Matching (or, inverted, non-matching) lines in this file. */
	matchCount: number;
	/** Match lines whose text is still in `lines` (0 once evicted, see TextBudget). */
	storedMatches: number;
	lines: HitLine[];
}

export interface SearchOutcome {
	files: FileHit[];
	/** Non-fatal rg diagnostics (unreadable file, bad target) - surfaced, never swallowed. */
	warnings: string[];
	timedOut: boolean;
	/** The pattern needed PCRE2 (look-around, backreferences) and was retried with it. */
	usedPcre2: boolean;
	/** Whether the windows-1252 pass actually ran. */
	legacyPassRan: boolean;
}

/** rg refused the pattern or the invocation itself; the message is rg's own. */
export class SearchError extends Error {}

// ---------------------------------------------------------------------------
// ripgrep binary

let cachedRgPath: string | null | undefined;
let rgPathOverride: string | null | undefined;

/**
 * pi core's own grep downloads a private ripgrep to `<agent dir>/bin` the
 * first time it runs (`ensureTool("rg")`, not exported). The branded
 * 0003-flat-config-layout patch leaves that directory alone, so this is right
 * on every branch. A miss is not cached: the tool can bootstrap the download
 * and ask again.
 */
export function resolveRipgrepPath(): string | null {
	if (rgPathOverride !== undefined) return rgPathOverride;
	if (cachedRgPath) return cachedRgPath;
	const candidate = join(getAgentDir(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
	cachedRgPath = existsSync(candidate) ? candidate : null;
	return cachedRgPath;
}

/** Test seam: force resolveRipgrepPath()'s answer (null = "not installed"); undefined restores the real lookup. */
export function setRipgrepPathForTests(path: string | null | undefined): void {
	rgPathOverride = path;
}

// ---------------------------------------------------------------------------
// Encoding

const cp1252 = new TextDecoder("windows-1252");

/** Past this, classification looks at the head only - a hit file this large is rare and the head decides it. */
const CLASSIFY_BYTES = 16 * 1024 * 1024;

/**
 * "unicode" for a UTF-8/UTF-16 BOM or content that is valid UTF-8, else
 * "legacy" (read as Windows-1252). Pure ASCII is valid UTF-8 and lands in
 * "unicode", which is fine: both decodings agree on it.
 */
export function classifyFile(path: string): "unicode" | "legacy" {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return "unicode";
	}
	try {
		const size = Math.min(fstatSync(fd).size, CLASSIFY_BYTES);
		const buffer = Buffer.alloc(size);
		const read = readSync(fd, buffer, 0, size, 0);
		let head = buffer.subarray(0, read);
		if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "unicode";
		if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return "unicode";
		// A cut through a multi-byte sequence at the end of a partial read is not evidence.
		if (read === CLASSIFY_BYTES) head = head.subarray(0, read - 3);
		return isUtf8(head) ? "unicode" : "legacy";
	} catch {
		return "unicode";
	} finally {
		closeSync(fd);
	}
}

/**
 * True when the two decodings could produce different results for this
 * pattern: any non-ASCII character, or (as a regex) anything that can
 * consume one - `.`, a class, or a backslash class/boundary like `\w` `\b`.
 * `\.` and other escaped punctuation are plain literals and do not count.
 */
export function needsLegacyPass(pattern: string, literal: boolean): boolean {
	if (/[\u0080-￿]/.test(pattern)) return true;
	if (literal) return false;
	const withoutEscapedPunctuation = pattern.replace(/\\[^A-Za-z0-9]/g, "");
	return /[.[]|\\[A-Za-z]/.test(withoutEscapedPunctuation);
}

function planPasses(spec: SearchSpec): Pass[] {
	if (spec.encoding === "utf-8") return ["default"];
	if (spec.encoding === "windows-1252") return ["legacy"];
	return needsLegacyPass(spec.pattern, spec.literal) ? ["default", "legacy"] : ["default"];
}

// ---------------------------------------------------------------------------
// Arguments

function buildArgs(spec: SearchSpec, pass: Pass, pcre2: boolean): string[] {
	const args = ["--json", "--no-config", "--color=never"];
	if (spec.hidden) args.push("--hidden");
	if (!spec.respectIgnore) args.push("--no-ignore");
	// Deliberately neither --sort=path (single-threaded: 6x slower on a real
	// repo; orchestrate() sorts instead) nor --binary (reads every walked
	// binary in full, 30s+ once transcoding): a binary found while walking is
	// skipped as rg always does, a named one is still searched and flagged.
	if (process.platform === "win32") args.push("--glob-case-insensitive");
	for (const glob of spec.globs) args.push("--glob", glob);
	if (spec.maxFileSize !== null) args.push("--max-filesize", String(spec.maxFileSize));
	args.push(spec.ignoreCase ? "--ignore-case" : "--case-sensitive");
	if (spec.literal) args.push("--fixed-strings");
	if (spec.invert) args.push("--invert-match");
	if (spec.maxCount !== null) args.push("--max-count", String(spec.maxCount));
	if (spec.before > 0) args.push("--before-context", String(spec.before));
	if (spec.after > 0) args.push("--after-context", String(spec.after));
	if (pass === "legacy") args.push("--encoding", "windows-1252");
	if (pcre2) args.push("--pcre2");
	args.push("-e", spec.pattern, "--", ...spec.targets);
	return args;
}

// ---------------------------------------------------------------------------
// Collecting rg's --json stream

interface RgData {
	text?: string;
	bytes?: string;
}

function rgString(data: RgData | undefined): string {
	if (!data) return "";
	if (typeof data.text === "string") return data.text;
	// Not valid UTF-8, so not from a Unicode file: read the bytes as CP1252.
	if (typeof data.bytes === "string") return cp1252.decode(Buffer.from(data.bytes, "base64"));
	return "";
}

/** One rg line, stripped of its terminator and any stray CR (CRLF normalised). */
function cleanLine(text: string): string {
	const line = text.replace(/\r?\n$/, "").replace(/\r/g, "");
	return line.startsWith("﻿") ? line.slice(1) : line;
}

interface RgEventData {
	path?: RgData;
	lines?: RgData;
	line_number?: number;
	binary_offset?: number | null;
}

/**
 * Keeps line text for the first `limit` matches *in path order* while rg
 * delivers files in whatever order its parallel walk finishes them. Files
 * holding text stay sorted; whenever the ones before the last already cover
 * the limit, the last one's text is dropped (its count stays). So memory is
 * bounded by roughly `limit` lines however many files match, and the result
 * is deterministic without making rg walk single-threaded.
 */
class TextBudget {
	private readonly kept: FileHit[] = [];
	private keptMatches = 0;

	constructor(private readonly limit: number) {}

	/** False when the budget is full and `path` sorts after every file holding text: it could never be shown. */
	couldKeep(path: string): boolean {
		if (this.limit === 0) return false;
		if (this.keptMatches < this.limit) return true;
		return comparePaths(path, this.kept[this.kept.length - 1].path) < 0;
	}

	add(file: FileHit): void {
		if (file.storedMatches === 0) return;
		let at = this.kept.length;
		while (at > 0 && comparePaths(this.kept[at - 1].path, file.path) > 0) at--;
		this.kept.splice(at, 0, file);
		this.keptMatches += file.storedMatches;
		for (;;) {
			const last = this.kept[this.kept.length - 1];
			if (this.kept.length < 2 || this.keptMatches - last.storedMatches < this.limit) break;
			this.keptMatches -= last.storedMatches;
			last.lines = [];
			last.storedMatches = 0;
			this.kept.pop();
		}
	}
}

class Collector {
	readonly files: FileHit[] = [];
	private current: FileHit | null = null;
	private accepted = false;
	/** This file can still contribute line text (see TextBudget.couldKeep). */
	private storing = false;
	private lastStoredMatch = -1;

	constructor(
		private readonly spec: SearchSpec,
		private readonly accept: (path: string) => boolean,
		private readonly budget: TextBudget,
	) {}

	feed(raw: string): void {
		if (!raw) return;
		// A search for something common emits millions of match lines that are
		// only counted; JSON.parse on each was 40s of a 42s search. rg always
		// writes the "type" key first, so the prefix identifies the event.
		const file = this.current;
		if (file && raw.startsWith('{"type":"match"')) {
			if (!this.accepted) return;
			if (!this.storing || file.storedMatches >= this.spec.storeMatches) {
				file.matchCount++;
				return;
			}
		} else if (file && raw.startsWith('{"type":"context"')) {
			if (!this.accepted || !this.storing) return;
			if (file.storedMatches >= this.spec.storeMatches && this.spec.after === 0) return;
		}
		let event: { type: string; data?: RgEventData };
		try {
			event = JSON.parse(raw);
		} catch {
			return;
		}
		const data = event.data;
		switch (event.type) {
			case "begin": {
				const path = rgString(data?.path);
				this.accepted = this.accept(path);
				this.storing = this.accepted && this.budget.couldKeep(path);
				this.current = { path, binary: false, matchCount: 0, storedMatches: 0, lines: [] };
				this.lastStoredMatch = -1;
				return;
			}
			case "match":
			case "context": {
				if (!file || !this.accepted) return;
				const line = data?.line_number ?? 0;
				const isMatch = event.type === "match";
				if (isMatch) file.matchCount++;
				// Per file, never more than the global limit could show.
				const budgetLeft = file.storedMatches < this.spec.storeMatches;
				const inAfterWindow = this.lastStoredMatch >= 0 && line <= this.lastStoredMatch + this.spec.after;
				if (isMatch ? !budgetLeft : !(budgetLeft || inAfterWindow)) return;
				file.lines.push({ kind: isMatch ? "match" : "context", line, text: cleanLine(rgString(data?.lines)) });
				if (isMatch) {
					file.storedMatches++;
					this.lastStoredMatch = line;
				}
				return;
			}
			case "end": {
				if (file && this.accepted && file.matchCount > 0) {
					if (data?.binary_offset !== null && data?.binary_offset !== undefined) {
						file.binary = true;
						file.lines = [];
						file.storedMatches = 0;
					}
					this.files.push(file);
					this.budget.add(file);
				}
				this.current = null;
				return;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Drivers

interface PassRun {
	collector: Collector;
	code: number | null;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

type PassRunner = (args: string[], collector: Collector, deadline: number) => PassRun | Promise<PassRun>;

const REGEX_ERROR = /regex parse error|error parsing regex|PCRE2: error/i;
const NEEDS_PCRE2 = /look-?around|look-?ahead|look-?behind|backreference/i;

/**
 * The pass loop both drivers share. It is written against a runner that may
 * or may not return a promise, so a sync driver gets a sync result: with a
 * sync runner this function never actually awaits anything.
 */
function* orchestrate(spec: SearchSpec): Generator<{ args: string[]; collector: Collector }, SearchOutcome, PassRun> {
	const passes = planPasses(spec);
	const classes = new Map<string, "unicode" | "legacy">();
	const classOf = (path: string) => {
		let cls = classes.get(path);
		if (!cls) {
			cls = classifyFile(path);
			classes.set(path, cls);
		}
		return cls;
	};
	const acceptFor = (pass: Pass) => {
		if (passes.length === 1) return () => true;
		return (path: string) => (classOf(path) === "legacy") === (pass === "legacy");
	};

	let pcre2 = false;
	const budget = new TextBudget(spec.storeMatches);
	const outcome: SearchOutcome = {
		files: [],
		warnings: [],
		timedOut: false,
		usedPcre2: false,
		legacyPassRan: false,
	};
	const perPass: FileHit[][] = [];
	for (const pass of passes) {
		let run: PassRun;
		for (;;) {
			const collector = new Collector(spec, acceptFor(pass), budget);
			run = yield { args: buildArgs(spec, pass, pcre2), collector };
			const stderr = run.stderr.trim();
			if (run.code === 2 && REGEX_ERROR.test(stderr)) {
				if (!pcre2 && NEEDS_PCRE2.test(stderr)) {
					pcre2 = true;
					outcome.usedPcre2 = true;
					continue;
				}
				throw new SearchError(stderr);
			}
			break;
		}
		if (pass === "legacy") outcome.legacyPassRan = true;
		perPass.push(run.collector.files);
		for (const line of run.stderr.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed && !outcome.warnings.includes(trimmed)) outcome.warnings.push(trimmed);
		}
		if (run.timedOut) {
			outcome.timedOut = true;
			break;
		}
		if (run.aborted) throw new Error("Operation aborted");
	}

	// rg's parallel walk finishes files in a different order on every run.
	outcome.files = perPass.flat().sort((a, b) => comparePaths(a.path, b.path));
	return outcome;
}

/** Path order, component by component rather than as one flat string (`a\b` before `a.txt`), like rg --sort=path. */
export function comparePaths(a: string, b: string): number {
	const pa = a.split(/[\\/]/);
	const pb = b.split(/[\\/]/);
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return pa.length - pb.length;
}

/**
 * Synchronous search for the shell emulator. Returns null when rg is not
 * installed, so the caller can fall back to its own walk.
 */
export function runSearchSync(spec: SearchSpec): SearchOutcome | null {
	const rgPath = resolveRipgrepPath();
	if (!rgPath) return null;
	const deadline = Date.now() + spec.timeoutMs;
	const run: PassRunner = (args, collector) => {
		const result = spawnSync(rgPath, args, {
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 256 * 1024 * 1024,
			timeout: Math.max(1, deadline - Date.now()),
		});
		for (const line of String(result.stdout ?? "").split("\n")) collector.feed(line);
		const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
		if (result.error && !timedOut && result.status === null) throw result.error;
		return { collector, code: result.status, stderr: String(result.stderr ?? ""), timedOut, aborted: false };
	};
	const steps = orchestrate(spec);
	let step = steps.next();
	while (!step.done) {
		step = steps.next(run(step.value.args, step.value.collector, deadline) as PassRun);
	}
	return step.value;
}

/** Streaming search for the tool: rg's output is consumed line by line, abort and the deadline kill it. */
export async function runSearchAsync(spec: SearchSpec, rgPath: string, signal?: AbortSignal): Promise<SearchOutcome> {
	const deadline = Date.now() + spec.timeoutMs;
	const run = (args: string[], collector: Collector): Promise<PassRun> =>
		new Promise((resolvePass, rejectPass) => {
			if (signal?.aborted) {
				resolvePass({ collector, code: null, stderr: "", timedOut: false, aborted: true });
				return;
			}
			const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let stderr = "";
			let timedOut = false;
			let aborted = false;
			const timer = setTimeout(
				() => {
					timedOut = true;
					child.kill();
				},
				Math.max(1, deadline - Date.now()),
			);
			const onAbort = () => {
				aborted = true;
				child.kill();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				if (stderr.length < 64 * 1024) stderr += chunk;
			});
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => collector.feed(line));
			child.on("error", (error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				rejectPass(new Error(`Failed to run ripgrep: ${error.message}`));
			});
			// "close", not "exit": only then has every stdout line been delivered.
			child.on("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolvePass({ collector, code, stderr, timedOut, aborted });
			});
		});
	const steps = orchestrate(spec);
	let step = steps.next();
	while (!step.done) {
		step = steps.next(await run(step.value.args, step.value.collector));
	}
	return step.value;
}

/** Forward slashes, and relative to `base` when the path is inside it (absolute otherwise). */
export function displayPath(path: string, base: string): string {
	const rel = relative(base, path);
	const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	return (inside ? rel : path).replace(/\\/g, "/");
}
