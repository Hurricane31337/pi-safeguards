import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SAFEGUARDS_SETTINGS, getSafeguardsJsonPath, loadSafeguardsSettings } from "../src/settings.js";

const dir = mkdtempSync(join(tmpdir(), "safeguards-settings-"));
const path = join(dir, "safeguards.json");

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
				commandPolicy: "allow-all",
				allowedCommands: ["npm", "docker"],
				confirmCommands: ["rm", "mv"],
				confirmAll: true,
			}),
			"utf8",
		);
		expect(loadSafeguardsSettings(path)).toEqual({
			commandPolicy: "allow-all",
			allowedCommands: ["npm", "docker"],
			confirmCommands: ["rm", "mv"],
			confirmAll: true,
		});
	});

	it("treats an unrecognised commandPolicy value as the safe default", () => {
		writeFileSync(path, JSON.stringify({ commandPolicy: "yolo" }), "utf8");
		expect(loadSafeguardsSettings(path).commandPolicy).toBe("whitelist");
	});

	it("accepts the ask commandPolicy", () => {
		writeFileSync(path, JSON.stringify({ commandPolicy: "ask" }), "utf8");
		expect(loadSafeguardsSettings(path).commandPolicy).toBe("ask");
	});

	it("ignores non-string entries in array fields instead of throwing", () => {
		writeFileSync(
			path,
			JSON.stringify({ allowedCommands: ["ok", 5, null], confirmCommands: "not-an-array" }),
			"utf8",
		);
		const settings = loadSafeguardsSettings(path);
		expect(settings.allowedCommands).toEqual(["ok"]);
		expect(settings.confirmCommands).toEqual([]);
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
