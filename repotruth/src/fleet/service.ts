// FleetService: the product core behind the dashboard and JSON API.
// Repositories are selected explicitly; scans run through a bounded queue;
// every scan calls auditRepository() directly on a local directory (in place
// for local repos, a temporary extracted snapshot for GitHub repos, deleted
// afterwards). Nothing from a scanned repository is ever executed.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuditConfigError, auditRepository } from '../audit.js';
import { DEFAULT_LIMITS } from '../discovery.js';
import { TargetError } from '../mcp/policy.js';
import { TOOL_VERSION, type Limits } from '../types.js';
import type { CheckRunReporter } from './checks.js';
import { compareRuns, completeness, latestPair } from './compare.js';
import { GitHubAppSource, GitHubError, REPO_NAME, type GitHubRepo } from './sources/github.js';
import { localSourceReport, resolveLocalRepo } from './sources/local.js';
import type { FleetStore } from './store.js';
import type { Comparison, Completeness, RepoRecord, RunRecord, SourceReport } from './types.js';

export interface FleetOptions {
  store: FleetStore;
  /** Local repositories must live under this directory. Omit to disable local repos. */
  allowedRoot?: string;
  github?: GitHubAppSource | null;
  maxParallel?: number;
  auditLimits?: Partial<Limits>;
  /** Where GitHub snapshots are extracted temporarily. */
  tmpDir?: string;
  /** When set, every completed GitHub scan also posts a check run. */
  checks?: CheckRunReporter | null;
}

export class FleetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface RepoSummary {
  repo: RepoRecord;
  latestRun?: RunRecord;
  lastCompleted?: RunRecord;
  completeness?: Completeness;
  active: boolean;
}

function idFor(kind: string, locator: string): string {
  return `${kind}-${createHash('sha256').update(`${kind}:${locator.toLowerCase()}`).digest('hex').slice(0, 12)}`;
}

