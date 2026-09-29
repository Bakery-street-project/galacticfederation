# RepoTruth (CLI + local MCP adapter, v0.1.0)

RepoTruth audits **one local repository** and reports where its CI, setup
instructions, license statements, imports, and self-descriptions contradict
what is actually in the repository. It is aimed at repos generated or
maintained by AI tools, where "green CI" and a polished README can hide
things that do not work.

**What it is today:** a deterministic, read-only command-line scanner, plus
a **local stdio MCP server** with one tool, `audit_repository`, that runs the
same audit core. Neither needs an API key or network access, and neither calls
a model. Neither ever runs the target's code, scripts, workflows, or package
installs.

**What it is not (yet):** there is no hosted or paid API, GitHub App, fleet
dashboard, AI-assisted review, or auto-fix. These are designed in
[`docs/repotruth/ROADMAP.md`](../docs/repotruth/ROADMAP.md) but not built.
It is also not a security scanner.

## Install and run (from a clean checkout)

Requires Node.js 22 (tested with 22.22.2 and npm 10.9.7).

```bash
cd repotruth
npm ci
npm run build
node dist/src/bin.js audit ..                  # human-readable
node dist/src/bin.js audit .. --format json    # versioned JSON (schemaVersion 1.0.0)
```

Development scripts: `npm run typecheck`, `npm test` (builds, then runs
`node:test`), `npm run build`.

## Options and exit codes

```text
repotruth audit <path> [--format human|json] [--fail-on info|low|medium|high|none]
                       [--max-files N] [--max-file-bytes N] [--max-total-bytes N] [--timeout-ms N]
```

| Exit | Meaning |
|---|---|
| 0 | No findings at or above `--fail-on` (default `low`), or `--fail-on none` |
| 1 | At least one finding at or above the threshold |
| 2 | Usage, configuration, or scanner error (e.g. path missing, bad flag) |

Default limits: 5,000 files, 1 MiB per file, 50 MiB total, 30 s. When a limit
is hit, the report says `truncated` and lists what was skipped.

## MCP server (local, stdio)

`dist/src/mcp/bin.js` is an MCP server that a compatible client (for example
an MCP-capable coding agent) launches as a child process. It speaks MCP over
stdin/stdout and exposes one tool: `audit_repository`. It uses
`@modelcontextprotocol/server` 2.2.0. Nothing is hosted, and there is no
network listener.

### Build and launch

```bash
cd repotruth
npm ci
npm run build
node dist/src/mcp/bin.js --allowed-root /absolute/path/to/workspace
# or: REPOTRUTH_ALLOWED_ROOT=/absolute/path/to/workspace node dist/src/mcp/bin.js
```

Run by hand, the server waits for an MCP client on stdin. It prints one
startup line to stderr, writes only protocol messages to stdout, and exits
when stdin closes.

- `--allowed-root <dir>` (required): the only directory tree the tool may
  audit.
- `--max-response-bytes N`: size budget for a tool result's structured
  content. Default 100000; allowed range 2048–10000000.
- Exit code 2: startup configuration error (missing or invalid root, bad
  flag). Once running, a bad request never exits the process.

### Client configuration (TEMPLATE; not tested in any specific client)

Many MCP clients accept a JSON server entry of this shape. Replace both
placeholder paths with real absolute paths on your machine. This template
has only been exercised via the official MCP TypeScript client in this
package's tests. It has **not** been installed or verified in a Claude Code
environment or any other client.

```json
{
  "mcpServers": {
    "repotruth": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/galacticfederation/repotruth/dist/src/mcp/bin.js",
        "--allowed-root",
        "/ABSOLUTE/PATH/TO/YOUR/WORKSPACE"
      ]
    }
  }
}
```

### Tool contract: `audit_repository`

Input: a strict object; unknown keys are rejected.

