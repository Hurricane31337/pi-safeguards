# pi-safeguards

The containment layer that the IDE extensions impose on a pi session, as one pi extension.

Two things, both **policy** rather than behaviour:

| Change | Why | How |
|---|---|---|
| pi's built-in file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) refuse paths outside the session's working directory | The IDE hands the agent one solution directory. Nothing above it is part of the task, and a model that wanders out of it is a support case at best. | `tool_call` hook returning `{ block: true, reason }` — the tools themselves are pi's and stay untouched |
| `bash` is a pure-Node emulator over a fixed command whitelist instead of a real shell | Windows has no `grep`/`sed`/`wc`, and a real shell would make every other guard here decorative: one `sh -c` and the path sandbox is gone. The whitelist gives the model no path to arbitrary code execution. | `pi.registerTool` under the name `bash`, replacing the built-in |

Supported commands: `grep [-rnilv]`, `sed -n 'X,Yp'`, `wc -l`, `head -n`, `tail -n`,
`find [-name] [-type f/d] [-maxdepth]`, `cat`, `ls`, `echo`, `pwd`, `git`, and `|` chaining.
`git` is the one real program: it is spawned as an argv array, never through a shell.
Interpreters and shells (`python`, `node`, `npm`, `curl`, `bash`, `powershell`, …) are refused **by
name** so the refusal says why and the model stops looking for a workaround.

## Why this is not in pi-improved

`pi-improved` is installed globally (`pi install ./pi-improved`) and is therefore loaded by every
terminal session a developer starts. These safeguards are only wanted where a host imposes them, so
they live in their own extension that the Visual Studio package passes explicitly:

```
--extension <path>/pi-safeguards/src/index.ts
```

Loading it in a TUI session is still useful for exactly one thing — reproducing what the IDE does:

```bash
pi -e ../pi-safeguards/src/index.ts
```

## Design note: the one deliberate reimplementation

The house rule (`pi-improved/README.md`) is *never reimplement a pi behaviour we only want to
adjust*. The emulated `bash` breaks it knowingly: pi's bash spawns a real shell, and the entire point
here is that no real shell exists. Everything that is *not* the execution mechanism still tracks pi:

- **Truncation is pi's.** `truncateShellOutput` calls pi's own `truncateTail` with pi's
  `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`, spills the full output to a `pi-bash-*.log` temp file
  and prints pi's `[Showing lines X-Y of Z (50.0KB limit). Full output: …]` notice. A truncated
  command therefore looks and measures identically in the IDE and in the TUI.
- **The tool contract is pi's.** Same tool name, same `command` / `timeout` parameters, same result
  shape, same `(no output)` placeholder.

Those spill files are the one exception to the path sandbox: pi's bash tells the model to read them
back, so `read` may reach a log this extension wrote — and only those (see `src/paths.ts`).

## Gotchas

- **The whitelist is the boundary, not the path check.** The path check exists because commands take
  paths; the reason it holds is that nothing in `src/shell/` can execute anything it did not resolve
  itself. Adding a command that shells out, evaluates a script or follows a config file removes that
  property.
- **Emulated, not equivalent.** `sed` supports only the `'X,Yp'` line-range form, `grep` a subset of
  flags, and there is no redirection, globbing or subshell. Commands go through pi's built-in
  `grep` / `find` / `ls` tools where possible; the emulator is the fallback.
- **`git` needs git on PATH.** Without it, `git` returns a plain German notice rather than failing
  the tool call.
- **Relative imports must use `.ts`** — extensions load from source through jiti.

## Tests

```bash
npm install && npm test && npm run check
```

The tests import pi's real `truncateTail`, resolved through the same alias mechanism `pi-improved`
uses: a `vendor/pi` or sibling `../pi` source checkout when one exists, otherwise the installed
`@earendil-works/pi-coding-agent` peer dependency. Either way the truncation numbers under test are
pi's own, not a copy.
