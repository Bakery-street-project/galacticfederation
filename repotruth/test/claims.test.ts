import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
