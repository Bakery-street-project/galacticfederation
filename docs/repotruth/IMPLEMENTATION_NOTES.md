# RepoTruth: implementation notes

## Preflight (2026-09-29, cloud workspace)

- Checkout: `Bakery-street-project/galacticfederation`, branch
  `claude/credits-cloud-environment-dx62xz`, clean working tree. The default
  branch is `main`.
- Tools present: git, node v22.22.2, npm 10.9.7, python3, ripgrep, jq.
  `gh` is not installed and isn't needed.
- Before this work the repository had no `package.json`, lockfile, or
  `tsconfig`. The root is not a Node project and is not claimed to be one.

## Verification of the product plan's claims

| Plan claim | Verified? | Evidence |
|---|---|---|
| C "quantum LLM runtime" doesn't run a model | Yes, by manual reading | `automation/qentropy_core.c`: `main` builds a zeroed demo model. "Logits" are `(tokens[i] ^ v) / n_vocab` (L220–223). Comments say "Simulate …". RepoTruth only reports the author's own markers and the "Better than llama.cpp" claim as `needs-review`, and does not claim to prove the code is non-functional. |
| TS file has an unresolved import | Yes | `automation/neuromorphic_engine.ts:4` imports `./batch_uploader`. No such file exists. |
| CI masked by `\|\| true` | Yes | `.github/workflows/ci.yml` lines 18, 20, 22, 24. The job also sets up Python in a repo with zero Python files. |
| README claims TS/npm setup with no package.json | Partly | README L31–38 run `npm install/start/test/build`, and the root has no `package.json`. "Developed in TypeScript" is *not* contradicted: one `.ts` file exists. |
| README/license contradiction | Yes | README L53 says MIT. `LICENSE` is a proprietary "all rights reserved" text. |
| Mostly automated commits | **No, overstated** | 11 of 38 commits match automation patterns (5 "RepoPilot AI Deployment", 6 "trigger CI" by `Kilo CI`). Automation can't be proven from git metadata. The plan was corrected. |

Also found, not in the plan: `.github/workflows/security-scan.yml` is empty
(0 bytes), and `CONTRIBUTING.md:9` links to a missing `CODE_OF_CONDUCT.md`.

## Toolchain decisions

- **Location:** a self-contained `repotruth/` package, so the legacy root is
  left as it is.
- **Runtime:** Node.js 22 LTS, which is available here and pinned in CI.
- **Dependencies:** `yaml` 2.9.1 (runtime, for structural YAML with source
  ranges), `typescript` 5.9.3 and `@types/node` 22.x (dev). They are pinned
  exactly, with `package-lock.json` committed and CI using `npm ci`.
- **Tests:** Node's built-in `node:test`, so no test-framework dependency.
  Fixtures are generated into temp directories at test time, which means the
  repository doesn't ship deliberately broken files that would pollute its
  own audit.
- **Not added:** no AI SDK, MCP SDK, GitHub token, database, or Docker.
- **npm `license` field:** set to `UNLICENSED` to stay consistent with the
  root proprietary `LICENSE`. The owner should confirm the intended license
  for RepoTruth before any distribution.

## Legacy files left untouched on purpose

`automation/*`, `.github/workflows/ci.yml`, the empty `security-scan.yml`,
the root README and LICENSE were not modified. Fixing them is an owner
decision, especially the license. The self-audit keeps reporting them.

## CI triage: GitHub Actions `startup_failure` (2026-09-29)

**Observed** via the GitHub API with the session's authenticated access:

