// Project-setup contradictions: README setup commands vs manifests, declared
// language vs source files, README/package license vs LICENSE text, and
// relative Markdown links to files that do not exist.

import { classifyLicenseText, familyFromSpdx, licenseMentions } from '../parsers/license.js';
import { proseLines, relativeLinks, shellCodeLines } from '../parsers/markdown.js';
import { stripShellComment } from '../parsers/workflow.js';
import { dirname, joinRel, languageOf, truncate } from '../text.js';
import type { RuleContext, RuleModule } from './types.js';

interface ManifestNeed {
  manifest: string;
  test(cmd: string): boolean;
  candidates: string[];
}

const NEEDS: ManifestNeed[] = [
  {
    manifest: 'package.json',
    candidates: ['package.json'],
    // Bare installs and script runs need a package.json; `npm install <pkg>` / `-g` do not.
    test: (c) => /^npm\s+(ci|start|test|t|run\s+\S+)\b/.test(c)
      || /^(yarn|pnpm)\s+(start|test|build|run\s+\S+)\b/.test(c)
      || /^(npm\s+(install|i)|pnpm\s+(install|i)|yarn(\s+install)?)(\s+-{1,2}[\w-]+(=\S+)?)*\s*$/.test(c),
  },
  { manifest: 'requirements file', candidates: [], test: (c) => /^pip3?\s+install\s+(.*\s)?-r\s+\S+/.test(c) },
  { manifest: 'pyproject.toml or setup.py', candidates: ['pyproject.toml', 'setup.py'], test: (c) => /^pip3?\s+install\s+(-e\s+)?\.(\[[^\]]*\])?\s*$|^poetry\s+install\b/.test(c) },
  { manifest: 'Cargo.toml', candidates: ['Cargo.toml'], test: (c) => /^cargo\s+(build|run|test)\b/.test(c) },
  { manifest: 'go.mod', candidates: ['go.mod'], test: (c) => /^go\s+(build|run|test)\s+\.\/?/.test(c) },
  { manifest: 'Makefile', candidates: ['Makefile', 'makefile', 'GNUmakefile'], test: (c) => /^make(\s+[\w.-]+)?\s*$/.test(c) },
];

const DECLARED_LANG = /\b(?:developed|written|built|implemented|coded)\s+(?:entirely\s+)?(?:in|with|using)\s+\**\s*(TypeScript|JavaScript|Python|Rust|Golang|Go|Java|Kotlin)\b/i;
const LANG_KEY: Record<string, string> = {
  typescript: 'typescript', javascript: 'javascript', python: 'python', rust: 'rust',
  go: 'go', golang: 'go', java: 'java', kotlin: 'kotlin',
};

function isReadme(p: string): boolean {
  return /(^|\/)README(\.[a-z]+)?\.md$/i.test(p) || /(^|\/)readme\.md$/i.test(p);
}

export const setupRules: RuleModule = {
  id: 'setup',
  async run(ctx: RuleContext) {
    const { index } = ctx;
    const readmes = index.list(isReadme).sort();
    if (!readmes.length) {
      ctx.notEvaluated({ area: 'setup: README', detail: 'no README.md found; setup and license claims not evaluated' });
    } else {
      ctx.evaluated({ area: 'setup: README', detail: `${readmes.length} README file(s): setup commands, declared language, license statement` });
    }

    for (const readme of readmes) {
      const md = await index.readText(readme);
      if (md === null) continue;
      checkSetupCommands(ctx, readme, md);
      checkDeclaredLanguage(ctx, readme, md);
    }
    await checkLicense(ctx);
    await checkPackageJsonLicense(ctx);
    await checkLinks(ctx);
  },
};

