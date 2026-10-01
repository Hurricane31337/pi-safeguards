import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SafeguardsSettings } from "../src/settings.js";
import { executeShellCommand } from "../src/shell/execute.js";
import { splitItems } from "../src/shell/parse.js";
import { programsIn } from "../src/shell/plan.js";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "safeguards-interp-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.txt"), "alpha\nbeta\n", "utf8");
	writeFileSync(join(root, "src", "b.txt"), "beta only\n", "utf8");
	writeFileSync(join(root, "src", "c.log"), "log\n", "utf8");
	writeFileSync(join(root, "top.txt"), "top\n", "utf8");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const node = `"${process.execPath}"`;
// Programs are looked up by the name typed, which for node is a full path; allow every external one.
const settings: SafeguardsSettings = { commands: {}, defaultPolicy: "allow" };
const run = (command: string) => executeShellCommand(command, root, root, settings);

describe("splitItems", () => {
	it("keeps the connector that follows each item", () => {
		expect(splitItems("a && b || c; d\ne")).toEqual([
			{ text: "a", connector: "&&" },
			{ text: "b", connector: "||" },
			{ text: "c", connector: ";" },
			{ text: "d", connector: ";" },
			{ text: "e", connector: ";" },
		]);
	});

	it("does not split inside quotes", () => {
		expect(splitItems(`echo "a && b; c" || echo 'x || y'`)).toEqual([
			{ text: `echo "a && b; c"`, connector: "||" },
			{ text: `echo 'x || y'`, connector: ";" },
		]);
	});

	it("keeps && across a line break and joins backslash continuations", () => {
		expect(splitItems("a &&\nb")).toEqual([
			{ text: "a", connector: "&&" },
			{ text: "b", connector: ";" },
		]);
		expect(splitItems("echo a \\\n b")).toEqual([{ text: "echo a  b", connector: ";" }]);
	});
});

describe("variables", () => {
	it("assigns and expands, as in the reported command", () => {
		expect(run("F=src/a.txt; grep -n beta $F")).toBe("2:beta");
	});

	it("expands inside double quotes, not inside single quotes", () => {
		expect(run(`X=world; echo "hello $X" 'no $X' \${X}!`)).toBe("hello world no $X world!");
	});

	it("splits an unquoted value into words and keeps a quoted one whole", () => {
		const both = run(`L="src/a.txt src/b.txt"; cat $L`);
		expect(both).toContain("alpha");
		expect(both).toContain("beta only");
		expect(run(`L="a b"; echo "$L" | wc -w`).trim()).toBe("2");
		expect(run(`L="a  b"; printf '%s|' "$L"`)).toContain("a  b");
	});

	it("uses defaults and treats an unset variable as empty", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
		expect(run("echo [$NOPE] [${NOPE:-fallback}]")).toBe("[] [fallback]");
	});

	it("supports export, several assignments and a value built from another variable", () => {
		expect(run("export A=1 B=2; C=$A$B; echo $C")).toBe("12");
	});

	it("never treats a value as syntax", () => {
		// The value contains a separator, a pipe and a redirect; it must stay text.
		const output = run(`X="a; rm -rf src | wc > evil.txt"; echo $X`);
		expect(output).toBe("a; rm -rf src | wc > evil.txt");
		expect(run("ls src")).toContain("a.txt");
		expect(() => readFileSync(join(root, "evil.txt"))).toThrow();
	});

	it("does not pass variables to programs", () => {
		expect(run(`SECRET=hunter2; ${node} -e "console.log(process.env.SECRET ?? 'unset')"`)).toBe("unset");
	});

	it("expands $? to the last status", () => {
		expect(run("false; echo $?")).toBe("1");
		expect(run("true; echo $?")).toBe("0");
	});

	it("leaves a lone dollar and \\$ alone", () => {
		expect(run(`echo 'cost $' "a$"`)).toBe("cost $ a$");
		expect(run(`echo "x\\$y"`)).toBe("x\\$y");
	});
});

describe("for loops", () => {
	it("loops over a literal list, with the reported failing case", () => {
		const output = run(`for f in a b c; do echo "item $f"; done`);
		expect(output).toBe("item a\nitem b\nitem c");
	});

	it("runs the loop from the report (py_compile style) with && and ||", () => {
		const script = `for f in ok.js bad.js; do ${node} --check "src/$f" && echo "ok $f" || echo "FAIL $f"; done`;
		writeFileSync(join(root, "src", "ok.js"), "const a = 1;\n", "utf8");
		writeFileSync(join(root, "src", "bad.js"), "const = ;\n", "utf8");
		const output = run(script);
		expect(output).toContain("ok ok.js");
		expect(output).toContain("FAIL bad.js");
		expect(output).not.toContain("FAIL ok.js");
		expect(output).not.toContain("ok bad.js");
	});

	it("supports newlines, do on its own line, and a command after do", () => {
		expect(run("for x in 1 2\ndo\n  echo $x\ndone")).toBe("1\n2");
		expect(run("for x in 1 2; do echo $x; done")).toBe("1\n2");
	});

	it("nests", () => {
		expect(run("for a in 1 2; do for b in x y; do echo $a$b; done; done")).toBe("1x\n1y\n2x\n2y");
	});

	it("expands globs and keeps the variable afterwards", () => {
		expect(run("for f in src/*.txt; do echo $f; done")).toBe("src/a.txt\nsrc/b.txt");
		expect(run("for f in src/*.nothing; do echo $f; done")).toBe("src/*.nothing");
	});

	it("does not expand a glob that leaves the sandbox", () => {
		expect(run("for f in ../*; do echo $f; done")).toBe("../*");
	});

	it("takes the loop list from a variable", () => {
		expect(run(`L="p q"; for x in $L; do echo $x; done`)).toBe("p\nq");
	});

	it("continues the script after done and honours && after it", () => {
		expect(run("for x in 1; do echo $x; done && echo after")).toBe("1\nafter");
	});

	it("explains malformed loops instead of running them", () => {
		expect(run("for x in 1 2; echo $x")).toContain("'for' ohne 'do'");
		expect(run("for x in 1 2; do echo $x")).toContain("'for' ohne 'done'");
		expect(run("echo a; done")).toContain("'done' ohne");
	});

	it("refuses an absurd number of iterations", () => {
		const many = Array.from({ length: 2500 }, (_, i) => i).join(" ");
		expect(run(`for x in ${many}; do echo $x; done`)).toContain("Durchläufe");
	});
});

