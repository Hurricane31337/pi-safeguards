import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comparePaths, needsLegacyPass, ripgrepThreads, setRipgrepPathForTests } from "../src/grep/search.js";
import { createSafeguardGrepTool, pathSyntaxError, type SafeguardGrepInput } from "../src/grep/tool.js";
import { execGrep } from "../src/shell/commands.js";

// Same rg lookup as ripgrep.test.ts: a binary pi core already downloaded on
// this machine. Without one, everything that needs rg skips itself.
const rgCandidates = [
	join(homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
	join(homedir(), ".label-code-agent", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
];
const realRgPath = rgCandidates.find((candidate) => existsSync(candidate));
const hasGit = spawnSync("git", ["--version"]).status === 0;

const UMLAUT_LINES = "x Einträge maximalen\r\nJörg Warnungsfrei\r\n";
const cp1252 = (text: string) => Buffer.from(text, "latin1");

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "safeguards-grep-tool-"));
	const corpus = join(root, "corpus");
	mkdirSync(corpus);
	writeFileSync(join(corpus, "bom.vb"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(UMLAUT_LINES)]));
	writeFileSync(join(corpus, "lf.vb"), UMLAUT_LINES.replace(/\r\n/g, "\n"));
	writeFileSync(join(corpus, "crlf.vb"), UMLAUT_LINES);
	writeFileSync(join(corpus, "legacy.vb"), cp1252(UMLAUT_LINES));
	writeFileSync(
		join(corpus, "binary.bin"),
		Buffer.concat([Buffer.from("MsgB header\n"), Buffer.from([0, 1, 2, 0]), Buffer.from("\nMsgB tail\n")]),
	);
	writeFileSync(join(corpus, "long.txt"), `start ${"y".repeat(900)} MsgB\n`);
	// 30 matches in one file, for limits and context.
	writeFileSync(
		join(corpus, "many.txt"),
		Array.from({ length: 30 }, (_, i) => `line ${i + 1} ${i % 2 === 0 ? "MsgB" : "filler"}`).join("\n"),
	);

	mkdirSync(join(root, "Kompilat"));
	writeFileSync(join(root, "Kompilat", "out.vb"), "MsgB compiled\n");
	writeFileSync(join(root, ".gitignore"), "Kompilat/\n");
	if (hasGit) spawnSync("git", ["init", "-q"], { cwd: root });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	setRipgrepPathForTests(undefined);
});

async function grep(params: SafeguardGrepInput) {
	setRipgrepPathForTests(realRgPath);
	const tool = createSafeguardGrepTool(root);
	const result = await tool.execute("t", params, undefined, undefined, { cwd: root } as never);
	const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
	return { text, details: result.details };
}

describe("needsLegacyPass", () => {
	it("is needed for non-ASCII and for anything that can consume a non-ASCII character", () => {
		expect(needsLegacyPass("Einträge", false)).toBe(true);
		expect(needsLegacyPass("Einträge", true)).toBe(true);
		expect(needsLegacyPass("Eintr.ge", false)).toBe(true);
		expect(needsLegacyPass("[a-z]+", false)).toBe(true);
		expect(needsLegacyPass("\\bfoo", false)).toBe(true);
	});
	it("is skipped for ASCII text and escaped punctuation", () => {
		expect(needsLegacyPass("fkt\\.MsgB", false)).toBe(false);
		expect(needsLegacyPass("MsgB|msgi", false)).toBe(false);
		expect(needsLegacyPass("a.b", true)).toBe(false);
	});
});

describe("ripgrepThreads", () => {
	it("uses about one thread per physical core on big machines, capped at 32, never below rg's own default", () => {
		expect(ripgrepThreads(1)).toBe(1);
		expect(ripgrepThreads(8)).toBe(8);
		expect(ripgrepThreads(16)).toBe(12);
		expect(ripgrepThreads(32)).toBe(16);
		expect(ripgrepThreads(64)).toBe(32);
		expect(ripgrepThreads(128)).toBe(32);
	});
});

describe("comparePaths", () => {
	it("orders component by component like rg --sort=path", () => {
		expect(comparePaths("a\\b\\c.txt", "a.txt")).toBeLessThan(0);
		expect(["b/x", "a/z", "a/y"].sort(comparePaths)).toEqual(["a/y", "a/z", "b/x"]);
	});
});

describe("pathSyntaxError", () => {
	it.skipIf(process.platform !== "win32")("rejects a stray colon after the drive", () => {
		expect(pathSyntaxError("C:/:/Users/x")).toMatch(/":"/);
		expect(pathSyntaxError("C:/Users/x")).toBeNull();
		expect(pathSyntaxError("src/*.vb")).toMatch(/glob/);
	});
});

