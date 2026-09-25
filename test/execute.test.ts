import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SAFEGUARDS_SETTINGS, type SafeguardsSettings } from "../src/settings.js";
import { executeShellCommand } from "../src/shell/execute.js";

let root: string;
let outsideFile: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "safeguards-root-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
	writeFileSync(join(root, "src", "b.log"), "beta only\n", "utf8");
	writeFileSync(join(root, "src", "dupes.txt"), "a\na\nb\na\n", "utf8");
	const utf8Body = "Option Strict On\nfür Sanität\nfür alle\nfür dich\n";
	writeFileSync(join(root, "src", "utf8_nobom.txt"), utf8Body, "utf8");
	writeFileSync(
		join(root, "src", "utf8_bom.txt"),
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Body, "utf8")]),
	);
	// A real Windows-1252 file: "für" encoded with a single 0xFC byte (ü), not
	// the two-byte 0xC3 0xBC a UTF-8 encoder would produce - that's exactly
	// what makes it invalid UTF-8 and forces the latin1 fallback.
	writeFileSync(join(root, "src", "cp1252.txt"), Buffer.from([0x66, 0xfc, 0x72, 0x0a]));
	writeFileSync(join(root, "src", "binary.dat"), Buffer.from([0x4c, 0x61, 0x62, 0x65, 0x6c, 0x00, 0x01, 0x02, 0x03]));

	outsideFile = join(mkdtempSync(join(tmpdir(), "safeguards-outside-")), "secret.txt");
	writeFileSync(outsideFile, "do not read me\n", "utf8");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(resolve(outsideFile, ".."), { recursive: true, force: true });
});

// Explicit defaultPolicy: "deny", not DEFAULT_SAFEGUARDS_SETTINGS (whose
// defaultPolicy is "ask", the shipped baseline) - this file unit-tests the
// dispatcher's own enforcement, which is independent of whatever policy
// ships by default. Built-in commands (cat, ls, mv, rm, …) are unaffected
// either way: commandState() resolves them from the built-in list before it
// ever consults defaultPolicy.
const DENY_BY_DEFAULT: SafeguardsSettings = { commands: {}, defaultPolicy: "deny" };
const run = (command: string) => executeShellCommand(command, root, root, DENY_BY_DEFAULT);
const runWith = (command: string, overrides: Partial<SafeguardsSettings>) =>
	executeShellCommand(command, root, root, { ...DENY_BY_DEFAULT, ...overrides });
const node = `"${process.execPath}"`;

describe("whitelist", () => {
	it("runs the built-ins", () => {
		expect(run("echo hello world")).toBe("hello world");
		expect(run("pwd")).toBe(root.replace(/\\/g, "/"));
	});

	it("refuses interpreters and shells by name, with a reason (defaultPolicy deny)", () => {
		for (const program of ["python", "node", "npm", "bash", "sh", "cmd", "powershell", "curl", "wget"]) {
			const output = run(`${program} -c "whatever"`);
			expect(output).toContain(`'${program}' ist deaktiviert`);
		}
	});

	it("refuses anything else it does not implement", () => {
		expect(run("touch foo")).toContain("ist deaktiviert");
	});
});

describe("path containment", () => {
	it("reads files inside the root", () => {
		expect(run("cat src/a.txt")).toContain("alpha");
	});

	it("refuses files outside the root", () => {
		expect(run(`cat ${outsideFile}`)).toContain("Access denied");
		expect(run(`sed -n '1,5p' ${outsideFile}`)).toContain("Access denied");
		expect(run(`wc -l ${outsideFile}`)).toContain("Access denied");
		expect(run(`ls ${resolve(outsideFile, "..")}`)).toContain("Access denied");
	});

	it("does not let grep escape via a target outside the root", () => {
		expect(run(`grep -rn read ${resolve(outsideFile, "..")}`)).toBe("");
	});

	it("ignores a cd that would leave the root", () => {
		expect(run(`cd ${resolve(outsideFile, "..")} && pwd`)).toBe(root.replace(/\\/g, "/"));
	});

	it("ignores a standalone cd that would leave the root", () => {
		expect(run(`cd ${resolve(outsideFile, "..")}\npwd`)).toBe(root.replace(/\\/g, "/"));
	});

	// readdirSync on a file throws ENOTDIR; that used to be caught and
	// reported as "No such file or directory" for a file that plainly exists.
	// Real `ls` echoes the argument as given, not just its basename.
	it("ls on a file argument echoes the path as given, not 'No such file or directory'", () => {
		expect(run("ls src/a.txt")).toBe("src/a.txt");
	});

	it("ls -d on a directory names it instead of listing its contents", () => {
		expect(run("ls -d src")).toBe("src");
	});

	// cd used to resolve any in-bounds target and accept it unconditionally,
	// with no check that it actually exists - every relative path after a
	// typo'd cd then failed with a confusing "No such file or directory"
	// naming an unrelated command, while the cd itself reported nothing wrong
	// and pwd would happily print a cwd that does not exist on disk.
	it("cd to a nonexistent directory reports an error and does not move", () => {
		const output = run("cd src/does-not-exist && pwd");
		expect(output).toContain("cd: no such file or directory: src/does-not-exist");
	});

	it("a failed cd leaves the working directory where it was", () => {
		expect(run("cd src/does-not-exist\npwd")).toContain(root.replace(/\\/g, "/"));
	});

	it("cd to a file (not a directory) reports an error, same as a missing path", () => {
		const output = run("cd src/a.txt && pwd");
		expect(output).toContain("cd: no such file or directory: src/a.txt");
	});
});

