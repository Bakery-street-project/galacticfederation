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
