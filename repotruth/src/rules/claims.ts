// Narrow claim-versus-code evidence. These rules never judge whether code is
// genuine; they surface the author's own words (comments admitting that a
// section only imitates the real behaviour, unbenchmarked superlatives) for a
// human to weigh. Broader semantic comparison is reserved for the opt-in AI
// review phase.

import { proseLines } from '../parsers/markdown.js';
import { commentStyleFor, scanSource } from '../parsers/source.js';
import { isTestPath, languageOf, truncate } from '../text.js';
import type { RuleContext, RuleModule } from './types.js';

export const SIMULATION_MARKER = /\b(simulat(?:e|es|ed|ing|ion)|placeholder|stub(?:bed)?|not (?:yet )?implemented|fake|dummy|hard-?coded (?:result|output|response)|for (?:the )?demo)\b/i;
export const SUPERLATIVE = /\b(better than\s+[\w.+-]+|(?:\d+(?:\.\d+)?\s*[x×]|\d+\s*%)\s+faster(?:\s+than\s+[\w.+-]+)?|faster than\s+[\w.+-]+|world'?s (?:first|fastest|best|most advanced))/i;

export const claimRules: RuleModule = {
  id: 'claims',
  async run(ctx: RuleContext) {
    const { index } = ctx;
    const unsupported = new Map<string, number>();
    const sources: string[] = [];
    for (const p of index.files.keys()) {
      const lang = languageOf(p);
      if (!lang || index.files.get(p)?.isSymlink) continue;
      if (commentStyleFor(lang)) sources.push(p);
      else unsupported.set(lang, (unsupported.get(lang) ?? 0) + 1);
    }
    sources.sort();
    const readmes = index.list((p) => /(^|\/)README[^/]*\.md$/i.test(p)).sort();
    if (sources.length || readmes.length) ctx.evaluated({ area: 'claims: comments & README', detail: `simulation markers and unbenchmarked superlatives in ${sources.length} source file(s) and README` });
    if (unsupported.size) {
      ctx.notEvaluated({ area: 'claims: other languages', detail: [...unsupported].map(([l, n]) => `${l} (${n})`).join(', ') + ': comment syntax not supported' });
    }

    for (const file of sources) {
      const src = await index.readText(file);
      if (src === null) continue;
      const { comments } = scanSource(src, commentStyleFor(languageOf(file))!);

      if (!isTestPath(file)) {
        const markers = comments.filter((c) => SIMULATION_MARKER.test(c.text));
        if (markers.length) {
          ctx.report({
            ruleId: 'claim.simulation-marker',
            title: `${markers.length} comment(s) describe behaviour as simulated/placeholder`,
            severity: 'low', confidence: 'medium', status: 'needs-review',
            location: { path: file, line: markers[0]!.line },
            evidence: truncate(markers.slice(0, 4).map((m) => `L${m.line}: ${m.text.trim()}`).join(' | '), 240),
            fingerprintKey: markers.map((m) => m.text.trim().toLowerCase()).join('|'),
            explanation: 'The code\'s own comments say parts of it are simulated, stubbed, or for demo only. If the README or file header presents this as a working feature, the claim is not backed by this code.',
            suggestion: 'Label the file as a prototype/demo, or replace the simulated sections with real implementations and tests.',
          });
        }
      }
      for (const c of comments) reportSuperlative(ctx, file, [c]);
    }

    for (const readme of readmes) {
      const md = await index.readText(readme);
      if (md === null) continue;
      for (const para of paragraphs(proseLines(md))) reportSuperlative(ctx, readme, para);
    }
  },
};

const SUPERLATIVE_ALL = new RegExp(SUPERLATIVE.source, 'gi');
/** Double-quoted (straight or curly) and inline-code spans. */
const QUOTED_SPAN = /"([^"\n]*)"|\u201c([^\u201d\n]*)\u201d|`([^`\n]*)`/g;

export interface ComparativeMatch {
  phrase: string;
  /** Offset of the phrase in the input text. */
  index: number;
  /** True when the phrase sits inside a quotation that also carries other words. */
  quoted: boolean;
}

/**
 * Finds the first comparative phrase used as an assertion. Use-mention rule:
 * a quotation or code span whose entire content is the phrase itself (e.g. a
 * rules table listing "better than X") names the phrase rather than asserting
 * it, so it is skipped. A longer quotation that contains the phrase (a quoted
 * sentence or testimonial) is still reported, flagged as quoted.
 */
export function findComparativeClaim(text: string): ComparativeMatch | null {
  const spans: { start: number; end: number; content: string }[] = [];
  for (const q of text.matchAll(QUOTED_SPAN)) {
    const content = q[1] ?? q[2] ?? q[3] ?? '';
    spans.push({ start: q.index!, end: q.index! + q[0].length, content });
  }
  const norm = (s: string) => s.toLowerCase().replace(/[\s.,;:!?]+$/g, '').replace(/^[\s.,;:!?]+/g, '').replace(/\s+/g, ' ');
  for (const m of text.matchAll(SUPERLATIVE_ALL)) {
    const phrase = m[1]!.replace(/[.,;:!?]+$/, '');
    const at = m.index!;
    const span = spans.find((sp) => at >= sp.start && at < sp.end);
    if (!span) return { phrase, index: at, quoted: false };
    if (norm(span.content) === norm(phrase)) continue; // a mention, not a claim
    return { phrase, index: at, quoted: true };
  }
  return null;
}

/**
 * Groups Markdown prose into paragraphs so quotations wrapped across lines
 * are seen whole. Table rows and headings stand alone.
 */
export function paragraphs(lines: { text: string; line: number }[]): { text: string; line: number }[][] {
  const out: { text: string; line: number }[][] = [];
  let cur: { text: string; line: number }[] = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (const l of lines) {
    if (!l.text.trim()) { flush(); continue; }
    if (/^\s*(\||#{1,6}\s)/.test(l.text)) { flush(); out.push([l]); continue; }
    cur.push(l);
  }
  flush();
  return out;
}

function reportSuperlative(ctx: RuleContext, path: string, lines: { text: string; line: number }[]): void {
  const text = lines.map((l) => l.text).join(' ');
  const m = findComparativeClaim(text);
  if (!m) return;
  let offset = 0;
  let hit = lines[0]!;
  for (const l of lines) {
    if (m.index < offset + l.text.length + 1) { hit = l; break; }
    offset += l.text.length + 1;
  }
  const line = hit.line;
  ctx.report({
    ruleId: 'claim.unverified-superlative',
    title: `Comparative performance claim: "${truncate(m.phrase, 60)}"`,
    severity: 'info', confidence: 'low', status: 'needs-review',
    location: { path, line }, evidence: truncate(hit.text), fingerprintKey: m.phrase.toLowerCase(),
    explanation: 'RepoTruth found no way to verify this comparison statically. Such claims should be backed by a reproducible benchmark in the repository.'
      + (m.quoted ? ' The phrase appears inside a quotation; confirm whether the project itself makes this claim.' : ''),
    suggestion: 'Link a benchmark (method, hardware, numbers) or remove the claim.',
  });
}
