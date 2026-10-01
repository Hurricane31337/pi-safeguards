/**
 * Path containment for pi's built-in file tools.
 *
 * The tools themselves are pi's and stay untouched — this only refuses calls
 * whose path argument points outside the session's working directory. That is
 * the whole mechanism: read/read_image/write/edit take `file_path` or `path`, grep/find take `path`,
 * and `ls` is covered because its listing is rooted at the same directory.
 */

import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOutside, isSpilled } from "./paths.ts";

// read_image is pi-improved's image reader; guarding a tool that is not loaded costs nothing.
const GUARDED_TOOLS = new Set(["read", "read_image", "write", "edit", "grep", "find", "ls"]);

export function registerPathGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		const input = event.input as { file_path?: string; path?: string } | undefined;
		const requested = input?.file_path ?? input?.path;
		if (!requested) return undefined;

		const absolute = isAbsolute(requested) ? requested : resolve(ctx.cwd, requested);

		// Truncated shell output lives in the temp dir. pi's own bash points the
		// model at those files, so reading one back is expected behaviour, not
		// an escape attempt.
		if (event.toolName === "read" && isSpilled(absolute)) return undefined;

		if (isOutside(absolute, ctx.cwd)) {
			return {
				block: true,
				reason: `Access denied: "${requested}" is outside the project directory.`,
			};
		}
		return undefined;
	});
}
