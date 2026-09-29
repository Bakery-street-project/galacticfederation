// Defensive extraction of a gzipped tar archive (GitHub tarballs) into a
// fresh directory. Archive contents are untrusted:
// - only regular files and directories are written; symlinks, hard links and
//   devices are recorded as skipped;
// - paths are normalized; absolute paths, `..` segments and NUL bytes are
//   rejected; the archive's top-level directory is stripped;
// - decompressed bytes, entry count and per-file size are capped (gzip-bomb
//   protection); dependency and build-output directories are not written.
// Nothing extracted is ever executed or made executable.

import { createGunzip } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { IGNORED_DIRS } from '../../discovery.js';
import type { SkippedEntry } from '../../types.js';

export interface ExtractLimits {
  /** Cap on total decompressed tar bytes read. */
  maxExtractBytes: number;
  maxEntries: number;
  maxFileBytes: number;
}

export interface ExtractResult {
  filesWritten: number;
  bytesWritten: number;
  skipped: SkippedEntry[];
  truncated: boolean;
  notes: string[];
}

export class ExtractError extends Error {}

/** Returns a safe relative path, or null if the entry must be rejected. */
export function safeEntryPath(raw: string, stripComponents = 1): string | null {
  if (raw.includes('\0')) return null;
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  const rest = parts.slice(stripComponents);
  return rest.length ? rest.join('/') : '';
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const s = buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/, '').trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new ExtractError('corrupt tar header (size field)');
  return parseInt(s, 8);
}

