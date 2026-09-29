import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { FleetService } from '../src/fleet/service.js';
import { DEFAULT_GITHUB_LIMITS, GitHubAppSource, GitHubError, nextLink, type GitHubLimits } from '../src/fleet/sources/github.js';
import { extractTarGz, safeEntryPath } from '../src/fleet/sources/tar.js';
import { FleetStore } from '../src/fleet/store.js';
import { APP_ID, INSTALLATION_ID, startGitHubMock, type GitHubMock } from './githubmock.js';
import { makeRepo, wf } from './helpers.js';
import { paxRecord, repoTarball, tgz } from './tarfixture.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const mocks: GitHubMock[] = [];
after(async () => { await Promise.all(mocks.map((m) => m.close())); });

async function mock(): Promise<GitHubMock> {
  const m = await startGitHubMock([
    { fullName: 'org/alpha', sha: SHA_A, tarball: repoTarball({ 'README.md': '```bash\nnpm install\n```\n', '.github/workflows/ci.yml': wf('      - run: npm test || true\n') }) },
    { fullName: 'org/beta', sha: SHA_B, tarball: repoTarball({ 'src/a.ts': "import x from './gone';\n" }) },
    { fullName: 'org/gamma', sha: 'c'.repeat(40), tarball: repoTarball({ 'a.ts': 'export {};\n' }) },
  ]);
  mocks.push(m);
  return m;
}

function source(m: GitHubMock, limits: Partial<GitHubLimits> = {}, now?: () => number, sleeps: number[] = []): GitHubAppSource {
  return new GitHubAppSource(
    { appId: APP_ID, installationId: INSTALLATION_ID, privateKey: m.privateKeyPem, apiUrl: m.url },
    { ...DEFAULT_GITHUB_LIMITS, maxRateLimitWaitMs: 5_000, ...limits },
    fetch,
    now ?? Date.now,
    async (ms) => { sleeps.push(ms); },
  );
}

async function fleet(m: GitHubMock, gh = source(m)) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'repotruth-ghdata-'));
  const tmp = await mkdtemp(path.join(tmpdir(), 'repotruth-ghtmp-'));
  const store = await FleetStore.open(dataDir);
  return { svc: new FleetService({ store, github: gh, tmpDir: tmp }), tmp, dataDir, store };
}