describe("statements", () => {
	it("moves cd's effect to the rest of the line with &&", () => {
		expect(run("cd src && pwd")).toBe(join(root, "src").replace(/\\/g, "/"));
	});

	it("applies a standalone cd to every later statement, on its own line or after ;", () => {
		expect(run("cd src\npwd")).toBe(join(root, "src").replace(/\\/g, "/"));
		expect(run("cd src; pwd")).toBe(join(root, "src").replace(/\\/g, "/"));
	});

	it("runs a real multi-line command and returns the non-cd output", () => {
		expect(run("cd src\ncat a.txt")).toContain("alpha");
	});

	it("does not carry stdin across statement boundaries", () => {
		// "cat a.txt" and "wc -l" are separate statements (;), not a pipe, so wc
		// sees no stdin at all rather than a.txt's line count.
		expect(run("cd src; cat a.txt; wc -l")).toBe("alpha\nbeta\ngamma\n\n0");
	});
});

describe("pipes", () => {
	it("chains segments through stdin", () => {
		expect(run("cat src/a.txt | wc -l").trim()).toBe("3");
		expect(run("cat src/a.txt | grep beta")).toBe("beta");
		expect(run("cat src/a.txt | head -n 2")).toBe("alpha\nbeta");
		expect(run("cat src/a.txt | tail -n 2").trim()).toBe("beta\ngamma");
	});

	it("counts zero lines for empty stdin, not one (find with no matches | wc -l)", () => {
		expect(run("find src -name *.nope | wc -l").trim()).toBe("0");
		expect(run("grep -l nomatch src/a.txt | wc -l").trim()).toBe("0");
	});
});

