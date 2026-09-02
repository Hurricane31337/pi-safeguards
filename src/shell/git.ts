/**
 * git is the one real program the emulator runs.
 *
 * It is spawned as an argv array, so no shell is involved and the command
 * string the model wrote is never re-parsed by anything but us. Pipes around it
 * are handled by the emulator via stdin/stdout — git never sees them.
 */

import { spawnSync } from "node:child_process";

/** null = not probed yet. Cached because `git --version` is a process spawn. */
let available: boolean | null = null;

export function isGitAvailable(): boolean {
	if (available !== null) return available;
	try {
		const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
		available = !result.error && result.status === 0;
	} catch {
		available = false;
	}
	return available;
}

/** Test seam: forget the cached probe result. */
export function resetGitProbe(): void {
	available = null;
}

export function execGit(args: string[], cwd: string, stdin: string | null): string {
	if (!isGitAvailable()) {
		return "[bash-emulator] 'git' ist nicht installiert oder nicht im PATH.";
	}

	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync("git", args.slice(1), {
			cwd,
			encoding: "utf8",
			input: stdin !== null ? stdin : undefined,
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		return `[bash-emulator] git: ${(error as Error).message}`;
	}
	if (result.error) return `[bash-emulator] git: ${result.error.message}`;

	const stdout = String(result.stdout ?? "").replace(/\r\n/g, "\n");
	const stderr = String(result.stderr ?? "").replace(/\r\n/g, "\n");
	return (stdout + stderr).replace(/\n+$/, "");
}
