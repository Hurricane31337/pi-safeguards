# pi-safeguards

The containment layer that the IDE extensions impose on a pi session, as one pi extension.

Two things, both **policy** rather than behaviour:

| Change | Why | How |
|---|---|---|
| pi's built-in file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) refuse paths outside the session's working directory | The IDE hands the agent one solution directory. Nothing above it is part of the task, and a model that wanders out of it is a support case at best. | `tool_call` hook returning `{ block: true, reason }` — the tools themselves are pi's and stay untouched |
| `bash` is a pure-Node emulator over a fixed command whitelist instead of a real shell | Windows has no `grep`/`sed`/`wc`, and a real shell would make every other guard here decorative: one `sh -c` and the path sandbox is gone. The whitelist gives the model no path to arbitrary code execution. | `pi.registerTool` under the name `bash`, replacing the built-in |

Supported commands: `grep [-rnilv]`, `sed -n 'X,Yp'`, `wc -l`, `uniq [-c] [-d] [-u]`, `head -n`,
`tail -n`, `find [-name] [-type f/d] [-maxdepth]`, `cat`, `ls`, `echo`, `pwd`, `git`, `|` chaining,
`>`/`>>` output redirection, and a `<<'EOF' ... EOF` heredoc as a command's stdin.
`git` is the one real program: it is spawned as an argv array, never through a shell.
Anything else — interpreters and shells (`python`, `node`, `npm`, `curl`, `bash`, `powershell`, …)
included — goes through `defaultPolicy` (see "Configuring the command policy" below): the shipped
default is `ask`, so the model is not silently refused and not silently allowed to spawn a process,
it is asked about by name every time. Set `defaultPolicy` to `deny` (or override a specific one of
them) for the old refuse-outright behaviour.

### Redirection and heredocs

`>`/`>>` writes stay inside the sandbox root exactly like every other command (`isBlocked` on the
resolved target), and are gated by `commandState()` under the pseudo-program name `"redirect"` -
`confirm-guard.ts` asks/denies a redirect the same way it does `rm` or any other command, so
`/safeguards redirect ask` (or `deny`) controls it. `/dev/null` and Windows' `nul` are recognised as
"discard the output" and never need asking, matching how a real shell treats them. Only stdout
redirection is implemented - a stderr redirect (`2>somefile`) is left as a literal token, same as
before this existed; `2>/dev/null` keeps being stripped as a no-op.

A heredoc (`<<'EOF' ... EOF`) supplies a command's stdin, e.g. `python - <<'PY' ... PY`. It must be
the last thing on that line and needs a line containing only the exact delimiter to close it -
`extractHeredocs()` (`src/shell/parse.ts`) unwraps it into an opaque marker *before* statement
splitting even sees the command, so a multi-line body is never shredded into bogus separate
statements (each line used to get dispatched - and refused - as its own "command"). Writes made this
way are plain UTF-8; for a file that must keep its original encoding, use the `write`/`edit` tools
instead, same as for `>`.

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

## Configuring the command policy

Each command's state (`deny` / `ask` / `allow`, see `src/settings.ts`) lives in `safeguards.json` and
can be edited three ways: the Visual Studio Model Settings panel, hand-editing the file, or the
`/safeguards` slash command — the only option a terminal-only session has, since it has no IDE panel
and pi-safeguards is explicitly meant to also run standalone in the TUI.

```
/safeguards                    show the current policy (defaultPolicy + every override)
/safeguards rm                 show one command's effective state
/safeguards rm deny            set an override (state: deny / ask / allow)
/safeguards rm clear           reset to the shipped default for rm ("ask"), or remove the
                                override entirely for a command with no shipped default
/safeguards default ask        set defaultPolicy itself
```

Settings are re-read from disk on every `tool_call` (`loadSafeguardsSettings` never caches), so a
change made through `/safeguards` takes effect on the very next `bash`/`grep`/`find`/`ls` call in the
same session — no restart needed.

### Shipped default (`DEFAULT_SAFEGUARDS_SETTINGS` in `src/settings.ts`)

What a fresh install starts from, and what `loadSafeguardsSettings()` falls back to whenever
`safeguards.json` is missing or malformed:

| defaultPolicy | `ask` — an unlisted command (`python`, `npm`, `curl`, …) is confirmed, not silently run or silently refused |
|---|---|

| Command | State |
|---|---|
| `cat`, `cd`, `echo`, `find`, `grep`, `head`, `ls`, `pwd`, `sed`, `tail`, `wc` | `allow` |
| `git`, `mv`, `rm` | `ask` |

`/safeguards <command> clear` on one of these resets it back to this table's value rather than to
the raw built-in default (which would otherwise be `allow` for all of them, since every command here
is one of the emulator's built-ins — see `commandState()`).

`"redirect"` (a `>`/`>>` write) is not a built-in and has no entry in this table, so it defaults to
`defaultPolicy` ("ask") until you set `/safeguards redirect <state>` explicitly.

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
  flags, `>`/`>>` write plain UTF-8 with no forced trailing newline (the content is written exactly
  as the pipeline produced it), and there is no globbing beyond `*`/`?` or subshell. Commands go
  through pi's built-in `grep` / `find` / `ls` tools where possible; the emulator is the fallback.
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
