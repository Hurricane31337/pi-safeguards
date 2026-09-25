import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSafeguardsCommand } from "../src/command.js";
import { loadSafeguardsSettings } from "../src/settings.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "safeguards-command-"));
	settingsPath = join(dir, "safeguards.json");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Captures the registered /safeguards command and hands back a caller for its handler. */
function command() {
	let registered: RegisteredCommand | undefined;
	const api = {
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			registered = { name, sourceInfo: { type: "extension" }, ...options } as unknown as RegisteredCommand;
		},
	} as unknown as ExtensionAPI;
	registerSafeguardsCommand(api, settingsPath);
	if (!registered) throw new Error("registerSafeguardsCommand did not register a command");
	const cmd = registered;
	const notify = vi.fn();
	const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
	const call = (args: string) => cmd.handler(args, ctx);
	return { call, notify };
}

function readSettings() {
	return loadSafeguardsSettings(settingsPath);
}

describe("/safeguards command", () => {
	it("shows the default policy and no overrides when nothing is configured", async () => {
		const { call, notify } = command();
		await call("");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("defaultPolicy: deny"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No per-command overrides"), "info");
	});

	it("sets an override with the one-liner and persists it", async () => {
		const { call, notify } = command();
		await call("rm deny");
		expect(readSettings().commands.rm).toBe("deny");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('set to "deny"'), "info");
	});

	it("shows an explicit override's state when queried with just the command name", async () => {
		const { call, notify } = command();
		await call("rm deny");
		notify.mockClear();
		await call("rm");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('explicitly set to "deny"'), "info");
	});

	it("shows the effective state for a command with no override", async () => {
		const { call, notify } = command();
		await call("npm");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('effective state is "deny"'), "info");
	});

	it("clears an override back to the default", async () => {
		const { call, notify } = command();
		await call("rm deny");
		await call("rm clear");
		expect(readSettings().commands.rm).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("removed"), "info");
	});

	it("reports nothing to clear when there was no override", async () => {
		const { call, notify } = command();
		await call("rm clear");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no override to remove"), "info");
	});

	it("rejects an invalid state instead of writing it", async () => {
		const { call, notify } = command();
		await call("rm yolo");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid state"), "error");
		expect(readSettings().commands.rm).toBeUndefined();
	});

	it("sets defaultPolicy via the default sub-command", async () => {
		const { call, notify } = command();
		await call("default allow");
		expect(readSettings().defaultPolicy).toBe("allow");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('defaultPolicy set to "allow"'), "info");
	});

	it("shows the current defaultPolicy when queried with no state", async () => {
		const { call, notify } = command();
		await call("default");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('currently "deny"'), "info");
	});

	it("takes effect immediately - a fresh load sees the write, no caching", async () => {
		const { call } = command();
		await call("git ask");
		const raw = readFileSync(settingsPath, "utf8");
		expect(JSON.parse(raw).commands.git).toBe("ask");
	});
});
