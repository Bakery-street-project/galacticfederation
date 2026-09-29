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
      for (const c of comments) reportSuperlative(ctx, file, c.text, c.line);
    }

    for (const readme of readmes) {
      const md = await index.readText(readme);
      if (md === null) continue;
      for (const { text, line } of proseLines(md)) reportSuperlative(ctx, readme, text, line);
    }
  },
};

function reportSuperlative(ctx: RuleContext, path: string, text: string, line: number): void {
  const m = SUPERLATIVE.exec(text);
  if (!m) return;
  ctx.report({
    ruleId: 'claim.unverified-superlative',
    title: `Comparative performance claim: "${truncate(m[1]!, 60)}"`,
    severity: 'info', confidence: 'low', status: 'needs-review',
    location: { path, line }, evidence: truncate(text), fingerprintKey: m[1]!.toLowerCase(),
    explanation: 'RepoTruth found no way to verify this comparison statically. Such claims should be backed by a reproducible benchmark in the repository.',
    suggestion: 'Link a benchmark (method, hardware, numbers) or remove the claim.',
  });
}
