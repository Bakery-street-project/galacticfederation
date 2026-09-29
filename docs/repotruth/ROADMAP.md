# RepoTruth: technical roadmap

Status key: **Built** = in `repotruth/` with tests. Everything else on this
page is **design only**.

**Built (v0.1.0):**
- a single-repo deterministic CLI with human and JSON output, fingerprints,
  exit codes and scan limits;
- a **local stdio MCP adapter** (`repotruth/src/mcp/`) with one tool,
  `audit_repository`;
- a **local fleet dashboard** (`repotruth/src/fleet/`) with persisted runs,
  change tracking, and a read-only GitHub App source adapter. The adapter is
  tested against a mocked GitHub API only and has not yet been connected to a
  live installation.

**Not built:** any hosted, network-reachable or paid API; webhooks or
scheduled scans; check-run posting; AI review; auto-fix.

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
