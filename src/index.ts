/**
 * pi-safeguards — the containment layer, as one extension.
 *
 * Four things, all of them policy rather than behaviour:
 *
 *   1. pi's built-in file tools are confined to the session's working
 *      directory (path-guard.ts).
 *   2. `bash` is replaced by a pure-Node emulator that by default runs only a
 *      fixed set of commands and no interpreter or shell (shell/), so there is
 *      no path from a tool call to arbitrary code execution — and no
 *      dependency on Unix utilities that Windows does not have. That default
 *      is itself configurable per command (settings.ts): each one, built in
 *      or not, can be denied outright, asked about, or allowed unconditionally.
 *   3. pi's grep is replaced by one that searches UTF-8 and Windows-1252 files
 *      alike (grep/), so a legacy source tree gives no silent false negatives.
 *   4. Any command, including a built-in one, can be set to ask for
 *      confirmation before it runs (confirm-guard.ts) or to be denied
 *      outright with no prompt at all, independent of the others' settings.
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
import { registerSafeguardsCommand } from "./command.ts";
import { registerConfirmGuard } from "./confirm-guard.ts";
import { createSafeguardGrepTool } from "./grep/tool.ts";
import { registerPathGuard } from "./path-guard.ts";
import { createEmulatedBashTool } from "./shell/tool.ts";

export default function piSafeguards(pi: ExtensionAPI, ctx?: ExtensionContext) {
	const cwd = ctx?.cwd ?? process.cwd();

	registerPathGuard(pi);
	registerConfirmGuard(pi);
	registerSafeguardsCommand(pi);
	pi.registerTool(createEmulatedBashTool(cwd));
	pi.registerTool(createSafeguardGrepTool(cwd));
}
