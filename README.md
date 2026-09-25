# pi-safeguards

The containment layer that the IDE extensions impose on a pi session, as one pi extension.

Two things, both **policy** rather than behaviour:

| Change | Why | How |
|---|---|---|
| pi's built-in file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) refuse paths outside the session's working directory | The IDE hands the agent one solution directory. Nothing above it is part of the task, and a model that wanders out of it is a support case at best. | `tool_call` hook returning `{ block: true, reason }` — the tools themselves are pi's and stay untouched |
| `bash` is a pure-Node emulator over a fixed command whitelist instead of a real shell | Windows has no `grep`/`sed`/`wc`, and a real shell would make every other guard here decorative: one `sh -c` and the path sandbox is gone. The whitelist gives the model no path to arbitrary code execution. | `pi.registerTool` under the name `bash`, replacing the built-in |

Supported commands: `grep [-rnilvc] [-e PATTERN]...` (`-c` with an empty pattern counts every line,
like real `grep -c ""`; `\(` `\)` `\{` `\}` `\|` `\+` `\?` act as the special ERE form even without
`-E`, like real BRE grep; repeating `-e` ORs the patterns together), `sed -n 'X,Yp'`, `wc -l`,
`uniq [-c] [-d] [-u]`, `sort [-r] [-u] [-n]`, `printf 'fmt' [args...]` (`\n`/`\t` escapes and
`%s`/`%d`/`%f`/`%o`/`%x`/`%X` substitution, repeating the format over extra args like real `printf`),
`head -n`, `tail -n` (both accept one or more file arguments, or stdin, with an `==> name <==` header
per file when given more than one), `find [-name] [-type f/d] [-maxdepth]` (root-relative paths, like
`./src/x.ts`), `cat` (reads stdin when given no file, like real `cat` in a `x | cat` pass-through),
`ls [-d]`, `echo`, `pwd`, `git`, `|` chaining, `>`/`>>` output redirection, and a `<<'EOF' ... EOF`
heredoc as a command's stdin.
`git` is the one real program: it is spawned as an argv array, never through a shell.
Anything else — interpreters and shells (`python`, `node`, `npm`, `curl`, `bash`, `powershell`, …)
included — goes through `defaultPolicy` (see "Configuring the command policy" below): the shipped
default is `ask`, so the model is not silently refused and not silently allowed to spawn a process,
it is asked about by name every time. Set `defaultPolicy` to `deny` (or override a specific one of
them) for the old refuse-outright behaviour.

There is no `$VAR` expansion, no `FOO=bar` prefix-assignment syntax, and `&&` is not gated on an
exit code (there are no exit codes at all — see `splitStatements()`'s doc comment — so `&&` behaves
exactly like `;`, and a denied/failed command never skips what comes after it). None of this is a
regression to chase; it was never implemented.

### Redirection and heredocs

`>`/`>>` writes stay inside the sandbox root exactly like every other command (`isBlocked` on the
resolved target), and are gated by `commandState()` under the pseudo-program name `"redirect"` -
`confirm-guard.ts` asks/denies a redirect the same way it does `rm` or any other command, so
`/safeguards redirect ask` (or `deny`) controls it. `/dev/null` and Windows' `nul` are recognised as
"discard the output" and never need asking, matching how a real shell treats them. Only stdout
redirection is implemented - a stderr redirect (`2>somefile`) is left as a literal token, same as
before this existed; `2>/dev/null` keeps being stripped as a no-op.

A heredoc (`<<'EOF' ... EOF`) supplies a command's stdin, e.g. `python - <<'PY' ... PY`. It must be
the last thing on that line and needs a line containing only the delimiter (whitespace trimmed) to
close it - unlike real bash, an *indented* closing delimiter is fine (only `<<-` gets that leniency
in a real shell, and only for tabs); models routinely indent an entire heredoc block for readability,
and requiring column 0 just meant that common, reasonable style broke instead of working. When the
delimiter is indented, its own leading whitespace is stripped from every body line that starts with
it, same idea as `<<-` generalised from tabs to whatever the model actually indented with; a body
line indented less than the delimiter is left alone rather than over-stripped. `extractHeredocs()`
(`src/shell/parse.ts`) unwraps the whole thing into an opaque marker *before* statement splitting
even sees the command, so a multi-line body is never shredded into bogus separate statements (each
line used to get dispatched - and refused - as its own "command"). Writes made this
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

