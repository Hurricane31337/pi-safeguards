import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commandState,
	DEFAULT_SAFEGUARDS_SETTINGS,
	getSafeguardsJsonPath,
	loadSafeguardsSettings,
	saveSafeguardsSettings,
} from "../src/settings.js";

const dir = mkdtempSync(join(tmpdir(), "safeguards-settings-"));
const path = join(dir, "safeguards.json");
const builtins = ["ls", "cat", "git"] as const;

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadSafeguardsSettings", () => {
	it("falls back to defaults when the file does not exist", () => {
		expect(loadSafeguardsSettings(join(dir, "missing.json"))).toEqual(DEFAULT_SAFEGUARDS_SETTINGS);
	});

	it("falls back to defaults on malformed JSON, rather than throwing", () => {
		writeFileSync(path, "{ not json", "utf8");
		expect(loadSafeguardsSettings(path)).toEqual(DEFAULT_SAFEGUARDS_SETTINGS);
	});

	it("reads a full custom config", () => {
		writeFileSync(
			path,
			JSON.stringify({
				commands: { rm: "deny", npm: "allow", python: "ask" },
				defaultPolicy: "ask",
			}),
			"utf8",
		);
		expect(loadSafeguardsSettings(path)).toEqual({
			commands: { rm: "deny", npm: "allow", python: "ask" },
			defaultPolicy: "ask",
		});
	});

	it("treats an unrecognised defaultPolicy value as the shipped default", () => {
		writeFileSync(path, JSON.stringify({ defaultPolicy: "yolo" }), "utf8");
		expect(loadSafeguardsSettings(path).defaultPolicy).toBe(DEFAULT_SAFEGUARDS_SETTINGS.defaultPolicy);
	});

	it("drops a command entry with an unrecognised state instead of throwing", () => {
		writeFileSync(path, JSON.stringify({ commands: { rm: "yolo", mv: "deny" } }), "utf8");
		expect(loadSafeguardsSettings(path).commands).toEqual({ mv: "deny" });
	});

	it("trims command names and ignores an empty one", () => {
		writeFileSync(path, JSON.stringify({ commands: { " rm ": "deny", "  ": "deny" } }), "utf8");
		expect(loadSafeguardsSettings(path).commands).toEqual({ rm: "deny" });
	});

	it("ignores a non-object commands value instead of throwing", () => {
		writeFileSync(path, JSON.stringify({ commands: "not-an-object" }), "utf8");
		expect(loadSafeguardsSettings(path).commands).toEqual({});
	});
});

describe("saveSafeguardsSettings", () => {
	it("writes settings that loadSafeguardsSettings reads back unchanged", () => {
		const settings = { commands: { rm: "deny", npm: "ask" }, defaultPolicy: "allow" } as const;
		saveSafeguardsSettings(settings, path);
		expect(loadSafeguardsSettings(path)).toEqual(settings);
	});

	it("creates the config directory if it does not exist yet", () => {
		const nestedPath = join(dir, "fresh-subdir", "safeguards.json");
		expect(existsSync(nestedPath)).toBe(false);
		saveSafeguardsSettings(DEFAULT_SAFEGUARDS_SETTINGS, nestedPath);
		expect(loadSafeguardsSettings(nestedPath)).toEqual(DEFAULT_SAFEGUARDS_SETTINGS);
	});
});

describe("commandState", () => {
	it("uses the explicit override when present, for a built-in or not", () => {
		const settings = { commands: { ls: "deny", npm: "allow" }, defaultPolicy: "deny" } as const;
		expect(commandState("ls", settings, builtins)).toBe("deny");
		expect(commandState("npm", settings, builtins)).toBe("allow");
	});

	it("defaults a built-in command to allow when not overridden", () => {
		const settings = { commands: {}, defaultPolicy: "deny" } as const;
		expect(commandState("ls", settings, builtins)).toBe("allow");
	});

	it("falls back to defaultPolicy for a non-built-in command when not overridden", () => {
		const settings = { commands: {}, defaultPolicy: "ask" } as const;
		expect(commandState("npm", settings, builtins)).toBe("ask");
	});
});

describe("getSafeguardsJsonPath", () => {
	const originalEnv = process.env.PI_SAFEGUARDS_JSON_PATH;

	beforeEach(() => {
		delete process.env.PI_SAFEGUARDS_JSON_PATH;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_SAFEGUARDS_JSON_PATH;
		else process.env.PI_SAFEGUARDS_JSON_PATH = originalEnv;
	});

	// Regression test: the IDE host (PiWindowControl.cs) sets this so the
	// extension and the settings panel agree on the file's location even on
	// branches where getAgentDir() and AgentPaths.SafeguardsJsonPath disagree
	// (patch 0003-flat-config-layout on the Label/RepoChat branches moves
	// models.json/auth.json/settings.json but not getAgentDir() itself).
	// Without this override, the two sides silently read/write different
	// files and every saved setting appears to do nothing.
	it("prefers PI_SAFEGUARDS_JSON_PATH over the getAgentDir()-derived default", () => {
		process.env.PI_SAFEGUARDS_JSON_PATH = join(dir, "overridden.json");
		expect(getSafeguardsJsonPath()).toBe(join(dir, "overridden.json"));
	});

	it("falls back to getAgentDir()/safeguards.json when unset", () => {
		expect(getSafeguardsJsonPath().endsWith("safeguards.json")).toBe(true);
		expect(getSafeguardsJsonPath()).not.toBe(join(dir, "overridden.json"));
	});
});