- Run 36551100959 (push, `0ee2b6d`) and run 36551386324 (`pull_request`, same
  SHA, PR #4) both ended `completed / startup_failure`.
  - Jobs: 0. Check runs on the PR head: 0.
  - Logs endpoint: 404. Billable usage: `{}`.
  - **No runner started and no step ran**, so no test or build failed.
- Both runs belong to workflow id 236408486, whose `path` is `BuildFailed`
  and `state` is `deleted`, created 2026-02-20. It is not the ID of
  `repotruth.yml`, which has never been registered as a workflow. GitHub uses
  this pseudo-workflow when it cannot build the run for a push or event.
- That pseudo-workflow has 94 runs. Runs 87–92 (2026-05-07 to 05-12,
  `schedule` on `main`, commit `4f7f8c4`) are also `startup_failure`, months
  before `repotruth.yml` existed.
- GitHub-managed Dependabot runs (`dynamic`, workflow 236312744), which don't
  depend on any repository workflow file:
  - succeeded weekly from 2026-08-17 to 09-21;
  - then ended `startup_failure` on **2026-09-28 20:53 UTC** (run
    36482368191), the day before `repotruth.yml` was pushed.
- `actionlint` 1.7.7 (release tarball, SHA-256 verified against the release
  checksums; shellcheck integration off) reports **no errors** in
  `.github/workflows/repotruth.yml`. The only error in the directory is the
  pre-existing empty `security-scan.yml`.

**Inference:** the failure is not caused by `repotruth.yml`'s content. A
workflow that didn't touch it failed the same way the day before. The old
workflows being disabled doesn't explain it either, because the Dependabot
job is not one of them. No workflow change was made, since no evidence
points to one.

**Not observable with this access:**
- the repository and organization Actions settings;
- billing and spending limits;
- the "Annotations" panel text on the run page.

**Checklist for the owner:**

1. Open https://github.com/Bakery-street-project/galacticfederation/actions/runs/36551100959
   and read the annotation at the top of the page.
   - A message about **billing, a spending limit or a locked account** means
     **billing**.
   - "... is not allowed to be used" / "actions must be from ..." means
     **policy**.
   - "Invalid workflow file" naming a path means **workflow configuration**.
2. Organization **Settings → Billing and plans / Spending limits**: are the
   Actions minutes for private repos used up for the cycle, or is a payment
   failing? The Dependabot failure starting on 09-28 fits a billing or
   spending cut-off.
3. Repository **Settings → Actions → General**:
   - "Actions permissions" must allow `actions/checkout` and
     `actions/setup-node`;
   - Actions must not be disabled for the repo.

   Also check organization **Settings → Actions → General**, which can
   override the repository setting.
4. **Runner:** this workflow uses GitHub-hosted `ubuntu-latest`. A
   runner-side cause would show a queued job that never gets picked up, not
   a startup failure with zero jobs. The current evidence doesn't point this
   way.

## Proposed disposition of legacy workflows (not applied; owner decision)

| File | Today | Proposal |
|---|---|---|
| `.github/workflows/ci.yml` | Disabled in GitHub. Runs Python ruff/bandit/pytest with every step masked by `\|\| true` in a repo with no Python. It can never fail and checks nothing. | **Delete it**, since `repotruth.yml` covers the only real code. Alternatively, rewrite it to lint and compile `automation/` (e.g. `tsc --noEmit`, `cc -fsyntax-only`) with no masking. In that case expect `neuromorphic_engine.ts` to fail on its missing import until that's resolved. |
| `.github/workflows/security-scan.yml` | 0 bytes. Registered, `disabled_manually`. `actionlint`: "workflow is empty". | **Delete it**, or replace it with an intended scanner such as CodeQL default setup, which already appears as a dynamic workflow. An empty file runs nothing and shows as invalid. |

## MCP adapter (local, stdio)

Plan as implemented: the adapter calls `auditRepository()` from
`repotruth/src/audit.ts`, the same function the CLI calls. It doesn't shell
out to the CLI and doesn't duplicate any rule. The adapter code is in
`repotruth/src/mcp/`:
- `policy.ts`: allowed-root canonicalization and target resolution;
- `tool.ts`: zod input/output schemas, a transport-independent handler, and
  response bounding;
- `server.ts`: tool registration and a request queue;
- `bin.ts`: stdio entry point and configuration.

SDK choice (checked 2026-09-29):
- `@modelcontextprotocol/sdk` 1.31.0 is the v1 monolith. It pulls in
  express, hono, cors and other HTTP-transport packages this server doesn't
  need.
- `@modelcontextprotocol/server` 2.2.0 is the documented stable v2 line (MCP
  spec 2026-07-28). Its runtime dependencies are only
  `@modelcontextprotocol/core` and `zod`.

The v2 server is used, pinned exactly. `@modelcontextprotocol/client` 2.2.0
is a dev dependency for the stdio integration tests.

No AI-provider SDK, API key, network listener or model call was added.

## Fleet: webhooks and check runs

Implemented 2026-09-29. Two new opt-in modules and three small wiring changes;
no new dependency, no new listener, no new storage.

- `repotruth/src/fleet/webhooks.ts` — signature verification, replay
  protection, and event routing, with no HTTP code in it. `verifySignature()`
  always compares two 32-byte buffers with `timingSafeEqual`, substituting a
  zero-filled buffer for a malformed or absent header, so a missing header, a
  wrong `sha256=` prefix, a non-hex digest and a wrong digest are one
  indistinguishable failure. Nothing is parsed or enqueued before that compare
  passes.
- `repotruth/src/fleet/checks.ts` — finding → check-run mapping and the
  conclusion policy.
- `repotruth/src/fleet/web.ts` — `POST /webhooks` on the existing loopback
  listener, read as a raw `Buffer` (`readBodyBuffer`; `readBody` now delegates
  to it with the same 16 KB cap and error). It sits before the form-parse and
  token branch, because GitHub cannot hold the per-process dashboard token.
- `repotruth/src/fleet/service.ts` — a completed GitHub run posts its own
  check run when a reporter is configured. The reporter is called after the
  status is `completed` and its failure is caught: a check run is an outbound
  notification, never a precondition of a scan. A failure is appended to
  `run.source.notes`, so it survives in `fleet.json` and is visible through
  `/api/runs/:id`.
- `repotruth/src/fleet/sources/github.ts` — `createCheckRun()` posts through
  the existing `api()` helper, so token refresh, rate-limit backoff, the 5xx
  retry and the host allow-list all apply unchanged. `send()` gained a `json`
  option. A `NOT_ACCESSIBLE`/`API_ERROR` from this one endpoint appends a hint
  about the `checks: write` permission; the error codes and message formats
  used by existing tests are untouched.

Decisions worth recording:

- **Scope: the default branch only.** A fleet scan resolves the repository's
  default branch, so an annotation for a feature-branch push would describe a
  commit nobody audited. A push to another branch is acknowledged (`200`) and
  ignored rather than treated as an error — it is a valid delivery, just not an
  interesting one.
- **A delivery never adds a repository.** Auto-selecting on webhook would let
  any push into a watched org grow the fleet's storage.
- **Replay window is in memory and bounded** (2048 delivery IDs, FIFO). It
  covers redelivery and a GitHub retry, not a process restart; a restart costs
  at most one redundant scan, which the active-run check in `FleetService.scan`
  collapses anyway.
- **No SDK, no `child_process`, plain `fetch`.** The check-run POST is one
  request with a JSON body; adding the REST SDK for it would pull a dependency
  tree larger than the module that uses it.
- **Both features are off unless asked for.** `--webhook-secret-file` and
  `--check-runs` default to off, so a read-only App install keeps working and
  never needs `checks: write`.
- **Operational caveat.** The dashboard is loopback-only and enforces a `Host`
  allow-list of `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>`. A
  tunnel (ngrok, cloudflared, SSH) rewrites the `Host` header, and GitHub's
  delivery will be rejected with `421`. That is the correct default for a
  single-operator tool; anyone using a tunnel needs to know the allow-list is
  the thing in the way, and this note is the place to look.
- `repotruth/src/fleet/bin.ts` also names the offending path when
  `--allowed-root` does not exist. The bare "allowed root does not exist or is
  not accessible" left the user with nothing to act on, and the README shipped a
  literal `/ABSOLUTE/PATH/TO/REPOS` placeholder that was being copied verbatim.

Tests: `repotruth/test/webhooks.test.ts` (24) and `repotruth/test/checks.test.ts`
(13), on top of the existing suite — 137 total, all passing. The GitHub mock
(`test/githubmock.ts`) grew a `POST /repos/{owner}/{name}/check-runs` route
that records the payload and can be forced to 403 through the existing
`overrides` hook.
