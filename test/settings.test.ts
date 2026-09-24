import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SAFEGUARDS_SETTINGS, loadSafeguardsSettings } from "../src/settings.js";

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