function checkSetupCommands(ctx: RuleContext, readme: string, md: string): void {
  const { index } = ctx;
  const base = dirname(readme);
  let cwd = base;
  const hits = new Map<ManifestNeed, { cmds: string[]; line: number; dir: string }>();
  for (const { text, line } of shellCodeLines(md)) {
    for (const part of stripShellComment(text).split(/&&|;/).map((s) => s.trim()).filter(Boolean)) {
      const cd = /^cd\s+(\S+)$/.exec(part);
      if (cd) {
        // Follow `cd` only into directories that exist here; `cd <clone-dir>` keeps the README's directory.
        const target = joinRel(cwd, cd[1]!.replace(/\/$/, ''));
        if (target !== null && index.isDir(target) && target !== cwd) cwd = target;
        continue;
      }
      if (/^git\s+clone\b/.test(part)) { cwd = base; continue; }
      for (const need of NEEDS) {
        if (!need.test(part)) continue;
        const req = /-r\s+(\S+)/.exec(part);
        const candidates = req ? [req[1]!] : need.candidates;
        const found = candidates.some((c) => { const p = joinRel(cwd, c); return p !== null && index.has(p); });
        if (found) continue;
        const h = hits.get(need) ?? { cmds: [], line, dir: cwd };
        if (!h.cmds.includes(part)) h.cmds.push(part);
        hits.set(need, h);
      }
    }
  }
  for (const [need, h] of hits) {
    const name = need.manifest === 'requirements file' ? (/-r\s+(\S+)/.exec(h.cmds[0] ?? '')?.[1] ?? need.manifest) : need.manifest;
    const elsewhere = need.candidates.length
      ? index.list((p) => need.candidates.some((c) => p === c || p.endsWith(`/${c}`)))
      : [];
    ctx.report({
      ruleId: 'setup.readme-manifest-missing',
      title: `README setup commands need ${name}, which is missing`,
      severity: 'medium',
      confidence: elsewhere.length ? 'medium' : 'high',
      status: elsewhere.length ? 'needs-review' : 'finding',
      location: { path: readme, line: h.line },
      evidence: truncate(h.cmds.join(' | ')),
      fingerprintKey: need.manifest,
      explanation: `These commands run in ${h.dir ? `\`${h.dir}/\`` : 'the repository root'}, which has no ${name}, so following the README fails.`
        + (elsewhere.length ? ` A ${need.candidates[0]} exists elsewhere (${elsewhere.slice(0, 3).join(', ')}); the README may just be missing a \`cd\`.` : ''),
      suggestion: elsewhere.length
        ? 'Point the instructions at the directory that actually contains the manifest.'
        : `Add the ${name} the instructions assume, or rewrite the setup section to match how the project is really built.`,
    });
  }
}

function checkDeclaredLanguage(ctx: RuleContext, readme: string, md: string): void {
  for (const { text, line } of proseLines(md)) {
    const m = DECLARED_LANG.exec(text);
    if (!m) continue;
    const lang = LANG_KEY[m[1]!.toLowerCase()];
    if (!lang) continue;
    const count = ctx.index.list((p) => languageOf(p) === lang).length;
    if (count > 0) continue;
    ctx.report({
      ruleId: 'setup.declared-language-missing',
      title: `README says the project is written in ${m[1]}, but no ${m[1]} files exist`,
      severity: 'medium', confidence: 'high', status: 'finding',
      location: { path: readme, line }, evidence: truncate(text), fingerprintKey: lang,
      explanation: `No files with ${m[1]} extensions were found in the scanned tree (ignored: dependencies and build output).`,
      suggestion: 'Correct the stated language or add the missing implementation.',
    });
  }
}

