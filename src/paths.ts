/**
 * Path containment.
 *
 * Everything the extension does is anchored to one root — the session's cwd,
 * which for the IDE is the open solution directory. The only paths outside it
 * that stay reachable are the temp files the shell tool spills truncated output
 * into: pi's own bash tells the model to read those back, so blocking them
 * would break a behaviour the TUI has.
 */

import { isAbsolute, relative, resolve } from "node:path";

const isWindows = process.platform === "win32";

/** Normalised comparison key for a path (case-insensitive on Windows). */
export function pathKey(path: string): string {
	const absolute = resolve(path);
	return isWindows ? absolute.toLowerCase() : absolute;
}

/** True when `target` resolves outside `base`. */
export function isOutside(target: string, base: string): boolean {
	let a: string;
	let b: string;
	try {
		a = pathKey(target);
		b = pathKey(base);
	} catch {
		return false;
	}
	const rel = relative(b, a);
	return rel.startsWith("..") || isAbsolute(rel);
}

/** Temp files this extension wrote; readable despite the sandbox. */
const spilled = new Set<string>();

export function markSpilled(path: string): void {
	spilled.add(pathKey(path));
}

export function isSpilled(path: string): boolean {
	try {
		return spilled.has(pathKey(path));
	} catch {
		return false;
	}
}

/** True when a path must not be touched: outside the root and not one of ours. */
export function isBlocked(target: string, root: string): boolean {
	return !isSpilled(target) && isOutside(target, root);
}
