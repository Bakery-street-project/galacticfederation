import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractImports } from '../src/parsers/source.js';
import { resolveRelative } from '../src/rules/js.js';
import { auditFiles, byRule } from './helpers.js';

describe('resolveRelative completeness', () => {
  const never = () => false;
  const notDir = () => false;
  const notIgnored = () => false;

  it('downgrades absence to unverifiable only when the index is incomplete', () => {
    assert.equal(resolveRelative(never, notDir, notIgnored, 'src/a.ts', './gone', true), 'missing');
    assert.equal(resolveRelative(never, notDir, notIgnored, 'src/a.ts', './gone', false), 'unverifiable');
  });

  it('still resolves to found against an incomplete index', () => {
    assert.equal(resolveRelative((p) => p === 'src/a.ts', notDir, notIgnored, 'src/a.ts', './a', false), 'found');
  });

  it('keeps ignored and root-escaping targets unknown, not unverifiable', () => {
    assert.equal(resolveRelative(never, notDir, () => true, 'src/a.ts', './gone', false), 'unknown');
    assert.equal(resolveRelative(never, notDir, notIgnored, 'src/a.ts', '../../escape', false), 'unknown');
  });

  it('treats a normalising ../ as unverifiable, since it stays inside the repo', () => {
    assert.equal(resolveRelative(never, notDir, notIgnored, 'src/a.ts', '../escape', true), 'missing');
    assert.equal(resolveRelative(never, notDir, notIgnored, 'src/a.ts', '../escape', false), 'unverifiable');
  });
});

describe('js.unresolved-import', () => {
  it('flags a missing relative import and accepts valid ones', async () => {
    const r = await auditFiles({
      'src/main.ts': [
        "import { a } from './a.js';", // .js → .ts mapping
        "import b from './lib';", // directory index
        "import data from './data.json';",
        "import lodash from 'lodash';", // bare: never judged
        "// import gone from './commented-out';",
        "import { missing } from './missing';",
        "const later = await import('./also-missing.js');",
      ].join('\n'),
      'src/a.ts': 'export const a = 1;\n',
      'src/lib/index.ts': 'export default 1;\n',
      'src/data.json': '{}',
    });
    const f = byRule(r, 'js.unresolved-import');
    assert.deepEqual(f.map((x) => [x.location.line, x.severity]), [[6, 'high'], [7, 'high']]);
  });

  it('does not claim imports into ignored build output are missing', async () => {
    const r = await auditFiles({ 'test/x.test.js': "import m from '../dist/index.js';\n" });
    assert.deepEqual(byRule(r, 'js.unresolved-import'), []);
  });

  it('extracts import forms and skips comments', () => {
    const refs = extractImports([
      "export * from './re';",
      "export { x } from \"./named\";",
      "const r = require('./req');",
      '/* import nope from "./block" */',
      "import './side-effect';",
      "import type { T } from './types.js';",
    ].join('\n'));
    assert.deepEqual(refs.map((r) => r.specifier), ['./re', './named', './req', './side-effect', './types.js']);
  });
});

describe('truncated file list cannot prove absence', () => {
  // The real-world failure: repos past maxFiles had every unindexed import
  // reported high/high "module not found", when the file was on disk all along.
  // Sorted walk order means the importer must come first and the cap must be
  // hit after it, so the importer is indexed but its target is not.
  const repo = {
    'a.ts': "import { gone } from './gone';\n",
    'b.ts': 'export const b = 1;\n',
    'c.ts': 'export const c = 1;\n',
  };

  it('suppresses the finding and discloses the unverifiable count', async () => {
    const r = await auditFiles(repo, { limits: { maxFiles: 2 } });
    assert.deepEqual(byRule(r, 'js.unresolved-import'), []);
    const note = r.coverage.notEvaluated.find((c) => c.area === 'js/ts: relative imports');
    assert.ok(note, 'expected a notEvaluated note; silence would be an unverifiable false negative');
    assert.match(note.detail, /^1 unresolved reference\(s\) not reported/);
  });

  it('withdraws the evaluated claim it can no longer stand behind', async () => {
    const r = await auditFiles(repo, { limits: { maxFiles: 2 } });
    assert.equal(r.coverage.evaluated.some((c) => c.area === 'js/ts: relative imports'), false);
  });

  it('still reports genuinely missing imports when the index is complete', async () => {
    const r = await auditFiles(repo);
    assert.deepEqual(byRule(r, 'js.unresolved-import').map((f) => f.severity), ['high']);
    assert.equal(r.limits.truncated, false);
  });

  it('does not suppress on a read-budget stop, where the file list was complete', async () => {
    // a.ts is read (and its import proven absent); b.ts then exhausts the byte
    // budget, so `truncated` is true while the file list is still complete.
    const files = { 'a.ts': "import { gone } from './gone';\n", 'b.ts': `// ${'x'.repeat(4000)}\n` };
    const r = await auditFiles(files, { limits: { maxTotalBytes: 200 } });
    assert.equal(r.limits.truncated, true);
    assert.deepEqual(byRule(r, 'js.unresolved-import').map((f) => f.severity), ['high']);
  });

  it('suppresses package entry points on an incomplete index too', async () => {
    const files = { 'package.json': '{"main":"src/index.js"}', 'src/other.ts': 'export const b = 1;\n' };
    assert.equal(byRule(await auditFiles(files), 'js.missing-entry-point').length, 1);
    assert.deepEqual(byRule(await auditFiles(files, { limits: { maxFiles: 1 } }), 'js.missing-entry-point'), []);
  });
});

describe('package.json entry points', () => {
  it('flags a missing main outside build output', async () => {
    const r = await auditFiles({ 'package.json': '{"main":"src/index.js","bin":{"t":"bin/cli.js"}}', 'bin/cli.js': '' });
    const f = byRule(r, 'js.missing-entry-point');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.evidence, '"main": "src/index.js"');
  });

  it('accepts build output when a build script exists, and marks it needs-review otherwise', async () => {
    const ok = await auditFiles({ 'package.json': '{"main":"dist/index.js","scripts":{"build":"tsc"}}' });
    assert.deepEqual(byRule(ok, 'js.missing-entry-point'), []);
    const unsure = await auditFiles({ 'package.json': '{"main":"dist/index.js"}' });
    assert.equal(byRule(unsure, 'js.missing-entry-point')[0]!.status, 'needs-review');
  });

  it('reports invalid package.json', async () => {
    const r = await auditFiles({ 'package.json': '{ nope' });
    assert.equal(byRule(r, 'js.package-json-invalid').length, 1);
  });
});

describe('import extraction robustness', () => {
  it('ignores import statements that only appear inside string literals', () => {
    const refs = extractImports([
      "const fixture = \"import x from './nope';\";",
      "const tpl = `import y from './also-nope';`;",
      "const lines = ['import z from \\'./still-nope\\';'];",
      "import real from './real';",
    ].join('\n'));
    assert.deepEqual(refs.map((r) => [r.specifier, r.line]), [['./real', 4]]);
  });
});
