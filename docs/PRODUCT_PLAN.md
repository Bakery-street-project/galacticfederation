# galacticfederation → Product Plan

This plan reverse-engineers what this repo actually is, maps it against the
AI-agent monetization research (agent marketplaces, MCP/paid APIs, vertical
automation, Polar-gated repos, Bittensor, consulting), and picks the one
project that is most realistic to build and sell.

## 1. What is in the repo today

| File | What it claims | What it does |
|---|---|---|
| `automation/qentropy_core.c` | "Quantum LLM runtime, better than llama.cpp" | Runs no model. It reads a fake header, the "quantum" functions are cos/sin loops over bytes, and the logits are `token XOR index`. It is a demo that prints numbers. |
| `automation/neuromorphic_engine.ts` | "Automation that learns and evolves" | Imports `./batch_uploader`, which doesn't exist, so it can't run. If it did run, it would push a workflow to 5 repos, and that workflow only `echo`es text. |
| `.github/workflows/ci.yml` | Lint, security scan, tests | Every step ends in `\|\| true`, so CI always passes. It also runs Python tools against a C/TS repo. |
| `README.md` | TypeScript project, `npm install` | There is no `package.json`. The text is generated boilerplate, and it says MIT while `LICENSE` is proprietary. |
| Git history | 38 commits | They are mostly automated "RepoPilot AI Deployment" and "trigger CI" commits. |

**Conclusion:** the only real asset here isn't the C or TS code. It's the
**pattern of fleet automation**: one tool (RepoPilot, githubupdater-tools,
Linty-McLintface, gitcrate) stamps README, SECURITY, CONTRIBUTING, FUNDING,
CI and Dependabot files across 60+ repos in the `Bakery-street-project` org.

That pattern has a real, growing problem attached to it, and this repo shows
it: **AI-generated repos that look healthy but aren't.** They have green CI
that tests nothing, imports that don't exist, contradictory licenses,
READMEs describing a different stack, and code whose claims are pure
marketing.

## 2. The pick: "RepoTruth", an honesty and hygiene auditor for AI-generated repos

A GitHub App, CLI and MCP server that scans a repo or a whole org and
reports what is real:

- **Fake-green CI**: `|| true`, `continue-on-error`, test steps that match no files, or tools for a language the repo doesn't use.
- **Dead code paths**: imports or modules that don't resolve, entry points that can't run, and a README install command with no manifest.
- **Claim vs. code mismatch**: an LLM compares what the README says (stack, features, license) with what the code does and flags contradictions like MIT vs. proprietary, "TypeScript" with no `package.json`, or "inference engine" with no inference.
- **Fleet view**: one dashboard for N repos, with a score per repo, drift from a baseline, and duplicated boilerplate.
- **Auto-fix PRs**: it opens PRs that remove `|| true`, add a real CI matrix for the detected language, and align LICENSE and README. It never pushes to the default branch.

### Why this one wins on the research criteria

| Research model | Fit | Why |
|---|---|---|
| Vertical automation (SWE-agent style) | ✅ core | It's a narrow, high-value dev task with measurable output: issues found and PRs merged. |
| MCP / paid API | ✅ | `repotruth.audit(repo)` exposed as an MCP tool, so agents (Claude Code, Cursor) call it before shipping. |
| Polar-gated open core | ✅ | Free OSS CLI with the basic rules. Paid private repo for the LLM claim checker, fleet dashboard and auto-fix. |
| Agent marketplaces | ✅ | You can list it on GitHub Marketplace plus MCP registries. |
| Consulting / fractional CAIO | ✅ upsell | Fixed-price "AI codebase due-diligence audit" for agencies and acquirers. |
| Bittensor / Ocean mining | ❌ | Needs capital and GPUs, rewards swing with the token price, and it doesn't use your assets. |
| LoRA avatar storefront | ⚠️ | It's cheap to build, but it's a consumer TikTok-distribution game and doesn't use your repos or skills. |
| Bug bounty / PentestGPT | ⚠️ | It pays per finding, but it's a skill grind rather than a product, and there are legal risks if you go out of scope. |

### Who pays

1. **Indie devs and vibe-coders** with dozens of AI-generated repos: $9–19/mo.
2. **Agencies** that deliver AI-built code to clients and need proof it's real: $49–149/mo per org.
3. **Buyers and investors** checking a codebase before acquiring it: a one-off report at $199–999. This is the highest margin.

### Why it's realistic for you specifically

- You already own the fleet tooling (RepoPilot and others) and 60+ repos that make a ready test corpus. This repo is test case #1.
- The first 80% is deterministic rules (grep and parse workflows, manifests and imports) and needs no GPU. The LLM layer is one call per repo.
- It's cheap to run: GitHub Actions free tier, a serverless API, Polar for billing.

## 3. Build plan (MVP in about 4 weeks)

**Week 1: CLI with deterministic rules** (TypeScript, `npx repotruth .`)
- Rules: `ci-swallowed-failure`, `ci-wrong-language`, `readme-manifest-mismatch`, `license-conflict`, `unresolved-import`, `placeholder-readme`.
- Output: a terminal table plus JSON and SARIF, so results show in GitHub code scanning.
- First test target: run it on this repo, where it must flag every row in section 1.

**Week 2: Fleet mode and GitHub Action**
- `repotruth org <name>` scans every repo via the API and writes an HTML scorecard.
- Publish a GitHub Action to the Marketplace (free, which gives you distribution).

**Week 3: LLM claim checker and auto-fix PRs (paid tier)**
- Send the README claims plus a file tree and key sources to Claude, get structured contradictions back.
- Fix templates for CI, license and README open PRs on a branch.

**Week 4: MCP server, Polar and launch**
- A `fastapi_mcp` or TS MCP server exposing `audit_repo` and `audit_org`.
- Polar: the paid tier grants access to the private repo and an API key.
- Launch: write up "I audited my own 60 AI-generated repos, here's what was fake" (Show HN, Reddit r/ChatGPTCoding, X). Your own fleet is the story.

## 4. Success metrics and kill criteria

- 30 days: 100 CLI installs, 10 Action installs, 3 paying users.
- 90 days: $500 MRR or 2 paid due-diligence audits.
- **Kill or pivot if** fewer than 3 paying users by day 60. At that point fall back to the consulting offer ("AI codebase audit"), using the tool internally.

## 5. Clean up this repo first

Before selling honesty tooling, the showcase repos have to be honest:
1. Remove `|| true` from CI and run the tools that match the language.
2. Pick one license and make the README agree with it.
3. Either delete `qentropy_core.c` and `neuromorphic_engine.ts` or relabel them as demos/prototypes. Remove "better than llama.cpp" and "quantum" claims the code doesn't back up.