describe("search", () => {
	it("greps recursively with line numbers, relative to the root", () => {
		const output = run("grep -rn beta src");
		expect(output).toContain("./src/a.txt:2:beta");
		expect(output).toContain("./src/b.log:1:beta only");
	});

	it("finds by name and type, with root-relative paths like grep uses", () => {
		expect(run("find src -name *.log")).toBe("./src/b.log");
		expect(run("find src -name *.log")).not.toContain("a.txt");
	});

	it("-c counts matches instead of printing them, from stdin", () => {
		expect(run("cat src/dupes.txt | grep -c a")).toBe("3");
	});

	it("-c counts matches per file when grepping files directly", () => {
		expect(run("grep -c beta src/a.txt")).toBe("1");
	});

	it("-c prefixes with the filename when recursive or multiple targets, like real grep", () => {
		const output = run("grep -rc beta src");
		expect(output).toContain("./src/a.txt:1");
		expect(output).toContain("./src/b.log:1");
	});

	// "" is falsy in JS, so `if (!pattern)` used to treat an explicitly empty
	// pattern the same as no pattern given at all - but an empty regex
	// matches every line, so -c "" should count all of them, not print nothing.
	it("-c with an empty pattern counts every line, not nothing", () => {
		expect(run("grep -c '' src/a.txt")).toBe("3");
	});

	it("an empty pattern with no -c matches (and prints) every line", () => {
		expect(run("grep '' src/a.txt")).toBe("alpha\nbeta\ngamma");
	});

	// Real (BRE) grep treats \| as alternation even without -E; a JS RegExp
	// does the opposite (\| means a literal "|" character), so grep "A\|B"
	// matched nothing instead of either line.
	it(String.raw`\| is alternation, like real BRE grep, not a literal pipe`, () => {
		expect(run(String.raw`grep 'alpha\|gamma' src/a.txt`)).toBe("alpha\ngamma");
	});

	it("-E with an unescaped | still works, unaffected by the BRE translation", () => {
		expect(run("grep -E 'alpha|gamma' src/a.txt")).toBe("alpha\ngamma");
	});

	// -e wasn't recognised as a value-taking flag at all: its value fell
	// through and got treated as the pattern (first -e) or a target (every
	// -e after that), so only the first -e's value ever mattered.
	it("-e PATTERN is recognised, and repeating it ORs the patterns together", () => {
		expect(run("grep -e alpha -e gamma src/a.txt")).toBe("alpha\ngamma");
	});

	it("-e still works combined with other flags", () => {
		expect(run("grep -ic -e ALPHA -e GAMMA src/a.txt")).toBe("2");
	});

	// The reported bug: "--include" was decomposed letter by letter against
	// the short-flag switch (its own spelling contains i/n/c/l), silently
	// setting -c/-l/-i instead of being recognised - turning a plain
	// recursive match into a bogus per-file match count across the whole
	// tree, no error, wrong data.
	it("--include=GLOB filters to matching files, instead of being decomposed into -c/-l/-i/-n", () => {
		const output = run("grep -rn --include=*.txt -e beta src");
		expect(output).toBe("./src/a.txt:2:beta");
		expect(output).not.toContain("b.log");
		// The corrupted-parse symptom: a bogus per-file match count instead of
		// the real match line above.
		expect(output).not.toMatch(/^\.\/src\/a\.txt:1$/m);
	});

	it("--include GLOB (space-separated) works the same as --include=GLOB", () => {
		expect(run("grep -rn --include *.txt -e beta src")).toBe("./src/a.txt:2:beta");
	});

	it("--include with no matching files finds nothing, not an error", () => {
		expect(run("grep -rn --include=*.nope -e beta src")).toBe("");
	});

	// The reported bug: bare (unescaped) ( ) { } | + ? were already special to
	// JS's native RegExp, so real BRE's rule - bare is literal, only the
	// escaped form is special - was only half-implemented (escaped -> special
	// worked, but bare was never made literal). There was no way to write a
	// literal parenthesis, pipe, brace or plus/question mark at all: grep
	// 'a(b)c' matched "abc" instead of the literal text a real BRE grep finds.
	describe("bare BRE metacharacters are literal by default, matching real grep", () => {
		beforeAll(() => {
			writeFileSync(join(root, "src", "bre.txt"), "foo+bar\nfoobar\nabc\na(b)c\nx|y\nxy\n1{2}\n111\n", "utf8");
		});

		it("bare ( ) are literal, not a group", () => {
			expect(run("grep 'a(b)c' src/bre.txt")).toBe("a(b)c");
		});

		it("bare | is literal, not alternation", () => {
			expect(run("grep 'x|y' src/bre.txt")).toBe("x|y");
		});

		it("bare + is literal, not a quantifier", () => {
			expect(run("grep 'foo+bar' src/bre.txt")).toBe("foo+bar");
		});

		it("bare {n} is literal, not an interval", () => {
			expect(run("grep '1{2}' src/bre.txt")).toBe("1{2}");
		});

		it("a bracket expression still reaches a literal special character, as an alternative to escaping", () => {
			expect(run("grep '[|]' src/bre.txt")).toBe("x|y");
		});

		it("-E switches to ERE, where the bare forms are special again", () => {
			expect(run("grep -E 'a(b)c' src/bre.txt")).toBe("abc");
			// "o+" under ERE means one-or-more "o", which "foobar" satisfies but
			// the literal "foo+bar" (a real plus character, not a quantifier)
			// does not.
			expect(run("grep -E 'foo+bar' src/bre.txt")).toBe("foobar");
		});
	});

	// Real grep -w requires whole-word matches; the emulator ignored -w
	// entirely, so grep -w 'alph' matched "alpha" (a substring, not a word).
	it("-w only matches whole words", () => {
		expect(run("grep -w alph src/a.txt")).toBe("");
		expect(run("grep -w alpha src/a.txt")).toBe("alpha");
	});

	// --word-regexp is -w's long form; it used to be silently dropped while
	// -w worked, so the same search gave two different answers depending only
	// on which spelling was used.
	it("--word-regexp behaves the same as its short form -w", () => {
		expect(run("grep --word-regexp alph src/a.txt")).toBe("");
		expect(run("grep --word-regexp alpha src/a.txt")).toBe("alpha");
	});

	// -m (max count) is implemented; -A/-B/-C (context) are not, and now fail
	// visibly instead of being silently swallowed - a caller typing `-C 3`
	// used to get an unfiltered dump with no indication context was ignored.
	it("-m limits matching lines per file; -A/-B/-C fail visibly instead of being silently ignored", () => {
		expect(run("grep -m 1 beta src/dupes.txt")).toBe("");
		expect(run("grep -m 2 a src/dupes.txt")).toBe("a\na");
		expect(run("grep --max-count=2 a src/dupes.txt")).toBe("a\na");
		expect(run("grep -m2 a src/dupes.txt")).toBe("a\na");
		expect(run("grep -m 2 -c a src/dupes.txt")).toBe("2");
		expect(run("grep -A 1 beta src/a.txt")).toBe("grep: unsupported option: -A");
		expect(run("grep -B 1 beta src/a.txt")).toBe("grep: unsupported option: -B");
		expect(run("grep -C 1 beta src/a.txt")).toBe("grep: unsupported option: -C");
		expect(run("grep -A2 beta src/a.txt")).toBe("grep: unsupported option: -A");
	});

	// -l wins over -c when both are given, like real grep - this used to
	// check -c first, so `grep -lc` printed a count instead of just the name.
	it("-l wins over -c when both are given", () => {
		expect(run("grep -lc beta src/a.txt")).toBe("./src/a.txt");
	});

	// readFileSafe used to decode every file as latin1 unconditionally, which
	// silently mangled UTF-8 multi-byte sequences into garbage and made every
	// non-ASCII pattern match zero lines - "no matches" looked like a real
	// answer while being wrong. These pin the fix: UTF-8 (with and without a
	// BOM), the BOM stripped so `^` still anchors to the true first line, and
	// a genuine Windows-1252 file still readable via the latin1 fallback.
	describe("file content is decoded as UTF-8, not latin1", () => {
		it("matches a UTF-8 pattern with no BOM", () => {
			expect(run('grep -c "für" src/utf8_nobom.txt')).toBe("3");
		});
		it("matches a UTF-8 pattern with a BOM", () => {
			expect(run('grep -c "für" src/utf8_bom.txt')).toBe("3");
		});
		it("strips the BOM so ^ anchors to the true first line", () => {
			expect(run('grep -c "^Option Strict On" src/utf8_bom.txt')).toBe("1");
			expect(run('grep -c "^Option Strict On" src/utf8_nobom.txt')).toBe("1");
		});
		it("prints matched lines readably, without mojibake", () => {
			expect(run('grep "für" src/utf8_bom.txt')).toBe("für Sanität\nfür alle\nfür dich");
		});
		it("does not regress plain ASCII matching on a BOM'd file", () => {
			expect(run('grep -c "Option Strict" src/utf8_bom.txt')).toBe("1");
		});
		it("falls back to latin1 for a genuine Windows-1252 byte sequence invalid as UTF-8", () => {
			expect(run('grep -c "für" src/cp1252.txt')).toBe("1");
		});
	});

	// GNU-grep-compatible binary handling: no raw byte dump, but -l/-c still
	// answer correctly. This used to have no binary detection at all, so a
	// match inside a binary file dumped raw NULs/control bytes as output.
	describe("binary file detection", () => {
		it("reports a binary match without dumping raw content", () => {
			expect(run("grep Label src/binary.dat")).toBe("grep: ./src/binary.dat: binary file matches");
		});
		it("-l still lists a matching binary file by name", () => {
			expect(run("grep -l Label src/binary.dat")).toBe("./src/binary.dat");
		});
		it("-c still counts matches in a binary file", () => {
			expect(run("grep -c Label src/binary.dat")).toBe("1");
		});
		it("a UTF-16-style file with NUL bytes but a text BOM is not misclassified as binary", () => {
			const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("beta\n", "utf16le")]);
			writeFileSync(join(root, "src", "utf16.txt"), utf16);
			expect(run("grep beta src/utf16.txt")).toBe("beta");
		});
	});

	// grepInPath silently returned nothing for a missing file (the same catch
	// that lets a recursive walk skip an entry that vanished mid-scan), so a
	// typo'd filename looked exactly like "no matches" - every sibling command
	// (cat, wc, uniq, sort) reports this case instead.
	it("a missing file is reported, not silently treated as zero matches", () => {
		expect(run("grep beta src/nope.txt")).toBe("grep: src/nope.txt: No such file or directory");
	});

	// The ripgrep fast path walks a tree in parallel, so recursive output
	// order used to vary run to run with nothing on disk changed.
	it("-r output order is deterministic across repeated identical runs", () => {
		const first = run("grep -rn beta src");
		for (let i = 0; i < 5; i++) expect(run("grep -rn beta src")).toBe(first);
	});

	// A directory operand without -r used to fall straight into grepInPath's
	// "not recursive, stop here" branch with no message at all, so
	// `grep foo src/` (forgetting -r, a common typo) looked exactly like a
	// clean "not found" instead of the refusal real grep gives. The message
	// echoes the operand as typed (cwd-relative), the same convention every
	// other error in this emulator uses (cat/wc/uniq/.../rm's own "Is a
	// directory") - not match output's root-relative "./" labeling.
	it("a directory without -r is reported, not silently treated as zero matches", () => {
		expect(run("grep beta src")).toBe("grep: src: Is a directory");
		expect(run("grep -c beta src")).toBe("grep: src: Is a directory");
		expect(run("grep -l beta src")).toBe("grep: src: Is a directory");
	});

	describe("-r directory traversal", () => {
		beforeAll(() => {
			mkdirSync(join(root, "src", ".hidden"), { recursive: true });
			writeFileSync(join(root, "src", ".hidden", "h.txt"), "hidden beta\n", "utf8");
			mkdirSync(join(root, "src", ".git"), { recursive: true });
			writeFileSync(join(root, "src", ".git", "g.txt"), "git beta\n", "utf8");
		});

		// Real grep -r descends into dot-directories; only .git (a deliberate,
		// narrow exception, not a blanket "skip anything hidden") is excluded -
		// this used to skip every dot-directory, silently under-reporting
		// .claude/, .github/, any dot-config directory.
		it("descends into dot-directories other than .git", () => {
			const output = run("grep -rn beta src");
			expect(output).toContain("./src/.hidden/h.txt:1:hidden beta");
			expect(output).not.toContain(".git");
		});

		it("--exclude-dir=GLOB excludes a matching directory from the recursive walk", () => {
			const output = run("grep -rn --exclude-dir=.hidden beta src");
			expect(output).not.toContain(".hidden");
			expect(output).toContain("./src/a.txt:2:beta");
		});

		// find used the same "skip anything starting with a dot" filter grep -r
		// just had removed, so the two commands disagreed about the exact same
		// tree: find could not see a file grep -r already reported.
		it("find also descends into dot-directories other than .git, agreeing with grep -r", () => {
			expect(run("find src -name h.txt")).toBe("./src/.hidden/h.txt");
			expect(run("find src -name g.txt")).toBe("");
		});
	});

	// -o prints only the matched text, once per match, not the whole line -
	// previously ignored entirely (whole lines came back regardless).
	it("-o prints only the matched substrings, one per match on a line", () => {
		writeFileSync(join(root, "src", "oh.txt"), "banana\n", "utf8");
		expect(run("grep -o an src/oh.txt")).toBe("an\nan");
	});

	// -q used to still print matches despite claiming to be quiet; there are
	// no exit codes here for -q's usual "check $?" role, so quiet output is
	// the only behaviour left to honor.
	it("-q suppresses all output", () => {
		expect(run("grep -q beta src/a.txt")).toBe("");
		expect(run("grep -rq beta src")).toBe("");
	});

	// -h/-H override the recursive-or-multi-file heuristic that otherwise
	// decides whether filenames are shown.
	it("-h hides the filename even when it would otherwise show, -H forces it even for one file", () => {
		expect(run("grep -rhn beta src/a.txt")).toBe("2:beta");
		expect(run("grep -Hn beta src/a.txt")).toBe("./src/a.txt:2:beta");
	});
});

