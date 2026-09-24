/**
 * Runs a command outside the hand-implemented set, once settings.ts's
 * commandState() has resolved it to "ask" (already approved) or "allow".
 * Spawned as an argv array exactly like git.ts's execGit — no shell, so the
 * command string the model wrote is never re-parsed by anything but this
 * emulator's own parser. Pipes around it are handled by the emulator via
 * stdin/stdout; the external process never sees them.
 */

import { spawnSync } from "node:child_process";

export function execExternal(args: string[], cwd: string, stdin: string | null): string {
	const program = args[0];
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(program, args.slice(1), {
			cwd,
			encoding: "utf8",
			input: stdin !== null ? stdin : undefined,
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		return `[bash-emulator] ${program}: ${(error as Error).message}`;
	}
	if (result.error) {
		const notFound = (result.error as NodeJS.ErrnoException).code === "ENOENT";
		return notFound
			? `[bash-emulator] '${program}' ist nicht installiert oder nicht im PATH.`
			: `[bash-emulator] ${program}: ${result.error.message}`;
	}

	const stdout = String(result.stdout ?? "").replace(/\r\n/g, "\n");
	const stderr = String(result.stderr ?? "").replace(/\r\n/g, "\n");
	return (stdout + stderr).replace(/\n+$/, "");
}
