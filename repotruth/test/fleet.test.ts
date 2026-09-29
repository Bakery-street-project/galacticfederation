import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { compareRuns } from '../src/fleet/compare.js';
import { FleetService } from '../src/fleet/service.js';
import { readGitHead } from '../src/fleet/sources/local.js';
import { FleetStore } from '../src/fleet/store.js';
import { startDashboard, type WebHandle } from '../src/fleet/web.js';
import { APP_ID, INSTALLATION_ID, startGitHubMock } from './githubmock.js';
import { makeRepo, wf } from './helpers.js';
import { GitHubAppSource } from '../src/fleet/sources/github.js';
import { repoTarball } from './tarfixture.js';

const handles: WebHandle[] = [];
after(async () => { await Promise.all(handles.map((h) => h.close())); });

/** Workspace with two repos that have distinct, known findings. */
async function workspace() {
  const root = await makeRepo({
    'alpha/package.json': '{"name":"alpha"}',
    'alpha/.github/workflows/ci.yml': wf('      - run: npm test || true\n'),
    'alpha/.git/HEAD': 'ref: refs/heads/main\n',
    'alpha/.git/refs/heads/main': `${'1'.repeat(40)}\n`,
    'beta/src/a.ts': "import x from './gone';\n",
    'beta/.git/HEAD': 'ref: refs/heads/main\n',
    'beta/.git/packed-refs': `# pack-refs\n${'2'.repeat(40)} refs/heads/main\n`,
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'repotruth-data-'));
  return { root, dataDir };
}

async function service(root: string, dataDir: string, extra: Partial<ConstructorParameters<typeof FleetService>[0]> = {}) {
  const store = await FleetStore.open(dataDir);
  return new FleetService({ store, allowedRoot: root, ...extra });
}

async function scanNow(svc: FleetService, id: string) {
  await svc.scan(id);
  await svc.idle();
  return svc.summary(svc.store.repo(id)!);
}

