// Small, dependency-free text helpers shared by parsers and rules.

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function truncate(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.lua': 'lua', '.sh': 'shell', '.bash': 'shell',
};

export function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base.endsWith('.d.ts')) return '.ts';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function languageOf(p: string): string | undefined {
  return LANGUAGE_BY_EXT[extOf(p)];
}

export function isTestPath(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__mocks__|mocks?|testdata|examples?)(\/|$)/i.test(p)
    || /\.(test|spec)\.[a-z]+$/i.test(p)
    || /(^|\/)test_[^/]+\.py$/.test(p);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Joins and normalizes POSIX paths; returns null if the result escapes the root. */
export function joinRel(base: string, rel: string): string | null {
  const out: string[] = base ? base.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}
