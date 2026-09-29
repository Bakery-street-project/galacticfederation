// GitHub webhook receiver, independent of the HTTP transport: the caller hands
// over the exact request bytes plus the three delivery headers. The signature is
// verified with a constant-time comparison before anything is parsed or
// enqueued, and delivery IDs are remembered so a replayed delivery is answered
// with an idempotent 200 instead of starting a second scan.
//
// Scope: `push` on the default branch of a repository that was explicitly
// selected in this fleet. Nothing is auto-added, and a push to any other branch
// is ignored, because a fleet scan always audits the default branch — reporting
// a feature-branch push would describe a commit that was never audited.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPO_NAME } from './sources/github.js';
import type { FleetService } from './service.js';

export type WebhookErrorCode =
  | 'NOT_CONFIGURED' | 'BAD_SIGNATURE' | 'BAD_PAYLOAD' | 'MISSING_DELIVERY_ID' | 'TOO_LARGE' | 'SCAN_FAILED';

export class WebhookError extends Error {
  constructor(readonly code: WebhookErrorCode, message: string, readonly status: number) {
    super(message);
  }
}

/** GitHub caps push payloads at 25 MB; the fields used here are a tiny fraction of that. */
export const MAX_WEBHOOK_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DELIVERY_CACHE_SIZE = 2048;

const HANDLED_EVENTS = new Set(['push']);
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;
const BRANCH_REF = 'refs/heads/';

/**
 * Constant-time HMAC-SHA256 check of `X-Hub-Signature-256`. A missing header, a
 * wrong algorithm prefix, a malformed digest and a wrong digest all take the
 * same path and produce the same error, so the response reveals nothing about
 * which part was wrong.
 */
export function verifySignature(secret: string, body: Buffer, header: string | null | undefined): void {
  if (!secret) throw new WebhookError('NOT_CONFIGURED', 'no webhook secret is configured', 409);
  const match = header ? SIGNATURE.exec(header.trim()) : null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = match?.[1] ? Buffer.from(match[1].toLowerCase(), 'hex') : Buffer.alloc(expected.length);
  if (!timingSafeEqual(provided, expected)) {
    throw new WebhookError('BAD_SIGNATURE', 'X-Hub-Signature-256 is missing or invalid', 400);
  }
}

/** Bounded FIFO of recently seen delivery IDs, for replay protection. */
export class DeliveryCache {
  private readonly seen = new Set<string>();

  constructor(private readonly limit: number = DEFAULT_DELIVERY_CACHE_SIZE) {}

  /** True the first time an ID is seen; false for a replay. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    const oldest = this.seen.values().next();
    if (this.seen.size > this.limit && oldest.done !== true) this.seen.delete(oldest.value);
    return true;
  }

  /** Drops an ID so a retryable failure can be redelivered. */
  forget(id: string): void {
    this.seen.delete(id);
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface WebhookHeaders {
  /** `X-GitHub-Event` */
  event?: string | undefined;
  /** `X-GitHub-Delivery` */
  delivery?: string | undefined;
  /** `X-Hub-Signature-256` */
  signature?: string | undefined;
}

export interface PushDelivery {
  fullName: string;
  branch: string;
  /** Head commit, when the push was not a deletion. */
  sha: string | null;
  deleted: boolean;
}

export function parsePush(body: Buffer): PushDelivery {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new WebhookError('BAD_PAYLOAD', 'push payload is not valid JSON', 400);
  }
  const p = payload as { repository?: { full_name?: unknown }; ref?: unknown; after?: unknown; deleted?: unknown };
  const fullName = p?.repository?.full_name;
  if (typeof fullName !== 'string' || !REPO_NAME.test(fullName)) {
    throw new WebhookError('BAD_PAYLOAD', 'push payload has no valid repository.full_name', 400);
  }
  const ref = typeof p.ref === 'string' ? p.ref : '';
  if (p.deleted === true) return { fullName, branch: ref.startsWith(BRANCH_REF) ? ref.slice(BRANCH_REF.length) : '', sha: null, deleted: true };
  if (!ref.startsWith(BRANCH_REF)) throw new WebhookError('BAD_PAYLOAD', 'push payload has no refs/heads ref', 400);
  const sha = typeof p.after === 'string' ? p.after : null;
  return { fullName, branch: ref.slice(BRANCH_REF.length), sha, deleted: false };
}

export interface WebhookOptions {
  service: FleetService;
  /** Webhook secret, byte-for-byte as configured on the GitHub App. */
  secret: string;
  maxBodyBytes?: number;
  cache?: DeliveryCache;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export class WebhookReceiver {
  readonly maxBodyBytes: number;
  private readonly cache: DeliveryCache;

  constructor(private readonly opts: WebhookOptions) {
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_WEBHOOK_BYTES;
    this.cache = opts.cache ?? new DeliveryCache();
  }

  async handle(headers: WebhookHeaders, body: Buffer): Promise<WebhookResult> {
    if (body.length > this.maxBodyBytes) {
      throw new WebhookError('TOO_LARGE', `delivery exceeds ${this.maxBodyBytes} bytes`, 413);
    }
    verifySignature(this.opts.secret, body, headers.signature);
    const delivery = headers.delivery?.trim() ?? '';
    if (!DELIVERY_ID.test(delivery)) {
      throw new WebhookError('MISSING_DELIVERY_ID', 'X-GitHub-Delivery is missing or malformed, so the delivery cannot be deduplicated', 400);
    }
    // Deduplicated before any side effect: a replay is a 200 and nothing more.
    if (!this.cache.add(delivery)) return { status: 200, body: { ok: true, duplicate: true, delivery } };
    try {
      return await this.route(headers.event?.trim() ?? '', body, delivery);
    } catch (err) {
      const e = err instanceof WebhookError
        ? err
        : new WebhookError('SCAN_FAILED', `could not queue a scan (${safeCode(err)})`, 500);
      // Only retryable failures forget the delivery: a 4xx would be redelivered
      // identically, and GitHub does not retry 4xx anyway.
      if (e.status >= 500) this.cache.forget(delivery);
      throw e;
    }
  }

  private async route(event: string, body: Buffer, delivery: string): Promise<WebhookResult> {
    if (event === 'ping') return { status: 200, body: { ok: true, duplicate: false, delivery, event } };
    if (!HANDLED_EVENTS.has(event)) {
      return { status: 200, body: { ok: true, ignored: true, delivery, event, reason: `event "${event}" is not handled` } };
    }
    const push = parsePush(body);
    if (push.deleted) {
      return { status: 200, body: { ok: true, ignored: true, delivery, event, repository: push.fullName, reason: 'branch deletion' } };
    }
    const repo = this.opts.service.store.repos().find((r) => r.kind === 'github' && r.locator.toLowerCase() === push.fullName.toLowerCase());
    if (!repo) {
      return { status: 200, body: { ok: true, ignored: true, delivery, event, repository: push.fullName, reason: 'repository is not selected in this fleet' } };
    }
    if (repo.defaultBranch !== push.branch) {
      return {
        status: 200,
        body: {
          ok: true, ignored: true, delivery, event, repository: repo.locator, branch: push.branch,
          reason: `fleet scans audit the default branch (${repo.defaultBranch ?? 'unknown'}) only`,
        },
      };
    }
    const run = await this.opts.service.scan(repo.id);
    return { status: 200, body: { ok: true, duplicate: false, delivery, event, repository: repo.locator, branch: push.branch, runId: run.id } };
  }
}

/** Error codes reach logs and GitHub's delivery log; keep them to an upper-case token. */
function safeCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'ERROR';
}
