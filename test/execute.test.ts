import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
		expect(run("rm -rf /")).toContain("wird nicht unterstuetzt");
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
});

describe("pipes", () => {
	it("chains segments through stdin", () => {
		expect(run("cat src/a.txt | wc -l").trim()).toBe("3");
		expect(run("cat src/a.txt | grep beta")).toBe("beta");
		expect(run("cat src/a.txt | head -n 2")).toBe("alpha\nbeta");
		expect(run("cat src/a.txt | tail -n 2").trim()).toBe("beta\ngamma");
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
