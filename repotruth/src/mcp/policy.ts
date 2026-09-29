// Access policy for the MCP adapter: every audit target must canonicalize to
// a directory inside one explicitly configured allowed root. This is an
// application-level check, not an OS sandbox.

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type TargetErrorCode =
  | 'INVALID_ARGUMENT'
  | 'URL_NOT_SUPPORTED'
  | 'OUTSIDE_ALLOWED_ROOT'
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'UNREADABLE';

export class TargetError extends Error {
  constructor(readonly code: TargetErrorCode, message: string) {
    super(message);
  }
}

/** Canonicalizes the configured root once at startup. */
export async function canonicalRoot(root: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path.resolve(root));
  } catch {
    throw new Error('allowed root does not exist or is not accessible');
  }
  if (!(await stat(real)).isDirectory()) throw new Error('allowed root is not a directory');
  return real;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolves `requested` (relative to the root, or absolute) to a canonical
 * directory inside `root`. Rejects URLs, traversal and symlink escapes.
 * Returns the real path plus a root-relative display path.
 */
export async function resolveTarget(root: string, requested: string | undefined): Promise<{ real: string; display: string }> {
  const raw = requested ?? '.';
  if (raw.includes('\0')) throw new TargetError('INVALID_ARGUMENT', 'path contains a NUL byte');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[\w.-]+@[\w.-]+:/.test(raw)) {
    throw new TargetError('URL_NOT_SUPPORTED', 'only local paths inside the allowed root can be audited; URLs and git remotes are not accepted');
  }
  const lexical = path.resolve(root, raw);
  // Lexical check first so `../` traversal is rejected even if the target does not exist.
  if (!isInside(root, lexical)) throw new TargetError('OUTSIDE_ALLOWED_ROOT', 'path resolves outside the allowed root');
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TargetError('NOT_FOUND', 'path does not exist');
    throw new TargetError('UNREADABLE', `path is not accessible (${code ?? 'error'})`);
  }
  // Canonical check catches symlinks that point outside the root.
  if (!isInside(root, real)) throw new TargetError('OUTSIDE_ALLOWED_ROOT', 'path resolves (via a symlink) outside the allowed root');
  let st;
  try {
    st = await stat(real);
  } catch (err) {
    throw new TargetError('UNREADABLE', `path is not accessible (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!st.isDirectory()) throw new TargetError('NOT_A_DIRECTORY', 'path is not a directory');
  const display = path.relative(root, real).split(path.sep).join('/') || '.';
  return { real, display };
}
