/**
 * Output truncation for the emulated shell.
 *
 * pi's own bash tool caps what the model sees and spills the rest into a temp
 * file (core/tools/bash.ts, formatOutput). We reuse pi's `truncateTail` and its
 * limits rather than restating them, so the emulator truncates at exactly the
 * same point and prints exactly the same notice as the TUI. The only thing left
 * to do here is write the file and format the sentence.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { markSpilled } from "../paths.ts";

/** Writes the full output to a temp file named like pi's, and whitelists it for reading. */
function spill(text: string): string | undefined {
	const path = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
	try {
		writeFileSync(path, text, "utf8");
	} catch {
		return undefined;
	}
	markSpilled(path);
	return path;
}

/**
 * Cap `text` the way pi's bash tool caps command output, appending the same
 * "[Showing lines ...]" notice so the model can page through the full log.
 */
export function truncateShellOutput(text: string): string {
	const truncation = truncateTail(text);
	if (!truncation.truncated) return text;

	const path = spill(text);
	const where = path ? ` Full output: ${path}` : " Full output could not be written to a temp file.";
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;

	if (truncation.lastLinePartial) {
		return `${truncation.content}\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}.${where}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${where}]`;
	}
	return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${where}]`;
}
