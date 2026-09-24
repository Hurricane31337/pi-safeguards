import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerConfirmGuard } from "../src/confirm-guard.js";

type BlockResult = { block?: boolean; reason?: string } | undefined;
type Ctx = { hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> } };
type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: Ctx) => Promise<BlockResult>;

let dir: string;
let settingsPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "safeguards-confirm-"));
	settingsPath = join(dir, "safeguards.json");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
	writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
}

/** Minimal stand-in for the extension API: captures the tool_call handler. */
function guard() {
	let handler: Handler | undefined;
	const api = {
		on: (_event: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as ExtensionAPI;
	registerConfirmGuard(api, settingsPath);
	if (!handler) throw new Error("registerConfirmGuard did not subscribe to tool_call");
	const call = handler;
	return (toolName: string, input: Record<string, unknown>, ctx: Ctx) => call({ toolName, input }, ctx);
}

describe("confirm guard", () => {
	it("does nothing when no confirmation is configured (missing settings file)", async () => {
		rmSync(settingsPath, { force: true });
		const call = guard();
		const confirm = vi.fn();
		expect(await call("bash", { command: "rm foo" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("ignores tools other than bash", async () => {
		writeSettings({ confirmAll: true });
		const call = guard();
		const confirm = vi.fn();
		expect(await call("read", { file_path: "x" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("asks before a command named in confirmCommands, and blocks on refusal", async () => {
		writeSettings({ confirmCommands: ["rm"] });
		const call = guard();
		const confirm = vi.fn().mockResolvedValue(false);
		const result = await call("bash", { command: "rm foo.txt" }, { hasUI: true, ui: { confirm } });
		expect(confirm).toHaveBeenCalledOnce();
		expect(result?.block).toBe(true);
	});

	it("allows the command through when the user approves", async () => {
		writeSettings({ confirmCommands: ["rm"] });
		const call = guard();
		const confirm = vi.fn().mockResolvedValue(true);
		expect(await call("bash", { command: "rm foo.txt" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
	});

	it("does not ask for a command not in confirmCommands", async () => {
		writeSettings({ confirmCommands: ["rm"] });
		const call = guard();
		const confirm = vi.fn();
		expect(await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("catches a piped-in command too, not just the first segment", async () => {
		writeSettings({ confirmCommands: ["rm"] });
		const call = guard();
		const confirm = vi.fn().mockResolvedValue(true);
		await call("bash", { command: "echo x | rm y" }, { hasUI: true, ui: { confirm } });
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("confirmAll asks for every command", async () => {
		writeSettings({ confirmAll: true });
		const call = guard();
		const confirm = vi.fn().mockResolvedValue(true);
		await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } });
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("fails closed when confirmation is needed but there is no UI to ask", async () => {
		writeSettings({ confirmCommands: ["rm"] });
		const call = guard();
		const confirm = vi.fn();
		const result = await call("bash", { command: "rm foo" }, { hasUI: false, ui: { confirm } });
		expect(result?.block).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	describe("ask policy", () => {
		it("asks about a command that is neither built in nor allowed", async () => {
			writeSettings({ commandPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("blocks the unlisted command on refusal", async () => {
			writeSettings({ commandPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(false);
			const result = await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
		});

		it("does not ask about a built-in command", async () => {
			writeSettings({ commandPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("does not ask about a command already pre-approved via allowedCommands", async () => {
			writeSettings({ commandPolicy: "ask", allowedCommands: ["npm"] });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("whitelist (the default) does not ask about unlisted commands - it just refuses them later", async () => {
			writeSettings({ commandPolicy: "whitelist" });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("allow-all does not ask about unlisted commands - it just runs them", async () => {
			writeSettings({ commandPolicy: "allow-all" });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("fails closed for an unlisted command with no UI to ask", async () => {
			writeSettings({ commandPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "npm install" }, { hasUI: false, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});
	});
});
