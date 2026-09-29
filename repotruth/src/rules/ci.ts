// GitHub Actions checks: masked failures, continue-on-error, invalid/empty
// workflow files, and toolchain steps for ecosystems absent from the repo.

import { isWorkflowPath, parseWorkflow, type WorkflowStep } from '../parsers/workflow.js';
import { truncate } from '../text.js';
import { ecosystemEvidence, type Ecosystem } from './stack.js';
import type { RuleContext, RuleModule } from './types.js';

type CommandClass = 'quality' | 'install' | 'cleanup' | 'other';

const QUALITY_TOOLS = new Set([
  'pytest', 'py.test', 'ruff', 'bandit', 'flake8', 'pylint', 'mypy', 'pyright', 'black', 'isort', 'tox', 'nox',
  'eslint', 'tsc', 'jest', 'vitest', 'mocha', 'ava', 'prettier', 'biome', 'playwright',
  'semgrep', 'trivy', 'safety', 'pip-audit', 'shellcheck', 'hadolint', 'golangci-lint', 'gosec', 'snyk',
  'phpunit', 'rspec', 'rubocop', 'ctest',
]);
const QUALITY_SUBCOMMANDS: Record<string, RegExp> = {
  go: /^(test|vet)\b/,
  cargo: /^(test|clippy|fmt|audit|check)\b/,
  npm: /^(test|t|audit|run\s+\S*(test|lint|check|type|audit)\S*)\b/,
  yarn: /^(test|lint|audit|run\s+\S*(test|lint|check|type)\S*|\S*(test|lint|check|type)\S*)\b/,
  pnpm: /^(test|lint|audit|run\s+\S*(test|lint|check|type)\S*)\b/,
  make: /^(test|check|lint|verify)\b/,
  dotnet: /^test\b/,
  mvn: /^(test|verify)\b/,
  gradle: /^(test|check)\b/,
  './gradlew': /^(test|check)\b/,
  python: /^-m\s+(pytest|unittest|mypy|ruff|flake8|pylint|bandit|black)\b/,
  python3: /^-m\s+(pytest|unittest|mypy|ruff|flake8|pylint|bandit|black)\b/,
};
const INSTALL: Record<string, RegExp> = {
  pip: /^install\b/, pip3: /^install\b/, npm: /^(install|i|ci)\b/, yarn: /^(install)?\s*$/, pnpm: /^(install|i)\b/,
  'apt-get': /^install\b/, apt: /^install\b/, brew: /^install\b/, gem: /^install\b/, cargo: /^install\b/, go: /^(install|get)\b/,
  python: /^-m\s+pip\s+install\b/, python3: /^-m\s+pip\s+install\b/,
};
const CLEANUP = new Set(['rm', 'rmdir', 'mkdir', 'kill', 'pkill', 'killall', 'unlink', 'umount', 'which', 'command', 'type', 'pgrep']);

/** First word of a command, skipping env assignments and wrappers. */
export function commandHead(cmd: string): { head: string; rest: string } {
  const words = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === 'sudo' || w === 'time' || w === 'env') i++;
    else if (w === 'timeout') i += 2;
    else break;
  }
  return { head: words[i] ?? '', rest: words.slice(i + 1).join(' ') };
}

export function classifyCommand(cmd: string): CommandClass {
  const { head, rest } = commandHead(cmd);
  if (head === 'npx' || head === 'uvx' || head === 'pipx') return classifyCommand(rest.replace(/^(-y|--yes)\s+/, ''));
  if (QUALITY_TOOLS.has(head)) return 'quality';
  if (QUALITY_SUBCOMMANDS[head]?.test(rest)) return 'quality';
  if (INSTALL[head]?.test(rest)) return 'install';
  if (CLEANUP.has(head) || (head === 'docker' && /^(rm|rmi|stop|kill)\b/.test(rest))) return 'cleanup';
  return 'other';
}

/** Detects `cmd || true` style failure masking on one logical shell line. */
export function findMasking(line: string): { masked: string; how: string } | null {
  // Match against a copy with quoted text blanked, so `echo "a || true"` is not a mask.
  const bare = blankQuoted(line);
  const m = /\|\|\s*(true\b|:(?=\s|;|$)|exit\s+0\b|echo\b[^;&|]*)/.exec(bare);
  if (!m) return null;
  const before = line.slice(0, m.index);
  const masked = (before.split(/;|\bthen\b|\bdo\b/).pop() ?? '').trim();
  if (!masked) return null;
  return { masked, how: `|| ${(m[1] ?? '').trim()}` };
}

