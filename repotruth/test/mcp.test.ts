// Integration tests for the MCP adapter. The server is launched as a real
// child process and driven through the official MCP client over stdio.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { main as cliMain } from '../src/cli.js';
import { resolveTarget, TargetError } from '../src/mcp/policy.js';
import { parseArgs } from '../src/mcp/server.js';
import { boundResponse } from '../src/mcp/tool.js';
import { auditRepository } from '../src/audit.js';
import { makeRepo, wf } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/bin.js');

interface Session {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

const sessions: Session[] = [];
after(async () => { await Promise.all(sessions.map((s) => s.close())); });

async function connect(allowedRoot: string, extra: string[] = []): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--allowed-root', allowedRoot, ...extra],
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '' },
  });
  let err = '';
  transport.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  const client = new Client({ name: 'repotruth-test', version: '0.0.0' });
  await client.connect(transport);
  const s = { client, stderr: () => err, close: () => client.close() };
  sessions.push(s);
  return s;
}

type Structured = Record<string, any>;
async function call(s: Session, args: Record<string, unknown>): Promise<{ isError: boolean; data: Structured; text: string }> {
  const r = await s.client.callTool({ name: 'audit_repository', arguments: args });
  const content = r.content as { type: string; text?: string }[];
  return { isError: r.isError === true, data: (r.structuredContent ?? {}) as Structured, text: content[0]?.text ?? '' };
}