async function checkLicense(ctx: RuleContext): Promise<void> {
  const { index } = ctx;
  const licenseFiles = index.list((p) => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(p)).sort();
  if (!licenseFiles.length) {
    ctx.notEvaluated({ area: 'setup: license', detail: 'no root LICENSE file; license consistency not evaluated' });
    return;
  }
  const classified: { path: string; family: string }[] = [];
  for (const f of licenseFiles) {
    const text = await index.readText(f);
    if (text === null) continue;
    classified.push({ path: f, family: classifyLicenseText(text) });
  }
  const known = classified.filter((c) => c.family !== 'unknown');
  if (!known.length) {
    ctx.notEvaluated({ area: 'setup: license', detail: `${licenseFiles.join(', ')}: license text not recognized; consistency not evaluated` });
    return;
  }
  ctx.evaluated({ area: 'setup: license', detail: known.map((k) => `${k.path} = ${k.family}`).join(', ') });
  const primary = known[0]!;

  const readme = index.list((p) => /^README(\.[a-z]+)?\.md$/i.test(p)).sort()[0];
  if (!readme) return;
  const md = await index.readText(readme);
  if (md === null) return;
  const mentions = licenseMentions(proseLines(md));
  const conflicting = mentions.filter((m) => m.family !== primary.family);
  if (!conflicting.length) return;
  const agreeing = mentions.length - conflicting.length;
  const first = conflicting[0]!;
  ctx.report({
    ruleId: 'setup.license-conflict',
    title: `README says ${first.family}, but ${primary.path} is ${primary.family}`,
    severity: 'medium',
    confidence: agreeing ? 'medium' : 'high',
    status: 'needs-review',
    location: { path: readme, line: first.line },
    evidence: truncate(`${readme}: "${first.text.trim()}" vs ${primary.path}: ${primary.family}`),
    fingerprintKey: `${first.family}|${primary.family}`,
    explanation: `The README's license statement names ${conflicting.map((c) => c.family).join(', ')}, while ${primary.path} matches ${primary.family} text. Users cannot tell which terms apply. Which one is correct is a legal/owner decision.`,
    suggestion: 'Have the copyright owner decide the intended license and align the README and LICENSE. RepoTruth never changes license files automatically.',
  });
}

async function checkPackageJsonLicense(ctx: RuleContext): Promise<void> {
  const { index } = ctx;
  for (const pkg of index.list((p) => /(^|\/)package\.json$/.test(p)).sort()) {
    const dir = dirname(pkg);
    const lic = index.list((p) => dirname(p) === dir && /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(p.slice(dir ? dir.length + 1 : 0)))[0];
    if (!lic) continue;
    const [pkgText, licText] = [await index.readText(pkg), await index.readText(lic)];
    if (pkgText === null || licText === null) continue;
    let declared: unknown;
    try { declared = (JSON.parse(pkgText) as { license?: unknown }).license; } catch { continue; }
    if (typeof declared !== 'string') continue;
    const a = familyFromSpdx(declared);
    const b = classifyLicenseText(licText);
    if (a === 'unknown' || b === 'unknown' || a === b) continue;
    ctx.report({
      ruleId: 'setup.license-conflict', title: `package.json license "${declared}" contradicts ${lic} (${b})`,
      severity: 'medium', confidence: 'high', status: 'needs-review',
      location: { path: pkg }, evidence: `"license": "${declared}" vs ${lic}: ${b}`,
      fingerprintKey: `pkg|${a}|${b}`,
      explanation: 'Registries and license scanners read package.json; humans read LICENSE. They disagree.',
      suggestion: 'Owner decision required; align both. Not auto-fixed.',
    });
  }
}

async function checkLinks(ctx: RuleContext): Promise<void> {
  const { index } = ctx;
  const docs = index.list((p) => /\.md$/i.test(p) && (!p.includes('/') || /^(docs|\.github)\//.test(p))).sort();
  let checked = 0;
  for (const doc of docs) {
    const md = await index.readText(doc);
    if (md === null) continue;
    checked++;
    for (const link of relativeLinks(md)) {
      let clean: string;
      try { clean = decodeURIComponent(link.target.split('#')[0]!.split('?')[0]!); } catch { continue; }
      if (!clean) continue;
      const target = joinRel(dirname(doc), clean.replace(/\/$/, ''));
      // Links that climb out of the repo are usually GitHub web routes (e.g. ../../security); not evaluated.
      if (target === null || index.has(target) || index.isDir(target) || index.isUnderIgnored(target)) continue;
      ctx.report({
        ruleId: 'docs.broken-relative-link', title: `Link to missing file: ${link.target}`,
        severity: 'low', confidence: 'high', status: 'finding',
        location: { path: doc, line: link.line }, evidence: link.target, fingerprintKey: link.target,
        explanation: `The link resolves to \`${target}\`, which does not exist in the repository.`,
        suggestion: 'Add the referenced file or fix/remove the link.',
      });
    }
  }
  if (checked) ctx.evaluated({ area: 'docs: relative links', detail: `${checked} Markdown file(s) at root, docs/, .github/` });
}