describe("head/tail with a file argument", () => {
	// The reported bug: head/tail only ever read stdin, so a bare `head -n 3
	// file` (no pipe) silently returned nothing - `stdin` was null and there
	// was no fallback to reading the named file.
	it("head reads a file directly, not just piped stdin", () => {
		expect(run("head -n 2 src/a.txt")).toBe("alpha\nbeta");
	});

	it("tail reads a file directly, not just piped stdin", () => {
		expect(run("tail -n 2 src/a.txt").trim()).toBe("beta\ngamma");
	});

	it("head/tail with no flags default to 10 lines from a file", () => {
		expect(run("head src/a.txt")).toBe("alpha\nbeta\ngamma");
	});

	it("the old -N form still works together with a file argument", () => {
		expect(run("head -2 src/a.txt")).toBe("alpha\nbeta");
	});

	it("refuses a file outside the root", () => {
		expect(run(`head ${outsideFile}`)).toContain("Access denied");
		expect(run(`tail ${outsideFile}`)).toContain("Access denied");
	});

	it("reports a missing file rather than silently returning nothing", () => {
		expect(run("head src/does-not-exist.txt")).toContain("No such file or directory");
	});

	// head/tail only ever read a single file argument - a second missing
	// file's error never surfaced at all, and multiple real files were
	// silently collapsed into just the first one.
	it("head accepts more than one file, with an ==> name <== header for each", () => {
		expect(run("head -n 1 src/a.txt src/b.log")).toBe("==> src/a.txt <==\nalpha\n\n==> src/b.log <==\nbeta only");
	});

	it("tail accepts more than one file, with an ==> name <== header for each", () => {
		expect(run("tail -n 1 src/a.txt src/b.log")).toBe("==> src/a.txt <==\ngamma\n\n==> src/b.log <==\nbeta only");
	});

	it("head reports every missing file among several, not just the first", () => {
		const output = run("head src/does-not-exist-1.txt src/does-not-exist-2.txt");
		expect(output).toContain("does-not-exist-1.txt: No such file or directory");
		expect(output).toContain("does-not-exist-2.txt: No such file or directory");
	});
});

