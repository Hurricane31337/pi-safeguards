/**
 * Command-line splitting for the shell emulator.
 *
 * Deliberately minimal: quoting and pipes, nothing else. Anything a real shell
 * would do beyond this (substitution, subshells, redirection to files) is not
 * supported and therefore cannot be used to escape the command whitelist.
 */

const isWindows = process.platform === "win32";

/** Split a command string on `|`, respecting single and double quotes. */
export function splitByPipes(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (const char of command) {
		if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === '"' && !inSingle) inDouble = !inDouble;
		else if (char === "|" && !inSingle && !inDouble) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Tokenise one command segment into argv, respecting quotes. */
export function parseArgs(segment: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (const char of segment) {
		if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === '"' && !inSingle) inDouble = !inDouble;
		else if (char === " " && !inSingle && !inDouble) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else current += char;
	}
	if (current) args.push(current);
	return args;
}

/** Convert a simple file glob (`*.vb`) to a RegExp. Case-insensitive on Windows. */
export function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, isWindows ? "i" : "");
}

/** `-n N` or `-N`, else the default. */
export function parseLineCount(args: string[], fallback: number): number {
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "-n" && i + 1 < args.length) return Number.parseInt(args[i + 1], 10);
		if (/^-\d+$/.test(args[i])) return Number.parseInt(args[i].slice(1), 10);
	}
	return fallback;
}
