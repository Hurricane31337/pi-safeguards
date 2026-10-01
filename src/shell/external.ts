/**
 * Runs a command outside the hand-implemented set, once settings.ts's
 * commandState() has resolved it to "ask" (already approved) or "allow".
 * Spawned as an argv array exactly like git.ts's execGit — no shell, so the
 * command string the model wrote is never re-parsed by anything but this
 * emulator's own parser. Pipes around it are handled by the emulator via
 * stdin/stdout; the external process never sees them.
 */

import { spawnSync } from "node:child_process";

export interface ExternalResult {
	output: string;
	/** The program's exit code; 127 when it could not be found, 1 for any other failure to run it. */
	status: number;
}

export function execExternalResult(args: string[], cwd: string, stdin: string | null): ExternalResult {
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
		return { output: `[bash-emulator] ${program}: ${(error as Error).message}`, status: 1 };
	}
	if (result.error) {
		const notFound = (result.error as NodeJS.ErrnoException).code === "ENOENT";
		return notFound
			? { output: `[bash-emulator] '${program}' ist nicht installiert oder nicht im PATH.`, status: 127 }
			: { output: `[bash-emulator] ${program}: ${result.error.message}`, status: 1 };
	}

	const stdout = String(result.stdout ?? "").replace(/\r\n/g, "\n");
	const stderr = String(result.stderr ?? "").replace(/\r\n/g, "\n");
	return { output: (stdout + stderr).replace(/\n+$/, ""), status: result.status ?? 1 };
}

export function execExternal(args: string[], cwd: string, stdin: string | null): string {
	return execExternalResult(args, cwd, stdin).output;
}
