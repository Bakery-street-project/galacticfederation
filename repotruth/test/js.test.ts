import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractImports } from '../src/parsers/source.js';
import { auditFiles, byRule } from './helpers.js';

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