function cstr(buf: Buffer, start: number, len: number): string {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return (nul >= 0 ? s.subarray(0, nul) : s).toString('utf8');
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(body.subarray(i, sp).toString('latin1'), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break;
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Streams `gz` through gunzip and a minimal ustar/pax/GNU-longname parser,
 * writing accepted files under `dest` (which must be a fresh, empty dir).
 */
export async function extractTarGz(gz: Readable | Buffer, dest: string, limits: ExtractLimits): Promise<ExtractResult> {
  const result: ExtractResult = { filesWritten: 0, bytesWritten: 0, skipped: [], truncated: false, notes: [] };
  const destReal = path.resolve(dest);
  const input = Buffer.isBuffer(gz) ? Readable.from([gz]) : gz;
  const gunzip = createGunzip();
  input.on('error', (e) => gunzip.destroy(e));
  input.pipe(gunzip);

  let buf: Buffer = Buffer.alloc(0);
  let total = 0;
  let entries = 0;
  let paxPath: string | undefined;
  let gnuLong: string | undefined;

  // State for the entry currently being read.
  type Pending = { kind: 'file' | 'skip' | 'pax' | 'gnulong' | 'globalpax'; rel: string | null; size: number; padded: number; got: number; chunks: Buffer[] };
  let pending: Pending | null = null;

  const skip = (p: string, reason: string) => { if (result.skipped.length < 1000) result.skipped.push({ path: p, reason }); };
  const stop = (note: string) => { result.truncated = true; result.notes.push(note); };

  const finishEntry = async (p: Pending) => {
    const body = Buffer.concat(p.chunks);
    if (p.kind === 'pax') { paxPath = parsePax(body).path; return; }
    if (p.kind === 'globalpax') return; // global pax records carry no per-file path we rely on
    if (p.kind === 'gnulong') { gnuLong = body.toString('utf8').replace(/\0+$/, ''); return; }
    if (p.kind !== 'file' || p.rel === null) return;
    const target = path.resolve(destReal, p.rel);
    if (!target.startsWith(destReal + path.sep)) { skip(p.rel, 'path escapes the extraction directory'); return; }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      skip(p.rel, code === 'EEXIST' ? 'duplicate path in archive' : `could not be written (${code ?? 'error'})`);
      return;
    }
    result.filesWritten++;
    result.bytesWritten += body.length;
  };

  let ended = false;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limits.maxExtractBytes) {
        stop(`decompressed archive exceeded maxExtractBytes (${limits.maxExtractBytes}); remaining entries were not extracted`);
        break;
      }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (true) {
        if (pending && pending.padded === 0) {
          const done: Pending = pending;
          pending = null;
          await finishEntry(done);
          continue;
        }
        if (pending) {
          const want = pending.padded;
          const take = Math.min(want, buf.length);
          if (take === 0) break;
          const dataLeft = pending.size - pending.got;
          if (dataLeft > 0) {
            const part = buf.subarray(0, Math.min(take, dataLeft));
            pending.got += part.length;
            if (pending.kind !== 'skip') pending.chunks.push(part);
          }
          buf = buf.subarray(take);
          pending.padded -= take;
          if (pending.padded > 0) break;
          const done = pending;
          pending = null;
          await finishEntry(done);
          continue;
        }
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (header.every((b) => b === 0)) { ended = true; break; }
        const size = parseOctal(header, 124, 12);
        const padded = Math.ceil(size / 512) * 512;
        const type = String.fromCharCode(header[156] ?? 0x30);
        const magic = header.subarray(257, 263).toString('latin1');
        const prefix = magic.startsWith('ustar') ? cstr(header, 345, 155) : '';
        let name = cstr(header, 0, 100);
        if (prefix) name = `${prefix}/${name}`;
        if (type === 'x') { pending = { kind: 'pax', rel: null, size, padded, got: 0, chunks: [] }; if (size > 1024 * 1024) throw new ExtractError('pax header too large'); continue; }
        if (type === 'g') { pending = { kind: 'globalpax', rel: null, size, padded, got: 0, chunks: [] }; if (size > 1024 * 1024) throw new ExtractError('pax header too large'); continue; }
        if (type === 'L') { pending = { kind: 'gnulong', rel: null, size, padded, got: 0, chunks: [] }; if (size > 64 * 1024) throw new ExtractError('long name too large'); continue; }
        const fullName = paxPath ?? gnuLong ?? name;
        paxPath = undefined;
        gnuLong = undefined;
        entries++;
        const rel = safeEntryPath(fullName);
        const label = rel ?? fullName.slice(0, 200);
        const skipBody = (reason: string | null) => {
          if (reason) skip(label, reason);
          pending = { kind: 'skip', rel: null, size, padded, got: 0, chunks: [] };
        };
        if (entries > limits.maxEntries) {
          if (!result.truncated) stop(`archive has more than maxEntries (${limits.maxEntries}) entries; the rest were not extracted`);
          skipBody(null);
          continue;
        }
        if (rel === null) { skipBody('unsafe path in archive (absolute, "..", or NUL)'); continue; }
        if (rel === '') { skipBody(null); continue; } // the archive's top-level directory
        if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) { skipBody(null); continue; }
        if (type === '5') { skipBody(null); continue; } // directories are created on demand
        if (type === '2') { skipBody('symlink in archive (not extracted)'); continue; }
        if (type === '1') { skipBody('hard link in archive (not extracted)'); continue; }
        if (type !== '0' && type !== '\0' && type !== '7') { skipBody(`unsupported entry type "${type}"`); continue; }
        if (size > limits.maxFileBytes) {
          skipBody(`larger than maxFileBytes (${size} > ${limits.maxFileBytes})`);
          result.truncated = true;
          if (!result.notes.some((n) => n.startsWith('some files exceeded'))) result.notes.push(`some files exceeded maxFileBytes (${limits.maxFileBytes}) and were not extracted`);
          continue;
        }
        pending = { kind: 'file', rel, size, padded, got: 0, chunks: [] };
      }
      if (ended) break;
    }
  } catch (err) {
    gunzip.destroy();
    input.destroy();
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(`archive could not be read: ${(err as Error).message}`);
  }
  gunzip.destroy();
  input.destroy();
  if (!ended && !result.truncated) {
    if (pending) throw new ExtractError('archive ended in the middle of an entry');
  }
  return result;
}
