# pi-safeguards

The containment layer that the IDE extensions impose on a pi session, as one pi extension.

Three things, all **policy** rather than behaviour:

| Change | Why | How |
|---|---|---|
| pi's built-in file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) refuse paths outside the session's working directory | The IDE hands the agent one solution directory. Nothing above it is part of the task, and a model that wanders out of it is a support case at best. | `tool_call` hook returning `{ block: true, reason }` |
| `bash` is a pure-Node emulator over a fixed command whitelist instead of a real shell | Windows has no `grep`/`sed`/`wc`, and a real shell would make every other guard here decorative: one `sh -c` and the path sandbox is gone. The whitelist gives the model no path to arbitrary code execution. | `pi.registerTool` under the name `bash`, replacing the built-in |
| `grep` searches UTF-8 and Windows-1252 files alike, with count/files modes and totals | pi's grep hands rg the pattern as-is: on a legacy tree every non-ASCII pattern is a silent false negative and legacy lines print as `J?rg`. A model that gets "No matches found" for `Einträge` concludes the text is not there. | `pi.registerTool` under the name `grep` (`src/grep/`), see "The grep tool" below |

### The grep tool

Same name and original parameters as pi's (`pattern`, `path`, `glob`, `ignoreCase`, `literal`,
`context`, `limit`), pi's renderers and truncation, plus: `mode` (`content` / `count` /
`filesWithMatches`), `before` / `after`, `maxCount` (per file), `includeIgnored`, and `encoding`
(`auto` / `utf-8` / `windows-1252`). Output is `path:line:text` (context `path-line-text`, `--`
between groups), paths relative to the project root with `/`, CRLF normalised. Every result ends
with a bracketed summary: total matching lines and files, and `truncated=true/false`. `limit` counts
matches (content) or files (other modes); context never uses it up. A malformed path (`C:/:/x`) is
an error, not a silent search. A search is capped at 60 s and says so when it is stopped.

**Encoding, `src/grep/search.ts`.** rg decodes as UTF-8 unless a BOM says otherwise, and
`--encoding windows-1252` breaks every UTF-8 file instead (including UTF-8 *with* BOM: the explicit
encoding wins over it). So `auto` runs both passes and takes each file from exactly one: a BOM or
valid UTF-8 content from the default pass, anything else from the windows-1252 pass
(`classifyFile`, run only for files that produced a hit). The second pass is skipped when the pattern
cannot tell the decodings apart (`needsLegacyPass`: ASCII, and nothing like `.`/`[…]`/`\w` that could
consume a non-ASCII character); legacy lines are then decoded from rg's base64 `lines.bytes`.

**Speed.** rg runs with neither `--sort=path` (single-threaded; 6× slower on a 14k-file repo) nor
`--binary` (reads every walked binary; 30 s+ with transcoding). Order is made deterministic in JS
instead: a path-ordered text budget keeps line text only for the first `limit` matches, every
other file just a count, and match events that can no longer contribute text are counted
without `JSON.parse`. Typical searches take 0.1–1.5 s on that repo. A search for `e` (7.4M matching
lines) takes about 11 s, and most of that is rg's own JSON output. As in rg, a binary found while
walking is skipped; a named one (or one whose NUL comes after a match) is reported, never printed.
Look-around and backreferences are retried with `--pcre2`.

**Threads.** rg defaults to min(logical cores, 12). On a 64-core dev machine that measured
209 ms per pass; 24 threads 174 ms, 32 171 ms, 64 184 ms (SMT siblings only contend). So
`ripgrepThreads()` passes half the logical cores, capped at 32, and never fewer than rg's own default.

`grep -r` in the emulator runs on the same engine (`src/shell/ripgrep.ts`). It used to read
`lines.text`, which rg leaves out for a non-UTF-8 line (it sends `lines.bytes`). Any CP1252 umlaut
in a matched line crashed it with `Cannot read properties of undefined (reading 'replace')`.

Supported commands: `grep [-rnilvcowqhH] [-e PATTERN]... [-m N] [--include=GLOB] [--exclude-dir=GLOB]`
(`-c` with an empty pattern counts every line, like real `grep -c ""`; `\(` `\)` `\{` `\}` `\|` `\+`
`\?` act as the special ERE form even without `-E`, like real BRE grep; repeating `-e` ORs the
patterns together; `-m`/`--max-count` stops after N matching lines per file, `-c` then reporting the
counted rather than the actual total; `-A`/`-B`/`-C` context lines are not implemented and fail with
`grep: unsupported option: -A (…use the grep tool's before/after/context…)` rather than being silently
ignored; a glob operand (`src/*.vb`) is expanded; file content is decoded per file as UTF-8
(BOM-sniffed, BOM stripped so `^` still anchors) or Windows-1252, on both the JS walk and the
ripgrep path; a binary file reports `grep: <path>: binary file matches` instead of dumping raw bytes, while
`-l`/`-c` still answer normally for it), `sed -n 'X,Yp'`, `wc -l`,
`uniq [-c] [-d] [-u]`, `sort [-r] [-u] [-n]`, `printf 'fmt' [args...]` (`\n`/`\t` escapes and
`%s`/`%d`/`%f`/`%o`/`%x`/`%X` substitution, repeating the format over extra args like real `printf`),
`head -n`, `tail -n` (both accept one or more file arguments, or stdin, with an `==> name <==` header
per file when given more than one), `find [-name] [-type f/d] [-maxdepth]` (root-relative paths, like
`./src/x.ts`), `cat` (reads stdin when given no file, like real `cat` in a `x | cat` pass-through),
`ls [-d]`, `rm [-rf]`, `mv`, `cp [-r] [-n]` (a byte-for-byte copy, so a Windows-1252 file stays
Windows-1252; a directory needs `-r`, like real `cp`), `mkdir [-p]`, `echo`, `pwd`, `git`, `|` chaining, `>`/`>>` output redirection, and a `<<'EOF' ... EOF`
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
| `cat`, `cd`, `echo`, `find`, `grep`, `head`, `ls`, `mkdir`, `printf`, `pwd`, `sed`, `sort`, `tail`, `uniq`, `wc` | `allow` |
| `cp`, `git`, `mv`, `rm` | `ask` |

A command with no entry in `safeguards.json` resolves to this table, then `allow` for any other
built-in, then `defaultPolicy` (`shippedCommandState()`). A file written before a command existed therefore
gets the shipped state for it: `cp` asks rather than being allowed as a built-in. `/safeguards` lists
those built-ins under "without an override", so they are visible too.

`/safeguards <command> clear` on one of these resets it back to this table's value rather than to
the raw built-in default (which would otherwise be `allow` for all of them, since every command here
is one of the emulator's built-ins — see `commandState()`).

`"redirect"` (a `>`/`>>` write) is not a built-in and has no entry in this table, so it defaults to
`defaultPolicy` ("ask") until you set `/safeguards redirect <state>` explicitly.

## Design note: the two deliberate reimplementations

The house rule (`pi-improved/README.md`) is *never reimplement a pi behaviour we only want to
adjust*. The `grep` tool breaks it because pi's only seam, `GrepOperations`, covers reading context
lines, not the search, and the fix is in how rg is invoked; it keeps pi's name, parameters,
renderers, truncation helpers and `details` fields. The emulated `bash` breaks it knowingly: pi's bash spawns a real shell, and the entire point
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
  through the `grep` tool (ours) and pi's `find` / `ls` tools where possible; the emulator is the fallback.
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
