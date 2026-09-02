/**
 * pi-safeguards — the containment layer, as one extension.
 *
 * Two things, both of them policy rather than behaviour:
 *
 *   1. pi's built-in file tools are confined to the session's working
 *      directory (path-guard.ts).
 *   2. `bash` is replaced by a pure-Node emulator that can run exactly one
 *      whitelisted set of commands and no interpreter or shell (shell/), so
 *      there is no path from a tool call to arbitrary code execution — and no
 *      dependency on Unix utilities that Windows does not have.
 *
 * It lives outside pi-improved on purpose. pi-improved is installed globally
 * and therefore also loaded by developers' terminal sessions; these safeguards
 * are only wanted where a host imposes them (the Visual Studio extension passes
 * `--extension`). Loading it in a TUI session is still useful for one thing:
 * reproducing exactly what the IDE does.
 *
 *   pi -e ../pi-safeguards/src/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPathGuard } from "./path-guard.ts";
import { createEmulatedBashTool } from "./shell/tool.ts";

export default function piSafeguards(pi: ExtensionAPI, ctx?: ExtensionContext) {
	const cwd = ctx?.cwd ?? process.cwd();

	registerPathGuard(pi);
	pi.registerTool(createEmulatedBashTool(cwd));
}