describe("cat", () => {
	it("reads stdin when given no file operand, like real cat (x | cat pass-through)", () => {
		expect(run("echo hi | cat")).toBe("hi");
	});

	it("still prefers a file argument over stdin when both are present", () => {
		expect(run("echo ignored | cat src/a.txt")).toContain("alpha");
	});
});

describe("sort", () => {
	it("sorts lines lexically from stdin", () => {
		expect(run("cat src/dupes.txt | sort")).toBe("a\na\na\nb");
	});

	it("reads a file directly, same as when piped", () => {
		expect(run("sort src/dupes.txt")).toBe(run("cat src/dupes.txt | sort"));
	});

	it("-r reverses the order", () => {
		expect(run("cat src/dupes.txt | sort -r")).toBe("b\na\na\na");
	});

	it("-u dedupes after sorting", () => {
		expect(run("cat src/dupes.txt | sort -u")).toBe("a\nb");
	});

	it("-n compares numerically instead of lexically", () => {
		const numbers = "10\n2\n1\n";
		writeFileSync(join(root, "src", "numbers.txt"), numbers, "utf8");
		expect(run("sort -n src/numbers.txt")).toBe("1\n2\n10");
		expect(run("sort src/numbers.txt")).toBe("1\n10\n2"); // lexical, for contrast
	});

	it("combines with uniq -c into the classic sort | uniq -c pipeline", () => {
		expect(
			run("cat src/dupes.txt | sort | uniq -c")
				.split("\n")
				.map((l) => l.trim()),
		).toEqual(["3 a", "1 b"]);
	});
});

