# RepoTruth: technical roadmap

Status key: **Built** = in `repotruth/` with tests. Everything else on this
page is **design only**.

**Built (v0.1.0):**
- a single-repo deterministic CLI with human and JSON output, fingerprints,
  exit codes and scan limits;
- a **local stdio MCP adapter** (`repotruth/src/mcp/`) with one tool,
  `audit_repository`;
- a **local fleet dashboard** (`repotruth/src/fleet/`) with persisted runs,
  change tracking, and a GitHub App source adapter. The adapter is
  tested against a mocked GitHub API only and has not yet been connected to a
  live installation;
- opt-in **webhook ingestion** (HMAC-verified, replay-protected, default branch
  only, served by the existing loopback listener) and **check-run posting**
  (advisory by default, at most 50 annotations, never sends finding evidence).

**Not built:** any hosted, network-reachable or paid API; scheduled scans;
AI review; auto-fix. Webhook ingestion and check-run posting are built, but they
are opt-in, loopback-only, and not a substitute for §1b: nothing here is
reachable from the network unless the operator puts a tunnel in front of it
themselves.

All phases reuse `auditRepository(root, options) → AuditResult` from
`repotruth/src/audit.ts`. Adapters must not import rule internals.

## 1. MCP adapter

### 1a. Local stdio adapter: BUILT

- `@modelcontextprotocol/server` 2.2.0 (v2 stable line), with zod 4 schemas.
  The client package is a dev dependency, used only by tests.
- One tool, `audit_repository`, with input `{ path?, maxFiles?, maxFileBytes?, maxTotalBytes?, timeoutMs? }`.
  - Limits can only be lowered.
  - `path` must canonicalize inside the operator's `--allowed-root`.
  - URLs are rejected.
- Output: CLI JSON schema 1.0.0 plus `target.path` and a `response` block
  that reports size-budget truncation explicitly. Errors are `isError`
  results with a code.
- Tested through the official MCP client over stdio (see
  `repotruth/test/mcp.test.ts`).

**Differences from the original design, kept deliberately:**
- There is no `failOn` input: it only affects CLI exit codes, which don't
  apply to MCP.
- There is no `repotruth_rules` tool: one tool keeps the surface minimal.
- There is no per-call audit log. stderr carries only startup and
  configuration diagnostics, so that paths and repository data aren't
  logged. If an operator needs an audit log, add an opt-in, redacted log file
  in a later phase.

### 1b. Hosted / paid API: NOT BUILT

A network-reachable or billed API would need authentication, tenancy
isolation, rate limiting, request/response size limits, fetching of remote
repositories into disposable sandboxes, and an abuse policy. None of these
exist. The local stdio server must not be exposed over a network as a
substitute.

## 2. GitHub App (read-only first)

- Permissions: `contents: read`, `metadata: read`, and `checks: write` only when posting a check run. Nothing else in v1, specifically no `contents: write` or `pull_requests: write`.
- Verify the webhook HMAC (`X-Hub-Signature-256`) with a constant-time compare, and reject unsigned or replayed deliveries by tracking delivery IDs.
- Use short-lived installation tokens scoped to the triggering repository. Fetch a tarball into an isolated temp dir with the same size limits, audit it, then delete it.
- Rate limits: respect `X-RateLimit-Remaining`/`Retry-After`, use a queue with backoff, and never retry forever.
- Output: a check run summary with annotations that map `location` → file/line. It does not block merges by default.

### 2a. Webhook receiver: BUILT (`repotruth/src/fleet/webhooks.ts`)

- Transport-independent: the caller passes the exact request bytes plus the
  three delivery headers, so the verification is testable without a socket.
- Constant-time compare of `sha256=<64 hex>` against
  `HMAC-SHA256(secret, body)`; a missing header, a wrong algorithm prefix, a
  malformed digest and a wrong digest all produce the same `400`.
- Bounded FIFO of `X-GitHub-Delivery` IDs: a replay is an idempotent `200` and
  starts no second scan. Only retryable (5xx) failures release the ID.
- Handles `push` only, and only for a repository already selected in the fleet.
  A delivery never adds a repository. Because a fleet scan audits the default
  branch, a push to any other branch — and any branch deletion — is
  acknowledged and ignored.
- Served at `POST /webhooks` on the **existing** loopback listener
  (`repotruth/src/fleet/web.ts`); the token-protected form endpoints are
  untouched. Enabled by `--webhook-secret-file`.

### 2b. Check runs: BUILT (`repotruth/src/fleet/checks.ts`)

- Enabled by `--check-runs advisory|gating`; off by default, so
  `checks: write` is never required silently. `advisory` reports `neutral` and
  cannot fail a build; `gating` fails on a high-severity finding and stays
  `neutral` on an incomplete scan, because an unevaluated repository proves
  neither clean nor dirty.
- Up to 50 annotations (GitHub's cap) mapping `location` → file/line, highest
  severity first and otherwise stable, so repeated runs agree. The count of
  unannotated findings is stated in the summary, and the counts above it are
  always complete.
- Repository-derived text never reaches GitHub beyond a path: finding evidence
  is excluded, and markdown-significant characters are stripped from titles and
  messages.
- A run is only reported on the commit it actually audited. A posting failure
  never fails the scan; it is appended to the run's source notes and persists in
  `fleet.json`.

## 3. Fleet view

- Input: an explicit list of repositories or an installation's repos, paginated (≤100 per page).
- Bounded concurrency (e.g. 4 at a time), per-repo timeouts, and a failure in one repo doesn't abort the run.
- Storage: one row per (repo, commit, fingerprint). **Drift** means new fingerprints since the baseline commit, and resolved means fingerprints that disappeared. Baselines are chosen explicitly.
- The dashboard shows findings and coverage first. Any aggregate number has a published formula.

## 4. AI-assisted claim review (opt-in)

- Off by default. It needs an explicit flag, a configured provider, and a cost estimate the user confirms per run.
- Provider abstraction: `review(evidencePack) → ClaimAssessment[]`, with no SDK types in the core.
- Minimized evidence: README claim sentences plus the specific files and line ranges the deterministic rules point to, capped (e.g. ≤20 KB). Secrets are redacted with pattern and entropy filters. Whole repositories are never uploaded.
- Prompt-injection posture: repository text is quoted as data, the model's output must match a JSON schema, and any tool use is disabled.
- Every AI assessment cites file/line evidence and is emitted as `needs-review`. Assessments never raise a finding to `finding` status on their own.
- Private code only goes to a provider after explicit per-repo authorization, recorded in config.

## 5. Auto-fix PRs (separate, opt-in capability)

- Only narrow fixes that can be tested:
  - remove `|| true` from quality commands;
  - delete an empty workflow;
  - fix a relative link when exactly one plausible target exists.
- Each fix: apply it on a new branch, re-run the audit to confirm the fingerprint is gone and nothing new appeared, show the diff, and open a PR only when authorized.
- Never push to the default branch and never force-push.
- **Never** change LICENSE files or license statements. License conflicts stay human decisions.
- Don't "fix" by suppressing: there are no inline ignore comments without a stated reason, and suppressions are listed in the report.
