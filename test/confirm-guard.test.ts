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
	// A missing settings file falls back to DEFAULT_SAFEGUARDS_SETTINGS (see
	// settings.test.ts), not an empty policy - "ls" is one of the shipped
	// overrides left at "allow", so this exercises that fallback rather than
	// an accidentally-permissive absence of any policy at all.
	it("does nothing for a command the shipped defaults leave at allow (missing settings file)", async () => {
		rmSync(settingsPath, { force: true });
		const call = guard();
		const confirm = vi.fn();
		expect(await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("asks for a command the shipped defaults set to ask (missing settings file)", async () => {
		rmSync(settingsPath, { force: true });
		const call = guard();
		const confirm = vi.fn().mockResolvedValue(true);
		expect(await call("bash", { command: "rm foo" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("ignores tools other than bash and the native grep/find/ls", async () => {
		writeSettings({ commands: { read: "ask" } });
		const call = guard();
		const confirm = vi.fn();
		expect(await call("read", { file_path: "x" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	describe("ask", () => {
		it("asks before a command set to ask, and blocks on refusal", async () => {
			writeSettings({ commands: { rm: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(false);
			const result = await call("bash", { command: "rm foo.txt" }, { hasUI: true, ui: { confirm } });
			expect(confirm).toHaveBeenCalledOnce();
			expect(result?.block).toBe(true);
		});

		it("allows the command through when the user approves", async () => {
			writeSettings({ commands: { rm: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("bash", { command: "rm foo.txt" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
		});

		it("judges the command behind `time`, not a program called time", async () => {
			writeSettings({ commands: { rm: "ask", ls: "allow" }, defaultPolicy: "deny" });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(false);
			const result = await call("bash", { command: "time rm foo.txt" }, { hasUI: true, ui: { confirm } });
			expect(confirm).toHaveBeenCalledOnce();
			expect(result?.block).toBe(true);
			const quiet = vi.fn();
			expect(
				await call("bash", { command: "time -p ls | ls" }, { hasUI: true, ui: { confirm: quiet } }),
			).toBeUndefined();
			expect(quiet).not.toHaveBeenCalled();
		});

		it("does not ask for a command not set to ask", async () => {
			writeSettings({ commands: { rm: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("catches a piped-in command too, not just the first segment", async () => {
			writeSettings({ commands: { rm: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			await call("bash", { command: "echo x | rm y" }, { hasUI: true, ui: { confirm } });
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("defaultPolicy ask covers anything not built in", async () => {
			writeSettings({ defaultPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("does not ask about a built-in command under defaultPolicy ask", async () => {
			writeSettings({ defaultPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "ls" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("does not ask about a command explicitly allowed, even under defaultPolicy ask", async () => {
			writeSettings({ defaultPolicy: "ask", commands: { npm: "allow" } });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "npm install" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("fails closed when a prompt is needed but there is no UI to ask", async () => {
			writeSettings({ commands: { rm: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "rm foo" }, { hasUI: false, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});
	});

	describe("deny", () => {
		it("blocks a denied command immediately, without asking at all", async () => {
			writeSettings({ commands: { rm: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "rm foo" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("blocks immediately even with no UI available - denial never needs one", async () => {
			writeSettings({ commands: { rm: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "rm foo" }, { hasUI: false, ui: { confirm } });
			expect(result?.block).toBe(true);
		});

		it("deny wins over defaultPolicy allow", async () => {
			writeSettings({ defaultPolicy: "allow", commands: { rm: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "rm foo" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("an explicit defaultPolicy deny blocks anything not built in, without asking", async () => {
			writeSettings({ defaultPolicy: "deny" });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "python -c 1" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});
	});

	describe("shipped defaults", () => {
		it("defaultPolicy ask (the shipped default) asks about anything not built in", async () => {
			writeSettings({});
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("bash", { command: "python -c 1" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("blocks on refusal the same as any other ask", async () => {
			writeSettings({});
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(false);
			const result = await call("bash", { command: "python -c 1" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
		});
	});

	// A real `>`/`>>` write is gated the same way any other command is, under
	// the pseudo-program name "redirect" - see execute.ts's applyRedirect(),
	// which checks the exact same commandState("redirect", …).
	describe("redirect (> / >>)", () => {
		it("asks before a command that writes output to a file", async () => {
			writeSettings({ commands: { redirect: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("bash", { command: "echo hi > out.txt" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("blocks a denied redirect immediately, without asking", async () => {
			writeSettings({ commands: { redirect: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "echo hi > out.txt" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("does not ask about a command with no redirect at all", async () => {
			writeSettings({ commands: { redirect: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("bash", { command: "echo hi" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("does not ask about discarding to /dev/null or nul - that is not a real write", async () => {
			writeSettings({ commands: { redirect: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			expect(
				await call("bash", { command: "echo hi > /dev/null" }, { hasUI: true, ui: { confirm } }),
			).toBeUndefined();
			expect(await call("bash", { command: "echo hi > nul" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("still asks/denies about the program itself, independent of the redirect", async () => {
			writeSettings({ commands: { rm: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("bash", { command: "rm -rf / > out.txt" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
		});

		it("a > inside a heredoc body is not mistaken for a real redirect", async () => {
			writeSettings({ commands: { redirect: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const command = "cat <<'EOF'\nsome text with > inside it\nEOF";
			expect(await call("bash", { command }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});
	});

	// grep/find/ls exist as both native pi tools and emulated bash commands; a
	// model asked to search or list reaches for the native tool, not bash - so
	// deny/ask must also be checked against the native toolName directly, or a
	// state set on "grep" would never apply in practice.
	describe("native tools with a bash equivalent (grep, find, ls)", () => {
		it("asks before the native grep tool when grep is set to ask", async () => {
			writeSettings({ commands: { grep: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			expect(await call("grep", { pattern: "TODO", path: "." }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).toHaveBeenCalledOnce();
		});

		it("asks before the native ls and find tools the same way", async () => {
			writeSettings({ commands: { ls: "ask", find: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(true);
			await call("ls", { path: "." }, { hasUI: true, ui: { confirm } });
			await call("find", { pattern: "*.ts" }, { hasUI: true, ui: { confirm } });
			expect(confirm).toHaveBeenCalledTimes(2);
		});

		it("blocks the native tool call on refusal", async () => {
			writeSettings({ commands: { grep: "ask" } });
			const call = guard();
			const confirm = vi.fn().mockResolvedValue(false);
			const result = await call("grep", { pattern: "secret" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
		});

		it("denies the native tool call immediately, without asking, when set to deny", async () => {
			writeSettings({ commands: { grep: "deny" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("grep", { pattern: "x" }, { hasUI: true, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("does not ask about a native tool with no override - built-ins default to allow", async () => {
			writeSettings({ commands: { grep: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("ls", { path: "." }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("defaultPolicy does not affect native tools - they are always built in, never 'unlisted'", async () => {
			writeSettings({ defaultPolicy: "ask" });
			const call = guard();
			const confirm = vi.fn();
			expect(await call("grep", { pattern: "x" }, { hasUI: true, ui: { confirm } })).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("fails closed for a native tool with no UI to ask", async () => {
			writeSettings({ commands: { grep: "ask" } });
			const call = guard();
			const confirm = vi.fn();
			const result = await call("grep", { pattern: "x" }, { hasUI: false, ui: { confirm } });
			expect(result?.block).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		});
	});
});