describe("&& and ||", () => {
	it("skips the right side of && after a failure and runs || instead", () => {
		expect(run("false && echo no || echo yes")).toBe("yes");
		expect(run("true && echo yes || echo no")).toBe("yes");
		expect(run("true || echo no && echo yes")).toBe("yes");
	});

	it("treats a failing cd as a failure", () => {
		expect(run("cd nowhere && echo reached")).not.toContain("reached");
		expect(run("cd nowhere || echo recovered")).toContain("recovered");
	});

	it("reads grep's no-match and a missing file as failure", () => {
		expect(run("grep zzz src/a.txt || echo none")).toBe("none");
		expect(run("grep beta src/a.txt && echo found")).toBe("beta\nfound");
		expect(run("cat nofile.txt || echo missing")).toContain("missing");
	});

	it("uses a real program's exit code", () => {
		expect(run(`${node} -e "process.exit(3)" || echo "failed $?"`)).toBe("failed 3");
	});

	it("keeps ; as an unconditional separator", () => {
		expect(run("false; echo still")).toBe("still");
	});
});

describe("unsupported shell syntax", () => {
	it("says so for if/while/case instead of naming a missing program", () => {
		for (const script of ["if true; then echo a; fi", "while true; do echo a; done", "case x in x) echo;; esac"]) {
			const output = run(script);
			expect(output).toContain("wird vom Emulator nicht unterstützt");
			expect(output).not.toContain("nicht installiert");
		}
	});
});

describe("command names from variables", () => {
	it("can be used, and the policy still applies to the real name", () => {
		expect(run("C=echo; $C hi")).toBe("hi");
		const denied = executeShellCommand("C=python; $C -V", root, root, { commands: {}, defaultPolicy: "deny" });
		expect(denied).toContain("'python' ist deaktiviert");
	});

	it("refuses a command name that came out of a glob", () => {
		const output = run("for f in src/*.txt; do $f; done");
		expect(output).toContain("Glob-Ergebnis");
	});

	it("refuses a glob-derived name behind a wrapper too", () => {
		const output = run("for f in src/*.txt; do env $f; done");
		expect(output).toContain("Glob-Ergebnis");
	});
});

describe("which", () => {
	it("finds a program on PATH", () => {
		const output = run(`which ${process.platform === "win32" ? "node" : "node"}`);
		expect(output).toMatch(/node/i);
		expect(output).not.toContain("no node in");
	});

	it("reports an emulated command as built in and a missing one as failure", () => {
		expect(run("which cat")).toContain("built into the bash emulator");
		expect(run("which definitely-not-a-program-xyz")).toContain("no definitely-not-a-program-xyz in (PATH)");
		expect(run("which definitely-not-a-program-xyz || echo gone")).toContain("gone");
	});

	it("handles several names and no argument", () => {
		expect(run("which cat ls")).toBe("cat: built into the bash emulator\nls: built into the bash emulator");
		expect(run("which")).toBe("");
	});

	it("is governed by its own policy", () => {
		const denied = executeShellCommand("which node", root, root, {
			commands: { which: "deny" },
			defaultPolicy: "allow",
		});
		expect(denied).toContain("'which' ist deaktiviert");
	});
});

describe("programsIn (what the confirm guard sees)", () => {
	it("sees the programs inside a loop body, with the loop variable expanded", () => {
		expect(programsIn("for c in rm ls; do $c x; done")).toEqual(["rm", "ls"]);
	});

	it("sees through variables and wrappers", () => {
		expect(programsIn("P=python; $P x")).toEqual(["python"]);
		expect(programsIn("P=python; env $P x")).toEqual(["env", "python"]);
	});

	it("considers both sides of && and ||", () => {
		expect(programsIn("git status && rm x || cp a b")).toEqual(["git", "rm", "cp"]);
	});

	it("counts a redirect, but not one to /dev/null", () => {
		expect(programsIn("echo hi > out.txt")).toContain("redirect");
		expect(programsIn("echo hi > /dev/null")).not.toContain("redirect");
		expect(programsIn("for f in a; do echo $f > $f.txt; done")).toContain("redirect");
	});

	it("treats a glob-derived command name as an unknown program, never as nothing", () => {
		const programs = programsIn("for f in *; do $f; done");
		expect(programs).toHaveLength(1);
		expect(programs[0]).not.toBe("");
		expect(programs[0]).not.toMatch(/^[a-z]/i);
	});

	it("includes cd, time and a time-prefixed statement", () => {
		expect(programsIn("cd src; time ls")).toEqual(["cd", "time", "ls"]);
	});

	it("yields nothing for a script that cannot be interpreted", () => {
		expect(programsIn("if true; then rm x; fi")).toEqual([]);
	});

	it("does not run anything while planning", () => {
		programsIn("echo gone > planned.txt");
		expect(() => readFileSync(join(root, "planned.txt"))).toThrow();
	});
});
