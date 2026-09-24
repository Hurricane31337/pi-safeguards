import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	outsideFile = join(mkdtempSync(join(tmpdir(), "safeguards-outside-")), "secret.txt");
	writeFileSync(outsideFile, "do not read me\n", "utf8");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(resolve(outsideFile, ".."), { recursive: true, force: true });
});

const run = (command: string) => executeShellCommand(command, root, root);
const runWith = (command: string, overrides: Partial<SafeguardsSettings>) =>
	executeShellCommand(command, root, root, { ...DEFAULT_SAFEGUARDS_SETTINGS, ...overrides });
const node = `"${process.execPath}"`;

describe("whitelist", () => {
	it("runs the built-ins", () => {
		expect(run("echo hello world")).toBe("hello world");
		expect(run("pwd")).toBe(root.replace(/\\/g, "/"));
	});

	it("refuses interpreters and shells by name, with a reason", () => {
		for (const program of ["python", "node", "npm", "bash", "sh", "cmd", "powershell", "curl", "wget"]) {
			const output = run(`${program} -c "whatever"`);
			expect(output).toContain(`'${program}' ist nicht verfuegbar`);
		}
	});

	it("refuses anything else it does not implement", () => {
		expect(run("touch foo")).toContain("wird nicht unterstuetzt");
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

	it("finds by name and type", () => {
		expect(run("find src -name *.log")).toContain("b.log");
		expect(run("find src -name *.log")).not.toContain("a.txt");
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
	it("whitelist mode (the default) refuses a command outside the built-in set", () => {
		expect(run(`${node} -e "console.log(1)"`)).toContain("wird nicht unterstuetzt");
	});

	it("whitelist mode still refuses a blocked interpreter by name", () => {
		expect(run('node -e "1"')).toContain("ist nicht verfuegbar");
	});

	it("allow-all runs an arbitrary external command with no shell involved", () => {
		expect(runWith(`${node} -e "console.log(1+1)"`, { commandPolicy: "allow-all" }).trim()).toBe("2");
	});

	it("allow-all lifts the interpreter refusal too", () => {
		expect(runWith('node -e "console.log(2+2)"', { commandPolicy: "allow-all" }).trim()).toBe("4");
	});

	it("allowedCommands opts a specific external command in without allow-all", () => {
		expect(runWith(`${node} -e "console.log(3+3)"`, { allowedCommands: [process.execPath] }).trim()).toBe("6");
	});

	it("allowedCommands overrides the interpreter refusal for exactly the named program", () => {
		expect(runWith('node -e "console.log(4+4)"', { allowedCommands: ["node"] }).trim()).toBe("8");
	});

	it("naming one command in allowedCommands does not open the whole blocklist", () => {
		expect(runWith('python -c "print(1)"', { allowedCommands: ["node"] })).toContain("ist nicht verfuegbar");
	});
});