describe("printf", () => {
	// The reported bug: printf was a plain arg-join, so it neither interpreted
	// \n/\t nor substituted %s/%d - the format string and its would-be
	// arguments just got concatenated verbatim.
	it("interprets \\n and \\t escapes in the format string", () => {
		expect(run(String.raw`printf 'a\tb\nc'`)).toBe("a\tb\nc");
	});

	it("substitutes %s with an argument", () => {
		expect(run(`printf '%s %s' hello world`)).toBe("hello world");
	});

	it("substitutes %d/%i/%o/%x/%X numerically", () => {
		expect(run(`printf '%d %o %x %X' 10 8 255 255`)).toBe("10 10 ff FF");
	});

	it("%% prints a literal percent sign", () => {
		expect(run(`printf '100%%'`)).toBe("100%");
	});

	it("repeats the format over extra arguments, like real printf", () => {
		expect(run(String.raw`printf '%s\n' a b c`)).toBe("a\nb\nc\n");
	});

	it("a format with no specifiers runs once even with extra arguments", () => {
		expect(run(`printf hi a b c`)).toBe("hi");
	});

	it("a missing %s argument becomes an empty string, not literal %s", () => {
		expect(run(`printf '[%s]'`)).toBe("[]");
	});
});

describe("wc flags", () => {
	it("honors -c (bytes) instead of always returning the line count", () => {
		expect(run("printf abc | wc -c").trim()).toBe("3");
	});

	it("honors -w (words) instead of always returning the line count", () => {
		expect(run(`printf 'one two three' | wc -w`).trim()).toBe("3");
	});

	it("with no flags at all, prints lines words bytes, not just lines", () => {
		const output = run(`printf 'a b\\nc\\n' | wc`).trim();
		expect(output.split(/\s+/)).toEqual(["2", "3", "6"]);
	});

	it("-c on a file with no trailing newline reports its byte length, not 1", () => {
		writeFileSync(join(root, "src", "nonewline.txt"), "abc", "utf8");
		expect(run("wc -c src/nonewline.txt")).toBe("       3 src/nonewline.txt");
	});
});

describe("glob expansion", () => {
	it("expands a wildcard to explicit filenames for wc", () => {
		const output = run("wc -l src/*.log");
		expect(output).toContain("src/b.log");
		expect(output).not.toContain("*.log");
	});

	it("leaves a glob that matches nothing untouched, as a literal", () => {
		expect(run("wc -l src/*.nope")).toContain("No such file or directory");
	});
});

