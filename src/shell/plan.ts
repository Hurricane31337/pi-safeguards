/**
 * Which programs a command string would run, found by walking the very same
 * interpreter that executes it (interpreter.ts) with hooks that record instead
 * of run. confirm-guard.ts asks or denies on this list, so it must never differ
 * from what executeShellCommand does - two parsers for one language eventually
 * disagree, and the disagreement is where a policy leaks. Loops are walked once
 * per value, variables are expanded, `&&` / `||` branches are all considered.
 */

import { REDIRECT_COMMAND } from "../settings.ts";
import { interpret } from "./interpreter.ts";
import { commandChain } from "./parse.ts";

/** `/dev/null` and Windows' `nul` both mean "discard", not a real write worth asking about. */
function isNullTarget(target: string): boolean {
	return target === "/dev/null" || target.toLowerCase() === "nul";
}

/**
 * Every program a command string would invoke, including `cd`, `time`, a wrapper's
 * target (`env python` -> env, python) and, for a real (non-null) `>` / `>>`
 * target, the pseudo-program "redirect" - the same name execute.ts checks
 * commandState() against. A script the interpreter cannot read yields nothing:
 * it will not run either (executeShellCommand answers with the reason).
 */
export function programsIn(command: string): string[] {
	const programs: string[] = [];
	interpret(
		command,
		"/",
		"/",
		{
			segment: (words) => {
				programs.push(...commandChain(words.map((word) => word.text)));
				return { output: "", status: 0 };
			},
			cd: (_arg, cwd) => {
				programs.push("cd");
				return { cwd, output: null, status: 0 };
			},
			redirect: (spec) => {
				if (!isNullTarget(spec.target)) programs.push(REDIRECT_COMMAND);
				return null;
			},
			timed: (_posix, run) => {
				programs.push("time");
				run();
				return [];
			},
		},
		true,
	);
	return programs;
}
