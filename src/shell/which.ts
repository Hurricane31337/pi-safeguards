/**
 * `which`: where a command name would be found.
 *
 * The emulated commands are part of this process, so there is no path to give
 * for them; anything else is looked up on PATH the way the shell (and so
 * execExternal's spawn) would find it, with PATHEXT on Windows. Read-only: it
 * stats files and runs nothing.
 */

import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export interface WhichResult {
	output: string;
	status: number;
}

function isExecutableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return false;
		return process.platform === "win32" || (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function candidateNames(name: string): string[] {
	if (process.platform !== "win32") return [name];
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	const hasExtension = extensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()));
	return hasExtension ? [name] : extensions.map((extension) => `${name}${extension}`);
}

/** Every place `name` is found, in lookup order. */
export function findOnPath(name: string, cwd: string): string[] {
	const found: string[] = [];
	if (/[\\/]/.test(name)) {
		for (const candidate of candidateNames(name)) {
			const path = resolve(cwd, candidate);
			if (isExecutableFile(path)) found.push(path);
		}
		return found;
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const candidate of candidateNames(name)) {
			const path = join(dir, candidate);
			if (isExecutableFile(path)) found.push(path);
		}
	}
	return found;
}

/**
 * `which [-a] NAME...`. `emulated` are the commands this emulator implements
 * itself; `git` is not among the ones reported that way, since it is a real
 * program and its path is the useful answer.
 */
export function execWhich(args: string[], cwd: string, emulated: readonly string[]): WhichResult {
	const all = args.slice(1).includes("-a");
	const names = args.slice(1).filter((arg) => !arg.startsWith("-"));
	if (names.length === 0) return { output: "", status: 1 };

	const lines: string[] = [];
	let status = 0;
	for (const name of names) {
		if (emulated.includes(name) && name !== "git") {
			lines.push(`${name}: built into the bash emulator`);
			continue;
		}
		const paths = findOnPath(name, cwd);
		if (paths.length === 0) {
			lines.push(`which: no ${name} in (PATH)`);
			status = 1;
			continue;
		}
		for (const path of all ? paths : paths.slice(0, 1)) lines.push(path.replace(/\\/g, "/"));
	}
	return { output: lines.join("\n"), status };
}
