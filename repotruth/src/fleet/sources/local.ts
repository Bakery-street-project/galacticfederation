// Local directory source. Audits the directory in place (the core is
// read-only), confined to the operator's allowed root. The commit is read
// from .git metadata without running git.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveTarget } from '../../mcp/policy.js';
import type { SourceReport } from '../types.js';

export { resolveTarget as resolveLocalRepo };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

async function readSmall(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Reads HEAD's commit from a checkout's .git directory (or gitdir file). Never executes git. */
export async function readGitHead(dir: string): Promise<{ sha: string | null; note: string }> {
  let gitDir = path.join(dir, '.git');
  const dotGit = await readSmall(gitDir);
  if (dotGit !== null) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(dotGit);
    if (!m) return { sha: null, note: 'unrecognized .git file' };
    gitDir = path.resolve(dir, m[1]!);
  }
  const head = await readSmall(path.join(gitDir, 'HEAD'));
  if (head === null) return { sha: null, note: 'no git metadata (not a git checkout)' };
  const trimmed = head.trim();
  if (SHA.test(trimmed)) return { sha: trimmed, note: 'detached HEAD; uncommitted changes are not detected' };
  const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(trimmed)?.[1];
  if (!ref || ref.includes('..')) return { sha: null, note: 'unrecognized HEAD' };
  const loose = (await readSmall(path.join(gitDir, ref)))?.trim();
  if (loose && SHA.test(loose)) return { sha: loose, note: `${ref.replace('refs/heads/', 'branch ')}; uncommitted changes are not detected` };
  const packed = await readSmall(path.join(gitDir, 'packed-refs'));
  const line = packed?.split('\n').find((l) => l.endsWith(` ${ref}`));
  const sha = line?.split(' ')[0];
  if (sha && SHA.test(sha)) return { sha, note: `${ref.replace('refs/heads/', 'branch ')} (packed); uncommitted changes are not detected` };
  return { sha: null, note: `${ref} has no commits yet` };
}

export async function localSourceReport(dir: string): Promise<SourceReport> {
  const head = await readGitHead(dir);
  return { commitSha: head.sha, commitNote: head.note, skipped: [], truncated: false, notes: [], bytesFetched: 0 };
}
