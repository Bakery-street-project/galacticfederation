// Local persistence: one JSON file, written atomically (temp file + rename),
// with writes serialized in-process. Small, dependency-free, and survives a
// restart. Location: <dataDir>/fleet.json. Reset: stop the service and delete
// that file (or the whole data dir).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RepoRecord, RunRecord, StoreData } from './types.js';

export const MAX_RUNS_PER_REPO = 20;

export class FleetStore {
  private data: StoreData = { version: 1, repos: [], runs: [] };
  private writing: Promise<void> = Promise.resolve();

  private constructor(readonly file: string) {}

  static async open(dataDir: string): Promise<FleetStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new FleetStore(path.join(dataDir, 'fleet.json'));
    try {
      const parsed = JSON.parse(await readFile(store.file, 'utf8')) as StoreData;
      if (parsed.version !== 1 || !Array.isArray(parsed.repos) || !Array.isArray(parsed.runs)) {
        throw new Error('unsupported store format');
      }
      store.data = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`cannot read ${store.file}: ${(err as Error).message}`);
      }
    }
    // Runs that were in flight when the process stopped did not finish.
    let changed = false;
    for (const run of store.data.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        run.error = { code: 'INTERRUPTED', message: 'the service stopped before this run finished' };
        changed = true;
      }
    }
    if (changed) await store.flush();
    return store;
  }

  repos(): RepoRecord[] {
    return [...this.data.repos];
  }

  repo(id: string): RepoRecord | undefined {
    return this.data.repos.find((r) => r.id === id);
  }

  runs(repoId: string): RunRecord[] {
    return this.data.runs.filter((r) => r.repoId === repoId).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || b.id.localeCompare(a.id));
  }

  run(id: string): RunRecord | undefined {
    return this.data.runs.find((r) => r.id === id);
  }

  async addRepo(repo: RepoRecord): Promise<RepoRecord> {
    const existing = this.data.repos.find((r) => r.id === repo.id);
    if (existing) return existing;
    this.data.repos.push(repo);
    await this.flush();
    return repo;
  }

  async removeRepo(id: string): Promise<void> {
    this.data.repos = this.data.repos.filter((r) => r.id !== id);
    this.data.runs = this.data.runs.filter((r) => r.repoId !== id);
    await this.flush();
  }

  async putRun(run: RunRecord): Promise<void> {
    const i = this.data.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.data.runs[i] = run;
    else this.data.runs.push(run);
    this.prune(run.repoId);
    await this.flush();
  }

  /** Keeps the newest runs per repo, but never drops the latest completed one. */
  private prune(repoId: string): void {
    const runs = this.runs(repoId);
    if (runs.length <= MAX_RUNS_PER_REPO) return;
    const latestCompleted = runs.find((r) => r.status === 'completed');
    const keep = new Set(runs.slice(0, MAX_RUNS_PER_REPO).map((r) => r.id));
    if (latestCompleted) keep.add(latestCompleted.id);
    this.data.runs = this.data.runs.filter((r) => r.repoId !== repoId || keep.has(r.id));
  }

  flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    // A failed write must not block later ones.
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
