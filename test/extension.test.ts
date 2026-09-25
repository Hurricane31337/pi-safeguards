import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import piSafeguards from "../src/index.js";

/**
 * Loads the extension the way pi does and hands back what it registered, so the
 * wiring itself (tool name, schema, result shape) is covered and not just the
 * emulator underneath it.
 */
function load(cwd: string) {
	const tools: ToolDefinition[] = [];
	const events: string[] = [];
	const commands: string[] = [];
	const api = {
		on: (event: string) => {
			events.push(event);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
	} as unknown as ExtensionAPI;

	piSafeguards(api, { cwd } as ExtensionContext);
	return { tools, events, commands };
}

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "safeguards-ext-"));
	writeFileSync(join(root, "hello.txt"), "hello\n", "utf8");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("extension wiring", () => {
	it("replaces bash and guards tool calls", () => {
		const { tools, events } = load(root);
		expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
		expect(events).toContain("tool_call");
	});

	it("registers the /safeguards command", () => {
		const { commands } = load(root);
		expect(commands).toContain("safeguards");
	});

	it("announces the truncation contract in the tool description", () => {
		const [bash] = load(root).tools;
		expect(bash.description).toContain("2000 lines or 50KB");
		expect(bash.description).toContain("temp file");
	});

	it("executes a command and returns pi's result shape", async () => {
		const [bash] = load(root).tools;
		const result = await bash.execute("call-1", { command: "cat hello.txt" }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);

		expect(result.content).toEqual([{ type: "text", text: "hello\n" }]);
		expect(result.details).toEqual({ command: "cat hello.txt" });
	});

	it("reports empty output the way pi's bash does", async () => {
		const [bash] = load(root).tools;
		const result = await bash.execute("call-2", { command: "echo" }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
	});

	it("runs uniq end to end through the registered tool", async () => {
		writeFileSync(join(root, "dupes.txt"), "a\na\nb\n", "utf8");
		const [bash] = load(root).tools;
		const result = await bash.execute("call-3", { command: "cat dupes.txt | uniq" }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "a\nb" }]);
	});

	it("feeds a heredoc to a built-in command end to end through the registered tool", async () => {
		const [bash] = load(root).tools;
		const command = "wc -l <<'EOF'\none\ntwo\nthree\nEOF";
		const result = await bash.execute("call-4", { command }, undefined, undefined, { cwd: root } as ExtensionContext);
		expect((result.content[0] as { text: string }).text.trim()).toBe("3");
	});

	// Reproduces the exact real-world pipeline that surfaced sort's absence
	// (it fell through to the real Windows sort.exe instead of being refused
	// or emulated) and head/tail's stdin-only limitation.
	it("runs the classic sort | uniq -c pipeline end to end through the registered tool", async () => {
		writeFileSync(join(root, "authors.txt"), "alice\nbob\nalice\nalice\nbob\n", "utf8");
		const [bash] = load(root).tools;
		const result = await bash.execute(
			"call-5",
			{ command: "cat authors.txt | sort | uniq -c" },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.split("\n").map((line) => line.trim())).toEqual(["3 alice", "2 bob"]);
	});

	it("head reads a file argument end to end through the registered tool", async () => {
		const [bash] = load(root).tools;
		const result = await bash.execute("call-6", { command: "head -n 1 authors.txt" }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		expect((result.content[0] as { text: string }).text).toBe("alice");
	});
});
