// GitHub App source. Authenticates as an App installation (no personal access
// token), lists the repositories that installation can see, resolves a commit,
// and downloads that commit's tarball into a temporary directory through the
// defensive extractor. Its only write is creating a check run for a commit it
// just audited, and only when the operator opts in. Tokens and the private key
// are never logged or persisted.

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { extractTarGz, type ExtractLimits, type ExtractResult } from './tar.js';

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  /** PEM text of the App private key. */
  privateKey: string;
  apiUrl?: string;
}

export interface GitHubLimits extends ExtractLimits {
  maxDownloadBytes: number;
  requestTimeoutMs: number;
  /** Longest rate-limit/Retry-After wait that is honored automatically. */
  maxRateLimitWaitMs: number;
  maxPages: number;
}

export const DEFAULT_GITHUB_LIMITS: GitHubLimits = {
  maxDownloadBytes: 100 * 1024 * 1024,
  maxExtractBytes: 300 * 1024 * 1024,
  maxEntries: 20_000,
  maxFileBytes: 1024 * 1024,
  requestTimeoutMs: 60_000,
  maxRateLimitWaitMs: 10_000,
  maxPages: 50,
};

export type GitHubErrorCode =
  | 'NOT_CONFIGURED' | 'AUTH_FAILED' | 'NOT_ACCESSIBLE' | 'RATE_LIMITED' | 'API_ERROR'
  | 'INVALID_REPO_NAME' | 'DOWNLOAD_TOO_LARGE' | 'BAD_REDIRECT' | 'ARCHIVE_ERROR';

export class GitHubError extends Error {
  constructor(readonly code: GitHubErrorCode, message: string, readonly status?: number) {
    super(message);
  }
}

export interface GitHubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
}

/** owner/name with GitHub's character set; `.` and `..` segments are rejected (path traversal). */
export const REPO_NAME = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/** Create-check-run request body; `output.annotations` mirrors the check-run output shape. */
export interface CheckRunRequest {
  name: string;
  head_sha: string;
  status?: 'queued' | 'in_progress' | 'completed';
  started_at?: string;
  completed_at?: string;
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped';
  details_url?: string;
  output?: { title: string; summary: string; text?: string; annotations?: unknown[] };
}

type FetchFn = typeof fetch;
type RequestRedirect = 'error' | 'follow' | 'manual';

export class GitHubAppSource {
  private readonly apiUrl: string;
  private readonly key: KeyObject;
  private token: { value: string; expiresAt: number } | null = null;
  /** Result of the most recent API interaction, for honest status display. */
  lastContact: { ok: boolean; at: string; message: string } | null = null;

  constructor(
    private readonly config: GitHubAppConfig,
    readonly limits: GitHubLimits = DEFAULT_GITHUB_LIMITS,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    try {
      this.key = createPrivateKey(config.privateKey);
    } catch {
      throw new GitHubError('NOT_CONFIGURED', 'GitHub App private key could not be parsed');
    }
    if (!/^\d+$/.test(config.appId) || !/^\d+$/.test(config.installationId)) {
      throw new GitHubError('NOT_CONFIGURED', 'GitHub App id and installation id must be numeric');
    }
  }

