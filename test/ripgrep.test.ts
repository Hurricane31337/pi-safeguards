import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execGrep } from "../src/shell/commands.js";
import { setRipgrepPathForTests } from "../src/shell/ripgrep.js";

// A real rg.exe/rg this dev machine already has cached for pi core's own
// grep tool (see pi-safeguards/src/shell/ripgrep.ts's block comment) - not
// guaranteed to exist in every environment (a fresh checkout, CI), so tests
// that need it skip themselves rather than fail when it's absent. The
// fallback-when-missing behaviour is exercised unconditionally below and
// does not depend on this.
const rgCandidates = [
	join(homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
	join(homedir(), ".label-code-agent", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
];
const realRgPath = rgCandidates.find((candidate) => existsSync(candidate));

let root: string;

const setup = () => {
	root = mkdtempSync(join(tmpdir(), "safeguards-ripgrep-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
	writeFileSync(join(root, "src", "b.log"), "beta only\n", "utf8");
	mkdirSync(join(root, "src", "node_modules"));
	writeFileSync(join(root, "src", "node_modules", "vendored.txt"), "beta from a dependency\n", "utf8");
	mkdirSync(join(root, "src", ".hidden"));
	writeFileSync(join(root, "src", ".hidden", "h.txt"), "hidden beta\n", "utf8");
	mkdirSync(join(root, "src", ".git"));
	writeFileSync(join(root, "src", ".git", "g.txt"), "git beta\n", "utf8");
};
setup();

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
	setRipgrepPathForTests(undefined);
});

const grep = (command: string) => execGrep(command.split(" "), root, root, null);

describe("ripgrep fast path", () => {
	it("falls back to the JS walk when ripgrep cannot be found, with no change in output", () => {
		setRipgrepPathForTests(null);
		const output = grep("grep -rn beta src");
		expect(output).toContain("./src/a.txt:2:beta");
		expect(output).toContain("./src/b.log:1:beta only");
		expect(output).not.toContain("node_modules");
	});

	it.skipIf(!realRgPath)(
		"produces identical output to the JS walk for a plain recursive match with line numbers",
		() => {
			setRipgrepPathForTests(null);
			const jsOutput = grep("grep -rn beta src");
			setRipgrepPathForTests(realRgPath);
			const rgOutput = grep("grep -rn beta src");
			expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
			expect(rgOutput).toContain("./src/a.txt:2:beta");
			expect(rgOutput).not.toContain("node_modules");
		},
	);

	it.skipIf(!realRgPath)("matches the JS walk with --include=GLOB", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rn --include=*.txt beta src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rn --include=*.txt beta src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
		expect(rgOutput).toContain("./src/a.txt:2:beta");
	});

	it.skipIf(!realRgPath)("matches the JS walk with --exclude-dir=GLOB", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rn --exclude-dir=.hidden beta src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rn --exclude-dir=.hidden beta src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
		expect(rgOutput).not.toContain(".hidden");
		expect(rgOutput).toContain("./src/a.txt:2:beta");
	});

	// Real grep -r descends into dot-directories; only .git is excluded (see
	// ripgrep.ts's block comment) - rg's own default is the opposite (hidden
	// entries excluded unless --hidden is passed), so this specifically
	// proves --hidden plus the negated .git glob reproduces grep's behaviour,
	// not rg's.
	it.skipIf(!realRgPath)("descends into dot-directories other than .git, matching the JS walk", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rn beta src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rn beta src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
		expect(rgOutput).toContain("./src/.hidden/h.txt:1:hidden beta");
		expect(rgOutput).not.toContain(".git");
	});

	// -w is implemented by wrapping the compiled pattern in \b...\b at the
	// regex-source level (commands.ts), which is what reaches rg via
	// regex.source - so it works through the fast path with no dedicated
	// ripgrep.ts option, and this proves that actually holds rather than
	// assuming it from the JS-side implementation alone.
	it.skipIf(!realRgPath)("matches the JS walk with -w (word boundary), embedded via \\b in regex.source", () => {
		writeFileSync(join(root, "src", "word.txt"), "alpha\nalph\n", "utf8");
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rnw alph src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rnw alph src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
		expect(rgOutput).toBe("./src/word.txt:2:alph");
	});

	it.skipIf(!realRgPath)("matches the JS walk with -i (ignore case)", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rni ALPHA src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rni ALPHA src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
	});

	it.skipIf(!realRgPath)("matches the JS walk with -v (invert)", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rvn beta src/a.txt");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rvn beta src/a.txt");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
	});

	it.skipIf(!realRgPath)("matches the JS walk with -l (files only)", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rl beta src");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rl beta src");
		expect(rgOutput.split("\n").sort()).toEqual(jsOutput.split("\n").sort());
	});

	it.skipIf(!realRgPath)("stays on the JS walk for -c (countOnly), since rg omits zero-match files", () => {
		// grepInPath always reports a line for a scanned file, zero matches
		// included; rg's --count silently omits those files, so -c is never
		// handed to ripgrep at all (see the comment in commands.ts). Forcing an
		// rg path here proves that skip actually holds, not just the fallback.
		setRipgrepPathForTests(realRgPath);
		const output = grep("grep -rc nomatch src");
		expect(output).toContain("./src/a.txt:0");
		expect(output).toContain("./src/b.log:0");
	});

	it.skipIf(!realRgPath)("falls back to the JS walk for a pattern rg's regex engine rejects (JS lookbehind)", () => {
		setRipgrepPathForTests(realRgPath);
		// Rust's regex crate has no lookbehind support; ripgrep exits 2 on it,
		// which execRipgrepGrep must treat as "fall back", not "no matches". -E
		// is required here so the pattern reaches the regex engine unchanged -
		// without it, bare "(" and ")" are literal (real BRE semantics), so
		// this wouldn't be a lookbehind for either engine to reject.
		const output = grep(`grep -rnE (?<=al)pha src/a.txt`);
		expect(output).toBe("./src/a.txt:1:alpha");
	});

	it.skipIf(!realRgPath)("matches the JS walk with -h (suppress filename)", () => {
		setRipgrepPathForTests(null);
		const jsOutput = grep("grep -rhn beta src/a.txt");
		setRipgrepPathForTests(realRgPath);
		const rgOutput = grep("grep -rhn beta src/a.txt");
		expect(rgOutput).toEqual(jsOutput);
		expect(rgOutput).toBe("2:beta");
	});

	it.skipIf(!realRgPath)("still excludes node_modules and respects the sandbox root when using ripgrep", () => {
		setRipgrepPathForTests(realRgPath);
		const output = grep("grep -rn beta src");
		expect(output).not.toContain("node_modules");
		expect(output.split("\n").every((line) => line.startsWith("./src/"))).toBe(true);
	});
});
