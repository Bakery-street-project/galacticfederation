// Local operator dashboard + JSON API over node:http. Loopback only, no
// JavaScript, strict CSP, Host allow-list (DNS-rebinding defense), and a
// per-process token on every state-changing request (CSRF defense). All
// repository-derived text is HTML-escaped: it is untrusted.
// This is a single-operator local tool, not multi-user authentication.
// POST /webhooks is the one exception to the token rule: GitHub cannot hold a
// per-process token, so it authenticates with the webhook HMAC instead. It is
// still served by this same loopback listener, never a new network port.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SEVERITIES, type Finding, type Severity } from '../types.js';
import { compareRuns, completeness } from './compare.js';
import { GitHubError } from './sources/github.js';
import { FleetError, type FleetService, type RepoSummary } from './service.js';
import type { Comparison, RunRecord } from './types.js';
import { WebhookError, type WebhookReceiver } from './webhooks.js';

export interface WebOptions {
  host?: string;
  port?: number;
  /** When set, POST /webhooks is served and authenticated by the GitHub HMAC signature. */
  webhooks?: WebhookReceiver;
}

export interface WebHandle {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const CSS = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--high:#b3261e;--medium:#b35c00;--low:#5b6b00;--info:#3b5b8c;--ok:#1f6f3f;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--card:#1f1f1d;--line:#34332f;--high:#ff8a80;--medium:#ffb86b;--low:#c5d86d;--info:#8fb3ff;--ok:#7fd6a0;--warn:#ffd27a}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header a{color:inherit;text-decoration:none;font-weight:600}main{padding:20px;max-width:1200px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;color:var(--muted);font-weight:600}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.sev{font-weight:700;font-size:12px;text-transform:uppercase}.sev-high{color:var(--high)}.sev-medium{color:var(--medium)}.sev-low{color:var(--low)}.sev-info{color:var(--info)}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn);font-weight:600}.bad{color:var(--high);font-weight:600}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;margin-right:4px}
form.inline{display:inline}button{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
input,select{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:0 0 10px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:8px;border-radius:6px;border:1px solid var(--line)}
.notice{border-left:4px solid var(--warn);padding:8px 12px;background:var(--card);margin-bottom:16px}
`;

function page(title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="2">' : ''}<title>${esc(title)} · RepoTruth Fleet</title><style>${CSS}</style></head>
<body><header><a href="/">RepoTruth Fleet</a><span class="muted">local · read-only · deterministic</span></header><main>${body}</main></body></html>`;
}

function sevCounts(by: Record<Severity, number> | undefined): string {
  if (!by) return '<span class="muted">—</span>';
  return [...SEVERITIES].reverse().map((s) => `<span class="sev sev-${s}">${by[s]} ${s}</span>`).join(' ');
}

function shortSha(sha: string | null | undefined): string {
  return sha ? `<code>${esc(sha.slice(0, 10))}</code>` : '<span class="muted">unknown</span>';
}

function runState(run: RunRecord | undefined): string {
  if (!run) return '<span class="muted">never scanned</span>';
  if (run.status === 'failed') return `<span class="bad">failed</span> <span class="muted">${esc(run.error?.code)}</span>`;
  if (run.status !== 'completed') return `<span class="warn">${esc(run.status)}…</span>`;
  const c = completeness(run);
  return c.complete ? '<span class="ok">complete</span>' : '<span class="warn">incomplete</span>';
}

function tokenField(token: string): string {
  return `<input type="hidden" name="token" value="${esc(token)}">`;
}

function renderHome(svc: FleetService, token: string, flash: string | null, ghRepos: string): string {
  const rows = svc.summaries().map((s: RepoSummary) => {
    const lc = s.lastCompleted;
    return `<tr>
<td><a href="/repos/${esc(s.repo.id)}">${esc(s.repo.name)}</a><div class="muted"><span class="pill">${esc(s.repo.kind)}</span></div></td>
<td>${lc ? esc(lc.finishedAt?.replace('T', ' ').slice(0, 19)) + ' UTC' : '<span class="muted">—</span>'}</td>
<td>${shortSha(lc?.source?.commitSha)}</td>
<td>${sevCounts(lc?.audit?.summary.bySeverity)}</td>
<td>${runState(s.latestRun)}${s.latestRun?.status === 'failed' && lc ? '<div class="muted">showing last successful report</div>' : ''}</td>
<td><form class="inline" method="post" action="/repos/${esc(s.repo.id)}/scan">${tokenField(token)}<button ${s.active ? 'disabled' : ''}>${lc ? 'Rescan' : 'Scan'}</button></form></td></tr>`;
  }).join('');
  const gh = svc.githubStatus();
  const ghStatus = !gh.configured
    ? '<p class="muted">GitHub App not configured. Local repositories work without it.</p>'
    : gh.lastContact
      ? `<p>${gh.lastContact.ok ? '<span class="ok">last API call succeeded</span>' : '<span class="bad">last API call failed</span>'} <span class="muted">${esc(gh.lastContact.at)} · ${esc(gh.lastContact.message)}</span></p>`
      : '<p class="muted">GitHub App configured; no API call made yet.</p>';
  return page('Repositories', `
${flash ? `<div class="notice">${esc(flash)}</div>` : ''}
<h1>Repositories</h1>
<div class="card">${rows ? `<table><thead><tr><th>Repository</th><th>Last complete scan</th><th>Commit</th><th>Findings</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No repositories selected yet.</p>'}</div>
<div class="grid">
<div class="card"><h2>Add a local repository</h2>${svc.localEnabled()
    ? `<form method="post" action="/repos">${tokenField(token)}<input name="path" placeholder="path inside the allowed root" required size="32"> <button>Add</button></form><p class="muted">Paths are resolved inside the configured allowed root; symlink escapes are rejected.</p>`
    : '<p class="muted">Disabled: start with --allowed-root to enable.</p>'}</div>
<div class="card"><h2>GitHub App</h2>${ghStatus}${gh.configured ? `<form method="get" action="/"><input type="hidden" name="github" value="1"><button>List accessible repositories</button></form>${ghRepos}` : ''}</div>
</div>`);
}

function findingRow(repoId: string, f: Finding, change?: string): string {
  const loc = f.location.line ? `${f.location.path}:${f.location.line}` : f.location.path;
  return `<tr><td><span class="sev sev-${f.severity}">${esc(f.severity)}</span></td><td>${esc(f.status)}<div class="muted">${esc(f.confidence)} confidence</div></td>
<td><a href="/repos/${esc(repoId)}/findings/${esc(f.fingerprint)}">${esc(f.title)}</a><div class="muted mono">${esc(f.ruleId)}</div></td>
<td class="mono">${esc(loc)}</td>${change !== undefined ? `<td>${esc(change)}</td>` : ''}</tr>`;
}

function filterFindings(findings: Finding[], q: URLSearchParams): Finding[] {
  const text = (q.get('q') ?? '').toLowerCase().trim();
  const sev = q.get('severity') ?? '';
  const status = q.get('status') ?? '';
  return findings.filter((f) =>
    (!sev || f.severity === sev)
    && (!status || f.status === status)
    && (!text || `${f.ruleId} ${f.title} ${f.location.path} ${f.evidence}`.toLowerCase().includes(text)));
}

function comparisonBlock(repoId: string, c: Comparison): string {
  const head = c.verified
    ? '<p class="ok">Verified comparison: both runs were complete and evaluated the same areas.</p>'
    : `<p class="warn">Unverified comparison. "Resolved" below means <em>not seen in the later run</em>, not confirmed fixed.</p><ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  const list = (title: string, items: Finding[]) => `<h2>${esc(title)} (${items.length})</h2>${items.length
    ? `<table><tbody>${items.map((f) => findingRow(repoId, f)).join('')}</tbody></table>` : '<p class="muted">None.</p>'}`;
  return `${head}${list('New', c.new)}${list('Continuing', c.continuing)}${list(c.verified ? 'Resolved' : 'Not seen in later run (unverified)', c.resolved)}`;
}

function renderRepo(svc: FleetService, repoId: string, q: URLSearchParams, token: string): string | null {
  const repo = svc.store.repo(repoId);
  if (!repo) return null;
  const s = svc.summary(repo);
  const runs = svc.store.runs(repoId);
  const lc = s.lastCompleted;
  const cmp = svc.latestComparison(repoId);
  const changeOf = new Map<string, string>();
  if (cmp) {
    for (const f of cmp.new) changeOf.set(f.fingerprint, cmp.baseRunId ? 'new' : 'first scan');
    for (const f of cmp.continuing) changeOf.set(f.fingerprint, 'continuing');
  }
  const findings = lc?.audit ? filterFindings(lc.audit.findings, q) : [];
  const opt = (name: string, values: readonly string[]) => `<select name="${name}"><option value="">any ${name}</option>${values.map((v) => `<option ${q.get(name) === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  const failedLatest = s.latestRun?.status === 'failed';
  const body = `
<h1>${esc(repo.name)} <span class="pill">${esc(repo.kind)}</span></h1>
${s.active ? '<div class="notice">A scan is queued or running. This page refreshes automatically.</div>' : ''}
${failedLatest ? `<div class="notice"><span class="bad">Latest scan failed</span> (${esc(s.latestRun!.error?.code)}: ${esc(s.latestRun!.error?.message)}).${lc ? ' The report below is the last successful scan.' : ''}</div>` : ''}
<div class="card"><form class="inline" method="post" action="/repos/${esc(repo.id)}/scan">${tokenField(token)}<button ${s.active ? 'disabled' : ''}>${lc ? 'Rescan' : 'Scan'}</button></form>
${lc ? ` <span class="muted">Report from ${esc(lc.finishedAt)} · commit ${shortSha(lc.source?.commitSha)} <span class="muted">(${esc(lc.source?.commitNote)})</span></span>` : ' <span class="muted">No completed scan yet.</span>'}</div>
${lc?.audit ? `
<div class="card"><h2>Summary</h2><p>${sevCounts(lc.audit.summary.bySeverity)} · ${lc.audit.summary.byStatus.finding} finding, ${lc.audit.summary.byStatus['needs-review']} needs-review</p>
${s.completeness && !s.completeness.complete ? `<p class="warn">Incomplete scan:</p><ul>${s.completeness.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="ok">Complete scan within limits.</p>'}
<details><summary>Coverage</summary><ul>${lc.audit.coverage.evaluated.map((e) => `<li>evaluated: ${esc(e.area)}: ${esc(e.detail)}</li>`).join('')}${lc.audit.coverage.notEvaluated.map((e) => `<li class="warn">not evaluated: ${esc(e.area)}: ${esc(e.detail)}</li>`).join('')}</ul></details></div>
<div class="card"><h2>Findings (${findings.length} of ${lc.audit.findings.length})</h2>
<form method="get"><input name="q" value="${esc(q.get('q') ?? '')}" placeholder="search rule, file, evidence"> ${opt('severity', SEVERITIES)} ${opt('status', ['finding', 'needs-review'])} <button>Filter</button></form>
<table><thead><tr><th>Severity</th><th>Status</th><th>Finding</th><th>Location</th><th>Change</th></tr></thead><tbody>${findings.map((f) => findingRow(repo.id, f, changeOf.get(f.fingerprint) ?? '')).join('') || '<tr><td colspan="5" class="muted">No findings match.</td></tr>'}</tbody></table></div>` : ''}
${cmp ? `<div class="card"><h2>Changes since previous completed scan</h2>${cmp.baseRunId ? comparisonBlock(repo.id, cmp) : '<p class="muted">Only one completed scan so far.</p>'}</div>` : ''}
<div class="card"><h2>Runs</h2><table><thead><tr><th>Run</th><th>Status</th><th>Commit</th><th>Findings</th><th>Finished</th><th></th></tr></thead><tbody>
${runs.map((r, i) => {
    const prevDone = runs.slice(i + 1).find((x) => x.status === 'completed');
    return `<tr><td class="mono">${esc(r.id)}</td><td>${runState(r)}${r.error ? `<div class="muted">${esc(r.error.message)}</div>` : ''}</td><td>${shortSha(r.source?.commitSha)}</td><td>${sevCounts(r.audit?.summary.bySeverity)}</td><td>${esc(r.finishedAt ?? '')}</td>
<td>${r.status === 'completed' && prevDone ? `<a href="/repos/${esc(repo.id)}/compare?base=${esc(prevDone.id)}&head=${esc(r.id)}">compare with previous</a>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  return page(repo.name, body, s.active);
}

function renderFinding(svc: FleetService, repoId: string, fp: string): string | null {
  const repo = svc.store.repo(repoId);
  const run = repo ? svc.summary(repo).lastCompleted : undefined;
  const f = run?.audit?.findings.find((x) => x.fingerprint === fp);
  if (!repo || !f) return null;
  const loc = f.location.line ? `${f.location.path}:${f.location.line}` : f.location.path;
  return page(f.title, `<p><a href="/repos/${esc(repo.id)}">← ${esc(repo.name)}</a></p>
<div class="card"><h1>${esc(f.title)}</h1><table><tbody>
<tr><th>Rule</th><td class="mono">${esc(f.ruleId)}</td></tr>
<tr><th>Severity</th><td><span class="sev sev-${f.severity}">${esc(f.severity)}</span></td></tr>
<tr><th>Status</th><td>${esc(f.status)}</td></tr><tr><th>Confidence</th><td>${esc(f.confidence)}</td></tr>
<tr><th>Location</th><td class="mono">${esc(loc)}</td></tr>
<tr><th>Evidence</th><td><pre>${esc(f.evidence)}</pre><div class="muted">Excerpt of repository text; untrusted.</div></td></tr>
<tr><th>Why</th><td>${esc(f.explanation)}</td></tr><tr><th>Next action</th><td>${esc(f.suggestion)}</td></tr>
<tr><th>Fingerprint</th><td class="mono">${esc(f.fingerprint)}</td></tr>
<tr><th>From run</th><td class="mono">${esc(run!.id)} · commit ${shortSha(run!.source?.commitSha)}</td></tr>
</tbody></table></div>`);
}

function renderCompare(svc: FleetService, repoId: string, c: Comparison): string {
  const repo = svc.store.repo(repoId)!;
  return page(`Compare · ${repo.name}`, `<p><a href="/repos/${esc(repo.id)}">← ${esc(repo.name)}</a></p><h1>Run comparison</h1>
<div class="card"><p class="mono">${esc(c.baseRunId ?? 'none')} → ${esc(c.headRunId)}</p>${comparisonBlock(repo.id, c)}</div>`);
}

async function readBodyBuffer(req: IncomingMessage, max: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new FleetError('TOO_LARGE', 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, max = 16 * 1024): Promise<string> {
  return (await readBodyBuffer(req, max)).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sameToken(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function publicRun(r: RunRecord | undefined): unknown {
  return r ? { ...r, completeness: r.status === 'completed' ? completeness(r) : undefined } : null;
}

export async function startDashboard(svc: FleetService, opts: WebOptions = {}): Promise<WebHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error('the dashboard only binds to a loopback address (127.0.0.1, ::1 or localhost)');
  const token = randomBytes(24).toString('base64url');
  let allowedHosts = new Set<string>();

  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...extra,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
  const html = (res: ServerResponse, status: number, body: string) => send(res, status, 'text/html; charset=utf-8', body);
  const redirect = (res: ServerResponse, to: string) => send(res, 303, 'text/plain', '', { Location: to });
  const errorStatus = (err: unknown) => {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'NOT_FOUND') return 404;
    if (['NOT_CONFIGURED', 'LOCAL_DISABLED'].includes(code)) return 409;
    if (err instanceof FleetError || err instanceof GitHubError) return 400;
    return 500;
  };
  const errorBody = (err: unknown) => (err instanceof FleetError || err instanceof GitHubError)
    ? { error: { code: err.code, message: err.message } }
    : { error: { code: 'INTERNAL_ERROR', message: 'internal error' } };

  const handleWebhook = async (req: IncomingMessage, res: ServerResponse) => {
    const receiver = opts.webhooks;
    if (!receiver) return json(res, 404, { error: { code: 'NOT_CONFIGURED', message: 'webhooks are not enabled on this dashboard' } });
    let body: Buffer;
    try {
      body = await readBodyBuffer(req, receiver.maxBodyBytes);
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
    try {
      const result = await receiver.handle({
        event: header(req, 'x-github-event'),
        delivery: header(req, 'x-github-delivery'),
        signature: header(req, 'x-hub-signature-256'),
      }, body);
      return json(res, result.status, result.body);
    } catch (err) {
      if (err instanceof WebhookError) return json(res, err.status, { error: { code: err.code, message: err.message } });
      return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
  };

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'text/plain', 'unexpected Host header');
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      const isApi = parts[0] === 'api';
      const p = isApi ? parts.slice(1) : parts;

      if (req.method === 'POST') {
        // Webhooks are authenticated by their own HMAC and never carry the dashboard token.
        if (p.length === 1 && p[0] === 'webhooks') return await handleWebhook(req, res);
        const raw = await readBody(req);
        const ctype = req.headers['content-type'] ?? '';
        let form: URLSearchParams;
        try {
          form = ctype.includes('application/json')
            ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}') as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v)]))
            : new URLSearchParams(raw);
        } catch {
          return json(res, 400, { error: { code: 'BAD_REQUEST', message: 'request body is not valid JSON' } });
        }
        const supplied = (req.headers['x-repotruth-token'] as string | undefined) ?? form.get('token');
        if (!sameToken(supplied, token)) return isApi ? json(res, 403, { error: { code: 'BAD_TOKEN', message: 'missing or invalid token' } }) : html(res, 403, page('Forbidden', '<p>Invalid form token. Reload the page and try again.</p>'));
        try {
          if (p.length === 1 && p[0] === 'repos') {
            const repo = form.get('github') ? await svc.addGitHub(form.get('github')!) : await svc.addLocal(form.get('path') ?? '');
            return isApi ? json(res, 201, repo) : redirect(res, `/repos/${repo.id}`);
          }
          if (p.length === 3 && p[0] === 'repos' && p[2] === 'scan') {
            const run = await svc.scan(p[1]!);
            return isApi ? json(res, 202, run) : redirect(res, `/repos/${p[1]}`);
          }
          if (p.length === 3 && p[0] === 'repos' && p[2] === 'delete') {
            await svc.removeRepo(p[1]!);
            return isApi ? json(res, 200, { ok: true }) : redirect(res, '/');
          }
        } catch (err) {
          if (isApi) return json(res, errorStatus(err), errorBody(err));
          const e = errorBody(err).error;
          return html(res, errorStatus(err), renderHome(svc, token, `${e.code}: ${e.message}`, ''));
        }
        return isApi ? json(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } }) : html(res, 404, page('Not found', '<p>Not found.</p>'));
      }
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { Allow: 'GET, POST' });

      if (isApi) {
        if (p.length === 1 && p[0] === 'repos') return json(res, 200, svc.summaries().map((s) => ({ ...s, latestRun: publicRun(s.latestRun), lastCompleted: publicRun(s.lastCompleted) })));
        if (p.length === 1 && p[0] === 'github') {
          try { return json(res, 200, { status: svc.githubStatus(), repositories: await svc.listGitHub() }); } catch (err) { return json(res, errorStatus(err), errorBody(err)); }
        }
        if (p.length === 2 && p[0] === 'repos') {
          const repo = svc.store.repo(p[1]!);
          if (!repo) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown repository' } });
          const s = svc.summary(repo);
          return json(res, 200, { repo, latestRun: publicRun(s.latestRun), lastCompleted: publicRun(s.lastCompleted), comparison: svc.latestComparison(repo.id), runs: svc.store.runs(repo.id).map((r) => ({ id: r.id, status: r.status, queuedAt: r.queuedAt, finishedAt: r.finishedAt, commitSha: r.source?.commitSha ?? null, error: r.error, summary: r.audit?.summary })) });
        }
        if (p.length === 2 && p[0] === 'runs') {
          const run = svc.store.run(p[1]!);
          return run ? json(res, 200, publicRun(run)) : json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown run' } });
        }
        if (p.length === 3 && p[0] === 'repos' && p[2] === 'compare') {
          try {
            const c = url.searchParams.get('base') && url.searchParams.get('head')
              ? svc.compare(url.searchParams.get('base')!, url.searchParams.get('head')!)
              : svc.latestComparison(p[1]!);
            return json(res, 200, c);
          } catch (err) { return json(res, errorStatus(err), errorBody(err)); }
        }
        return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
      }

      if (p.length === 0) {
        let ghRepos = '';
        if (url.searchParams.get('github') && svc.githubStatus().configured) {
          try {
            const list = await svc.listGitHub();
            const selected = new Set(svc.store.repos().filter((r) => r.kind === 'github').map((r) => r.locator.toLowerCase()));
            ghRepos = `<table><tbody>${list.map((r) => `<tr><td>${esc(r.fullName)} ${r.private ? '<span class="pill">private</span>' : ''}</td><td>${selected.has(r.fullName.toLowerCase()) ? '<span class="muted">selected</span>' : `<form class="inline" method="post" action="/repos">${tokenField(token)}<input type="hidden" name="github" value="${esc(r.fullName)}"><button>Select</button></form>`}</td></tr>`).join('')}</tbody></table>`;
          } catch (err) {
            ghRepos = `<p class="bad">${esc(errorBody(err).error.code)}: ${esc(errorBody(err).error.message)}</p>`;
          }
        }
        return html(res, 200, renderHome(svc, token, null, ghRepos));
      }
      if (p.length === 2 && p[0] === 'repos') {
        const body = renderRepo(svc, p[1]!, url.searchParams, token);
        return body ? html(res, 200, body) : html(res, 404, page('Not found', '<p>Unknown repository.</p>'));
      }
      if (p.length === 4 && p[0] === 'repos' && p[2] === 'findings') {
        const body = renderFinding(svc, p[1]!, p[3]!);
        return body ? html(res, 200, body) : html(res, 404, page('Not found', '<p>Finding not in the latest completed report.</p>'));
      }
      if (p.length === 3 && p[0] === 'repos' && p[2] === 'compare') {
        const base = svc.store.run(url.searchParams.get('base') ?? '');
        const head = svc.store.run(url.searchParams.get('head') ?? '');
        if (!head || head.repoId !== p[1] || head.status !== 'completed' || (base && base.repoId !== p[1])) return html(res, 404, page('Not found', '<p>Runs not found.</p>'));
        return html(res, 200, renderCompare(svc, p[1]!, compareRuns(base?.status === 'completed' ? base : undefined, head)));
      }
      return html(res, 404, page('Not found', '<p>Not found.</p>'));
    } catch (err) {
      if (!res.headersSent) json(res, errorStatus(err), errorBody(err));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4178, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const shownHost = host === '::1' ? '[::1]' : host;
  return {
    server,
    url: `http://${shownHost}:${port}`,
    token,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