  /** RS256 App JWT, valid ~9 minutes, backdated 60 s for clock skew. */
  appJwt(): string {
    const nowS = Math.floor(this.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowS - 60, exp: nowS + 540, iss: this.config.appId })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.key).toString('base64url');
    return `${unsigned}.${sig}`;
  }

  private async installationToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.now() > 60_000) return this.token.value;
    const res = await this.send(`${this.apiUrl}/app/installations/${this.config.installationId}/access_tokens`, {
      method: 'POST', auth: `Bearer ${this.appJwt()}`,
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw this.fail(new GitHubError('AUTH_FAILED', `could not obtain an installation token (HTTP ${res.status}); check the App id, installation id and private key`, res.status));
    }
    if (!res.ok) throw this.fail(new GitHubError('API_ERROR', `installation token request failed (HTTP ${res.status})`, res.status));
    const body = await res.json() as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw this.fail(new GitHubError('API_ERROR', 'installation token response was malformed'));
    }
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) || this.now() + 30 * 60_000 };
    return this.token.value;
  }

  private fail(err: GitHubError): GitHubError {
    this.lastContact = { ok: false, at: new Date(this.now()).toISOString(), message: `${err.code}: ${err.message}` };
    return err;
  }

  private async send(url: string, opts: { method?: string; auth?: string; accept?: string; redirect?: RequestRedirect; signal?: AbortSignal; json?: unknown }): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'repotruth-fleet',
    };
    if (opts.auth) headers.Authorization = opts.auth;
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        redirect: opts.redirect ?? 'error',
        signal: opts.signal ?? AbortSignal.timeout(this.limits.requestTimeoutMs),
      });
    } catch (err) {
      throw this.fail(new GitHubError('API_ERROR', `request failed: ${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`));
    }
  }

  /**
   * Authenticated API request with one token refresh on 401, bounded waits for
   * rate limits / Retry-After, and one retry on 5xx. Pass `json` to send a body.
   */
  private async api(pathOrUrl: string, opts: { accept?: string; redirect?: RequestRedirect; method?: string; json?: unknown } = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    if (!url.startsWith(`${this.apiUrl}/`)) throw this.fail(new GitHubError('BAD_REDIRECT', 'refusing to send credentials outside the configured API host'));
    let refreshed = false;
    let retried = false;
    for (;;) {
      const token = await this.installationToken();
      const res = await this.send(url, { auth: `token ${token}`, accept: opts.accept, redirect: opts.redirect ?? 'error', method: opts.method, json: opts.json });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.installationToken(true);
        continue;
      }
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
      if (limited) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - this.now()) : Infinity;
        if (!retried && waitMs <= this.limits.maxRateLimitWaitMs) {
          retried = true;
          await this.sleep(waitMs);
          continue;
        }
        const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
        throw this.fail(new GitHubError('RATE_LIMITED', `GitHub API rate limit reached${when}; try again later`, res.status));
      }
      if (res.status >= 500 && !retried) {
        retried = true;
        await this.sleep(1000);
        continue;
      }
      if (res.status === 404 || res.status === 403) {
        throw this.fail(new GitHubError('NOT_ACCESSIBLE', 'repository or resource is not accessible to this installation', res.status));
      }
      if (res.status === 401) throw this.fail(new GitHubError('AUTH_FAILED', 'installation token rejected', 401));
      if (!res.ok && !(res.status >= 300 && res.status < 400 && opts.redirect === 'manual')) {
        throw this.fail(new GitHubError('API_ERROR', `GitHub API returned HTTP ${res.status}`, res.status));
      }
      this.lastContact = { ok: true, at: new Date(this.now()).toISOString(), message: 'GitHub API reachable with installation token' };
      return res;
    }
  }

  /** All repositories the installation can access (paginated, bounded). */
  async listRepositories(): Promise<GitHubRepo[]> {
    const out: GitHubRepo[] = [];
    let next: string | null = '/installation/repositories?per_page=100';
    for (let page = 0; next; page++) {
      if (page >= this.limits.maxPages) throw this.fail(new GitHubError('API_ERROR', `more than ${this.limits.maxPages} pages of repositories; refusing to continue`));
      const res = await this.api(next);
      const body = await res.json() as { repositories?: unknown[] };
      for (const r of body.repositories ?? []) out.push(toRepo(r));
      next = nextLink(res.headers.get('link'));
      if (next && !next.startsWith(`${this.apiUrl}/`)) throw this.fail(new GitHubError('BAD_REDIRECT', 'pagination link points outside the API host'));
    }
    return out;
  }

  async getRepository(fullName: string): Promise<GitHubRepo> {
    if (!REPO_NAME.test(fullName)) throw new GitHubError('INVALID_REPO_NAME', 'expected "owner/name"');
    const res = await this.api(`/repos/${fullName}`);
    const repo = toRepo(await res.json());
    if (repo.fullName.toLowerCase() !== fullName.toLowerCase()) throw this.fail(new GitHubError('API_ERROR', 'repository response did not match the request'));
    return repo;
  }

  async resolveCommit(fullName: string, ref: string): Promise<string> {
    if (!REPO_NAME.test(fullName)) throw new GitHubError('INVALID_REPO_NAME', 'expected "owner/name"');
    const res = await this.api(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`);
    const sha = (await res.json() as { sha?: unknown }).sha;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw this.fail(new GitHubError('API_ERROR', 'commit response had no valid SHA'));
    return sha;
  }

  /**
   * Creates a check run on `head_sha`, with its conclusion, in one call. Needs
   * the App's `checks: write` permission; nothing else in this adapter writes.
   */
  async createCheckRun(fullName: string, payload: CheckRunRequest): Promise<{ id: number; html_url?: string }> {
    if (!REPO_NAME.test(fullName)) throw new GitHubError('INVALID_REPO_NAME', 'expected "owner/name"');
    if (!SHA.test(payload.head_sha)) throw new GitHubError('INVALID_REPO_NAME', 'head_sha must be a full 40-character commit SHA');
    let res: Response;
    try {
      res = await this.api(`/repos/${fullName}/check-runs`, { method: 'POST', json: payload as unknown });
    } catch (err) {
      if (err instanceof GitHubError && (err.code === 'NOT_ACCESSIBLE' || err.code === 'API_ERROR')) {
        throw this.fail(new GitHubError(err.code, `${err.message} (creating a check run needs the GitHub App permission "checks: write")`, err.status));
      }
      throw err;
    }
    const body = await res.json() as { id?: unknown; html_url?: unknown };
    if (typeof body.id !== 'number') throw this.fail(new GitHubError('API_ERROR', 'check run response had no id'));
    return { id: body.id, html_url: typeof body.html_url === 'string' ? body.html_url : undefined };
  }

  /**
   * Downloads the tarball for `sha` and extracts it into `dest` (a fresh
   * directory). The redirect target is fetched WITHOUT the installation
   * token; download size is capped before and during streaming.
   */
  async fetchSnapshot(fullName: string, sha: string, dest: string): Promise<ExtractResult & { bytesFetched: number }> {
    if (!REPO_NAME.test(fullName) || !SHA.test(sha)) throw new GitHubError('INVALID_REPO_NAME', 'invalid repository or commit');
    const first = await this.api(`/repos/${fullName}/tarball/${sha}`, { redirect: 'manual', accept: 'application/vnd.github+json' });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location) throw this.fail(new GitHubError('BAD_REDIRECT', 'tarball redirect had no location'));
      const target = new URL(location, this.apiUrl);
      const sameOrigin = target.origin === new URL(this.apiUrl).origin;
      if (target.protocol !== 'https:' && !sameOrigin) throw this.fail(new GitHubError('BAD_REDIRECT', 'tarball redirect is not https'));
      res = await this.send(target.toString(), { redirect: 'error', accept: 'application/octet-stream', signal: AbortSignal.timeout(this.limits.requestTimeoutMs) });
      if (!res.ok) throw this.fail(new GitHubError('API_ERROR', `tarball download returned HTTP ${res.status}`, res.status));
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.limits.maxDownloadBytes) {
      throw this.fail(new GitHubError('DOWNLOAD_TOO_LARGE', `archive is ${declared} bytes, over maxDownloadBytes (${this.limits.maxDownloadBytes})`));
    }
    if (!res.body) throw this.fail(new GitHubError('API_ERROR', 'tarball response had no body'));
    let fetched = 0;
    const max = this.limits.maxDownloadBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        fetched += chunk.length;
        if (fetched > max) cb(new GitHubError('DOWNLOAD_TOO_LARGE', `archive exceeded maxDownloadBytes (${max}) while downloading`));
        else cb(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    body.on('error', (e) => counter.destroy(e));
    body.pipe(counter);
    try {
      const extracted = await extractTarGz(counter, dest, this.limits);
      return { ...extracted, bytesFetched: fetched };
    } catch (err) {
      body.destroy();
      if (err instanceof GitHubError) throw this.fail(err);
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof GitHubError) throw this.fail(cause);
      if (/maxDownloadBytes/.test((err as Error).message)) throw this.fail(new GitHubError('DOWNLOAD_TOO_LARGE', (err as Error).message));
      throw this.fail(new GitHubError('ARCHIVE_ERROR', (err as Error).message));
    }
  }
}

function toRepo(raw: unknown): GitHubRepo {
  const r = raw as { full_name?: unknown; private?: unknown; default_branch?: unknown; archived?: unknown };
  if (typeof r?.full_name !== 'string' || !REPO_NAME.test(r.full_name)) throw new GitHubError('API_ERROR', 'repository entry was malformed');
  return {
    fullName: r.full_name,
    private: r.private === true,
    defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    archived: r.archived === true,
  };
}

/** Parses the rel="next" URL from a GitHub Link header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2]!.split(/\s+/).includes('next')) return m[1]!;
  }
  return null;
}

/** Reads App configuration from the environment; returns null when absent. */
export async function githubConfigFromEnv(env: NodeJS.ProcessEnv, readKey: (p: string) => Promise<string>): Promise<GitHubAppConfig | null> {
  const appId = env.REPOTRUTH_GH_APP_ID;
  const installationId = env.REPOTRUTH_GH_INSTALLATION_ID;
  const keyFile = env.REPOTRUTH_GH_PRIVATE_KEY_FILE;
  if (!appId && !installationId && !keyFile) return null;
  if (!appId || !installationId || !keyFile) {
    throw new GitHubError('NOT_CONFIGURED', 'set all of REPOTRUTH_GH_APP_ID, REPOTRUTH_GH_INSTALLATION_ID and REPOTRUTH_GH_PRIVATE_KEY_FILE, or none');
  }
  return { appId, installationId, privateKey: await readKey(keyFile), apiUrl: env.REPOTRUTH_GH_API_URL || undefined };
}