describe('fleet: local repositories', () => {
  it('scans two selected repositories with separate results and commits', async () => {
    const { root, dataDir } = await workspace();
    const svc = await service(root, dataDir);
    const a = await svc.addLocal('alpha');
    const b = await svc.addLocal('beta');
    await Promise.all([svc.scan(a.id), svc.scan(b.id)]);
    await svc.idle();
    const sa = svc.summary(a);
    const sb = svc.summary(b);
    assert.deepEqual(sa.lastCompleted?.audit?.findings.map((f) => f.ruleId), ['ci.masked-failure']);
    assert.deepEqual(sb.lastCompleted?.audit?.findings.map((f) => f.ruleId), ['js.unresolved-import']);
    assert.equal(sa.lastCompleted?.source?.commitSha, '1'.repeat(40));
    assert.equal(sb.lastCompleted?.source?.commitSha, '2'.repeat(40), 'packed ref read without running git');
    assert.ok(sa.lastCompleted!.audit!.findings.every((f) => !f.location.path.startsWith('src/')), 'no cross-repo leakage');
  });

  it('rejects paths outside the allowed root, including symlink escapes', async () => {
    const { root, dataDir } = await workspace();
    const outside = await makeRepo({ 'x.ts': '' });
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, path.join(root, 'escape'));
    const svc = await service(root, dataDir);
    for (const p of ['..', '../x', outside, 'escape']) {
      await assert.rejects(svc.addLocal(p), (e: unknown) => (e as { code?: string }).code === 'OUTSIDE_ALLOWED_ROOT', p);
    }
    await assert.rejects(svc.addLocal('nope'), (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND');
  });

  it('persists repositories and runs across a restart, and fails interrupted runs', async () => {
    const { root, dataDir } = await workspace();
    const svc1 = await service(root, dataDir);
    const a = await svc1.addLocal('alpha');
    await scanNow(svc1, a.id);
    // Simulate a crash mid-scan: a run left in "running" state on disk.
    await svc1.store.putRun({ id: 'run-crashed', repoId: a.id, status: 'running', queuedAt: new Date(Date.now() + 1000).toISOString() });

    const svc2 = await service(root, dataDir);
    assert.deepEqual(svc2.store.repos().map((r) => r.locator), ['alpha']);
    const s = svc2.summary(svc2.store.repo(a.id)!);
    assert.equal(s.latestRun?.id, 'run-crashed');
    assert.equal(s.latestRun?.status, 'failed');
    assert.equal(s.latestRun?.error?.code, 'INTERRUPTED');
    assert.deepEqual(s.lastCompleted?.audit?.findings.map((f) => f.ruleId), ['ci.masked-failure']);
  });

  it('tracks a finding that appears, continues, then is resolved (verified)', async () => {
    const { root, dataDir } = await workspace();
    const svc = await service(root, dataDir);
    const b = await svc.addLocal('beta');
    await writeFile(path.join(root, 'beta/src/gone.ts'), 'export default 1;\n');
    await scanNow(svc, b.id);
    await rm(path.join(root, 'beta/src/gone.ts'));
    await scanNow(svc, b.id);
    let c = svc.latestComparison(b.id)!;
    assert.equal(c.verified, true, c.reasons.join('; '));
    assert.deepEqual(c.new.map((f) => f.ruleId), ['js.unresolved-import']);
    const fp = c.new[0]!.fingerprint;
    await scanNow(svc, b.id);
    c = svc.latestComparison(b.id)!;
    assert.deepEqual(c.continuing.map((f) => f.fingerprint), [fp]);
    assert.deepEqual(c.new, []);
    await writeFile(path.join(root, 'beta/src/gone.ts'), 'export default 1;\n');
    await scanNow(svc, b.id);
    c = svc.latestComparison(b.id)!;
    assert.equal(c.verified, true);
    assert.deepEqual(c.resolved.map((f) => f.fingerprint), [fp]);
  });

  it('does not verify "resolved" when either run was truncated', async () => {
    const { root, dataDir } = await workspace();
    const full = await service(root, dataDir);
    await writeFile(path.join(root, 'beta/README.md'), '# beta\n');
    await writeFile(path.join(root, 'beta/src/z.ts'), 'export {};\n');
    const b = await full.addLocal('beta');
    await scanNow(full, b.id);
    assert.equal(full.latestComparison(b.id)!.new.length, 1);
    const truncated = await service(root, dataDir, { auditLimits: { maxFiles: 1 } });
    await scanNow(truncated, b.id);
    const c = truncated.latestComparison(b.id)!;
    assert.equal(c.verified, false);
    assert.match(c.reasons.join(' '), /this run: scan truncated/);
    assert.equal(c.resolved.length, 1, 'the missing finding is listed but not claimed resolved');
    assert.equal(truncated.summary(truncated.store.repo(b.id)!).completeness?.complete, false);
  });

  it('keeps the last successful report after a failed scan', async () => {
    const { root, dataDir } = await workspace();
    const svc = await service(root, dataDir);
    const a = await svc.addLocal('alpha');
    await scanNow(svc, a.id);
    await rename(path.join(root, 'alpha'), path.join(root, 'alpha-moved'));
    const s = await scanNow(svc, a.id);
    assert.equal(s.latestRun?.status, 'failed');
    assert.equal(s.latestRun?.error?.code, 'NOT_FOUND');
    assert.ok(!s.latestRun!.error!.message.includes(root), 'no absolute paths in errors');
    assert.deepEqual(s.lastCompleted?.audit?.findings.map((f) => f.ruleId), ['ci.masked-failure']);
  });

  it('bounds parallel scans and never runs two scans of one repo at once', async () => {
    const { root, dataDir } = await workspace();
    const svc = await service(root, dataDir, { maxParallel: 1 });
    const store = svc.store;
    const active = new Set<string>();
    let peak = 0;
    const orig = store.putRun.bind(store);
    store.putRun = async (run) => {
      if (run.status === 'running') active.add(run.id);
      else active.delete(run.id);
      peak = Math.max(peak, active.size);
      return orig(run);
    };
    const a = await svc.addLocal('alpha');
    const b = await svc.addLocal('beta');
    const r1 = await svc.scan(a.id);
    const r2 = await svc.scan(a.id);
    assert.equal(r1.id, r2.id, 'second request returns the active run');
    await svc.scan(b.id);
    await svc.idle();
    assert.equal(peak, 1);
  });

  it('reads git HEAD variants without executing git', async () => {
    const detached = await makeRepo({ '.git/HEAD': `${'3'.repeat(40)}\n` });
    assert.equal((await readGitHead(detached)).sha, '3'.repeat(40));
    const none = await makeRepo({ 'a.txt': '' });
    assert.equal((await readGitHead(none)).sha, null);
    const bad = await makeRepo({ '.git/HEAD': 'ref: refs/heads/../../../etc/passwd\n' });
    assert.equal((await readGitHead(bad)).sha, null);
  });

  it('comparison without an earlier run is never verified', () => {
    const head = { id: 'h', repoId: 'r', status: 'completed' as const, queuedAt: '', audit: undefined };
    const c = compareRuns(undefined, head);
    assert.equal(c.verified, false);
    assert.equal(c.baseRunId, null);
  });
});

describe('fleet: no execution of scanned code', () => {
  it('never runs scripts, imports, workflows or builds from local or GitHub repositories', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'repotruth-marker-')), 'EXECUTED');
    const payload = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    const files = {
      'package.json': JSON.stringify({ main: 'index.js', scripts: { preinstall: `node -e "${payload}"`, test: `node -e "${payload}"`, build: `node -e "${payload}"` } }),
      'index.js': `${payload};\nrequire('./lib');\n`,
      'lib.js': `${payload};\n`,
      Makefile: `all:\n\ttouch ${marker}\n`,
      '.github/workflows/ci.yml': wf(`      - run: touch ${marker}\n`),
      'README.md': '```bash\nnpm install\nnpm test\nmake\n```\n',
    };
    const root = await makeRepo(Object.fromEntries(Object.entries(files).map(([k, v]) => [`trap/${k}`, v])));
    const gh = await startGitHubMock([{ fullName: 'org/trap', sha: 'd'.repeat(40), tarball: repoTarball(files) }]);
    try {
      const store = await FleetStore.open(await mkdtemp(path.join(tmpdir(), 'repotruth-data-')));
      const svc = new FleetService({
        store, allowedRoot: root,
        github: new GitHubAppSource({ appId: APP_ID, installationId: INSTALLATION_ID, privateKey: gh.privateKeyPem, apiUrl: gh.url }),
      });
      const local = await svc.addLocal('trap');
      const remote = await svc.addGitHub('org/trap');
      await svc.scan(local.id);
      await svc.scan(remote.id);
      await svc.idle();
      assert.equal(svc.summary(local).latestRun?.status, 'completed');
      assert.equal(svc.summary(remote).latestRun?.status, 'completed');
      await assert.rejects(access(marker));
    } finally {
      await gh.close();
    }
  });
});

