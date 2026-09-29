import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditRepository, AuditConfigError } from '../src/audit.js';
import { main } from '../src/cli.js';
import { DeadlineExceeded, DEFAULT_LIMITS, discover } from '../src/discovery.js';
import { auditFiles, byRule, makeRepo, wf } from './helpers.js';

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { code, out, err };
}

describe('unsupported projects', () => {
  it('returns "not evaluated", not fabricated findings', async () => {
    const root = await makeRepo({ 'main.hs': 'main = print 1\n', 'lib/x.lua': 'return 1\n' });
    const r = await auditRepository(root);
    assert.equal(r.findings.length, 0);
    assert.equal(r.coverage.evaluated.length, 0);
    assert.ok(r.coverage.notEvaluated.some((e) => e.detail.includes('lua (1)')));
    const cli = await run(['audit', root]);
    assert.equal(cli.code, 0);
    assert.match(cli.out, /Nothing was evaluated/);
  });
});

describe('discovery safety and limits', () => {
  it('ignores .git and node_modules, and skips binary files', async () => {
    const r = await auditFiles({
      '.git/config': '[core]\n',
      'node_modules/pkg/index.ts': "import x from './nope';\n",
      'img.ts': Buffer.from([0x69, 0x00, 0x01, 0x02]),
    });
    assert.equal(r.findings.length, 0);
    assert.ok(r.skipped.some((s) => s.path === 'img.ts' && s.reason === 'binary file'));
    assert.equal(r.stats.filesIndexed, 1);
  });

  it('never follows symlinks, but counts in-repo symlink targets as present', async () => {
    const outside = await makeRepo({ 'secret.ts': "import x from './would-be-missing';\n" });
    const root = await makeRepo({ 'a.ts': "import l from './linked';\n" });
    await symlink(path.join(outside, 'secret.ts'), path.join(root, 'linked.ts'));
    await symlink(outside, path.join(root, 'outside-dir'));
    const r = await auditRepository(root);
    assert.deepEqual(byRule(r, 'js.unresolved-import'), []);
    assert.ok(!r.findings.some((f) => f.location.path.startsWith('outside-dir')));
    assert.equal(r.stats.filesRead, 1);
  });

  it('records unreadable files instead of failing', { skip: process.getuid?.() === 0 ? 'running as root: permissions not enforced' : false }, async () => {
    const root = await makeRepo({ 'a.ts': 'export {};\n' });
    await chmod(path.join(root, 'a.ts'), 0o000);
    const r = await auditRepository(root);
    assert.ok(r.skipped.some((s) => s.path === 'a.ts' && s.reason.startsWith('unreadable')));
  });

  it('enforces maxFiles and maxFileBytes and reports truncation', async () => {
    const r = await auditFiles(
      { 'a.ts': 'export {};\n', 'b.ts': 'export {};\n', 'c.ts': 'export {};\n', 'big.md': 'x'.repeat(200) },
      { limits: { maxFiles: 3, maxFileBytes: 100 } },
    );
    assert.equal(r.limits.truncated, true);
    assert.equal(r.stats.filesIndexed, 3);
    assert.ok(r.limits.notes[0]?.includes('maxFiles'));
    const r2 = await auditFiles({ 'big.md': 'x'.repeat(200) }, { limits: { maxFileBytes: 100 } });
    assert.ok(r2.skipped.some((s) => s.path === 'big.md' && s.reason.includes('maxFileBytes')));
  });

  it('stops at the deadline', async () => {
    const root = await makeRepo({ 'a.ts': '' });
    await assert.rejects(discover(root, DEFAULT_LIMITS, Date.now() - 1), DeadlineExceeded);
  });

  it('rejects missing targets and bad limits', async () => {
    await assert.rejects(auditRepository('/definitely/not/here'), AuditConfigError);
    await assert.rejects(auditRepository('.', { limits: { maxFiles: 0 } }), AuditConfigError);
  });
});

describe('output contract', () => {
  it('fingerprints are stable when lines shift', async () => {
    const steps = '      - run: npm test || true\n';
    const a = await auditFiles({ 'package.json': '{}', '.github/workflows/ci.yml': wf(steps) });
    const b = await auditFiles({ 'package.json': '{}', '.github/workflows/ci.yml': `# comment\n\n${wf(steps)}` });
    const fa = byRule(a, 'ci.masked-failure')[0]!;
    const fb = byRule(b, 'ci.masked-failure')[0]!;
    assert.notEqual(fa.location.line, fb.location.line);
    assert.equal(fa.fingerprint, fb.fingerprint);
  });

  it('JSON output is versioned and contains no absolute paths', async () => {
    const root = await makeRepo({ 'README.md': '```\nnpm install\n```\n' });
    const res = await run(['audit', root, '--format', 'json']);
    assert.equal(res.code, 1);
    const json = JSON.parse(res.out);
    assert.equal(json.schemaVersion, '1.0.0');
    assert.equal(json.findings[0].ruleId, 'setup.readme-manifest-missing');
    for (const key of ['ruleId', 'severity', 'confidence', 'status', 'location', 'evidence', 'explanation', 'suggestion', 'fingerprint']) {
      assert.ok(key in json.findings[0], key);
    }
    assert.ok(!res.out.includes(root));
  });

  it('uses documented exit codes', async () => {
    const root = await makeRepo({ 'README.md': '```\nnpm install\n```\n' }); // one medium finding
    assert.equal((await run(['audit', root])).code, 1);
    assert.equal((await run(['audit', root, '--fail-on', 'high'])).code, 0);
    assert.equal((await run(['audit', root, '--fail-on=none'])).code, 0);
    const clean = await makeRepo({ 'a.ts': 'export {};\n' });
    assert.equal((await run(['audit', clean])).code, 0);
    assert.equal((await run(['audit', '/no/such/dir'])).code, 2);
    assert.equal((await run(['audit', root, '--format', 'xml'])).code, 2);
    assert.equal((await run(['audit'])).code, 2);
    assert.equal((await run(['scan', root])).code, 2);
  });

  it('handles nested workflow-like files outside .github/workflows as non-workflows', async () => {
    const root = await makeRepo({});
    await mkdir(path.join(root, 'docs/.github/workflows'), { recursive: true });
    await writeFile(path.join(root, 'docs/.github/workflows/x.yml'), 'jobs: {a: {steps: [{run: "pytest || true"}]}}\n');
    const r = await auditRepository(root);
    assert.deepEqual(byRule(r, 'ci.masked-failure'), []);
  });
});
