# poor — workspace-style tools and a complete instruction profile for Pi

A self-contained Pi extension that **shadows and hides `read`, `write`, `edit`,
and `bash`**. The normal default tool set is **`bash_exec` + `apply_patch`**.
Inspect files and run commands through `bash_exec`; mutate source through
`apply_patch`. Shell output is collected into separate bounded stdout/stderr
artifacts, with small inline previews and compact output length counters.

Version 2 also **replaces the complete base system prompt**, rather than
appending guidance or selectively rewriting Pi's old tool sections. The new
standalone prompt covers workflow, verification, and skill loading without
referring to default prompts. Tool definitions carry argument schemas, output
semantics, and patch grammar instead of repeating them in the base prompt.
Path rule: shell paths use `cwd`; patch paths are workspace-relative, regardless
of shell `cwd`. There is no MCP/session dependency
and no environment-file or persistent-environment feature.

Targets **Pi 0.85.1** (`@earendil-works/pi-coding-agent`, `typebox`) and
**Node.js 22.19+**. The older `@mariozechner` / `@sinclair/typebox` generation is
not the tested target. `bash_exec` requires a POSIX host (Linux/macOS) with Bash;
Linux is the platform verified in this checkout. Windows is rejected explicitly.

## Development

Enter the reproducible development shell and run the complete check suite:

```bash
nix develop -c npm run check
```

This runs TypeScript's strict typecheck followed by the Node test suite. The
extension is executed directly from TypeScript, so no build step is required.

Load it for one invocation, from any project directory:

```bash
pi -e /home/hilaolu/poor/src/index.ts
```

Install the local package for all projects:

```bash
pi install /home/hilaolu/poor
```

Or install only for the current project:

```bash
pi install -l /home/hilaolu/poor
```

Then start Pi or use `/reload` in an existing session. For another machine,
replace `/home/hilaolu/poor` with the package directory. Local package installs
reference the directory without copying it. Do not install both the package
and its entry file at the same time.

This repository does not change your global Pi settings automatically.

For explicit tool allowlists, use the **new names**:

```bash
pi -e /home/hilaolu/poor/src/index.ts --tools bash_exec,apply_patch
pi -e /home/hilaolu/poor/src/index.ts --tools bash_exec
```

Pi enforces explicit allowlists. `--tools bash` selects a disabled original
name and does not authorize `bash_exec`; it therefore leaves no active tool
in that case. `--no-tools` remains no-tools. Default sessions need no flags.

## bash_exec

The model-facing input mirrors `BashExecRequest` in `~/workspace-mcp`, minus
the MCP `session` and `env_file` fields:

```json
{
  "command": "npm test > test.log 2>&1; status=$?; tail -n 60 -- test.log; exit \"$status\"",
  "cwd": ".",
  "timeout_seconds": 120,
  "max_artifact_bytes": 67108864,
  "max_preview_bytes": 4096
}
```

Only `command` is required. The three numeric options also accept null, with
the same effect as omission. Unknown arguments are rejected, including `env`,
`env_file`, `session`, `timeout`, and `max_output_bytes`. No `store_cmd_env` tool
is registered. The shell inherits the normal host process environment, but
exports and other shell state do not persist between calls. Startup hooks
(`BASH_ENV`, `ENV`, exported Bash functions) and inherited Git-routing overrides
are stripped; interactive Git/SSH credential prompts are disabled. Commands
can still set their own variables explicitly inside the command string.

| Property | Effective behavior |
| --- | --- |
| `command` | Fresh non-interactive Bash command; no profiles/rc files; stdin closed; at most 131072 UTF-8 bytes. |
| `background_id` | With `command`, launch a named background job; without `command`, inspect it. Runner-scoped, unique even after completion; 1–64 letters/digits/`_`/`.`/`-`, starting with a letter/digit. |
| `kill` | With `background_id` and no `command`, `true` sends SIGKILL to the owned process group and waits for cleanup. |
| `cwd` | Default `.`; arbitrary existing host directory. Relative paths use the Pi session workspace; absolute paths, traversal, and symlinks are allowed. |
| `timeout_seconds` | Default 120 seconds; effective maximum 604800 seconds (7 days); minimum 1. |
| `max_artifact_bytes` | Default and maximum 67108864 (64 MiB) raw retained bytes **per stream**; minimum 1. |
| `max_preview_bytes` | Default `min(1024, artifact quota)`; explicit values must be positive and no greater than the artifact quota. |

The public schema and effective host cap allow up to 604800 seconds (7 days).
Larger values are rejected, not silently clamped. String size limits are
reported with the `x-maxUtf8Bytes` annotation because JSON Schema's standard
`maxLength` counts characters, while runtime validation counts UTF-8 bytes.