`/safeguards` with no arguments also lists every **pseudo-command** (`PSEUDO_COMMANDS` in
`src/settings.ts` — today just `"redirect"`, see below) that has no explicit override yet, under
"Also configurable", precisely so it doesn't have to be discovered by reading source: a pseudo-command
names an emulator *behaviour*, not a program, so there is no other way to learn it is even settable.

### Shipped default (`DEFAULT_SAFEGUARDS_SETTINGS` in `src/settings.ts`)

What a fresh install starts from, and what `loadSafeguardsSettings()` falls back to whenever
`safeguards.json` is missing or malformed:

| defaultPolicy | `ask` — an unlisted command (`python`, `npm`, `curl`, …) is confirmed, not silently run or silently refused |
|---|---|

| Command | State |
|---|---|
| `cat`, `cd`, `echo`, `find`, `grep`, `head`, `ls`, `printf`, `pwd`, `sed`, `sort`, `tail`, `uniq`, `wc` | `allow` |
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
- **`cd` used to accept any in-bounds path with no existence check.** A typo'd or already-deleted
  directory silently "succeeded" - `workingDir` became a path that does not exist on disk, `pwd`
  happily printed it, and every relative path in every later command failed with a confusing
  "No such file or directory" that named an unrelated command, not the `cd` that actually caused it.
  Fixed with a `statSync().isDirectory()` check before moving; a bad target now reports
  `cd: no such file or directory: <target>` and leaves `workingDir` untouched. `cd` to a path
  *outside* the sandbox is unrelated and stays a deliberate silent no-op (see the comment in
  `execute.ts` - a refusal message there would have to quote the walked path).
- **A JS `RegExp` and real (BRE) `grep` disagree about which form of `|`/`(`/`)`/`{`/`}`/`+`/`?` is
  special.** Real grep without `-E` treats the *escaped* forms (`\|`, `\(`, …) as the special one and
  the bare forms as literal; a JS `RegExp` is the other way around. `grep "A\|B"` therefore matched
  nothing until `bareGrepEscapesToRegex()` (`commands.ts`) unescaped those six sequences before
  building the pattern. `-e PATTERN` had a related but separate bug: it was never recognised as a
  value-taking flag, so `-e`'s value silently became the positional pattern (or, on a second `-e`, a
  search target) instead of being OR'd in.
- **A common Unix command missing from `SUPPORTED_COMMANDS` doesn't get refused - it silently spawns
  the real program of that name via `execExternal`, once approved.** This bit us for real: `sort`
  wasn't emulated, so `sort` resolved to Windows' own `sort.exe` (cmd.exe's, not GNU's), which
  mangled UTF-8 through the OEM codepage and rejected GNU-style flags like `-u` — looking exactly
  like a broken emulator rather than a missing one. Before assuming a command is "emulated but
  buggy," check `SUPPORTED_COMMANDS` first; it may just not exist yet.
- **`parseArgs` used to drop an empty quoted argument (`''`) entirely**, because it only pushed a
  token when `current` was truthy and `""` is falsy - `grep '' file` silently lost its pattern
  argument and matched `file` as the pattern instead, with nothing left to search. Fixed by tracking
  whether a token was *started* (a `hasToken` flag) rather than checking the accumulated text for
  truthiness. Worth remembering when touching any of the tokenisers in `parse.ts`: an empty string is
  a legitimate value here, not an absent one.
- **A trailing newline is not an extra empty line.** Every command that splits file/stdin content on
  `\n` (`uniq`, `sort`, `head`, `tail`, `grep`) pops a resulting empty final element before using the
  lines - otherwise a pattern that can match an empty string (an empty pattern, or e.g. `.*`) reports
  one bogus extra match per file, and dedup/sort logic gets a phantom blank line to work with.
- **Relative imports must use `.ts`** — extensions load from source through jiti.

## Tests

```bash
npm install && npm test && npm run check
```

The tests import pi's real `truncateTail`, resolved through the same alias mechanism `pi-improved`
uses: a `vendor/pi` or sibling `../pi` source checkout when one exists, otherwise the installed
`@earendil-works/pi-coding-agent` peer dependency. Either way the truncation numbers under test are
pi's own, not a copy.