/** A workspace root holding several fixture repositories. */
async function workspace(repos: Record<string, Record<string, string>>): Promise<string> {
  const root = await makeRepo({});
  for (const [name, files] of Object.entries(repos)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, name, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
  return root;
}

const NOISY = {
  'README.md': '# x\n\n```bash\nnpm install\n```\n\n## License\nMIT\n',
  LICENSE: 'PROPRIETARY\nALL RIGHTS RESERVED\nNo use is permitted.\n',
  '.github/workflows/ci.yml': wf('      - run: npm test || true\n      - run: npx eslint . || true\n'),
  'src/a.ts': "import x from './missing';\n// Simulate the engine for now\n",
};

describe('MCP adapter over stdio (real client)', () => {
  it('lists exactly one read-only tool with input and output schemas', async () => {
    const s = await connect(await workspace({ r: { 'a.ts': 'export {};\n' } }));
    const { tools } = await s.client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['audit_repository']);
    const tool = tools[0]!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['maxFileBytes', 'maxFiles', 'maxTotalBytes', 'path', 'timeoutMs']);
    assert.ok(tool.outputSchema);
  });

  it('audits a fixture and agrees with the CLI on every finding', async () => {
    const root = await workspace({ noisy: NOISY });
    const s = await connect(root);
    const r = await call(s, { path: 'noisy' });
    assert.equal(r.isError, false);
    assert.equal(r.data.schemaVersion, '1.0.0');
    assert.deepEqual(r.data.target, { name: 'noisy', path: 'noisy' });
    assert.equal(r.data.response.truncated, false);
    assert.ok(r.data.findings.some((f: Structured) => f.status === 'needs-review'));

    let out = '';
    const code = await cliMain(['audit', path.join(root, 'noisy'), '--format', 'json'], { stdout: (x) => { out += x; }, stderr: () => {} });
    assert.equal(code, 1);
    const cli = JSON.parse(out);
    const key = (f: Structured) => `${f.ruleId}|${f.status}|${f.severity}|${f.confidence}|${f.location.path}:${f.location.line}|${f.fingerprint}`;
    assert.deepEqual(r.data.findings.map(key), cli.findings.map(key));
    assert.deepEqual(r.data.summary, cli.summary);
    assert.deepEqual(r.data.coverage, cli.coverage);
    assert.ok(!JSON.stringify(r.data).includes(root), 'no absolute paths in the response');
  });

  it('reports zero findings, unsupported inputs and scan truncation explicitly', async () => {
    const root = await workspace({
      clean: { 'a.ts': 'export const a = 1;\n' },
      lua: { 'x.lua': 'return 1\n' },
      many: { 'a.ts': '', 'b.ts': '', 'c.ts': '', 'd.ts': '' },
    });
    const s = await connect(root);
    const clean = await call(s, { path: 'clean' });
    assert.equal(clean.data.summary.total, 0);
    assert.ok(clean.data.coverage.evaluated.length > 0);

    const lua = await call(s, { path: 'lua' });
    assert.equal(lua.isError, false);
    assert.equal(lua.data.coverage.evaluated.length, 0);
    assert.ok(lua.data.coverage.notEvaluated.some((e: Structured) => e.detail.includes('lua')));
    assert.match(lua.text, /NOT a clean bill of health/);

    const trunc = await call(s, { path: 'many', maxFiles: 2 });
    assert.equal(trunc.data.limits.truncated, true);
    assert.equal(trunc.data.limits.maxFiles, 2);
    assert.match(trunc.text, /SCAN TRUNCATED/);
  });

  it('bounds the response size and says exactly what was omitted', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => `      - run: pytest tests/t${i}.py || true\n`).join('');
    const root = await workspace({ big: { 'app.py': 'x=1\n', '.github/workflows/ci.yml': wf(steps), 'README.md': 'better than numpy\n' } });
    const s = await connect(root, ['--max-response-bytes', '8000']);
    const r = await call(s, { path: 'big' });
    assert.equal(r.isError, false);
    const resp = r.data.response;
    assert.equal(resp.truncated, true);
    assert.equal(resp.findingsTotal, r.data.summary.total);
    assert.ok(resp.findingsReturned > 0 && resp.findingsReturned < resp.findingsTotal);
    const omitted = Object.values(resp.omittedBySeverity as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(resp.findingsReturned + omitted, resp.findingsTotal);
    assert.ok(r.data.findings.every((f: Structured) => f.severity === 'high'), 'highest severity kept first');
    assert.match(r.text, /RESPONSE TRUNCATED: returned \d+ of \d+ findings/);
    assert.match(resp.fullReport, /repotruth audit ".*big" --format json/);
    assert.ok(Buffer.byteLength(JSON.stringify(r.data)) <= 8000);
  });

  it('rejects invalid arguments without killing the server', async () => {
    const s = await connect(await workspace({ r: { 'a.ts': '' } }));
    for (const args of [{ bogus: 1 }, { maxFiles: 0 }, { maxFiles: 999999 }, { path: 42 }, { path: '' }]) {
      const r = await call(s, args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, /Input validation error/);
    }
    assert.equal((await call(s, { path: 'r' })).isError, false);
  });

  it('distinguishes missing, non-directory and URL targets with error codes', async () => {
    const root = await workspace({ r: { 'file.txt': 'x' } });
    const s = await connect(root);
    const cases: [Record<string, unknown>, string][] = [
      [{ path: 'does-not-exist' }, 'NOT_FOUND'],
      [{ path: 'r/file.txt' }, 'NOT_A_DIRECTORY'],
      [{ path: 'https://github.com/org/repo' }, 'URL_NOT_SUPPORTED'],
      [{ path: 'git@github.com:org/repo.git' }, 'URL_NOT_SUPPORTED'],
    ];
    for (const [args, code] of cases) {
      const r = await call(s, args);
      assert.equal(r.isError, true);
      assert.equal(r.data.error.code, code, JSON.stringify(args));
      assert.ok(!r.text.includes(root), 'error text does not leak the absolute root');
    }
  });

  it('reports unreadable targets as UNREADABLE', { skip: process.getuid?.() === 0 ? 'running as root: permissions not enforced' : false }, async () => {
    const root = await workspace({ locked: { 'a.ts': '' } });
    await chmod(path.join(root, 'locked'), 0o000);
    try {
      const s = await connect(root);
      const r = await call(s, { path: 'locked' });
      assert.equal(r.isError, true);
      assert.equal(r.data.error.code, 'UNREADABLE');
      assert.ok(!r.text.includes(root));
    } finally {
      await chmod(path.join(root, 'locked'), 0o755);
    }
  });

  it('rejects ../ traversal, outside absolute paths and symlink escapes', async () => {
    const outside = await makeRepo({ 'secret.ts': "import x from './nope';\n" });
    const root = await workspace({ r: { 'a.ts': '' } });
    await symlink(outside, path.join(root, 'escape'));
    await symlink(path.join(root, 'r'), path.join(root, 'inside-link'));
    const s = await connect(root);
    for (const p of ['..', '../', 'r/../..', `../${path.basename(outside)}`, outside, 'escape', 'escape/']) {
      const r = await call(s, { path: p });
      assert.equal(r.isError, true, p);
      assert.equal(r.data.error.code, 'OUTSIDE_ALLOWED_ROOT', p);
    }
    const ok = await call(s, { path: 'inside-link' });
    assert.equal(ok.isError, false);
    assert.equal(ok.data.target.path, 'r');
  });

  it('serves consecutive and concurrent requests independently after an error', async () => {
    const root = await workspace({ noisy: NOISY, clean: { 'a.ts': 'export {};\n' } });
    const s = await connect(root);
    assert.equal((await call(s, { path: '../..' })).isError, true);
    const [a, b] = await Promise.all([call(s, { path: 'noisy' }), call(s, { path: 'clean' })]);
    assert.equal(a.data.target.path, 'noisy');
    assert.equal(b.data.target.path, 'clean');
    assert.ok(a.data.summary.total > 0);
    assert.equal(b.data.summary.total, 0);
    assert.deepEqual(b.data.findings, []);
    const again = await call(s, { path: 'noisy' });
    assert.deepEqual(again.data.findings.map((f: Structured) => f.fingerprint), a.data.findings.map((f: Structured) => f.fingerprint));
  });

  it('never executes code from the target repository', async () => {
    const root = await workspace({ trap: {} });
    const repo = path.join(root, 'trap');
    const marker = path.join(root, 'EXECUTED');
    await mkdir(repo, { recursive: true });
    const payload = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ main: 'index.js', scripts: { preinstall: `node -e "${payload}"`, test: `node -e "${payload}"` } }));
    await writeFile(path.join(repo, 'index.js'), `${payload};\nrequire('./lib');\n`);
    await writeFile(path.join(repo, 'lib.js'), `${payload};\n`);
    await writeFile(path.join(repo, 'Makefile'), `all:\n\ttouch ${marker}\n`);
    await mkdir(path.join(repo, '.github/workflows'), { recursive: true });
    await writeFile(path.join(repo, '.github/workflows/ci.yml'), wf(`      - run: touch ${marker}\n`));
    const s = await connect(root);
    const r = await call(s, { path: 'trap' });
    assert.equal(r.isError, false);
    await assert.rejects(access(marker));
  });

  it('writes only JSON-RPC messages to stdout', async () => {
    const root = await workspace({ noisy: NOISY });
    const child = spawn(process.execPath, [BIN, '--allowed-root', root], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && out.split('\n').filter(Boolean).length < n; i++) await new Promise((r) => setTimeout(r, 25));
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'audit_repository', arguments: { path: 'noisy' } } });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'audit_repository', arguments: { path: '../../etc' } } });
    await waitFor(3);
    child.stdin.end();
    const exit = await new Promise<number | null>((r) => child.on('exit', r));
    const lines = out.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0');
    assert.equal(exit, 0, 'exits cleanly when stdin closes');
    assert.equal(err, 'repotruth-mcp 0.1.0: serving 1 tool on stdio\n');
    assert.ok(!err.includes(root));
  });

  it('refuses to start without a valid allowed root', async () => {
    for (const args of [[], ['--allowed-root', '/definitely/not/here'], ['--max-response-bytes', '5']]) {
      const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      const code = await new Promise<number | null>((r) => child.on('exit', r));
      assert.equal(code, 2, args.join(' '));
      assert.equal(out, '');
      assert.match(err, /^repotruth-mcp: /);
    }
  });
});