describe('GitHub App source (mocked API)', () => {
  it('authenticates with a signed App JWT and lists all pages of accessible repositories', async () => {
    const m = await mock();
    const repos = await source(m).listRepositories();
    assert.deepEqual(repos.map((r) => r.fullName), ['org/alpha', 'org/beta', 'org/gamma']);
    assert.equal(m.tokensIssued, 1);
    assert.equal(m.log.filter((l) => l.startsWith('GET /installation/repositories')).length, 2, 'followed the Link rel="next" page');
  });

  it('parses Link headers', () => {
    assert.equal(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=5>; rel="last"'), 'https://x/a?page=2');
    assert.equal(nextLink('<https://x/a?page=1>; rel="prev"'), null);
    assert.equal(nextLink(null), null);
  });

  it('selects, scans and stores a GitHub repository end to end, then removes the snapshot', async () => {
    const m = await mock();
    const { svc, tmp, dataDir } = await fleet(m);
    const repo = await svc.addGitHub('org/alpha');
    await svc.scan(repo.id);
    await svc.idle();
    const s = svc.summary(repo);
    assert.equal(s.latestRun?.status, 'completed', JSON.stringify(s.latestRun?.error));
    assert.equal(s.latestRun?.source?.commitSha, SHA_A);
    // The snapshot has a workflow running npm but no package.json: stack mismatch is correct here.
    assert.deepEqual(s.lastCompleted?.audit?.findings.map((f) => f.ruleId).sort(), ['ci.masked-failure', 'ci.stack-mismatch', 'setup.readme-manifest-missing']);
    assert.ok(s.lastCompleted?.audit?.findings.every((f) => !f.location.path.includes('org-repo')), 'archive prefix stripped');
    assert.deepEqual(await readdir(tmp), [], 'temporary snapshot deleted');
    assert.deepEqual(m.codeloadAuth, [undefined], 'installation token never sent to the redirect target');
    const stored = await readFile(path.join(dataDir, 'fleet.json'), 'utf8');
    assert.ok(!stored.includes('ghs_mock_'), 'tokens are not persisted');
    assert.equal(svc.githubStatus().lastContact?.ok, true);
  });

  it('refuses repositories the installation cannot access, and keeps the last report when access is lost', async () => {
    const m = await mock();
    const { svc } = await fleet(m);
    await assert.rejects(svc.addGitHub('org/secret'), (e: unknown) => e instanceof GitHubError && e.code === 'NOT_ACCESSIBLE');
    for (const bad of ['../etc', 'org/..', './x', 'org/.', 'a/b/c', 'org']) {
      await assert.rejects(svc.addGitHub(bad), (e: unknown) => (e as { code?: string }).code === 'INVALID_REPO_NAME', bad);
    }
    const repo = await svc.addGitHub('org/beta');
    await svc.scan(repo.id);
    await svc.idle();
    m.repos.get('org/beta')!.hidden = true;
    await svc.scan(repo.id);
    await svc.idle();
    const s = svc.summary(repo);
    assert.equal(s.latestRun?.status, 'failed');
    assert.equal(s.latestRun?.error?.code, 'NOT_ACCESSIBLE');
    assert.equal(s.lastCompleted?.audit?.findings[0]?.ruleId, 'js.unresolved-import', 'previous successful report still available');
  });

  it('refreshes the installation token on 401 and before expiry', async () => {
    const m = await mock();
    let now = Date.now();
    const gh = source(m, {}, () => now);
    await gh.listRepositories();
    assert.equal(m.tokensIssued, 1);
    m.overrides.push((req, res) => {
      if (!req.url?.startsWith('/repos/')) return false;
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); return true;
    });
    await gh.getRepository('org/alpha');
    assert.equal(m.tokensIssued, 2, 'token refreshed after 401');
    now += 2 * 60 * 60_000; // past the 1h expiry
    await gh.getRepository('org/alpha');
    assert.equal(m.tokensIssued, 3, 'token refreshed after expiry');
  });

  it('waits out a short rate limit, and fails clearly on a long one', async () => {
    const m = await mock();
    const sleeps: number[] = [];
    const gh = source(m, {}, undefined, sleeps);
    m.overrides.push((req, res) => {
      if (!req.url?.startsWith('/repos/')) return false;
      res.writeHead(403, { 'retry-after': '2', 'content-type': 'application/json' }); res.end('{}'); return true;
    });
    assert.equal((await gh.getRepository('org/alpha')).fullName, 'org/alpha');
    assert.deepEqual(sleeps, [2000]);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    m.overrides.push((req, res) => {
      if (!req.url?.startsWith('/repos/')) return false;
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }); res.end('{}'); return true;
    });
    await assert.rejects(gh.getRepository('org/alpha'), (e: unknown) => e instanceof GitHubError && e.code === 'RATE_LIMITED' && /until/.test(e.message));
    assert.equal(gh.lastContact?.ok, false);
  });

  it('retries one 5xx, then reports API errors without crashing the fleet', async () => {
    const m = await mock();
    const gh = source(m);
    const fail500 = (req: { url?: string }, res: import('node:http').ServerResponse) => {
      if (!req.url?.startsWith('/repos/')) return false;
      res.writeHead(502); res.end(); return true;
    };
    m.overrides.push(fail500);
    assert.equal((await gh.getRepository('org/alpha')).fullName, 'org/alpha');
    const { svc } = await fleet(m, gh);
    const repo = await svc.addGitHub('org/alpha');
    m.overrides.push(fail500, fail500);
    await svc.scan(repo.id);
    await svc.idle();
    assert.equal(svc.summary(repo).latestRun?.error?.code, 'API_ERROR');
  });

  it('rejects oversized downloads, both declared and streamed', async () => {
    const m = await mock();
    const { randomBytes } = await import('node:crypto');
    const big = repoTarball({ 'a.txt': randomBytes(50_000).toString('base64') }); // incompressible
    m.repos.get('org/alpha')!.tarball = big;
    const { svc } = await fleet(m, source(m, { maxDownloadBytes: 1000 }));
    const repo = await svc.addGitHub('org/alpha');
    await svc.scan(repo.id);
    await svc.idle();
    assert.equal(svc.summary(repo).latestRun?.error?.code, 'DOWNLOAD_TOO_LARGE');
    // No content-length: the streaming counter must stop it.
    m.overrides.push((req, res) => {
      if (!req.url?.startsWith('/codeload/')) return false;
      res.writeHead(200, { 'content-type': 'application/x-gzip' }); res.end(big); return true;
    });
    await svc.scan(repo.id);
    await svc.idle();
    assert.equal(svc.summary(repo).latestRun?.error?.code, 'DOWNLOAD_TOO_LARGE');
  });

  it('refuses a malformed private key and partial configuration', async () => {
    assert.throws(() => new GitHubAppSource({ appId: '1', installationId: '2', privateKey: 'not a key' }), (e: unknown) => e instanceof GitHubError && e.code === 'NOT_CONFIGURED');
    const { githubConfigFromEnv } = await import('../src/fleet/sources/github.js');
    assert.equal(await githubConfigFromEnv({}, async () => ''), null);
    await assert.rejects(githubConfigFromEnv({ REPOTRUTH_GH_APP_ID: '1' }, async () => ''), GitHubError);
  });
});