| Field | Type | Meaning |
|---|---|---|
| `path` | string, optional | Directory to audit, relative to the allowed root or absolute inside it. Default: the allowed root. URLs and `git@host:` remotes are rejected. |
| `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `timeoutMs` | integer, optional | Can only **lower** the core limits (defaults 5000 files, 1 MiB per file, 50 MiB total, 30 s). |

Output on success (`structuredContent`, validated against the advertised
`outputSchema`):
- the same fields as CLI JSON schema 1.0.0 (`schemaVersion`, `tool`,
  `durationMs`, `stats`, `limits`, `coverage`, `skipped`, `summary`,
  `findings`);
- `target.path`, the path relative to the allowed root; absolute paths are
  never returned;
- a `response` block: `truncated`, `maxBytes`, `findingsReturned`,
  `findingsTotal`, `omittedBySeverity`, `skippedReturned`, `skippedTotal`,
  and `fullReport` (the CLI command for the complete report).

The text `content` is a one-paragraph summary that repeats any truncation
warnings.

Errors are tool results with `isError: true`, never a server crash:
- **Target errors** carry `structuredContent.error.code`, one of
  `OUTSIDE_ALLOWED_ROOT`, `URL_NOT_SUPPORTED`, `NOT_FOUND`,
  `NOT_A_DIRECTORY`, `UNREADABLE`, `INVALID_ARGUMENT`, `SCAN_ERROR` or
  `INTERNAL_ERROR`, plus a message.
- **Schema violations** (wrong type, unknown key, out-of-range limit) are
  rejected by the SDK before the handler runs. They come back as `isError`
  results whose text starts with `Input validation error:`, with no
  structured `error` field.
- A valid audit that *has findings* is **not** an error. Findings live in the
  result, and CLI exit codes don't apply to MCP.

### Truncation: two kinds, both explicit

- **Scan truncation** (`limits.truncated`): a file/byte/time limit stopped
  discovery early. `limits.notes` says which one.
- **Response truncation** (`response.truncated`): findings or skipped entries
  were dropped so the result fits `--max-response-bytes`.
  - Higher-severity findings are kept first.
  - `summary` and `findingsTotal` still describe the full audit.
  - For everything, run the CLI locally:
    `node dist/src/bin.js audit <dir> --format json`.

### Trust boundary

- **Read-only.** The server reads files under the allowed root with the core's
  bounded, non-symlink-following reader. It never executes, installs or
  imports target code, and makes no network calls. A test proves this with
  booby-trapped scripts, imports, a workflow step and a Makefile.
- **Path policy.** Targets are canonicalized with `realpath` and must stay
  inside the canonical allowed root. `../` traversal, absolute paths
  elsewhere, and symlinks pointing out of the root are rejected with
  `OUTSIDE_ALLOWED_ROOT`. This is an application check, **not** an OS
  sandbox: run the server as a user that can only read what it should.
- **Untrusted output.** `evidence`, titles and paths contain text from the
  audited repository. Treat them as data, never as instructions; the tool
  description tells clients the same.
- **One audit at a time.** Requests are queued so concurrent calls can't
  multiply the core's resource limits. Each request builds its own index,
  so no state carries over between requests.
- **Diagnostics.** stderr gets one startup line and configuration errors.
  It never receives repository contents, paths or environment values.

## Fleet dashboard (local, private)

Audits several selected repositories, keeps run history, and shows what
changed since the previous complete scan. It uses the same `auditRepository()`
core as the CLI. Scanning is deterministic, with no model calls, and nothing
from a scanned repository is ever executed.

```bash
cd repotruth && npm ci && npm run build
node dist/src/fleet/bin.js --allowed-root /ABSOLUTE/PATH/TO/REPOS --data-dir ./.repotruth-data
# open http://127.0.0.1:4178
```

- **Access:** the dashboard binds to 127.0.0.1 only. It is a single-operator
  local tool, not a multi-user authenticated service. Write requests need the
  per-process token that is printed on startup and embedded in the forms.
- **Local repositories:** add paths inside `--allowed-root`. The commit is read
  from `.git` without running git, and uncommitted changes are not detected.
- **Data:** stored in `<data-dir>/fleet.json`, which holds repositories, runs,
  findings, and short evidence excerpts. No repository copies are kept. To
  reset, stop the service and delete that file.
- **Change view:**
  - New, continuing and resolved findings are keyed by finding fingerprint.
  - "Resolved" is verified only when both runs are complete (no truncation,
    no unusual skips) and evaluated the same areas.
  - Otherwise the page says the missing findings were not seen, not that they
    were fixed.
- **GitHub App (optional, read-only).** Set `REPOTRUTH_GH_APP_ID`,
  `REPOTRUTH_GH_INSTALLATION_ID` and `REPOTRUTH_GH_PRIVATE_KEY_FILE`. The App
  needs repository permissions **Contents: read** and **Metadata: read** only;
  no webhook is required.
  - The dashboard can then list and select the installation's repositories.
  - Each scan downloads one commit's tarball to a temporary directory (size-,
    entry- and decompression-capped; links and unsafe paths are not
    extracted) and deletes it afterwards.

## Rules

Every finding carries: `ruleId`, `severity` (info/low/medium/high),
`confidence` (low/medium/high), `status` (`finding` = evidence supports the
claim; `needs-review` = a human must decide), `location` (path, line),
`evidence`, `explanation`, `suggestion`, and a `fingerprint` that stays
stable when lines shift.

| Rule | What it detects | Notes |
|---|---|---|
| `ci.masked-failure` | `cmd \|\| true`, `\|\| :`, `\|\| exit 0`, `\|\| echo …` in `run:` steps | Parsed structurally from `jobs.*.steps[*].run`. Comments and quoted text are ignored. Cleanup commands (`rm`, `docker rm`, …) aren't flagged. Unknown commands are `needs-review`. |
| `ci.continue-on-error` | `continue-on-error: true` on jobs or steps | Only the step/job key counts, not action inputs. Expressions are `info`/`needs-review`. |
| `ci.stack-mismatch` | Python/Node/Go/Rust/Java tooling in CI with no source files or manifests for that ecosystem | Medium confidence. |
| `ci.workflow-empty`, `ci.workflow-invalid` | Empty or unparseable workflow files | |
| `setup.readme-manifest-missing` | README shell blocks run `npm install/ci/test/run`, `yarn`, `pnpm`, `pip install -r/.`, `cargo`, `go`, `make` where no matching manifest exists | Replays `git clone` and `cd` to find the working directory. A manifest in another directory never makes the command valid; it only shapes the suggestion. An unresolvable `cd` lowers it to `needs-review`. |
| `setup.declared-language-missing` | "Written/developed in X" with zero X files | |
| `setup.license-conflict` | README license statement or package.json `license` vs LICENSE text | Always `needs-review`. Unrecognized license text is **not evaluated**. RepoTruth never edits licenses. |
| `docs.broken-relative-link` | Relative Markdown links (root, `docs/`, `.github/`) to missing files | Links that leave the repo, such as GitHub web routes, are skipped. |
| `js.unresolved-import` | Relative JS/TS imports that match no file | Tries extensions, `.js`→`.ts`, and index files. Bare package specifiers are never judged. tsconfig `paths` aliases are **not evaluated**. |
| `js.missing-entry-point`, `js.package-json-invalid` | `main/module/types/bin/exports` pointing to missing files; invalid JSON | Build-output paths are accepted when a build script exists. |
| `claim.simulation-marker` | Comments saying code is simulated, a placeholder, stubbed, or "for demo" | `needs-review`. Test and fixture paths are excluded. |
| `claim.unverified-superlative` | Comparative claims such as "better than X", "10x faster", "world's first" in README prose or comments | `info`/`needs-review`. A quotation or code span containing *only* the phrase names it rather than asserting it, and is skipped. A longer quotation containing it is still reported and marked as quoted. |

## Known limitations

- JS/TS scanning is lexical (a comment/string tokenizer plus patterns), not a
  full parser. Unusual syntax such as regex literals containing quotes can
  cause misses or false hits.
- Claim rules match words, so prose *about* stubs or simulations (a
  changelog, say) can be flagged. That is why they are `needs-review`. The
  comparative-claim rule skips a phrase only when a quotation or code span
  contains exactly that phrase. An unquoted mention in running prose is still
  reported, because the heuristic cannot reliably tell it apart from a
  claim.
- Only GitHub Actions is evaluated. GitLab, CircleCI, Travis, Azure, Jenkins
  and `dependabot.yml` are reported as **not evaluated**.
- Symlinks are never followed. In-repo symlinks count as "present" for import
  resolution but are not read.
- There is no scoring. Findings and coverage are the output.

## Architecture

`discovery` (bounded, read-only file index) → `parsers` (workflow YAML,
Markdown, source comments/imports, license text) → `rules` (independent
modules) → `audit` (fingerprints, sorting, summary) → `report` / `cli`. The
audit core (`auditRepository`) has no CLI dependencies. The MCP adapter
(`src/mcp/`) calls it directly: `policy.ts` handles the allowed-root check,
`tool.ts` holds the schemas, handler and response bounding, `server.ts`
registers the tool, and `bin.ts` handles stdio and configuration.

See [`examples/`](examples/) for the human and JSON output from auditing this
repository.