describe('MCP adapter units', () => {
  it('resolveTarget canonicalizes and enforces the root', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repotruth-root-')));
    await mkdir(path.join(root, '..hidden'));
    await mkdir(path.join(root, 'sub'));
    assert.deepEqual((await resolveTarget(root, undefined)).display, '.');
    assert.deepEqual((await resolveTarget(root, 'sub/')).display, 'sub');
    assert.deepEqual((await resolveTarget(root, '..hidden')).display, '..hidden');
    await assert.rejects(resolveTarget(root, '../x'), (e: unknown) => e instanceof TargetError && e.code === 'OUTSIDE_ALLOWED_ROOT');
    await assert.rejects(resolveTarget(root, 'a\0b'), (e: unknown) => e instanceof TargetError && e.code === 'INVALID_ARGUMENT');
  });

  it('boundResponse keeps full counts and never exceeds the budget', async () => {
    const root = await makeRepo({ 'README.md': '```\nnpm install\n```\n', 'x.ts': "import a from './gone';\n" });
    const result = await auditRepository(root);
    const full = boundResponse(result, '.', { allowedRoot: root, maxResponseBytes: 1_000_000 });
    assert.equal(full.response.truncated, false);
    const tiny = boundResponse(result, '.', { allowedRoot: root, maxResponseBytes: 2048 });
    assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 2048);
    assert.equal(tiny.summary.total, result.findings.length);
    const capped = boundResponse({ ...result, skipped: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, reason: 'binary file' })) }, '.', { allowedRoot: root, maxResponseBytes: 1_000_000, maxSkippedEntries: 2 });
    assert.equal(capped.response.truncated, true);
    assert.equal(capped.response.skippedTotal, 5);
    assert.equal(capped.skipped.length, 2);
    const longPaths = { ...result, skipped: Array.from({ length: 100 }, (_, i) => ({ path: `${'d/'.repeat(1000)}f${i}`, reason: 'binary file' })) };
    const fitted = boundResponse(longPaths, '.', { allowedRoot: root, maxResponseBytes: 20_000 });
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 20_000);
    assert.equal(fitted.response.truncated, true);
    assert.ok(fitted.response.skippedReturned < 100);
    assert.equal(fitted.response.skippedTotal, 100);
  });

  it('parseArgs requires sane options', () => {
    assert.equal(typeof parseArgs(['--bogus'], {}), 'string');
    assert.equal(typeof parseArgs(['--max-response-bytes', '10'], {}), 'string');
    assert.deepEqual(parseArgs([], { REPOTRUTH_ALLOWED_ROOT: '/w' }), { allowedRoot: '/w', maxResponseBytes: 100_000 });
    assert.deepEqual(parseArgs(['--allowed-root=/a', '--max-response-bytes=4096'], {}), { allowedRoot: '/a', maxResponseBytes: 4096 });
  });
});
