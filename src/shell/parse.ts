/**
 * Command-line splitting for the shell emulator.
 *
 * Deliberately minimal: quoting and pipes, nothing else. Anything a real shell
 * would do beyond this (substitution, subshells, redirection to files) is not
 * supported and therefore cannot be used to escape the command whitelist.
 */

const isWindows = process.platform === "win32";

/**
 * `time [-p] PIPELINE`: in bash `time` is a keyword in front of a whole
 * pipeline, not a program, so it is peeled off here at statement level -
 * for the emulator (which times the rest, see executeShellCommand) and for
 * confirm-guard.ts (which must judge the timed commands, not a program
 * called "time"). A lone `time` is still timed: bash prints ~0s for it.
 */
export function splitTimePrefix(statement: string): { timed: boolean; posix: boolean; rest: string } {
	const match = statement.match(/^time(?:\s+(-p))?(?:\s+(.*))?$/s);
	if (!match) return { timed: false, posix: false, rest: statement };
	return { timed: true, posix: match[1] === "-p", rest: (match[2] ?? "").trim() };
}

/**
 * Split a command string into statements on `;`, newlines and `&&`, respecting
 * quotes. The emulator has no exit codes to gate on, so `&&` is treated as a
 * plain separator like `;` rather than "run only if the previous succeeded".
 * This is what lets `cd DIR && rest` and `cd DIR\nrest` both work, and lets a
 * standalone `cd DIR` change the working directory for the statements after it.
 */
