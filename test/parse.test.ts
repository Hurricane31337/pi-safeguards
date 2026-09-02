import { describe, expect, it } from "vitest";
import { globToRegex, parseArgs, parseLineCount, splitByPipes } from "../src/shell/parse.js";

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
