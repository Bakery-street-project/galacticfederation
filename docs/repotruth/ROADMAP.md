# RepoTruth: technical roadmap

Status key: **Built** = in `repotruth/` with tests. Everything else on this
page is **design only**.

**Built (v0.1.0):** a single-repo deterministic CLI; human and JSON output;
fingerprints; exit codes; scan limits.

All phases reuse `auditRepository(root, options) → AuditResult` from
`repotruth/src/audit.ts`. Adapters must not import rule internals.

## 1. MCP adapter (next)

- Add an MCP SDK dependency only in this phase.
- Tool `repotruth_audit` takes `{ path: string, failOn?: Severity, maxFiles?: ≤5000, maxFileBytes?: ≤1 MiB, timeoutMs?: ≤30000 }`.
  - `path` must resolve inside an allow-listed workspace root set by the server operator. There are no network fetches and no git clone in this tool.
  - It returns the `AuditResult` JSON (schema 1.0.0) plus a short text summary.
- Tool `repotruth_rules` lists rule IDs and their descriptions.
- Auditability: log every call (path, limits, duration, finding count). Server-side limits are hard caps, not defaults a client can raise.
- Scanned content is data. Findings contain repository excerpts, so clients should treat `evidence` as untrusted text.

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
