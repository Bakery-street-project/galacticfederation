// Minimal Markdown helpers: fenced code blocks and relative links. Enough for
// setup/claim checks; not a CommonMark implementation.

export interface CodeLine {
  text: string;
  line: number;
  lang: string;
}

export interface MdLink {
  target: string;
  line: number;
}

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'shell-session', 'powershell', 'ps1', 'cmd']);

/** Lines inside fenced code blocks whose info string is empty or a shell. */
export function shellCodeLines(md: string): CodeLine[] {
  const out: CodeLine[] = [];
  let fence: string | null = null;
  let lang = '';
  md.split('\n').forEach((raw, idx) => {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(raw);
    if (m && (fence === null || m[1]!.startsWith(fence))) {
      if (fence === null) {
        fence = m[1]!;
        lang = (m[2] ?? '').toLowerCase();
      } else {
        fence = null;
      }
      return;
    }
    if (fence !== null && SHELL_LANGS.has(lang)) {
      out.push({ text: raw.replace(/^\s*[$>]\s+/, ''), line: idx + 1, lang });
    }
  });
  return out;
}

/** Prose lines (outside fenced code), with 1-based line numbers. */
export function proseLines(md: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let inFence = false;
  md.split('\n').forEach((raw, idx) => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ text: raw, line: idx + 1 });
  });
  return out;
}

/** Inline `[text](target)` links in prose whose target looks like a local path. */
export function relativeLinks(md: string): MdLink[] {
  const out: MdLink[] = [];
  for (const { text, line } of proseLines(md)) {
    const noCode = text.replace(/`[^`]*`/g, '');
    const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(noCode)) !== null) {
      const target = m[1] ?? '';
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/|\/)/i.test(target)) continue; // URL, anchor, absolute
      out.push({ target, line });
    }
  }
  return out;
}
