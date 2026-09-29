import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCommand, findMasking } from '../src/rules/ci.js';
import { auditFiles, byRule, wf } from './helpers.js';

const PY = { 'app.py': 'print(1)\n' };

describe('ci.masked-failure', () => {
  it('flags a quality command masked with || true, with the right line', async () => {
    const r = await auditFiles({
      ...PY,
      '.github/workflows/ci.yml': wf(`      - uses: actions/checkout@v4
      - name: Tests
        run: pytest -q || true
`),
    });
    const f = byRule(r, 'ci.masked-failure');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, 'high');
    assert.equal(f[0]!.status, 'finding');
    assert.equal(f[0]!.location.line, 9);
    assert.match(f[0]!.evidence, /pytest -q \|\| true/);
  });

  it('locates lines inside block scalars and handles continuations', async () => {
    const r = await auditFiles({
      ...PY,
      '.github/workflows/ci.yml': wf(`      - run: |
          echo start
          ruff check \\
            src || true
`),
    });
    const f = byRule(r, 'ci.masked-failure');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.location.line, 9);
    assert.equal(f[0]!.severity, 'high');
  });

  it('ignores YAML comments, shell comments, quoted text and non-run keys', async () => {
    const r = await auditFiles({
      ...PY,
      '.github/workflows/ci.yml': wf(`      # - run: pytest || true
      - name: "docs mention || true"
        run: |
          # pytest || true   (old approach, removed)
          echo "never write pytest || true"
          pytest
      - uses: some/action@v1
        with:
          args: "lint || true"
`),
    });
    assert.deepEqual(byRule(r, 'ci.masked-failure'), []);
  });

  it('does not flag idiomatic cleanup, and marks unknown commands needs-review', async () => {
    const r = await auditFiles({
      ...PY,
      '.github/workflows/ci.yml': wf(`      - run: rm -rf build || true
      - run: docker rm -f db || true
      - run: ./scripts/notify.sh || echo "notify failed"
`),
    });
    const f = byRule(r, 'ci.masked-failure');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.status, 'needs-review');
    assert.equal(f[0]!.severity, 'low');
  });

  it('classifies commands', () => {
    assert.equal(classifyCommand('npm test'), 'quality');
    assert.equal(classifyCommand('npx eslint .'), 'quality');
    assert.equal(classifyCommand('CI=1 go test ./...'), 'quality');
    assert.equal(classifyCommand('pip install -r requirements.txt'), 'install');
    assert.equal(classifyCommand('rm -f x'), 'cleanup');
    assert.equal(classifyCommand('./deploy.sh'), 'other');
    assert.deepEqual(findMasking('make test || :'), { masked: 'make test', how: '|| :' });
    assert.equal(findMasking('a || b'), null);
  });
});

describe('ci.continue-on-error', () => {
  it('flags relevant step/job usage and ignores false or action inputs', async () => {
    const r = await auditFiles({
      ...PY,
      '.github/workflows/ci.yml': wf(`      - run: pytest
        continue-on-error: true
      - run: echo hi
        continue-on-error: false
      - uses: some/action@v1
        with:
          continue-on-error: true
`, '    continue-on-error: ${{ matrix.experimental }}\n'),
    });
    const f = byRule(r, 'ci.continue-on-error');
    assert.equal(f.length, 2);
    const step = f.find((x) => x.severity === 'medium')!;
    assert.equal(step.status, 'finding');
    assert.equal(step.location.line, 9);
    const expr = f.find((x) => x.severity === 'info')!;
    assert.equal(expr.status, 'needs-review');
  });

  it('treats a non-quality step as low / needs-review', async () => {
    const r = await auditFiles({
      '.github/workflows/ci.yml': wf(`      - run: ./upload-artifacts.sh
        continue-on-error: true
`),
    });
    const [f] = byRule(r, 'ci.continue-on-error');
    assert.equal(f!.severity, 'low');
    assert.equal(f!.status, 'needs-review');
  });
});

describe('workflow validity and stack mismatch', () => {
  it('reports empty and malformed workflows without crashing', async () => {
    const r = await auditFiles({
      '.github/workflows/empty.yml': '\n',
      '.github/workflows/bad.yml': 'jobs:\n  a: [unclosed\n',
    });
    assert.equal(byRule(r, 'ci.workflow-empty').length, 1);
    const bad = byRule(r, 'ci.workflow-invalid');
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.location.path, '.github/workflows/bad.yml');
  });

  it('flags python tooling only when the repo has no python', async () => {
    const steps = `      - uses: actions/setup-python@v5
      - run: pip install ruff && ruff check .
`;
    const without = await auditFiles({ '.github/workflows/ci.yml': wf(steps), 'index.ts': 'export {};\n' });
    const f = byRule(without, 'ci.stack-mismatch');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.confidence, 'medium');
    const withPy = await auditFiles({ '.github/workflows/ci.yml': wf(steps), 'pyproject.toml': '[project]\n' });
    assert.deepEqual(byRule(withPy, 'ci.stack-mismatch'), []);
  });

  it('reports non-GitHub CI as not evaluated', async () => {
    const r = await auditFiles({ '.gitlab-ci.yml': 'test:\n  script: pytest || true\n' });
    assert.equal(r.findings.length, 0);
    assert.ok(r.coverage.notEvaluated.some((e) => e.area.includes('non-GitHub')));
  });
});
