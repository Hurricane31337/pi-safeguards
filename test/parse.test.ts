import { describe, expect, it } from "vitest";
import {
	extractHeredocs,
	extractRedirect,
	globToRegex,
	heredocBodyFor,
	parseArgs,
	parseLineCount,
	splitByPipes,
	splitStatements,
} from "../src/shell/parse.js";

describe("splitStatements", () => {
	it("splits on semicolons, newlines and &&", () => {
		expect(splitStatements("cd src; pwd")).toEqual(["cd src", "pwd"]);
		expect(splitStatements("cd src\npwd")).toEqual(["cd src", "pwd"]);
		expect(splitStatements("cd src && pwd")).toEqual(["cd src", "pwd"]);
	});

	it("keeps separators inside quotes", () => {
		expect(splitStatements(`echo "a;b"`)).toEqual([`echo "a;b"`]);
		expect(splitStatements("echo 'a && b'")).toEqual(["echo 'a && b'"]);
	});

	it("drops empty statements", () => {
		expect(splitStatements("cd src;; pwd\n\n")).toEqual(["cd src", "pwd"]);
	});
});

describe("splitByPipes", () => {
	it("splits on unquoted pipes and trims", () => {
		expect(splitByPipes("git log | grep fix | wc -l")).toEqual(["git log", "grep fix", "wc -l"]);
	});

	it("keeps pipes inside quotes", () => {
		expect(splitByPipes(`grep "a|b" file`)).toEqual([`grep "a|b" file`]);
		expect(splitByPipes("grep 'a|b' file")).toEqual(["grep 'a|b' file"]);
	});

	it("drops empty segments", () => {
		expect(splitByPipes("ls |  | wc -l")).toEqual(["ls", "wc -l"]);
	});
});

describe("parseArgs", () => {
	it("splits on spaces outside quotes", () => {
		expect(parseArgs("grep -rn foo src")).toEqual(["grep", "-rn", "foo", "src"]);
	});

	it("keeps quoted arguments together and strips the quotes", () => {
		expect(parseArgs(`sed -n '1,20p' "my file.txt"`)).toEqual(["sed", "-n", "1,20p", "my file.txt"]);
	});

	// `if (current)` used to drop an empty quoted argument entirely, since ""
	// is falsy - `grep '' file` silently lost its pattern arg and matched
	// "file" as the pattern instead, with no target left to search.
	it("keeps an empty quoted argument as an empty string, not dropping it", () => {
		expect(parseArgs(`grep '' file.txt`)).toEqual(["grep", "", "file.txt"]);
		expect(parseArgs(`grep "" file.txt`)).toEqual(["grep", "", "file.txt"]);
	});

	it("keeps an empty quoted argument even when it is the last token", () => {
		expect(parseArgs(`echo ''`)).toEqual(["echo", ""]);
	});
});

describe("globToRegex", () => {
	it("translates * and ?", () => {
		expect(globToRegex("*.vb").test("Form1.vb")).toBe(true);
		expect(globToRegex("*.vb").test("Form1.cs")).toBe(false);
		expect(globToRegex("Form?.vb").test("Form1.vb")).toBe(true);
		expect(globToRegex("Form?.vb").test("Form12.vb")).toBe(false);
	});

	it("escapes regex metacharacters in the glob", () => {
		expect(globToRegex("a+b.txt").test("a+b.txt")).toBe(true);
		expect(globToRegex("a+b.txt").test("aab.txt")).toBe(false);
	});
});

describe("parseLineCount", () => {
	it("reads -n N and -N, else the default", () => {
		expect(parseLineCount(["head", "-n", "5"], 10)).toBe(5);
		expect(parseLineCount(["head", "-3"], 10)).toBe(3);
		expect(parseLineCount(["head"], 10)).toBe(10);
	});
});

describe("extractHeredocs / heredocBodyFor", () => {
	it("replaces a heredoc with a marker and captures its body", () => {
		const { rewritten, bodies } = extractHeredocs("wc -l <<'EOF'\nline1\nline2\nEOF");
		expect(rewritten).not.toContain("\n");
		expect(rewritten.startsWith("wc -l ")).toBe(true);
		const { cleaned, body } = heredocBodyFor(rewritten, bodies);
		expect(cleaned).toBe("wc -l");
		expect(body).toBe("line1\nline2");
	});

	it("supports an unquoted delimiter too", () => {
		const { rewritten, bodies } = extractHeredocs("cat <<EOF\nhi\nEOF");
		const { body } = heredocBodyFor(rewritten, bodies);
		expect(body).toBe("hi");
	});

	it("does not touch a statement with no heredoc", () => {
		const { rewritten, bodies } = extractHeredocs("echo hi");
		expect(rewritten).toBe("echo hi");
		expect(bodies.size).toBe(0);
	});

	it("leaves an unterminated heredoc as raw, unmodified text", () => {
		const input = "wc -l <<'EOF'\nno terminator here";
		const { rewritten, bodies } = extractHeredocs(input);
		expect(rewritten).toBe(input);
		expect(bodies.size).toBe(0);
	});

	it("preserves text on the heredoc line after the delimiter", () => {
		const { rewritten, bodies } = extractHeredocs("wc -l <<'EOF' | grep x\nhi\nEOF");
		const { cleaned, body } = heredocBodyFor(rewritten, bodies);
		// Marker removal can leave a doubled space where it sat; parseArgs
		// (which sees this next in the real pipeline) treats runs of spaces
		// as one delimiter, so this only needs to be whitespace-equivalent.
		expect(cleaned.replace(/\s+/g, " ")).toBe("wc -l | grep x");
		expect(body).toBe("hi");
	});

	it("heredocBodyFor is a no-op when the segment has no marker", () => {
		expect(heredocBodyFor("echo hi", new Map())).toEqual({ cleaned: "echo hi", body: null });
	});
});

describe("extractRedirect", () => {
	it("splits off a > target", () => {
		expect(extractRedirect("echo hi > out.txt")).toEqual({ command: "echo hi", target: "out.txt", append: false });
	});

	it("splits off a >> target as append", () => {
		expect(extractRedirect("echo hi >> out.txt")).toEqual({ command: "echo hi", target: "out.txt", append: true });
	});

	it("keeps a quoted target's quotes stripped by parseArgs downstream, not here", () => {
		expect(extractRedirect(`echo hi > "my file.txt"`)).toEqual({
			command: "echo hi",
			target: "my file.txt",
			append: false,
		});
	});

	it("returns null when there is no unquoted >", () => {
		expect(extractRedirect("echo hi")).toBeNull();
		expect(extractRedirect(`echo "a > b"`)).toBeNull();
	});

	it("leaves a stderr fd redirect (2>) untouched", () => {
		expect(extractRedirect("cmd 2>errors.txt")).toBeNull();
		expect(extractRedirect("cmd 2>/dev/null")).toBeNull();
	});

	it("does not mistake a literal digit argument followed by > for a fd redirect", () => {
		expect(extractRedirect("echo 2 > out.txt")).toEqual({ command: "echo 2", target: "out.txt", append: false });
	});

	it("returns null for a trailing > with nothing after it", () => {
		expect(extractRedirect("echo hi >")).toBeNull();
	});
});
