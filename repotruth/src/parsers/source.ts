// Lightweight lexical scanning of source files. This is a tokenizer-level
// heuristic, not a full parser: regex literals and exotic syntax can confuse
// it, which is why rules built on it state their confidence explicitly.

export interface Comment {
  text: string;
  line: number;
}

export interface ImportRef {
  specifier: string;
  line: number;
}

type CommentStyle = 'c' | 'hash';

export function commentStyleFor(language: string | undefined): CommentStyle | undefined {
  switch (language) {
    case 'typescript': case 'javascript': case 'c': case 'cpp': case 'go':
    case 'rust': case 'java': case 'kotlin': case 'csharp': case 'swift': case 'php':
      return 'c';
    case 'python': case 'shell': case 'ruby':
      return 'hash';
    default:
      return undefined;
  }
}

/**
 * Splits source into comments and two same-length views (newlines preserved):
 * `code` has comments blanked; `bare` additionally replaces string-literal
 * contents with `x`, so regexes can match statement structure without ever
 * matching text that merely sits inside a string. Offsets map 1:1 to `src`.
 */
export function scanSource(src: string, style: CommentStyle): { comments: Comment[]; code: string; bare: string } {
  const comments: Comment[] = [];
  const code = src.split('');
  const bare = src.split('');
  let line = 1;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = bare[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    const lineComment = (style === 'c' && c === '/' && n === '/') || (style === 'hash' && c === '#');
    if (lineComment) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      comments.push({ text: src.slice(i, stop), line });
      blank(i, stop);
      i = stop;
      continue;
    }
    if (style === 'c' && c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      const body = src.slice(i, stop);
      body.split('\n').forEach((t, k) => comments.push({ text: t, line: line + k }));
      line += body.split('\n').length - 1;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = ++i;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          if (src[i + 1] === '\n') line++;
          i++;
        } else if (src[i] === '\n') {
          line++;
          if (c !== '`') break; // unterminated ordinary string: stop at EOL
        }
        i++;
      }
      for (let k = start; k < i && k < src.length; k++) if (src[k] !== '\n') bare[k] = 'x';
      i++;
      continue;
    }
    i++;
  }
  return { comments, code: code.join(''), bare: bare.join('') };
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?(["'])([^"'\n]+)\1/dg,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(["'])([^"'\n]+)\1/dg,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/dg,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/dg,
];

/**
 * Extracts static module specifiers from JS/TS source. Matching runs on the
 * `bare` view, so imports inside comments or string literals are ignored;
 * the specifier text is then read from the original source.
 */
export function extractImports(src: string): ImportRef[] {
  const { bare } = scanSource(src, 'c');
  const refs: ImportRef[] = [];
  const seen = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bare)) !== null) {
      const span = m.indices?.[2];
      if (!span) continue;
      const specifier = src.slice(span[0], span[1]);
      const line = bare.slice(0, m.index).split('\n').length;
      const key = `${line}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ specifier, line });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}
