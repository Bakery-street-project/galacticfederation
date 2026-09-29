// Builds (possibly hostile) gzipped tar archives for tests.

import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  body?: string | Buffer;
  /** '0' file, '5' dir, '2' symlink, '1' hardlink, 'x' pax header. */
  type?: string;
  linkname?: string;
  /** Override the size field (to lie about sizes). */
  size?: number;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname) h.write(e.linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = typeof e.body === 'string' ? Buffer.from(e.body) : e.body ?? Buffer.alloc(0);
    parts.push(header(e, e.size ?? body.length));
    if (body.length) {
      parts.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function paxRecord(key: string, value: string): string {
  const rec = ` ${key}=${value}\n`;
  let len = rec.length + 1;
  while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
  return `${len}${rec}`;
}

export function tgz(entries: TarEntry[]): Buffer {
  return gzipSync(tar(entries));
}

/** A repository tarball as GitHub produces it: everything under "<owner>-<repo>-<sha7>/". */
export function repoTarball(files: Record<string, string>, prefix = 'org-repo-abc1234'): Buffer {
  return tgz([{ name: `${prefix}/`, type: '5' }, ...Object.entries(files).map(([name, body]) => ({ name: `${prefix}/${name}`, body }))]);
}
