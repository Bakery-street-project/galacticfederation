import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findComparativeClaim } from '../src/rules/claims.js';
import { auditFiles, byRule } from './helpers.js';

describe('claim rules', () => {
  it('reports simulation markers in comments as needs-review, one finding per file', async () => {
    const r = await auditFiles({
      'engine.c': '/* Inference engine */\nint run() {\n  // Simulate inference\n  return 0; // placeholder\n}\n',
    });
    const [f, ...rest] = byRule(r, 'claim.simulation-marker');
    assert.equal(rest.length, 0);
    assert.equal(f!.status, 'needs-review');
    assert.equal(f!.location.line, 3);
    assert.match(f!.evidence, /L4:/);
  });

  it('ignores markers in strings, code identifiers, and test files', async () => {
    const r = await auditFiles({
      'src/a.ts': 'const mode = "simulate"; function placeholder() {}\n',
      'test/a.test.ts': '// fake server for tests\n',
    });
    assert.deepEqual(byRule(r, 'claim.simulation-marker'), []);
  });

  it('flags unbenchmarked superlatives in README and comments as info', async () => {
    const r = await auditFiles({
      'README.md': '# Fast\n\n10x faster than redis.\n\n```\nbetter than code blocks are ignored\n```\n',
      'x.py': '# better than numpy\nx = 1\n',
    });
    const f = byRule(r, 'claim.unverified-superlative');
    assert.deepEqual(f.map((x) => [x.location.path, x.severity]), [['README.md', 'info'], ['x.py', 'info']]);
  });

  it('does not flag the rule-documentation example (quoted phrases are mentions)', async () => {
    const doc = '| `claim.unverified-superlative` | "better than X", "10x faster", "world\'s first" in README or comments | `info`/`needs-review`. |';
    assert.equal(findComparativeClaim(doc), null);
    const r = await auditFiles({ 'README.md': `# Rules\n\n${doc}\n` });
    assert.deepEqual(byRule(r, 'claim.unverified-superlative'), []);
  });

  it('still flags a genuine unsupported comparative claim in a README', async () => {
    const r = await auditFiles({ 'README.md': '# Engine\n\nOur runtime is better than llama.cpp on every device.\n' });
    const [f, ...rest] = byRule(r, 'claim.unverified-superlative');
    assert.equal(rest.length, 0);
    assert.equal(f!.location.line, 3);
    assert.equal(f!.status, 'needs-review');
    assert.doesNotMatch(f!.explanation, /quotation/);
  });

  it('keeps review behaviour for comparative phrases in code comments', async () => {
    const r = await auditFiles({ 'src/engine.c': '/**\n * Better than llama.cpp with quantum optimization\n */\nint x;\n' });
    const [f] = byRule(r, 'claim.unverified-superlative');
    assert.equal(f!.location.line, 2);
    assert.equal(f!.severity, 'info');
    assert.equal(f!.confidence, 'low');
  });

  it('distinguishes a quoted phrase from a quoted or unquoted assertion', () => {
    const pick = (t: string) => { const m = findComparativeClaim(t); return m && { phrase: m.phrase, quoted: m.quoted }; };
    assert.equal(findComparativeClaim('The rule matches "faster than redis".'), null);
    assert.equal(findComparativeClaim('Avoid phrases like `10x faster`.'), null);
    assert.deepEqual(pick('Users say "RepoX is 10x faster than redis".'), { phrase: '10x faster than redis', quoted: true });
    assert.deepEqual(pick('RepoX is 10x faster than redis.'), { phrase: '10x faster than redis', quoted: false });
    assert.deepEqual(pick('\u201cbetter than X\u201d, but we are better than Y.'), { phrase: 'better than Y', quoted: false });
  });

  it('sees quotations wrapped across Markdown lines and reports the right line', async () => {
    const mention = await auditFiles({ 'README.md': '# Docs\n\nThe rule matches phrases like "better\nthan X" in prose.\n' });
    assert.deepEqual(byRule(mention, 'claim.unverified-superlative'), []);
    const claim = await auditFiles({ 'README.md': '# Docs\n\nThis engine is fast.\nIt is 3x faster than\nredis in our tests.\n' });
    const [f] = byRule(claim, 'claim.unverified-superlative');
    assert.equal(f!.location.line, 4);
  });
});