describe('untrusted archive extraction', () => {
  async function extract(buf: Buffer, limits = { maxExtractBytes: 10_000_000, maxEntries: 1000, maxFileBytes: 100_000 }) {
    const parent = await makeRepo({});
    const dest = path.join(parent, 'dest');
    await mkdir(dest);
    const result = await extractTarGz(buf, dest, limits);
    return { parent, dest, result };
  }

  it('normalizes paths and rejects traversal, absolute paths and NUL', () => {
    assert.equal(safeEntryPath('pre/a/./b.txt'), 'a/b.txt');
    assert.equal(safeEntryPath('pre/../../etc/passwd'), null);
    assert.equal(safeEntryPath('/etc/passwd'), null);
    assert.equal(safeEntryPath('C:\\x'), null);
    assert.equal(safeEntryPath('pre/a\0b'), null);
    assert.equal(safeEntryPath('pre'), '');
  });

  it('never writes outside the destination, and never materializes links', async () => {
    const buf = tgz([
      { name: 'pre/', type: '5' },
      { name: 'pre/ok.txt', body: 'fine' },
      { name: 'pre/../../escape.txt', body: 'evil' },
      { name: '/abs.txt', body: 'evil' },
      { name: 'pre/link', type: '2', linkname: '/etc/passwd' },
      { name: 'pre/hard', type: '1', linkname: 'pre/ok.txt' },
      { name: 'pre/node_modules/pkg/index.js', body: 'x' },
      { name: 'pre/dup.txt', body: '1' },
      { name: 'pre/dup.txt', body: '2' },
    ]);
    const { parent, dest, result } = await extract(buf);
    assert.deepEqual((await readdir(dest)).sort(), ['dup.txt', 'ok.txt']);
    assert.deepEqual((await readdir(parent)).sort(), ['dest']);
    const reasons = result.skipped.map((s) => s.reason);
    assert.ok(reasons.includes('unsafe path in archive (absolute, "..", or NUL)'));
    assert.ok(reasons.includes('symlink in archive (not extracted)'));
    assert.ok(reasons.includes('hard link in archive (not extracted)'));
    assert.ok(reasons.includes('duplicate path in archive'));
    assert.equal((await stat(path.join(dest, 'ok.txt'))).mode & 0o111, 0, 'nothing is executable');
  });

  it('honors pax long paths', async () => {
    const long = `pre/${'d/'.repeat(80)}deep.txt`;
    const { dest } = await extract(tgz([{ name: 'pax', type: 'x', body: paxRecord('path', long) }, { name: 'short', body: 'deep' }]));
    assert.equal(await readFile(path.join(dest, long.slice(4)), 'utf8'), 'deep');
  });

  it('caps per-file size, entry count, and decompressed size (gzip bomb)', async () => {
    const big = await extract(tgz([{ name: 'pre/big.bin', body: Buffer.alloc(200_000) }, { name: 'pre/small.txt', body: 's' }]));
    assert.equal(big.result.truncated, true);
    assert.deepEqual(await readdir(big.dest), ['small.txt']);

    const many = await extract(tgz(Array.from({ length: 20 }, (_, i) => ({ name: `pre/f${i}.txt`, body: 'x' }))), { maxExtractBytes: 10_000_000, maxEntries: 5, maxFileBytes: 1000 });
    assert.equal(many.result.truncated, true);
    assert.equal((await readdir(many.dest)).length, 5);

    const bombBuf = tgz([{ name: 'pre/zeros.bin', body: Buffer.alloc(20_000_000) }]);
    assert.ok(bombBuf.length < 100_000, 'highly compressible input');
    const bomb = await extract(bombBuf, { maxExtractBytes: 1_000_000, maxEntries: 1000, maxFileBytes: 50_000_000 });
    assert.equal(bomb.result.truncated, true);
    assert.match(bomb.result.notes.join(' '), /maxExtractBytes/);
    assert.deepEqual(await readdir(bomb.dest), []);
  });

  it('reports a corrupt archive as an error, not a partial success', async () => {
    const parent = await makeRepo({});
    await assert.rejects(extractTarGz(Buffer.from('not gzip at all'), parent, { maxExtractBytes: 1e6, maxEntries: 10, maxFileBytes: 1e6 }));
  });

  it('marks GitHub runs with source truncation as incomplete', async () => {
    const m = await mock();
    m.repos.get('org/gamma')!.tarball = tgz([{ name: 'p/', type: '5' }, { name: 'p/a.ts', body: 'export {};\n' }, { name: 'p/big.bin', body: Buffer.alloc(5000) }]);
    const { svc } = await fleet(m, source(m, { maxFileBytes: 1000 }));
    const repo = await svc.addGitHub('org/gamma');
    await svc.scan(repo.id);
    await svc.idle();
    const s = svc.summary(repo);
    assert.equal(s.latestRun?.status, 'completed');
    assert.equal(s.completeness?.complete, false);
    assert.match(s.completeness!.reasons.join(' '), /source truncated/);
  });
});
