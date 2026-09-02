import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSpilled } from "../src/paths.js";
import { truncateShellOutput } from "../src/shell/output.js";

/** Path out of the "[... Full output: <path>]" notice pi's bash tool prints. */
function spillPath(output: string): string {
	const match = output.match(/Full output: (.+?)\]$/m);
	if (!match) throw new Error(`no spill path in: ${output.slice(-200)}`);
	return match[1];
}

describe("truncateShellOutput", () => {
	it("passes short output through untouched", () => {
		expect(truncateShellOutput("one\ntwo\n")).toBe("one\ntwo\n");
	});

	it("caps output past the byte limit and keeps the tail", () => {
		const line = "x".repeat(200);
		const text = Array.from({ length: 1000 }, (_, i) => `${i} ${line}`).join("\n");

		const output = truncateShellOutput(text);

		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(Buffer.byteLength(text, "utf8"));
		expect(output).toContain("50.0KB limit");
		expect(output).toContain(`999 ${line}`); // last line survives
		expect(output.startsWith("0 ")).toBe(false); // the head is gone
	});

	it("caps output past the line limit", () => {
		const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
		const output = truncateShellOutput(text);
		expect(output).toContain("Showing lines 501-2500 of 2500.");
	});

	it("writes the complete output to a temp file the sandbox then allows", () => {
		const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
		const path = spillPath(truncateShellOutput(text));

		expect(readFileSync(path, "utf8")).toBe(text);
		expect(isSpilled(path)).toBe(true);
	});
});