describe('fleet: dashboard and API flow', () => {
  async function boot() {
    const { root, dataDir } = await workspace();
    await writeFile(path.join(root, 'alpha/README.md'), '# Alpha\n\n<script>alert(1)</script> is better than everything.\n');
    const svc = await service(root, dataDir);
    const web = await startDashboard(svc, { port: 0 });
    handles.push(web);
    return { root, svc, web };
  }
  const post = (web: WebHandle, p: string, body: Record<string, string>, token: string | null = web.token) =>
    fetch(`${web.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-repotruth-token': token } : {}) }, body: JSON.stringify(body) });

  it('goes from repository selection to finding detail and a comparison', async () => {
    const { root, svc, web } = await boot();
    const added = await post(web, '/api/repos', { path: 'alpha' });
    assert.equal(added.status, 201);
    const repo = await added.json() as { id: string };
    const scan = await post(web, `/api/repos/${repo.id}/scan`, {});
    assert.equal(scan.status, 202);
    await svc.idle();

    const list = await (await fetch(`${web.url}/api/repos`)).json() as { repo: { id: string }; lastCompleted: { audit: { summary: { total: number } } } }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.lastCompleted.audit.summary.total, 2);

    const home = await (await fetch(`${web.url}/`)).text();
    assert.match(home, /alpha/);
    assert.match(home, /Rescan/);
    const detail = await (await fetch(`${web.url}/repos/${repo.id}`)).text();
    assert.match(detail, /CI step masks failure of a test\/lint\/scan command/);
    assert.match(detail, /first scan/);
    const filtered = await (await fetch(`${web.url}/repos/${repo.id}?severity=info`)).text();
    assert.match(filtered, /Findings \(1 of 2\)/);
    const searched = await (await fetch(`${web.url}/repos/${repo.id}?q=workflows`)).text();
    assert.match(searched, /Findings \(1 of 2\)/);

    const api = await (await fetch(`${web.url}/api/repos/${repo.id}`)).json() as { lastCompleted: { audit: { findings: { fingerprint: string; ruleId: string }[] } } };
    const claim = api.lastCompleted.audit.findings.find((f) => f.ruleId === 'claim.unverified-superlative')!;
    const findingPage = await (await fetch(`${web.url}/repos/${repo.id}/findings/${claim.fingerprint}`)).text();
    assert.match(findingPage, /Next action/);
    assert.match(findingPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'untrusted evidence is escaped');
    assert.doesNotMatch(findingPage, /<script>/);

    await writeFile(path.join(root, 'alpha/README.md'), '# Alpha\n');
    await post(web, `/api/repos/${repo.id}/scan`, {});
    await svc.idle();
    const cmp = await (await fetch(`${web.url}/api/repos/${repo.id}/compare`)).json() as { verified: boolean; resolved: { ruleId: string }[]; continuing: unknown[] };
    assert.equal(cmp.verified, true);
    assert.deepEqual(cmp.resolved.map((f) => f.ruleId), ['claim.unverified-superlative']);
    assert.equal(cmp.continuing.length, 1);
    const repoPage = await (await fetch(`${web.url}/repos/${repo.id}`)).text();
    assert.match(repoPage, /Verified comparison/);
    assert.match(repoPage, /Resolved \(1\)/);
  });

  it('uses HTML forms end to end with the page token', async () => {
    const { svc, web } = await boot();
    const home = await (await fetch(`${web.url}/`)).text();
    const token = /name="token" value="([^"]+)"/.exec(home)?.[1];
    assert.equal(token, web.token);
    const res = await fetch(`${web.url}/repos`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token!, path: 'beta' }) });
    assert.equal(res.status, 303);
    const repoUrl = res.headers.get('location')!;
    const scan = await fetch(`${web.url}${repoUrl}/scan`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token! }) });
    assert.equal(scan.status, 303);
    await svc.idle();
    assert.match(await (await fetch(`${web.url}${repoUrl}`)).text(), /Relative import &quot;\.\/gone&quot;/);
  });

  it('shows a failed rescan next to the last successful report', async () => {
    const { root, svc, web } = await boot();
    const repo = await (await post(web, '/api/repos', { path: 'alpha' })).json() as { id: string };
    await post(web, `/api/repos/${repo.id}/scan`, {});
    await svc.idle();
    await rename(path.join(root, 'alpha'), path.join(root, 'gone'));
    await post(web, `/api/repos/${repo.id}/scan`, {});
    await svc.idle();
    const page = await (await fetch(`${web.url}/repos/${repo.id}`)).text();
    assert.match(page, /Latest scan failed/);
    assert.match(page, /The report below is the last successful scan/);
    assert.match(page, /CI step masks failure/);
  });

  it('rejects writes without the token, foreign Host headers, and non-loopback binding', async () => {
    const { web } = await boot();
    assert.equal((await post(web, '/api/repos', { path: 'alpha' }, null)).status, 403);
    assert.equal((await post(web, '/api/repos', { path: 'alpha' }, 'wrong')).status, 403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(web.url);
      request({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end();
    });
    assert.equal(status, 421);
    const r = await fetch(`${web.url}/`);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const store = await FleetStore.open(await mkdtemp(path.join(tmpdir(), 'repotruth-data-')));
    await assert.rejects(startDashboard(new FleetService({ store }), { host: '0.0.0.0', port: 0 }), /loopback/);
    const bad = await post(web, '/api/repos', { path: '../..' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: { code: string } }).error.code, 'OUTSIDE_ALLOWED_ROOT');
  });

  it('lists and selects GitHub repositories through the dashboard when an App is configured', async () => {
    const gh = await startGitHubMock([
      { fullName: 'org/one', sha: 'e'.repeat(40), tarball: repoTarball({ 'a.ts': "import x from './nope';\n" }) },
      { fullName: 'org/two', sha: 'f'.repeat(40), tarball: repoTarball({ 'b.ts': 'export {};\n' }) },
    ]);
    try {
      const store = await FleetStore.open(await mkdtemp(path.join(tmpdir(), 'repotruth-data-')));
      const svc = new FleetService({ store, github: new GitHubAppSource({ appId: APP_ID, installationId: INSTALLATION_ID, privateKey: gh.privateKeyPem, apiUrl: gh.url }) });
      const web = await startDashboard(svc, { port: 0 });
      handles.push(web);
      const home = await (await fetch(`${web.url}/?github=1`)).text();
      assert.match(home, /org\/one/);
      assert.match(home, /org\/two/);
      const repo = await (await post(web, '/api/repos', { github: 'org/one' })).json() as { id: string };
      await post(web, `/api/repos/${repo.id}/scan`, {});
      await svc.idle();
      const detail = await (await fetch(`${web.url}/repos/${repo.id}`)).text();
      assert.match(detail, /eeeeeeeeee/);
      assert.match(detail, /Relative import/);
      assert.match(await (await fetch(`${web.url}/`)).text(), /last API call succeeded/);
    } finally {
      await gh.close();
    }
  });
});

describe('fleet: store robustness', () => {
  it('refuses a corrupt store file instead of silently starting empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'repotruth-data-'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'fleet.json'), '{ not json');
    await assert.rejects(FleetStore.open(dir), /cannot read/);
  });
});
