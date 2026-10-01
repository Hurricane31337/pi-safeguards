import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPathGuard } from "../src/path-guard.js";
import { markSpilled } from "../src/paths.js";

type BlockResult = { block?: boolean; reason?: string } | undefined;
type Handler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string },
) => Promise<BlockResult>;

/** Minimal stand-in for the extension API: captures the tool_call handler. */
function guard(cwd: string) {
	let handler: Handler | undefined;
	const api = {
		on: (_event: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as ExtensionAPI;
	registerPathGuard(api);
	if (!handler) throw new Error("registerPathGuard did not subscribe to tool_call");
	const call = handler;
	return (toolName: string, input: Record<string, unknown>) => call({ toolName, input }, { cwd });
}

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "safeguards-guard-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("path guard", () => {
	it("allows paths inside the working directory", async () => {
		const call = guard(root);
		expect(await call("read", { file_path: "src/a.txt" })).toBeUndefined();
		expect(await call("read", { file_path: join(root, "src", "a.txt") })).toBeUndefined();
		expect(await call("grep", { path: "." })).toBeUndefined();
	});

	it("blocks paths outside it, for every path-bearing tool", async () => {
		const call = guard(root);
		const outside = resolve(root, "..", "elsewhere", "secret.txt");
		for (const tool of ["read", "write", "edit"]) {
			const result = await call(tool, { file_path: outside });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("outside the project directory");
		}
		for (const tool of ["grep", "find", "ls", "read_image"]) {
			expect((await call(tool, { path: outside }))?.block).toBe(true);
		}
		expect((await call("read", { file_path: "../../etc/passwd" }))?.block).toBe(true);
	});

	it("ignores tools without a path argument", async () => {
		const call = guard(root);
		expect(await call("bash", { command: "ls" })).toBeUndefined();
		expect(await call("read", {})).toBeUndefined();
	});

	it("lets read reach a spilled output log, but nothing else in the temp dir", async () => {
		const call = guard(root);
		const log = join(tmpdir(), "pi-bash-deadbeefdeadbeef.log");
		markSpilled(log);

		expect(await call("read", { file_path: log })).toBeUndefined();
		expect((await call("write", { file_path: log }))?.block).toBe(true);
		expect((await call("read", { file_path: join(tmpdir(), "other.log") }))?.block).toBe(true);
	});
});
