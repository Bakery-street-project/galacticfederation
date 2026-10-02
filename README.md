# galacticfederation

Personal engineering repository. The active project here is **RepoTruth**, which lives in
[`repotruth/`](repotruth/). Everything else in this repo is either design documentation or
early experiments.

## RepoTruth — CI that reads the repository, not just the diff

RepoTruth audits **one local repository** and reports where its CI, setup instructions,
license statements, imports, and self-descriptions contradict what is actually in the
repository. It is aimed at repos generated or maintained by AI tools, where green CI and a
polished README can hide things that do not work.

It exposes one audit core three ways:

- a read-only **CLI** (`repotruth audit <repo>`),
- a local stdio **MCP server** with a single `audit_repository` tool,
- a **fleet** dashboard for scanning many repositories.

Its webhook receiver verifies what it accepts: a signed push is audited, a replayed
delivery gets an idempotent 200, an unsigned push gets a 400 and queues nothing, and a
tampered body with an otherwise-valid signature is rejected. It reports `truncated: false`
and its own input limits instead of silently truncating an audit above them.

### Quick start (verified from a clean checkout)

Requires Node.js 22.

```bash
cd repotruth
npm ci
npm run build
node dist/src/bin.js audit ..                  # human-readable
node dist/src/bin.js audit .. --format json    # versioned JSON (schemaVersion 1.0.0)
```

- 147 tests across 32 suites, deterministic, no network access, no model calls
- The audit never runs the target's code, scripts, workflows, or package installs
- [`repotruth/README.md`](repotruth/README.md) — full documentation, including what this is
  deliberately **not** (no hosted API, no GitHub App, no auto-fix yet)
- [`docs/repotruth/ROADMAP.md`](docs/repotruth/ROADMAP.md) — implementation notes and roadmap

## What else is here

- [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) — the original product plan.
- [`automation/`](automation/) — early neuromorphic/physics experiments, unmaintained,
  kept for reference.

## License

AGPL-3.0-only — see the root [`LICENSE`](LICENSE). A company that wants to use RepoTruth
internally must open-source its own modifications.
