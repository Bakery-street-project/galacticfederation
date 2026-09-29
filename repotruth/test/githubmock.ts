// A local HTTP stand-in for the GitHub REST API, sufficient for the App
// source adapter. It verifies App JWTs against the test key pair.

import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRepo {
  fullName: string;
  defaultBranch?: string;
  sha: string;
  tarball: Buffer;
  /** Pretend the repo became inaccessible (404). */
  hidden?: boolean;
}

type Override = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface GitHubMock {
  url: string;
  privateKeyPem: string;
  repos: Map<string, MockRepo>;
  /** Requests seen, e.g. "GET /installation/repositories?per_page=100". */
  log: string[];
  tokensIssued: number;
  /** Authorization headers seen on the codeload (redirect target) route. */
  codeloadAuth: (string | undefined)[];
  /** One-shot response overrides, consumed in order when they return true. */
  overrides: Override[];
  tokenTtlMs: number;
  pageSize: number;
  close(): Promise<void>;
}

export const INSTALLATION_ID = '4242';
export const APP_ID = '1001';

function verifyJwt(jwt: string, pub: KeyObject): boolean {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return false;
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss?: string; exp?: number };
  return ok && claims.iss === APP_ID && typeof claims.exp === 'number';
}

export async function startGitHubMock(repos: MockRepo[]): Promise<GitHubMock> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const validTokens = new Set<string>();
  const mock: GitHubMock = {
    url: '',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    repos: new Map(repos.map((r) => [r.fullName.toLowerCase(), r])),
    log: [],
    tokensIssued: 0,
    codeloadAuth: [],
    overrides: [],
    tokenTtlMs: 60 * 60_000,
    pageSize: 2,
    close: async () => {},
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const repoJson = (r: MockRepo) => ({ full_name: r.fullName, private: true, default_branch: r.defaultBranch ?? 'main', archived: false });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', mock.url);
    mock.log.push(`${req.method} ${url.pathname}${url.search}`);
    const next = mock.overrides[0];
    if (next && next(req, res)) { mock.overrides.shift(); return; }

    if (url.pathname.startsWith('/codeload/')) {
      mock.codeloadAuth.push(req.headers.authorization);
      const [, , owner, name] = url.pathname.split('/');
      const repo = mock.repos.get(`${owner}/${name}`.toLowerCase());
      if (!repo) return json(res, 404, {});
      res.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': String(repo.tarball.length) });
      return res.end(repo.tarball);
    }
    if (req.method === 'POST' && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !verifyJwt(auth.slice(7), pub)) return json(res, 401, { message: 'bad jwt' });
      const token = `ghs_mock_${++mock.tokensIssued}`;
      validTokens.add(token);
      return json(res, 201, { token, expires_at: new Date(Date.now() + mock.tokenTtlMs).toISOString() });
    }
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('token ') || !validTokens.has(auth.slice(6))) return json(res, 401, { message: 'Bad credentials' });

    if (url.pathname === '/installation/repositories') {
      const all = [...mock.repos.values()].filter((r) => !r.hidden);
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = all.slice((page - 1) * mock.pageSize, page * mock.pageSize);
      const headers: Record<string, string> = {};
      if (page * mock.pageSize < all.length) headers.link = `<${mock.url}/installation/repositories?per_page=100&page=${page + 1}>; rel="next", <${mock.url}/installation/repositories?page=99>; rel="last"`;
      return json(res, 200, { total_count: all.length, repositories: slice.map(repoJson) }, headers);
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/(commits|tarball)\/(.+))?$/.exec(url.pathname);
    if (m) {
      const repo = mock.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!repo || repo.hidden) return json(res, 404, { message: 'Not Found' });
      if (!m[3]) return json(res, 200, repoJson(repo));
      if (m[3] === 'commits') return json(res, 200, { sha: repo.sha });
      if (m[3] === 'tarball') {
        res.writeHead(302, { location: `${mock.url}/codeload/${repo.fullName}/legacy.tar.gz/${m[4]}?token=short-lived` });
        return res.end();
      }
    }
    return json(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return mock;
}