### Collected output and redirection

Pi receives **one final JSON text result** plus identical structured `details`.
The extension does not stream the entire log or repeatedly emit growing output
snapshots. stdout and stderr are drained concurrently and stored independently:

In Pi's interactive UI, the call shows a one-line command preview capped at 120
characters, and the result is rendered as a single status line (for example,
`exit_code: 0`) instead of displaying that JSON blob. This is presentation-only:
the model and saved session still receive the complete result.

```text
{
  cwd,
  outcome: {
    command_id, exit_code, signal, timed_out,
    descendant_cleanup_attempted, duration_ms,
    stdout: {
      path, preview, len
    },
    stderr: { ...same fields... }
  }
}
```

An empty stream is returned as `null`. For nonempty output that fits entirely
within the requested preview, the stream object omits `path`; an artifact path
is included only when it is needed to inspect output beyond the inline preview.

`preview` is a lossy UTF-8 view of a raw prefix. `len` is a compact
`shown/observed` raw-byte counter, such as `37/37` or `37/3700`. There is no
combined ordering between stdout and stderr.

When `len` differs, more output was observed than shown inline. Inspect the
returned absolute artifact path with a bounded `bash_exec` command such as
`sed -n '1,80p' -- '/absolute/path/to/output.stdout'`. Bytes past the artifact
quota are drained and silently discarded; reading the artifact cannot recover
them.

To preserve large logs completely, redirect output to a deliberate workspace
file as in the example above, then print a summary. Shell redirection occurs
before tool capture. Preserve the original exit status; a trailing successful
`tail` or `cat` must not mask a failed build. Use `set -o pipefail` when upstream
pipeline errors matter. Do not rerun mutating commands merely to get logs.

Each capture has a unique private directory (mode 0700) and stream files
(mode 0600) beneath `/tmp/pi` (or the platform temporary directory's `pi`
folder). Completed artifacts have
best-effort seven-day retention; later commands perform bounded cleanup.
Cleanup does not recurse through unknown directories. There is no background
retention service, aggregate disk quota, or guarantee against host tmp cleanup.
Interrupted/crashed captures without a completion marker are left alone.

### Named background jobs

```js
{ command: "npm run dev", background_id: "dev-server", timeout_seconds: 3600 }
{ background_id: "dev-server" }
{ background_id: "dev-server", kill: true }
```

Launch returns after spawn (not application readiness). Launch, status, and kill
return `{ background_id, pid, exit, stdout_path, stderr_path }`. `exit` is `null`
until execution/capture cleanup finishes, then a code string (`"0"`, `"1"`) or
signal name (`"SIGKILL"`). Capture/cleanup failures also include `error`; an
unavailable final exit is `"unknown"`. Failed launches throw and release the name.

Both log paths exist immediately, even for empty logs. Read them with ordinary
foreground commands, e.g. `tail -n 50 -- '/path/to/stderr'`. Capture limits still
apply, and active captures are not expired by retention cleanup. Stdin remains
closed; launch the command itself, not `command &`.

Completion sends one model-visible Pi steering message with the final result,
delivered at the next steering boundary while running, or triggering a turn when
idle. Shutdown suppresses notifications and cleans up jobs.
Polling does not consume logs; killing an already finished job returns its result.
Names and status survive until runner teardown, not across Pi restarts. A PID is
informational; control always uses the name. Background jobs retain the default
120-second deadline unless overridden; cancelling a returned launch does not stop
its job. Without `background_id`, foreground behavior is unchanged.

In interactive Pi, a compact widget above the prompt lists each active job as
`<background_id> · <pid> · <command summary>`. Commands are single-line and
truncated to fit; completed jobs disappear, and the widget hides when empty.

### Command status and cancellation

A returned result does **not** imply command success. Check `exit_code`,
`signal`, `timed_out`, and `descendant_cleanup_attempted`. Nonzero exits and
timeouts return this metadata normally. Spawn/capture/cleanup errors and
cancellation throw tool errors, with available capture diagnostics.

Each shell owns a POSIX process group. Timeout, cancellation, and extension
shutdown trigger TERM then KILL cleanup; leftover group members are also
terminated after the main shell exits. Named background jobs are supported as below.
Collector cleanup is bounded, and deliberately detached descendants can escape
the group; failures do not imply rollback of command-side filesystem changes.

The cwd check is **not a sandbox**. Commands can access arbitrary host paths and
mutate files with the process's permissions. Relative cwd paths resolve from the
session cwd; absolute artifact paths may also be supplied in `cwd` or inside
the `command`. Concurrent hostile directory replacement cannot be fully
excluded by Node's path-based checks.