export class FleetService {
  private readonly maxParallel: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly opts: FleetOptions) {
    this.maxParallel = Math.max(1, Math.min(opts.maxParallel ?? 2, 8));
  }

  get store(): FleetStore {
    return this.opts.store;
  }

  githubStatus(): { configured: boolean; lastContact: GitHubAppSource['lastContact'] } {
    return { configured: !!this.opts.github, lastContact: this.opts.github?.lastContact ?? null };
  }

  localEnabled(): boolean {
    return !!this.opts.allowedRoot;
  }

  async addLocal(requested: string): Promise<RepoRecord> {
    if (!this.opts.allowedRoot) throw new FleetError('LOCAL_DISABLED', 'local repositories are disabled (no --allowed-root)');
    let target;
    try {
      target = await resolveLocalRepo(this.opts.allowedRoot, requested);
    } catch (err) {
      if (err instanceof TargetError) throw new FleetError(err.code, err.message);
      throw err;
    }
    const name = target.display === '.' ? path.basename(this.opts.allowedRoot) : target.display;
    return this.store.addRepo({ id: idFor('local', target.display), kind: 'local', locator: target.display, name, addedAt: new Date().toISOString() });
  }

  async listGitHub(): Promise<GitHubRepo[]> {
    if (!this.opts.github) throw new FleetError('NOT_CONFIGURED', 'GitHub App is not configured');
    return this.opts.github.listRepositories();
  }

  /** Selects one repository the installation can access. */
  async addGitHub(fullName: string): Promise<RepoRecord> {
    if (!this.opts.github) throw new FleetError('NOT_CONFIGURED', 'GitHub App is not configured');
    if (!REPO_NAME.test(fullName)) throw new FleetError('INVALID_REPO_NAME', 'expected "owner/name"');
    const repo = await this.opts.github.getRepository(fullName);
    return this.store.addRepo({
      id: idFor('github', repo.fullName), kind: 'github', locator: repo.fullName, name: repo.fullName,
      addedAt: new Date().toISOString(), defaultBranch: repo.defaultBranch,
    });
  }

  async removeRepo(id: string): Promise<void> {
    if (this.store.runs(id).some((r) => r.status === 'queued' || r.status === 'running')) {
      throw new FleetError('BUSY', 'a scan for this repository is in progress');
    }
    await this.store.removeRepo(id);
  }

  summaries(): RepoSummary[] {
    return this.store.repos().map((repo) => this.summary(repo)).sort((a, b) => a.repo.name.localeCompare(b.repo.name));
  }

  summary(repo: RepoRecord): RepoSummary {
    const runs = this.store.runs(repo.id);
    const lastCompleted = runs.find((r) => r.status === 'completed');
    return {
      repo,
      latestRun: runs[0],
      lastCompleted,
      completeness: lastCompleted ? completeness(lastCompleted) : undefined,
      active: runs.some((r) => r.status === 'queued' || r.status === 'running'),
    };
  }

  /** Latest completed run compared with the previous completed run. */
  latestComparison(repoId: string): Comparison | null {
    const { head, base } = latestPair(this.store.runs(repoId));
    return head ? compareRuns(base, head) : null;
  }

  compare(baseRunId: string, headRunId: string): Comparison {
    const base = this.store.run(baseRunId);
    const head = this.store.run(headRunId);
    if (!base || !head || base.repoId !== head.repoId) throw new FleetError('NOT_FOUND', 'runs not found for the same repository');
    if (head.status !== 'completed') throw new FleetError('NOT_COMPLETED', 'the later run did not complete');
    return compareRuns(base.status === 'completed' ? base : undefined, head);
  }

  /** Queues a scan. If one is already queued or running for the repo, returns that run. */
  async scan(repoId: string): Promise<RunRecord> {
    const repo = this.store.repo(repoId);
    if (!repo) throw new FleetError('NOT_FOUND', 'unknown repository');
    const active = this.store.runs(repoId).find((r) => r.status === 'queued' || r.status === 'running');
    if (active) return active;
    const run: RunRecord = { id: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, repoId, status: 'queued', queuedAt: new Date().toISOString() };
    await this.store.putRun(run);
    const p = this.execute(repo, run).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    return run;
  }

  /** Resolves when every queued/running scan has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private async acquire(): Promise<void> {
    if (this.running < this.maxParallel) { this.running++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  private async execute(repo: RepoRecord, run: RunRecord): Promise<void> {
    await this.acquire();
    let tmp: string | null = null;
    try {
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      await this.store.putRun(run);

      let dir: string;
      let source: SourceReport;
      let headSha: string | null = null;
      if (repo.kind === 'local') {
        if (!this.opts.allowedRoot) throw new FleetError('LOCAL_DISABLED', 'local repositories are disabled (no --allowed-root)');
        // Re-resolve every time: the path policy is checked at scan time, not only when added.
        dir = (await resolveLocalRepo(this.opts.allowedRoot, repo.locator)).real;
        source = await localSourceReport(dir);
      } else {
        const gh = this.opts.github;
        if (!gh) throw new FleetError('NOT_CONFIGURED', 'GitHub App is not configured');
        const info = await gh.getRepository(repo.locator);
        const sha = await gh.resolveCommit(repo.locator, info.defaultBranch);
        headSha = sha;
        tmp = await mkdtemp(path.join(this.opts.tmpDir ?? tmpdir(), 'repotruth-snap-'));
        const snap = await gh.fetchSnapshot(repo.locator, sha, tmp);
        dir = tmp;
        source = {
          commitSha: sha, commitNote: `default branch ${info.defaultBranch} via GitHub App`,
          skipped: snap.skipped, truncated: snap.truncated, notes: snap.notes, bytesFetched: snap.bytesFetched,
        };
      }
      run.source = source;
      const result = await auditRepository(dir, { name: repo.name, limits: { ...DEFAULT_LIMITS, ...this.opts.auditLimits } });
      run.audit = {
        schemaVersion: result.schemaVersion,
        toolVersion: result.tool.version ?? TOOL_VERSION,
        durationMs: result.durationMs,
        stats: result.stats,
        limits: result.limits,
        coverage: result.coverage,
        skipped: result.skipped,
        summary: result.summary,
        findings: result.findings,
      };
      run.status = 'completed';
      if (headSha && this.opts.checks) {
        // A check run is an outbound notification, never a scan requirement:
        // a failure here must not fail the run.
        try {
          await this.opts.checks.report(run, { fullName: repo.locator, headSha });
        } catch (err) {
          const { code, message } = describeError(err, [tmp, this.opts.allowedRoot]);
          if (run.source) run.source.notes.push(`check run not posted (${code}: ${message})`);
        }
      }
    } catch (err) {
      run.status = 'failed';
      run.error = describeError(err, [tmp, this.opts.allowedRoot]);
    } finally {
      run.finishedAt = new Date().toISOString();
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      await this.store.putRun(run).catch(() => undefined);
      this.release();
    }
  }
}

/** Error summary safe to persist and display: no stack, no absolute paths, no tokens. */
function describeError(err: unknown, hidePaths: (string | null | undefined)[]): { code: string; message: string } {
  let code = 'INTERNAL_ERROR';
  let message = 'the scan failed unexpectedly';
  if (err instanceof GitHubError) { code = err.code; message = err.message; }
  else if (err instanceof FleetError) { code = err.code; message = err.message; }
  else if (err instanceof TargetError) { code = err.code; message = err.message; }
  else if (err instanceof AuditConfigError) { code = 'SCAN_ERROR'; message = err.message; }
  for (const p of hidePaths) if (p) message = message.split(p).join('<dir>');
  return { code, message: message.slice(0, 500) };
}
