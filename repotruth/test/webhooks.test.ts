// Webhook signature verification, replay protection, and the transport wiring
// in the existing loopback dashboard.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { FleetService } from '../src/fleet/service.js';
import { FleetStore } from '../src/fleet/store.js';
import type { RepoRecord } from '../src/fleet/types.js';
import { startDashboard, type WebHandle } from '../src/fleet/web.js';
import { DeliveryCache, WebhookReceiver, parsePush, verifySignature } from '../src/fleet/webhooks.js';

const SECRET = 'a-shared-webhook-secret';
const SHA = 'c'.repeat(40);
const WIDGETS: RepoRecord = { id: 'github-abc123', kind: 'github', locator: 'acme/widgets', name: 'acme/widgets', addedAt: '2026-01-01T00:00:00.000Z', defaultBranch: 'main' };

const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

function pushBody(fullName: string, ref = 'refs/heads/main', head = SHA, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ref, after: head, repository: { full_name: fullName }, ...extra });
}

let seq = 0;
const nextDelivery = (): string => `delivery-${++seq}`;

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'repotruth-wh-'));

async function fixture(repos: RepoRecord[] = [WIDGETS]): Promise<{ svc: FleetService; receiver: WebhookReceiver; repo: RepoRecord }> {
  const store = await FleetStore.open(await tmpDir());
  for (const r of repos) await store.addRepo(r);
  const svc = new FleetService({ store, allowedRoot: await tmpDir() });
  return { svc, receiver: new WebhookReceiver({ service: svc, secret: SECRET }), repo: repos[0]! };
}

async function boot(secret?: string): Promise<{ web: WebHandle; svc: FleetService; repo: RepoRecord }> {
  const { svc, repo } = await fixture();
  const web = await startDashboard(svc, { port: 0, webhooks: secret ? new WebhookReceiver({ service: svc, secret }) : undefined });
  closers.push(async () => { await web.close(); await svc.idle(); });
  return { web, svc, repo };
}

