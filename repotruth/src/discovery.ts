// Read-only, bounded repository discovery. Never follows symlinks, never
// executes anything, and records every file it declines to read.

import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Limits, SkippedEntry } from './types.js';

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 5000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  timeoutMs: 30_000,
};

/** Directory names skipped at any depth: VCS data, dependencies, build output. */
export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'target',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
]);

export interface FileEntry {
  path: string;
  size: number;
  isSymlink: boolean;
}

export class DeadlineExceeded extends Error {}

export class RepoIndex {
  readonly files = new Map<string, FileEntry>();
  readonly dirs = new Set<string>(['']);
  /** Paths inside ignored directories are unknown to us; used to avoid false "missing" claims. */
  readonly ignoredDirs = new Set<string>();
  readonly skipped: SkippedEntry[] = [];
  readonly notes: string[] = [];
  truncated = false;
  filesRead = 0;
  bytesRead = 0;
  private readonly cache = new Map<string, string | null>();

  constructor(
    readonly root: string,
    readonly limits: Limits,
    private readonly deadline: number,
  ) {}

  checkDeadline(): void {
    if (Date.now() > this.deadline) throw new DeadlineExceeded('scan timeout reached');
  }

  has(rel: string): boolean {
    return this.files.has(rel);
  }

  isDir(rel: string): boolean {
    return this.dirs.has(rel);
  }

  /** True when `rel` lies under a directory we deliberately did not index. */
  isUnderIgnored(rel: string): boolean {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (this.ignoredDirs.has(parts.slice(0, i).join('/'))) return true;
      if (IGNORED_DIRS.has(parts[i - 1] ?? '')) return true;
    }
    return false;
  }

  list(predicate: (p: string) => boolean): string[] {
    return [...this.files.keys()].filter(predicate);
  }

  /**
   * Returns file text, or null when the file is a symlink, too large, binary,
   * unreadable, or the byte budget is exhausted (the reason is recorded).
   */
  async readText(rel: string): Promise<string | null> {
    if (this.cache.has(rel)) return this.cache.get(rel) ?? null;
    this.checkDeadline();
    const entry = this.files.get(rel);
    let result: string | null = null;
    if (!entry) {
      result = null;
    } else if (entry.isSymlink) {
      this.skip(rel, 'symlink (not followed)');
    } else if (entry.size > this.limits.maxFileBytes) {
      this.skip(rel, `larger than maxFileBytes (${entry.size} > ${this.limits.maxFileBytes})`);
    } else if (this.bytesRead + entry.size > this.limits.maxTotalBytes) {
      this.truncated = true;
      this.skip(rel, 'maxTotalBytes budget exhausted');
    } else {
      try {
        const buf = await readFileBounded(path.join(this.root, rel), this.limits.maxFileBytes);
        if (buf.subarray(0, 8192).includes(0)) {
          this.skip(rel, 'binary file');
        } else {
          this.filesRead++;
          this.bytesRead += buf.length;
          result = buf.toString('utf8');
        }
      } catch (err) {
        this.skip(rel, `unreadable: ${errCode(err)}`);
      }
    }
    this.cache.set(rel, result);
    return result;
  }

  skip(rel: string, reason: string): void {
    this.skipped.push({ path: rel, reason });
  }
}

async function readFileBounded(abs: string, max: number): Promise<Buffer> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    if (bytesRead > max) throw Object.assign(new Error('file grew past limit'), { code: 'EFBIG' });
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? String(err);
}

/** Walks `root` breadth-first in sorted order so results are deterministic. */
export async function discover(root: string, limits: Limits, deadline: number): Promise<RepoIndex> {
  const index = new RepoIndex(root, limits, deadline);
  const queue: string[] = [''];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    index.checkDeadline();
    let names: string[];
    try {
      names = (await readdir(path.join(root, dir))).sort();
    } catch (err) {
      if (dir === '') throw err;
      index.skip(dir, `unreadable directory: ${errCode(err)}`);
      continue;
    }
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name;
      let st;
      try {
        st = await lstat(path.join(root, rel));
      } catch (err) {
        index.skip(rel, `unreadable: ${errCode(err)}`);
        continue;
      }
      if (st.isSymbolicLink()) {
        // Recorded so imports that target it are not reported as missing,
        // but never read or traversed.
        index.files.set(rel, { path: rel, size: 0, isSymlink: true });
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(name)) {
          index.ignoredDirs.add(rel);
          continue;
        }
        index.dirs.add(rel);
        queue.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (index.files.size >= limits.maxFiles) {
        if (!index.truncated) index.notes.push(`maxFiles (${limits.maxFiles}) reached; remaining files were not indexed`);
        index.truncated = true;
        return index;
      }
      index.files.set(rel, { path: rel, size: st.size, isSymlink: false });
    }
  }
  return index;
}
