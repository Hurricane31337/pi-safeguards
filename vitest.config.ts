import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests exercise pi's real tool implementations, so resolve the pi
 * packages to an actual checkout instead of a stub: vendor/pi when this repo is
 * consumed as a submodule, otherwise a sibling ../pi checkout. Unit tests do
 * not need it and run either way.
 */
const piRoot = [resolve(here, "vendor/pi"), resolve(here, "../pi")].find((p) =>
	existsSync(resolve(p, "packages/coding-agent/src/index.ts")),
);

/** npm package name -> directory under packages/ */
const PACKAGE_DIRS: Record<string, string> = {
	"pi-ai": "ai",
	"pi-tui": "tui",
	"pi-agent-core": "agent",
	"pi-coding-agent": "coding-agent",
	"pi-protocol": "protocol",
	"pi-client": "client",
	"pi-telemetry": "telemetry",
};

function piAliases(root: string) {
	const subpaths = [];
	const bare = [];
	for (const [pkg, dir] of Object.entries(PACKAGE_DIRS)) {
		const src = resolve(root, `packages/${dir}/src`).replace(/\\/g, "/");
		// Subpath exports (pi-ai/compat, pi-ai/providers/all, ...) map onto the
		// matching source file. Listed before the bare name so they win.
		subpaths.push({
			find: new RegExp(`^@earendil-works/${pkg}/(.+)$`),
			replacement: `${src}/$1.ts`,
		});
		bare.push({ find: `@earendil-works/${pkg}`, replacement: `${src}/index.ts` });
	}
	return [...subpaths, ...bare];
}

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		env: {
			...(piRoot ? { PI_ROOT: piRoot } : {}),
			// Never the developer's real safeguards.json: loading the extension
			// migrates that file, and tests must see the shipped defaults.
			PI_SAFEGUARDS_JSON_PATH: resolve(tmpdir(), "pi-safeguards-tests-no-such-dir", "safeguards.json"),
		},
	},
	resolve: {
		alias: piRoot ? piAliases(piRoot) : [],
	},
});