describe("rm and mv", () => {
	it("removes a file inside the root", () => {
		writeFileSync(join(root, "src", "doomed.txt"), "bye\n", "utf8");
		expect(run("rm src/doomed.txt")).toBe("");
		expect(run("cat src/doomed.txt")).toContain("No such file or directory");
	});

	it("refuses to remove a file outside the root, even with -f", () => {
		expect(run(`rm ${outsideFile}`)).toContain("Access denied");
		expect(run(`rm -f ${outsideFile}`)).toBe("");
	});

	it("refuses a directory without -r", () => {
		mkdirSync(join(root, "src", "doomed-dir"));
		expect(run("rm src/doomed-dir")).toContain("Is a directory");
		expect(run("rm -r src/doomed-dir")).toBe("");
	});

	// The reported bug, applied to rm: "--force" contains an "r", which the
	// same letter-by-letter decomposition read as -r (recursive) - so
	// `rm --force` on a directory would have silently recursed and deleted
	// it, instead of refusing like a force-less `rm` on a directory should.
	it("--force does not accidentally enable -r via the 'r' in its own name", () => {
		mkdirSync(join(root, "src", "force-no-recurse-dir"));
		expect(run("rm --force src/force-no-recurse-dir")).toContain("Is a directory");
	});

	it("removes a glob's matches", () => {
		writeFileSync(join(root, "src", "a.tmp"), "", "utf8");
		writeFileSync(join(root, "src", "b.tmp"), "", "utf8");
		expect(run("rm src/*.tmp")).toBe("");
		expect(run("find src -name *.tmp")).toBe("");
	});

	it("moves a file inside the root", () => {
		writeFileSync(join(root, "src", "from.txt"), "moved\n", "utf8");
		expect(run("mv src/from.txt src/to.txt")).toBe("");
		expect(run("cat src/to.txt")).toContain("moved");
		run("rm src/to.txt");
	});

	it("refuses to move a file outside the root, in either direction", () => {
		expect(run(`mv ${outsideFile} src/stolen.txt`)).toContain("Access denied");
		writeFileSync(join(root, "src", "escaping.txt"), "no\n", "utf8");
		expect(run(`mv src/escaping.txt ${resolve(outsideFile, "..", "escaped.txt")}`)).toContain("Access denied");
		run("rm src/escaping.txt");
	});
});

describe("command policy", () => {
	it("defaultPolicy deny refuses a command outside the built-in set", () => {
		expect(run(`${node} -e "console.log(1)"`)).toContain("ist deaktiviert");
	});

	it("deny also refuses a command by that name explicitly, even one that looks like an interpreter", () => {
		expect(run('node -e "1"')).toContain("ist deaktiviert");
	});

	it("defaultPolicy allow runs an arbitrary external command with no shell involved", () => {
		expect(runWith(`${node} -e "console.log(1+1)"`, { defaultPolicy: "allow" }).trim()).toBe("2");
	});

	it("defaultPolicy allow lifts the refusal for an interpreter-like name too", () => {
		expect(runWith('node -e "console.log(2+2)"', { defaultPolicy: "allow" }).trim()).toBe("4");
	});

	it("an explicit allow override opts a specific external command in without changing defaultPolicy", () => {
		expect(runWith(`${node} -e "console.log(3+3)"`, { commands: { [process.execPath]: "allow" } }).trim()).toBe("6");
	});

	it("an explicit allow override works for an interpreter-like name specifically", () => {
		expect(runWith('node -e "console.log(4+4)"', { commands: { node: "allow" } }).trim()).toBe("8");
	});

	it("allowing one command by name does not open the door for another", () => {
		expect(runWith('python -c "print(1)"', { commands: { node: "allow" } })).toContain("ist deaktiviert");
	});

	it("an explicit deny override refuses a built-in command that would otherwise run", () => {
		expect(runWith("cat src/a.txt", { commands: { cat: "deny" } })).toContain("ist deaktiviert");
	});

	// "ask" only ever reaches executeShellCommand's dispatcher after
	// confirm-guard.ts's tool_call hook already asked and the user approved -
	// there is no prompting left to do here, so dispatch runs it exactly like
	// "allow" would.
	it("ask (already approved) runs an arbitrary external command, same as allow", () => {
		expect(runWith(`${node} -e "console.log(5+5)"`, { defaultPolicy: "ask" }).trim()).toBe("10");
	});

	it("an explicit ask override (already approved) runs an interpreter-like name too", () => {
		expect(runWith('node -e "console.log(6+6)"', { commands: { node: "ask" } }).trim()).toBe("12");
	});
});

describe("uniq", () => {
	it("collapses adjacent duplicate lines, from stdin", () => {
		expect(run("cat src/dupes.txt | uniq")).toBe("a\nb\na");
	});

	it("-c prefixes each run with its length", () => {
		const output = run("cat src/dupes.txt | uniq -c");
		expect(output.split("\n").map((line) => line.trim())).toEqual(["2 a", "1 b", "1 a"]);
	});

	it("-d keeps only duplicated runs, -u keeps only non-duplicated ones", () => {
		expect(run("cat src/dupes.txt | uniq -d")).toBe("a");
		expect(run("cat src/dupes.txt | uniq -u")).toBe("b\na");
	});

	it("reads a file directly when given one, same as when piped", () => {
		expect(run("uniq src/dupes.txt")).toBe(run("cat src/dupes.txt | uniq"));
	});
});

