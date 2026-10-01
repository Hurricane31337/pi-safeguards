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

export interface GitResult {
	output: string;
	/** git's exit code; 1 when it could not run at all. */
	status: number;
}

export function execGitResult(args: string[], cwd: string, stdin: string | null): GitResult {
	if (!isGitAvailable()) {
		return { output: "[bash-emulator] 'git' ist nicht installiert oder nicht im PATH.", status: 127 };
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
		return { output: `[bash-emulator] git: ${(error as Error).message}`, status: 1 };
	}
	if (result.error) return { output: `[bash-emulator] git: ${result.error.message}`, status: 1 };

	const stdout = String(result.stdout ?? "").replace(/\r\n/g, "\n");
	const stderr = String(result.stderr ?? "").replace(/\r\n/g, "\n");
	return { output: (stdout + stderr).replace(/\n+$/, ""), status: result.status ?? 1 };
}

export function execGit(args: string[], cwd: string, stdin: string | null): string {
	return execGitResult(args, cwd, stdin).output;
}