async function deliver(web: WebHandle, body: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${web.url}/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const codeOf = (body: Record<string, unknown>): string => (body.error as { code: string }).code;

describe('webhook signature', () => {
  it('accepts a correct sha256 signature over the exact bytes', () => {
    const body = '{"ref":"refs/heads/main"}';
    assert.doesNotThrow(() => verifySignature(SECRET, Buffer.from(body, 'utf8'), sign(body)));
  });

  it('rejects a signature made with a different secret, and a body one byte off the signed bytes', () => {
    assert.throws(() => verifySignature(SECRET, Buffer.from('{}', 'utf8'), sign('{}', 'other-secret')), /missing or invalid/);
    assert.throws(() => verifySignature(SECRET, Buffer.from('{"a":2}', 'utf8'), sign('{"a":1}')), /missing or invalid/);
  });

  it('gives the same answer for a missing header, a wrong prefix, and a malformed digest', () => {
    const failures = new Set<string>();
    for (const header of [undefined, '', 'sha1=' + 'a'.repeat(40), 'sha256=nothex', 'sha256=' + 'a'.repeat(63), 'sha256=' + 'a'.repeat(65)]) {
      try { verifySignature(SECRET, Buffer.from('{}', 'utf8'), header); assert.fail('expected a throw'); }
      catch (err) { failures.add(`${(err as { code: string }).code}: ${(err as Error).message}`); }
    }
    assert.equal(failures.size, 1, 'the failure must not distinguish which part was wrong');
  });

  it('accepts an upper-case digest, and reports NOT_CONFIGURED when no secret is set', () => {
    const body = Buffer.from('{}', 'utf8');
    assert.doesNotThrow(() => verifySignature(SECRET, body, sign('{}').toUpperCase().replace('SHA256=', 'sha256=')));
    assert.throws(() => verifySignature('', body, sign('{}')), (err: { code: string }) => err.code === 'NOT_CONFIGURED');
  });
});

describe('DeliveryCache', () => {
  it('reports a replay, forgets on request, and stays bounded', () => {
    const cache = new DeliveryCache(2);
    assert.equal(cache.add('a'), true);
    assert.equal(cache.add('a'), false);
    cache.forget('a');
    assert.equal(cache.add('a'), true);
    cache.add('b');
    cache.add('c');
    assert.equal(cache.size, 2, 'the oldest id is evicted at the limit');
  });
});

describe('parsePush', () => {
  it('extracts repository, branch and head commit', () => {
    assert.deepEqual(parsePush(Buffer.from(pushBody('acme/widgets'), 'utf8')), { fullName: 'acme/widgets', branch: 'main', sha: SHA, deleted: false });
  });

  it('rejects non-JSON, a missing or unsafe full_name, and a non-branch ref', () => {
    for (const body of ['not json', '{}', JSON.stringify({ repository: { full_name: '../evil' }, ref: 'refs/heads/main' }), JSON.stringify({ repository: { full_name: 'a/b' }, ref: 'refs/tags/v1' })]) {
      assert.throws(() => parsePush(Buffer.from(body, 'utf8')), (err: { code: string }) => err.code === 'BAD_PAYLOAD', body);
    }
  });

  it('marks a branch deletion', () => {
    assert.equal(parsePush(Buffer.from(pushBody('acme/widgets', 'refs/heads/main', SHA, { deleted: true }), 'utf8')).deleted, true);
  });
});

describe('WebhookReceiver', () => {
  it('queues a scan for a push to the default branch of a selected repository', async () => {
    const { receiver, repo, svc } = await fixture();
    const body = pushBody('acme/widgets');
    const result = await receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.repository, 'acme/widgets');
    assert.equal(result.body.runId !== undefined, true);
    await svc.idle();
    assert.equal(svc.store.runs(repo.id).length, 1);
  });

  it('answers a replayed delivery with an idempotent 200 and no second scan', async () => {
    const { receiver, repo, svc } = await fixture();
    const body = pushBody('acme/widgets');
    const headers = { event: 'push', delivery: nextDelivery(), signature: sign(body) };
    const first = await receiver.handle(headers, Buffer.from(body, 'utf8'));
    await svc.idle();
    const second = await receiver.handle(headers, Buffer.from(body, 'utf8'));
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.runId, undefined, 'a replay must not report a new run');
    assert.equal(svc.store.runs(repo.id).length, 1);
    assert.equal(first.body.duplicate, false);
  });

  it('rejects an unsigned or mis-signed delivery before it reaches the service', async () => {
    const { receiver, repo, svc } = await fixture();
    const body = pushBody('acme/widgets');
    for (const signature of [undefined, sign(body, 'wrong')]) {
      await assert.rejects(
        receiver.handle({ event: 'push', delivery: nextDelivery(), signature }, Buffer.from(body, 'utf8')),
        (err: { code: string; status: number }) => err.code === 'BAD_SIGNATURE' && err.status === 400,
      );
    }
    await svc.idle();
    assert.equal(svc.store.runs(repo.id).length, 0);
  });

  it('refuses a delivery it could not deduplicate', async () => {
    const { svc } = await fixture();
    const body = pushBody('acme/widgets');
    const receiver = new WebhookReceiver({ service: svc, secret: SECRET });
    await assert.rejects(
      receiver.handle({ event: 'push', delivery: 'has spaces', signature: sign(body) }, Buffer.from(body, 'utf8')),
      (err: { code: string; status: number }) => err.code === 'MISSING_DELIVERY_ID' && err.status === 400,
    );
    await assert.rejects(
      receiver.handle({ event: 'push', delivery: undefined, signature: sign(body) }, Buffer.from(body, 'utf8')),
      (err: { code: string }) => err.code === 'MISSING_DELIVERY_ID',
    );
  });

  it('refuses a delivery over the size limit before verifying it', async () => {
    const { svc, repo } = await fixture();
    const body = pushBody('acme/widgets');
    const receiver = new WebhookReceiver({ service: svc, secret: SECRET, maxBodyBytes: 32 });
    await assert.rejects(
      receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8')),
      (err: { code: string; status: number }) => err.code === 'TOO_LARGE' && err.status === 413,
    );
    await svc.idle();
    assert.equal(svc.store.runs(repo.id).length, 0);
  });

  it('acknowledges ping and ignores every event it does not handle', async () => {
    const { receiver } = await fixture();
    const ping = await receiver.handle({ event: 'ping', delivery: nextDelivery(), signature: sign('{"zen":"x"}') }, Buffer.from('{"zen":"x"}', 'utf8'));
    assert.deepEqual({ status: ping.status, ok: ping.body.ok, event: ping.body.event }, { status: 200, ok: true, event: 'ping' });
    const body = pushBody('acme/widgets');
    const other = await receiver.handle({ event: 'pull_request', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(other.status, 200);
    assert.equal(other.body.ignored, true);
  });

  it('never adds a repository it was not told about', async () => {
    const { receiver, svc } = await fixture();
    const body = pushBody('other/repo');
    const result = await receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(result.status, 200);
    assert.match(result.body.reason as string, /not selected/);
    assert.equal(svc.store.repos().length, 1);
  });

  it('ignores a push to a branch other than the default branch it would audit', async () => {
    const { receiver, repo, svc } = await fixture();
    const body = pushBody('acme/widgets', 'refs/heads/feature/x');
    const result = await receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(result.status, 200);
    assert.match(result.body.reason as string, /default branch \(main\) only/);
    await svc.idle();
    assert.equal(svc.store.runs(repo.id).length, 0);
  });

  it('ignores a branch deletion', async () => {
    const { receiver, repo, svc } = await fixture();
    const body = pushBody('acme/widgets', 'refs/heads/main', '0'.repeat(40), { deleted: true });
    const result = await receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(result.status, 200);
    assert.match(result.body.reason as string, /deletion/);
    await svc.idle();
    assert.equal(svc.store.runs(repo.id).length, 0);
  });

  it('matches the repository name case-insensitively', async () => {
    const { receiver, svc } = await fixture();
    const body = pushBody('ACME/Widgets');
    const result = await receiver.handle({ event: 'push', delivery: nextDelivery(), signature: sign(body) }, Buffer.from(body, 'utf8'));
    assert.equal(result.body.runId !== undefined, true);
    await svc.idle();
  });
});

describe('POST /webhooks on the loopback dashboard', () => {
  it('accepts a correctly signed push without the dashboard token', async () => {
    const { web, svc } = await boot(SECRET);
    const body = pushBody('acme/widgets');
    const res = await deliver(web, body, { 'x-github-event': 'push', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(body) });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.runId !== undefined, true);
    await svc.idle();
  });

  it('answers a replayed delivery over HTTP with an idempotent 200', async () => {
    const { web, svc } = await boot(SECRET);
    const body = pushBody('acme/widgets');
    const headers = { 'x-github-event': 'push', 'x-github-delivery': 'd-dup', 'x-hub-signature-256': sign(body) };
    await deliver(web, body, headers);
    await svc.idle();
    const replay = await deliver(web, body, headers);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal(svc.store.runs(svc.store.repos()[0]!.id).length, 1);
  });

  it('rejects an unsigned push with 400 and does not queue a scan', async () => {
    const { web, svc } = await boot(SECRET);
    const body = pushBody('acme/widgets');
    const res = await deliver(web, body, { 'x-github-event': 'push', 'x-github-delivery': 'd-2' });
    assert.equal(res.status, 400);
    assert.equal(codeOf(res.body), 'BAD_SIGNATURE');
    await svc.idle();
    assert.equal(svc.store.runs(svc.store.repos()[0]!.id).length, 0);
  });

  it('rejects a tampered body even with a signature that is otherwise valid', async () => {
    const { web } = await boot(SECRET);
    const signed = pushBody('acme/widgets');
    const sent = signed.replace('acme/widgets', 'other/repo');
    const res = await deliver(web, sent, { 'x-github-event': 'push', 'x-github-delivery': 'd-3', 'x-hub-signature-256': sign(signed) });
    assert.equal(res.status, 400);
    assert.equal(codeOf(res.body), 'BAD_SIGNATURE');
  });

  it('is not served at all unless a receiver is configured', async () => {
    const { web } = await boot();
    const body = pushBody('acme/widgets');
    const res = await deliver(web, body, { 'x-github-event': 'push', 'x-github-delivery': 'd-4', 'x-hub-signature-256': sign(body) });
    assert.equal(res.status, 404);
    assert.equal(codeOf(res.body), 'NOT_CONFIGURED');
  });

  it('leaves the existing token-protected form endpoints alone', async () => {
    const { web } = await boot(SECRET);
    const api = await fetch(`${web.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(api.status, 403);
    assert.equal(codeOf(await api.json() as Record<string, unknown>), 'BAD_TOKEN');
    const form = await fetch(`${web.url}/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(form.status, 403, 'the browser form endpoint still answers in HTML');
  });
});