export function splitStatements(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === '"' && !inSingle) inDouble = !inDouble;
		else if ((char === "\n" || char === ";") && !inSingle && !inDouble) {
			parts.push(current);
			current = "";
			continue;
		} else if (char === "&" && command[i + 1] === "&" && !inSingle && !inDouble) {
			parts.push(current);
			current = "";
			i++;
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

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

/**
 * Tokenise one command segment into argv, respecting quotes. Tracks whether
 * the current token has been *started* (hasToken) rather than checking
 * `current` for truthiness - `''` is a valid, meaningful empty-string
 * argument in a real shell (e.g. `grep '' file` matches every line), and
 * checking `if (current)` would silently drop it since `""` is falsy,
 * quietly reshuffling every argument after it by one position instead.
 */
export function parseArgs(segment: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;
	for (const char of segment) {
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			hasToken = true;
		} else if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			hasToken = true;
		} else if (char === " " && !inSingle && !inDouble) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (hasToken) args.push(current);
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

/**
 * Heredocs (`<<'EOF' ... EOF`) and output redirection (`>`/`>>`) both need to
 * be recognised identically by execute.ts (which performs them) and
 * confirm-guard.ts (which must ask/deny a redirect target the same way it
 * asks/denies any other command - see extractRedirect below). Living here,
 * next to splitStatements/splitByPipes, keeps the two from drifting apart;
 * a heredoc body line that happens to contain "> file" text must never be
 * mistaken for a real redirect, which is why extractHeredocs always runs
 * first and both callers operate on its rewritten output.
 */

/** Sentinel a heredoc body is replaced with; a NUL byte never appears in a real command string. */
const HEREDOC_MARKER_PREFIX = "\u0000HD";

export interface HeredocExtraction {
	/** The input with every `<<'DELIM' ... DELIM` span replaced by an opaque marker token. */
	rewritten: string;
	/** Marker token -> the heredoc body text (without the terminator line). */
	bodies: Map<string, string>;
}

/**
 * Replaces each heredoc in `input` with a single marker token holding no
 * newlines, so splitStatements/splitByPipes (which split on newlines) do not
 * shred a multi-line heredoc body into bogus separate statements. A heredoc
 * with no matching terminator line is left as-is from that point on (real
 * bash would hang waiting for input; the emulator has none to wait for, so
 * it simply stops looking for more heredocs and lets the malformed tail
 * fail downstream the way an unrecognised command normally does).
 *
 * The terminator is matched after trimming its own leading/trailing
 * whitespace, not by an exact line match - real bash requires the plain
 * `<<DELIM` terminator at column 0 (only `<<-DELIM` strips leading *tabs*,
 * and only tabs), but models routinely indent an entire heredoc block,
 * closing delimiter included, for readability. Requiring column 0 here
 * just meant that extremely common, reasonable style silently broke every
 * body line into its own bogus "command". Once a terminator is found this
 * way, its own leading-whitespace prefix is stripped from every body line
 * that starts with it - the same idea as `<<-`, generalised from tabs to
 * whatever whitespace the model actually indented with.
 */
export function extractHeredocs(input: string): HeredocExtraction {
	const bodies = new Map<string, string>();
	const heredocRegex = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g;
	let result = "";
	let cursor = 0;
	let counter = 0;
	let match: RegExpExecArray | null = heredocRegex.exec(input);

	while (match) {
		const opStart = match.index;
		const opEnd = heredocRegex.lastIndex;
		const delimiter = match[2];
		const lineEnd = input.indexOf("\n", opEnd);
		if (lineEnd === -1) break; // no body possible - malformed, stop rewriting

		const trailingOnLine = input.slice(opEnd, lineEnd);
		const rest = input.slice(lineEnd + 1).split("\n");
		const bodyLines: string[] = [];
		let consumedChars = 0;
		let terminated = false;
		for (const line of rest) {
			consumedChars += line.length + 1;
			const withoutCR = line.replace(/\r$/, "");
			if (withoutCR.trim() === delimiter) {
				terminated = true;
				const indent = withoutCR.slice(0, withoutCR.length - withoutCR.trimStart().length);
				if (indent.length > 0) {
					for (let i = 0; i < bodyLines.length; i++) {
						if (bodyLines[i].startsWith(indent)) bodyLines[i] = bodyLines[i].slice(indent.length);
					}
				}
				break;
			}
			bodyLines.push(withoutCR);
		}
		if (!terminated) break; // no terminator found - malformed, stop rewriting

		const marker = `${HEREDOC_MARKER_PREFIX}${counter++}\u0000`;
		bodies.set(marker, bodyLines.join("\n"));
		const nextCursor = lineEnd + 1 + consumedChars;
		// The terminator line's own newline was consumed into consumedChars
		// (cursor lands past it) but never written to `result`. When more
		// input follows, that newline needs restoring here, or a statement
		// after the heredoc on the next line glues directly onto this one
		// instead of starting fresh - silently swallowing it into the
		// heredoc command's own argv. Nothing follows -> no newline to add,
		// which is what keeps a heredoc-only input marker-only (no trailing
		// "\n" some callers specifically check for).
		result += input.slice(cursor, opStart) + marker + trailingOnLine + (nextCursor < input.length ? "\n" : "");
		cursor = nextCursor;
		heredocRegex.lastIndex = cursor;
		match = heredocRegex.exec(input);
	}
	result += input.slice(cursor);
	return { rewritten: result, bodies };
}

/**
 * If `segment` carries a heredoc marker, strips it and returns the body it
 * stands for. Plain indexOf rather than a regex - a NUL byte in a regex
 * literal reads as a mistake to a linter, even though it is exactly the
 * point here (see HEREDOC_MARKER_PREFIX).
 */
export function heredocBodyFor(segment: string, bodies: Map<string, string>): { cleaned: string; body: string | null } {
	const start = segment.indexOf(HEREDOC_MARKER_PREFIX);
	if (start === -1) return { cleaned: segment, body: null };
	const end = segment.indexOf("\u0000", start + HEREDOC_MARKER_PREFIX.length);
	if (end === -1) return { cleaned: segment, body: null };

	const marker = segment.slice(start, end + 1);
	const cleaned = (segment.slice(0, start) + segment.slice(end + 1)).trim();
	return { cleaned, body: bodies.get(marker) ?? null };
}

export interface RedirectSpec {
	/** The statement with the redirect clause removed, ready for normal parsing. */
	command: string;
	target: string;
	append: boolean;
}

/**
 * Finds an unquoted `>`/`>>` in `statement` and splits off its target, e.g.
 * `echo hi > out.txt` -> { command: "echo hi", target: "out.txt", append:
 * false }. Must run on heredoc-stripped text (see extractHeredocs) or a `>`
 * inside a heredoc body would false-positive. Only stdout redirection is
 * recognised: a fd-numbered redirect (`2>`, immediately preceded by a
 * digit that is itself a standalone token) is left untouched, same as
 * before this existed - `2>/dev/null` keeps being handled by the
 * regex-based stripping in execute.ts/confirm-guard.ts.
 */
export function extractRedirect(statement: string): RedirectSpec | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < statement.length; i++) {
		const char = statement[i];
		if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === '"' && !inSingle) inDouble = !inDouble;
		else if (char === ">" && !inSingle && !inDouble) {
			const prev = statement[i - 1];
			const isFdRedirect = prev !== undefined && /\d/.test(prev) && (i < 2 || /\s/.test(statement[i - 2]));
			if (isFdRedirect) continue;

			const append = statement[i + 1] === ">";
			const rest = statement.slice(append ? i + 2 : i + 1).trim();
			if (!rest) return null; // trailing ">" with nothing after it - malformed, ignore
			const [target] = parseArgs(rest);
			if (!target) return null;
			return { command: statement.slice(0, i).trim(), target, append };
		}
	}
	return null;
}