## apply_patch schema

The model-facing input follows the `patch` argument of
`~/workspace-mcp/src/contract.rs` (`ApplyPatchRequest` / `ApplyPatchArguments`):

```json
{
  "type": "object",
  "properties": {
    "patch": {
      "type": "string",
      "minLength": 1,
      "x-maxUtf8Bytes": 33554432,
      "description": "Complete exact-only Codex patch document with ordered hunks; maximum UTF-8 size is 33554432 bytes."
    }
  },
  "required": ["patch"],
  "additionalProperties": false
}
```

There is **no `session` argument**: that belongs to workspace-mcp authentication,
not local patch execution. There is no server dependency, shell patch command,
session credential, `oldText`/`newText` schema, or unified-diff fallback. Pi calls
the tool with `{ "patch": "*** Begin Patch\n...\n*** End Patch" }` rather than
Codex's provider-specific freeform transport. The patch text uses the same
Codex-style grammar as the local reference.

Example decoded patch:

```diff
*** Begin Patch
*** Add File: notes.txt
+hello
*** Update File: src/example.ts
@@ function example() {
-  return "old";
+  return "new";
 }
*** Update File: old-name.txt
*** Move to: new-name.txt
*** Delete File: obsolete.txt
*** End Patch
```

Existing files in this example must exist, and context/locator lines must match
their contents. Add-file lines start with `+`. Every update hunk starts with
`@@` or `@@ <exact locator line>`. Context lines start with one space, removed
lines with `-`, and inserted lines with `+`. Blank context lines still need
their space prefix. `*** End of File` anchors the preceding hunk to the file's
end. A hunk containing only insertions appends; use context to insert elsewhere.
Hunks are processed top to bottom. A move-only update needs no hunks.

Success returns a short A/M/D/R file summary and structured `details.files`
containing `path`, `previous_path`, `action`, before/after SHA-256 hashes, and
added/removed line counts, matching the reference's success metadata fields.

## Behavior and limits

The parser and matcher follow the exact-only implementation in
`~/workspace-mcp/src/patch.rs` at revision
`3a1343d12beba431ab3868d6399e742a8adeb824` (see `NOTICE`).

- Context and locators match logical lines **exactly**, including whitespace,
  punctuation and Unicode. No trimming, Unicode normalization, fuzzy matching,
  heredoc wrappers, missing-hunk-marker fallback, or numeric unified-diff hunks.
- Preserve existing LF/CRLF style, UTF-8 BOM content, trailing-newline state,
  and ordinary permission bits. Reject mixed LF/CRLF for textual updates.
  Move-only and delete operations can handle binary files; text updates require
  valid UTF-8. Added nonempty files use LF and end with a newline.
- Paths are relative to the **current Pi session's cwd**, not the extension's
  installation directory. Reject absolute paths, traversal, non-normalized
  paths, case-insensitive `.git` components, symlinks and nonregular targets.
  For portable path safety, this port additionally rejects backslashes and
  Windows drive-style prefixes, even on Linux.
- Limits are 32 MiB of UTF-8 patch input, 128 file operations, 4 MiB per file,
  and 32 MiB of retained before/after file bytes during planning. These match
  the reference defaults, not any later custom server configuration.

All operations are parsed and preflighted before file mutations. Targets are
rechecked before changes. Each regular-file replacement uses a sibling
temporary file and atomic rename; adds use a no-overwrite link operation.
Moves and multi-file changes are **not atomic**. On cancellation or failure,
the extension attempts reverse-order compensation and reports
`patch_effect: unchanged | rolled_back | partial`, committed operation count,
failed operation/path, and recovery errors in the thrown tool error. A reported
`partial` effect requires inspecting the workspace before retrying.

Patch calls from this extension are serialized per canonical cwd. This does not
lock other Pi processes, `bash_exec`, editors, or other extensions. Recovery compares
expected content and permissions and refuses to knowingly overwrite unrelated
concurrent edits. Ordinary permission bits are preserved; ownership, ACLs,
extended attributes, hard-link identity and crash-durable transactions are not
promised.

**This is a workflow change, not a security sandbox.** `bash_exec` remains capable
of file writes. Node's path-based checks also cannot fully prevent hostile
concurrent directory/symlink replacement; this port does not reproduce Rust's
capability-filesystem guarantees. It is intended for normal, trusted local
development workspaces.

## Tool lifecycle

All four original names are replaced with implementations that only throw a
redirecting error. They are removed from the active tool list on startup,
reload, tree navigation and before turns; a `tool_call` handler also blocks
them if another extension reactivates them. Other tools remain untouched.

