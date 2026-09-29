# RepoTruth (CLI MVP, v0.1.0)

RepoTruth audits **one local repository** and reports where its CI, setup
instructions, license statements, imports, and self-descriptions contradict
what is actually in the repository. It is aimed at repos generated or
maintained by AI tools, where "green CI" and a polished README can hide
things that do not work.

**What it is today:** a deterministic, read-only command-line scanner. No API
key, no network, no model. It never runs the target's code, scripts,
workflows, or package installs.

**What it is not (yet):** there is no MCP server, GitHub App, fleet
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
audit core (`auditRepository`) has no CLI dependencies, so future adapters can
call it directly.

See [`examples/`](examples/) for the human and JSON output from auditing this
repository.