function blankQuoted(line: string): string {
  let quote: string | null = null;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') { out += '__'; i++; continue; }
      if (c === quote) { quote = null; out += c; } else out += '_';
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

const TOOLCHAIN_ACTIONS: [RegExp, Ecosystem][] = [
  [/^actions\/setup-python@/, 'python'],
  [/^actions\/setup-node@/, 'node'],
  [/^actions\/setup-go@/, 'go'],
  [/^(dtolnay\/rust-toolchain|actions-rs\/toolchain)@/, 'rust'],
  [/^actions\/setup-java@/, 'java'],
];
const TOOLCHAIN_HEADS: Record<string, Ecosystem> = {
  pip: 'python', pip3: 'python', pytest: 'python', ruff: 'python', bandit: 'python', flake8: 'python',
  pylint: 'python', mypy: 'python', tox: 'python', poetry: 'python',
  npm: 'node', yarn: 'node', pnpm: 'node',
  cargo: 'rust', mvn: 'java', gradle: 'java',
};

function stepEcosystems(step: WorkflowStep): Ecosystem[] {
  const out = new Set<Ecosystem>();
  for (const [re, eco] of TOOLCHAIN_ACTIONS) if (step.uses && re.test(step.uses)) out.add(eco);
  for (const l of step.run ?? []) {
    const { head, rest } = commandHead(l.text);
    const eco = TOOLCHAIN_HEADS[head];
    if (eco) out.add(eco);
    if (head === 'go' && /^(build|test|vet|mod)\b/.test(rest)) out.add('go');
  }
  return [...out];
}

function isQualityStep(step: WorkflowStep): boolean {
  if (step.uses && /(lint|test|codeql|scan|audit|check|sonar|semgrep|trivy)/i.test(step.uses)) return true;
  return (step.run ?? []).some((l) => classifyCommand(l.text) === 'quality');
}

export const ciRules: RuleModule = {
  id: 'ci',
  async run(ctx: RuleContext) {
    const { index } = ctx;
    const workflows = index.list(isWorkflowPath).sort();
    const otherCi = index.list((p) =>
      /^(\.gitlab-ci\.ya?ml|\.travis\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|bitbucket-pipelines\.yml|\.circleci\/config\.ya?ml)$/.test(p));
    if (otherCi.length) {
      ctx.notEvaluated({ area: 'ci: non-GitHub CI', detail: `formats not supported yet: ${otherCi.join(', ')}` });
    }
    if (index.has('.github/dependabot.yml') || index.has('.github/dependabot.yaml')) {
      ctx.notEvaluated({ area: 'ci: dependabot config', detail: 'dependabot.yml is not checked in this version' });
    }
    if (!workflows.length) {
      ctx.notEvaluated({ area: 'ci: GitHub Actions', detail: 'no .github/workflows/*.yml files found' });
      return;
    }
    ctx.evaluated({ area: 'ci: GitHub Actions', detail: `${workflows.length} workflow file(s) parsed structurally` });
    const ecoCache = new Map<Ecosystem, ReturnType<typeof ecosystemEvidence>>();

    for (const wf of workflows) {
      const src = await index.readText(wf);
      if (src === null) continue;
      const parsed = parseWorkflow(src);
      if (parsed.kind === 'empty') {
        ctx.report({
          ruleId: 'ci.workflow-empty', title: 'Workflow file is empty',
          severity: 'low', confidence: 'high', status: 'finding',
          location: { path: wf, line: 1 }, evidence: '(0 non-whitespace bytes)',
          explanation: 'An empty workflow defines no jobs; GitHub reports it as an invalid workflow and nothing runs. If a scan was meant to live here, it is not running.',
          suggestion: 'Delete the file or restore the intended workflow content.',
        });
        continue;
      }
      if (parsed.kind === 'invalid') {
        ctx.report({
          ruleId: 'ci.workflow-invalid', title: 'Workflow file is not valid YAML',
          severity: 'medium', confidence: 'high', status: 'finding',
          location: { path: wf, line: parsed.line }, evidence: truncate(parsed.message),
          explanation: 'GitHub cannot load a workflow that fails to parse, so none of its jobs run. Other checks for this file were skipped.',
          suggestion: 'Fix the YAML syntax (e.g. validate with actionlint) and re-run the audit.',
        });
        continue;
      }

      const reportedEco = new Set<Ecosystem>();
      for (const job of parsed.jobs) {
        if (job.continueOnError) reportContinueOnError(ctx, wf, job.continueOnError, `job "${job.id}"`, 'job', true);
        for (const step of job.steps) {
          const label = `job "${job.id}" step ${step.name ? `"${step.name}"` : `#${step.index + 1}`}`;
          if (step.continueOnError) reportContinueOnError(ctx, wf, step.continueOnError, label, 'step', isQualityStep(step));
          for (const l of step.run ?? []) {
            const mask = findMasking(l.text);
            if (!mask) continue;
            const cls = classifyCommand(mask.masked);
            if (cls === 'cleanup') continue;
            const sev = cls === 'quality' ? 'high' : cls === 'install' ? 'medium' : 'low';
            ctx.report({
              ruleId: 'ci.masked-failure', title: `CI step masks failure of ${cls === 'quality' ? 'a test/lint/scan command' : cls === 'install' ? 'an install command' : 'a command'}`,
              severity: sev, confidence: cls === 'other' ? 'medium' : 'high',
              status: cls === 'other' ? 'needs-review' : 'finding',
              location: { path: wf, line: l.line }, evidence: truncate(l.text),
              fingerprintKey: `${job.id}|${mask.masked}`,
              explanation: cls === 'quality'
                ? `\`${truncate(mask.masked, 60)}\` is a test/lint/scan command, but \`${mask.how}\` makes the step succeed even when it fails, so this check can never turn CI red (${label}).`
                : cls === 'install'
                  ? `\`${mask.how}\` hides installation failures (${label}); later steps may then run without their tools while the job still passes.`
                  : `\`${mask.how}\` makes this command's failure invisible (${label}). This may be intentional; confirm the command is not meant to gate CI.`,
              suggestion: cls === 'quality'
                ? `Remove \`${mask.how}\`. If the check is not ready to gate merges, run it in a separate, explicitly non-blocking job and say so in the job name.`
                : `Remove \`${mask.how}\` or handle the specific expected failure explicitly.`,
            });
          }
          for (const eco of stepEcosystems(step)) {
            if (reportedEco.has(eco)) continue;
            const ev = ecoCache.get(eco) ?? ecosystemEvidence(index, eco);
            ecoCache.set(eco, ev);
            if (ev.manifests.length || ev.sources) continue;
            reportedEco.add(eco);
            ctx.report({
              ruleId: 'ci.stack-mismatch', title: `CI uses ${eco} tooling but the repository has no ${eco} project`,
              severity: 'medium', confidence: 'medium', status: 'finding',
              location: { path: wf, line: step.line },
              evidence: truncate(step.uses ?? step.run?.map((r) => r.text).join('; ') ?? ''),
              fingerprintKey: eco,
              explanation: `${label} sets up or runs ${eco} tools, but no ${eco} source files or manifests were found in the scanned tree. Such steps usually check nothing (e.g. a linter over zero files) and give a false signal of coverage.`,
              suggestion: `Replace these steps with checks for the languages the repository actually contains, or add the missing ${eco} project if it was expected.`,
            });
          }
        }
      }
    }
  },
};

function reportContinueOnError(
  ctx: RuleContext, wf: string, coe: { raw: unknown; line: number }, label: string,
  scope: 'job' | 'step', relevant: boolean,
): void {
  const raw = coe.raw;
  if (raw === false || raw === 'false') return;
  if (typeof raw === 'string' && raw.includes('${{')) {
    ctx.report({
      ruleId: 'ci.continue-on-error', title: 'continue-on-error is set by an expression',
      severity: 'info', confidence: 'low', status: 'needs-review',
      location: { path: wf, line: coe.line }, evidence: `continue-on-error: ${truncate(raw)}`,
      explanation: `${label} may ignore failures depending on runtime values (often an "experimental" matrix entry). This is frequently intentional.`,
      suggestion: 'Confirm which matrix entries or conditions are allowed to fail.',
    });
    return;
  }
  if (raw !== true && raw !== 'true') return;
  const isJob = scope === 'job';
  const sev = isJob || relevant ? 'medium' : 'low';
  ctx.report({
    ruleId: 'ci.continue-on-error', title: `continue-on-error: true on ${isJob ? 'a job' : 'a step'}`,
    severity: sev, confidence: 'high', status: relevant || isJob ? 'finding' : 'needs-review',
    location: { path: wf, line: coe.line }, evidence: 'continue-on-error: true',
    explanation: `Failures in ${label} are ignored when deciding whether the ${isJob ? 'workflow' : 'job'} succeeds${relevant ? '; it runs a test/lint/scan, so that check cannot fail CI' : ''}.`,
    suggestion: 'Remove continue-on-error, or document why this failure is acceptable.',
  });
}