describe.skipIf(!realRgPath)("grep tool", () => {
	it("matches a non-ASCII pattern in UTF-8 (BOM, LF, CRLF) and Windows-1252 in one call, decoded", async () => {
		const { text, details } = await grep({ pattern: "Einträge", path: "corpus" });
		expect(text).toContain("corpus/bom.vb:1:x Einträge maximalen");
		expect(text).toContain("corpus/lf.vb:1:x Einträge maximalen");
		expect(text).toContain("corpus/crlf.vb:1:x Einträge maximalen");
		expect(text).toContain("corpus/legacy.vb:1:x Einträge maximalen");
		expect(text).not.toMatch(/[?\uFFFD\r]/);
		expect(details?.totalMatches).toBe(4);
		expect(details?.totalFiles).toBe(4);
	});

	it("decodes legacy lines even when the pattern is ASCII and the second pass is skipped", async () => {
		const { text } = await grep({ pattern: "Warnungsfrei", path: "corpus/legacy.vb" });
		expect(text).toContain("corpus/legacy.vb:2:Jörg Warnungsfrei");
	});

	it("handles alternation with umlauts and ignoreCase across encodings", async () => {
		const { details } = await grep({ pattern: "jörg|NOPE", path: "corpus", ignoreCase: true });
		expect(details?.totalMatches).toBe(4);
		const classes = await grep({ pattern: "[äöü]", path: "corpus", mode: "filesWithMatches" });
		expect(classes.text.split("\n").filter((line) => line.startsWith("corpus/"))).toHaveLength(4);
	});

	it("prints path:line:text with no extra space, paths relative to the project root", async () => {
		const { text } = await grep({ pattern: "line 3 ", path: "corpus/many.txt" });
		expect(text.split("\n")[0]).toBe("corpus/many.txt:3:line 3 MsgB");
	});

	it("agrees between content, count and filesWithMatches", async () => {
		const content = await grep({ pattern: "MsgB", path: "corpus", limit: 1000 });
		const count = await grep({ pattern: "MsgB", path: "corpus", mode: "count" });
		const files = await grep({ pattern: "MsgB", path: "corpus", mode: "filesWithMatches" });
		expect(count.text).toContain("corpus/many.txt:15");
		expect(count.text).toContain("corpus/long.txt:1");
		expect(files.text.split("\n").slice(0, 2)).toEqual(["corpus/long.txt", "corpus/many.txt"]);
		for (const run of [content, count, files]) {
			expect(run.details?.totalMatches).toBe(16);
			expect(run.details?.totalFiles).toBe(2);
		}
	});

	it("reports the total and truncated=true when the limit cuts the listing", async () => {
		const { text, details } = await grep({ pattern: "MsgB", path: "corpus/many.txt", limit: 5 });
		expect(text.split("\n").filter((line) => line.startsWith("corpus/"))).toHaveLength(5);
		expect(text).toContain("15 matching lines in 1 file; showing the first 5. truncated=true");
		expect(details?.truncated).toBe(true);
		const all = await grep({ pattern: "MsgB", path: "corpus/many.txt" });
		expect(all.text).toContain("truncated=false");
		expect(all.details?.truncated).toBe(false);
	});

	it("keeps context out of the match budget, with -N- context lines and -- separators", async () => {
		const { text } = await grep({ pattern: "MsgB", path: "corpus/many.txt", limit: 2, before: 0, after: 1 });
		const lines = text.split("\n\n")[0].split("\n");
		expect(lines).toEqual([
			"corpus/many.txt:1:line 1 MsgB",
			"corpus/many.txt-2-line 2 filler",
			"corpus/many.txt:3:line 3 MsgB",
			"corpus/many.txt-4-line 4 filler",
		]);
		const spaced = await grep({ pattern: "line (1|9) ", path: "corpus/many.txt", context: 1 });
		expect(spaced.text).toContain("corpus/many.txt-2-line 2 filler\n--\ncorpus/many.txt-8-line 8 filler");
	});

	it("honours maxCount per file", async () => {
		const { details } = await grep({ pattern: "MsgB", path: "corpus", maxCount: 2 });
		expect(details?.totalMatches).toBe(3);
	});

	it("reports a named binary file by name and never prints it; skips binaries while walking", async () => {
		const named = await grep({ pattern: "MsgB", path: "corpus/binary.bin" });
		expect(named.details?.binaryFiles).toEqual(["corpus/binary.bin"]);
		expect(named.text).toContain("binary file also matches, content not shown: corpus/binary.bin");
		expect(named.text).not.toContain("MsgB header");
		const walked = await grep({ pattern: "MsgB", path: "corpus" });
		expect(walked.details?.binaryFiles).toEqual([]);
		expect(walked.text).not.toContain("MsgB header");
	});

	it("keeps the first matches in path order however rg's parallel walk finishes", async () => {
		const { text } = await grep({ pattern: "Jörg", path: "corpus", limit: 2 });
		expect(text.split("\n").slice(0, 2)).toEqual([
			"corpus/bom.vb:2:Jörg Warnungsfrei",
			"corpus/crlf.vb:2:Jörg Warnungsfrei",
		]);
	});

	it("cuts very long lines", async () => {
		const { text, details } = await grep({ pattern: "MsgB", path: "corpus/long.txt" });
		expect(details?.linesTruncated).toBe(true);
		expect(text).toContain("some lines cut at 500 chars");
	});

	it.skipIf(!hasGit)("skips ignored dirs when walking, searches them when named, or with includeIgnored", async () => {
		const walked = await grep({ pattern: "MsgB compiled" });
		expect(walked.text).toContain("No matches found");
		const named = await grep({ pattern: "MsgB compiled", path: "Kompilat" });
		expect(named.text).toContain("Kompilat/out.vb:1:MsgB compiled");
		const included = await grep({ pattern: "MsgB compiled", includeIgnored: true });
		expect(included.text).toContain("Kompilat/out.vb:1:MsgB compiled");
	});

	it("says the Windows-1252 decoding was also searched when nothing matches", async () => {
		const { text } = await grep({ pattern: "Übermorgen", path: "corpus" });
		expect(text).toBe("[No matches found (searched both UTF-8 and Windows-1252 decodings)]");
	});

	it("warns that encoding=utf-8 cannot match non-ASCII text in legacy files", async () => {
		const { text, details } = await grep({ pattern: "Einträge", path: "corpus", encoding: "utf-8" });
		expect(details?.totalMatches).toBe(3);
		expect(text).toContain("warning: encoding=utf-8");
	});

	it("retries a look-around pattern with PCRE2 and says so", async () => {
		const { text } = await grep({ pattern: "(?<=J)örg", path: "corpus/legacy.vb" });
		expect(text).toContain("corpus/legacy.vb:2:Jörg Warnungsfrei");
		expect(text).toContain("searched with PCRE2");
	});

	it("rejects an invalid regex, a missing path and a malformed one", async () => {
		await expect(grep({ pattern: "(unclosed" })).rejects.toThrow(/Invalid pattern/);
		await expect(grep({ pattern: "x", path: "nope" })).rejects.toThrow(/Path not found: nope/);
		if (process.platform === "win32") {
			await expect(grep({ pattern: "x", path: "C:/:/Users" })).rejects.toThrow(/Invalid path/);
		}
	});

	it("completes a repo-root search", async () => {
		const { text } = await grep({ pattern: "MsgB", mode: "count" });
		expect(text).toContain("corpus/many.txt:15");
	});
});

