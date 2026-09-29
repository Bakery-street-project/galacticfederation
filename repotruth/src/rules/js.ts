// JavaScript/TypeScript checks: relative imports that resolve to nothing and
// package.json entry points that point at missing files. Bare package
// specifiers are never judged: dependencies are not installed by the scanner.

import { extractImports } from '../parsers/source.js';
import { dirname, joinRel, languageOf, truncate } from '../text.js';
import type { RuleContext, RuleModule } from './types.js';

const RESOLVE_EXTS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
};
const BUILD_DIRS = /^(dist|build|lib|out|es|esm|cjs|types)(\/|$)/;

type Resolution = 'found' | 'missing' | 'unknown';

/** Resolves a relative specifier the way Node + TypeScript bundler/NodeNext resolution would, statically. */
export function resolveRelative(has: (p: string) => boolean, isDir: (p: string) => boolean,
  ignored: (p: string) => boolean, fromFile: string, spec: string): Resolution {
  const target = joinRel(dirname(fromFile), spec);
  if (target === null) return 'unknown';
  if (ignored(target)) return 'unknown';
  const candidates = [target];
  for (const ext of RESOLVE_EXTS) candidates.push(target + ext);
  const extMatch = /(\.[cm]?jsx?)$/.exec(target);
  if (extMatch) {
    for (const ts of JS_TO_TS[extMatch[1]!] ?? []) candidates.push(target.slice(0, -extMatch[1]!.length) + ts);
  }
  if (isDir(target)) {
    for (const ext of RESOLVE_EXTS) candidates.push(`${target}/index${ext}`);
    candidates.push(`${target}/package.json`);
  }
  return candidates.some(has) ? 'found' : 'missing';
}

export const jsRules: RuleModule = {
  id: 'js',
  async run(ctx: RuleContext) {
    const { index } = ctx;
    const sources = index
      .list((p) => { const l = languageOf(p); return l === 'typescript' || l === 'javascript'; })
      .filter((p) => !index.files.get(p)?.isSymlink)
      .sort();
    const pkgs = index.list((p) => /(^|\/)package\.json$/.test(p)).sort();
    if (!sources.length && !pkgs.length) {
      ctx.notEvaluated({ area: 'js/ts', detail: 'no JavaScript/TypeScript sources or package.json' });
      return;
    }

    let aliasNote = false;
    for (const ts of index.list((p) => /(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(p))) {
      const text = await index.readText(ts);
      if (text && /"(paths|baseUrl|rootDirs)"\s*:/.test(text)) aliasNote = true;
    }
    ctx.evaluated({
      area: 'js/ts: relative imports',
      detail: `${sources.length} file(s); relative specifiers only${aliasNote ? '; tsconfig path aliases present but NOT evaluated' : ''}`,
    });

    for (const file of sources) {
      const src = await index.readText(file);
      if (src === null) continue;
      for (const ref of extractImports(src)) {
        if (!ref.specifier.startsWith('./') && !ref.specifier.startsWith('../') && ref.specifier !== '.' && ref.specifier !== '..') continue;
        const res = resolveRelative((p) => index.has(p), (p) => index.isDir(p), (p) => index.isUnderIgnored(p), file, ref.specifier);
        if (res !== 'missing') continue;
        ctx.report({
          ruleId: 'js.unresolved-import',
          title: `Relative import "${ref.specifier}" does not resolve to any file`,
          severity: 'high', confidence: 'high', status: 'finding',
          location: { path: file, line: ref.line },
          evidence: truncate(src.split('\n')[ref.line - 1] ?? ref.specifier),
          fingerprintKey: ref.specifier,
          explanation: `No file matches "${ref.specifier}" relative to \`${dirname(file) || '.'}\` (tried the exact path, common JS/TS extensions, .js→.ts mapping, and index files). Loading this module will fail with a module-not-found error.`,
          suggestion: 'Add the missing module, fix the path, or remove the import and the code that depends on it.',
        });
      }
    }

    for (const pkg of pkgs) await checkPackageEntries(ctx, pkg);
  },
};

async function checkPackageEntries(ctx: RuleContext, pkg: string): Promise<void> {
  const { index } = ctx;
  const text = await index.readText(pkg);
  if (text === null) return;
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    json = parsed as Record<string, unknown>;
  } catch (err) {
    ctx.report({
      ruleId: 'js.package-json-invalid', title: 'package.json is not valid JSON',
      severity: 'medium', confidence: 'high', status: 'finding',
      location: { path: pkg }, evidence: truncate(String((err as Error).message)),
      explanation: 'npm and every tool that reads this manifest will fail.',
      suggestion: 'Fix the JSON syntax.',
    });
    return;
  }
  const dir = dirname(pkg);
  const scripts = (json.scripts && typeof json.scripts === 'object') ? json.scripts as Record<string, unknown> : {};
  const hasBuild = typeof scripts.build === 'string' || typeof scripts.prepare === 'string' || typeof scripts.prepublishOnly === 'string';

  const entries: { field: string; target: string }[] = [];
  const collect = (field: string, v: unknown) => {
    if (typeof v === 'string') entries.push({ field, target: v });
    else if (v && typeof v === 'object') for (const [k, sub] of Object.entries(v)) collect(`${field}.${k}`, sub);
  };
  for (const field of ['main', 'module', 'types', 'typings', 'bin', 'exports']) collect(field, json[field]);

  for (const { field, target } of entries) {
    if (target.includes('*')) continue; // subpath patterns: not evaluated
    const rel = joinRel(dir, target);
    if (rel === null || index.has(rel) || index.isDir(rel)) continue;
    const underBuild = BUILD_DIRS.test(target.replace(/^\.\//, ''));
    if (underBuild && hasBuild) continue; // produced by the build script; absence before build is normal
    ctx.report({
      ruleId: 'js.missing-entry-point',
      title: `package.json "${field}" points to a missing file`,
      severity: underBuild ? 'low' : 'high',
      confidence: underBuild ? 'low' : 'high',
      status: underBuild ? 'needs-review' : 'finding',
      location: { path: pkg }, evidence: `"${field}": "${target}"`, fingerprintKey: `${field}|${target}`,
      explanation: underBuild
        ? `\`${target}\` looks like build output, but package.json has no build/prepare script that would create it.`
        : `\`${rel}\` does not exist, so importing or running this package fails.`,
      suggestion: 'Add the file (or the build step that produces it), or correct the field.',
    });
  }
}