describe("heredoc", () => {
	it("feeds a heredoc body to a command as stdin", () => {
		expect(run("wc -l <<'EOF'\nline1\nline2\nline3\nEOF").trim()).toBe("3");
	});

	it("matches within a heredoc body via grep, same as piped stdin would", () => {
		expect(run("grep line2 <<'EOF'\nline1\nline2\nline3\nEOF")).toBe("line2");
	});

	it("does not let the heredoc's body lines get parsed as separate statements", () => {
		// Every one of these lines would previously dispatch as its own bogus
		// command ("assert ist nicht installiert...") if heredocs were not
		// unwrapped before splitStatements ran.
		const output = run("wc -l <<'PY'\nimport re\nassert True\nprint('patched')\nPY");
		expect(output.trim()).toBe("3");
	});

	it("runs an external interpreter with heredoc content as its stdin", () => {
		const script = `process.stdout.write(require("fs").readFileSync(0,"utf8").trim().toUpperCase())`;
		const output = runWith(`${node} -e '${script}' <<'EOF'\nhello\nEOF`, { defaultPolicy: "allow" });
		expect(output).toBe("HELLO");
	});

	it("leaves an unterminated heredoc as a harmless no-op rather than throwing", () => {
		expect(() => run("wc -l <<'EOF'\nline1\nline2")).not.toThrow();
	});

	// Reproduces the reported real-world shape: an entire heredoc block,
	// closing delimiter included, indented for readability - the common
	// style a model reaches for when embedding a script. This used to leave
	// the terminator unrecognised (only column 0 matched), so every body
	// line dispatched as its own bogus "command" instead of reaching python.
	it("feeds an indented heredoc block to an interpreter, dedented, with relative indentation preserved", () => {
		const script = `process.stdout.write(require("fs").readFileSync(0,"utf8"))`;
		const command = `${node} -e '${script}' <<'PY'\n    if True:\n        print(1)\n    PY`;
		expect(runWith(command, { defaultPolicy: "allow" })).toBe("if True:\n    print(1)");
	});

	it("still runs a statement that follows a heredoc on the next line, instead of swallowing it into the heredoc command's argv", () => {
		const output = run("wc -l <<'EOF'\nline1\nline2\nEOF\necho after-heredoc");
		expect(output.split("\n").map((line) => line.trim())).toEqual(["2", "after-heredoc"]);
	});

	it("still runs a statement that follows a heredoc joined with ; on the next line", () => {
		const output = run("wc -l <<'EOF'\nline1\nEOF\necho one; echo two");
		expect(output.split("\n").map((line) => line.trim())).toEqual(["1", "one", "two"]);
	});
});

describe("output redirection", () => {
	it("writes a command's output to a file inside the root, overwriting", () => {
		expect(runWith("echo hello > out.txt", { commands: { redirect: "allow" } })).toBe("");
		expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hello");
	});

	it("appends with >>", () => {
		const opts = { commands: { redirect: "allow" as const } };
		runWith("echo one > append.txt", opts);
		runWith("echo two >> append.txt", opts);
		expect(readFileSync(join(root, "append.txt"), "utf8")).toBe("onetwo");
	});

	it("refuses to write outside the root", () => {
		const output = runWith(`echo hi > ${resolve(outsideFile, "..", "new.txt")}`, { commands: { redirect: "allow" } });
		expect(output).toContain("Access denied");
	});

	it("discards output to /dev/null and nul without writing a file", () => {
		expect(runWith("echo secret > /dev/null", { commands: { redirect: "allow" } })).toBe("");
		expect(runWith("echo secret > nul", { commands: { redirect: "allow" } })).toBe("");
	});

	it("discarding to /dev/null bypasses the redirect policy entirely, even when denied", () => {
		expect(runWith("echo secret > /dev/null", { commands: { redirect: "deny" } })).toBe("");
	});

	it("an explicit deny on redirect blocks the write, without touching the file", () => {
		const output = runWith("echo hi > denied.txt", { commands: { redirect: "deny" } });
		expect(output).toContain("ist deaktiviert");
		expect(() => readFileSync(join(root, "denied.txt"), "utf8")).toThrow();
	});

	it("a plain '2>' redirect is left alone (only stdout redirection is implemented)", () => {
		// Not a real file write - this documents the limitation rather than
		// asserting a specific error shape, which comes from whatever program
		// receives the literal "2>somefile.txt" token.
		expect(() => runWith("echo hi 2>somefile.txt", { commands: { redirect: "allow" } })).not.toThrow();
	});
});

describe("shipped defaults (DEFAULT_SAFEGUARDS_SETTINGS)", () => {
	const runShipped = (command: string) => executeShellCommand(command, root, root, DEFAULT_SAFEGUARDS_SETTINGS);

	it("does not refuse an unlisted command outright - defaultPolicy is ask, not deny", () => {
		expect(runShipped(`${node} -e "console.log(7+7)"`).trim()).toBe("14");
	});

	it("runs rm/mv/git the same as any other built-in - 'ask' is already-approved by the time it reaches here", () => {
		writeFileSync(join(root, "src", "shipped.txt"), "x\n", "utf8");
		expect(runShipped("mv src/shipped.txt src/shipped2.txt")).toBe("");
		expect(runShipped("rm src/shipped2.txt")).toBe("");
	});
});