describe.skipIf(!realRgPath)("emulator grep -r on the shared engine", () => {
	const run = (args: string[]) => {
		setRipgrepPathForTests(realRgPath);
		return execGrep(["grep", ...args], root, root, null);
	};

	it("finds a non-ASCII pattern in Windows-1252 files under -r, decoded, without crashing", () => {
		const output = run(["-rn", "Einträge", "corpus"]);
		expect(output).toContain("./corpus/legacy.vb:1:x Einträge maximalen");
		expect(output).toContain("./corpus/bom.vb:1:x Einträge maximalen");
	});

	it("prints a legacy line matched by an ASCII pattern (the old lines.text crash)", () => {
		expect(run(["-rn", "Warnungsfrei", "."])).toContain("./corpus/legacy.vb:2:Jörg Warnungsfrei");
		expect(run(["-rn", "Warnungsfrei", "corpus/legacy.vb"])).toContain("./corpus/legacy.vb:2:Jörg Warnungsfrei");
		expect(run(["-rl", "Jörg", "corpus"])).toContain("./corpus/legacy.vb");
	});

	it("reports a named binary file instead of printing it", () => {
		const output = run(["-rn", "MsgB", "corpus/binary.bin"]);
		expect(output).toContain("grep: ./corpus/binary.bin: binary file matches");
		expect(output).not.toContain("MsgB header");
	});
});