The extension respects explicit Pi tool allowlists and does not continually
re-enable replacement tools disabled by a plan/read-only extension. Normal
default startup enables the two replacement tools. Intentional override
warnings for the four original names may appear. Other tools remain available
when selected. Avoid loading multiple extensions that override the same names.
Extension shutdown cancels its active commands and closes retention resources.

Hiding `read` also removes its image/PDF reading features. Use a separate
specialized tool when those are needed; this extension deliberately does not
keep a hidden read alias.

## Runtime prompt replacement

`src/prompt.ts` now provides `buildPoorSystemPrompt(options, activeNames, tools)`.
The `before_agent_start` hook returns its complete string. It never parses or
appends to `event.systemPrompt`, and the former target-replacement API and
`poor:tools` markers are no longer used.

The new base defines the coding workflow, available tools, shell arguments and
limits, output inspection/redirection, exit and cancellation checks, exact
patch grammar, verification expectations, and correct `bash_exec` skill loading.
Tool-specific instruction sections appear only when those tools are active.
The actual tool list after hiding originals wins over stale prompt options.
The replacement explicitly says not to recover discarded Pi defaults, custom base
text, or earlier extension prompt text; the supplied tool definitions remain
authoritative for names and arguments.
No-tools and restricted sessions do not get instructions to call an absent
shell or patch tool. Repeated prompt construction is deterministic.

This is an intentional **full base-prompt override**. Pi's built-in persona,
generated tool guidance, documentation section, a custom `SYSTEM.md` or
`--system-prompt` base, and earlier extensions' prompt-string modifications are
replaced. A custom base triggers a once-per-extension warning. Move requirements
that must survive this override into project context or explicit append text.

The builder preserves structured AGENTS.md/project bodies verbatim, the current
working directory, visible skill metadata, explicit `--append-system-prompt`
text, and instructions from other active tools' metadata. Project and append
instructions are not semantically rewritten; resolve their obsolete tool
references in their source files. Skill metadata is escaped and skill content
is read only through an available inspection tool.

Replacement runs once per agent run at `before_agent_start`. Tool definitions
remain the authority if another extension changes availability mid-run. Later
prompt-replacement hooks or provider interceptors can override the result;
this extension does not patch provider-specific payloads or claim last-writer
control. Avoid conflicting full-prompt extensions.

### Inspect the resulting prompt

From this checkout:

```bash
npm run audit:prompt
```

The audit loads the real Pi SDK/extension with disposable, synthetic project
and skill fixtures, captures the assembled base and the post-hook prompt,
and verifies normal, restricted, reactivated and custom-prompt cases. It
never reads your auth files or calls a model. JSON and readable Markdown
snapshots are written to `artifacts/bash-prompt-audit.{json,md}`.

To verify a different installed SDK, set `POOR_PI_SDK` to its absolute
`dist/index.js` path. For example, on this development machine:

```bash
PI_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")"
POOR_PI_SDK="$PI_ROOT/lib/node_modules/pi-monorepo/dist/index.js" npm run audit:prompt
```

After changing the extension, use `/reload` in an existing Pi session before
starting the next agent run. No global prompt or settings files are changed
by the extension implementation or audit.

## Develop and verify

```bash
cd /home/hilaolu/poor
npm ci --ignore-scripts
npm run check
npm run audit:prompt
npm pack
```

Tests use disposable directories and make no external model requests. An
offline provider stub drives a real three-request Pi agent loop, verifying
the provider-facing prompt, command results, and patch execution. Other tests
cover exact patch matching, binary moves, limits, compensation, cancellation,
concurrency, shell output truncation, redirection, process-group cleanup,
retention, schema validation, active-tool restrictions, and full prompt assembly.
Development dependencies are not bundled; Pi provides its host API and TypeBox.

Source layout: `src/index.ts` registers tools and lifecycle hooks;
`src/prompt.ts` constructs the complete runtime instruction profile;
`src/bash-exec.ts` validates and runs commands with bounded capture;
`src/command-artifacts.ts` manages private capture files and retention;
`src/patch.ts` implements grammar/matching; `src/apply-patch.ts` plans and
coordinates execution; `src/workspace.ts` handles local filesystem access.

## Reference documentation

- Pi's installed `docs/extensions.md` and `docs/packages.md` (0.85.1).
- Upstream: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs>.
- Local reference: `~/workspace-mcp/src/contract.rs`, `src/patch.rs`,
  `src/process.rs`, `src/workspace.rs`, and `src/patch/refinement_tests.rs`.
