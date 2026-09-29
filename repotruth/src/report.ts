// Presentation only: turns an AuditResult into terminal text or JSON.

import { severityRank, type AuditResult, type Severity } from './types.js';

export function toJson(result: AuditResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const LABEL: Record<Severity, string> = { high: 'HIGH  ', medium: 'MEDIUM', low: 'LOW   ', info: 'INFO  ' };

export function toHuman(result: AuditResult, failOn: Severity | 'none'): string {
  const out: string[] = [];
  const { stats, limits, summary } = result;
  out.push(`RepoTruth ${result.tool.version}: audit of "${result.target.name}"`);
  out.push(`Indexed ${stats.filesIndexed} files, read ${stats.filesRead} (${stats.bytesRead} bytes) in ${result.durationMs} ms. No repository code was executed.`);
  if (limits.truncated) out.push(`WARNING: scan truncated. ${limits.notes.join('; ')}`);
  out.push('');

  if (!result.findings.length) {
    out.push(result.coverage.evaluated.length
      ? 'No findings in the evaluated areas.'
      : 'Nothing was evaluated: no supported inputs found. This is NOT a clean bill of health.');
  }
  for (const f of result.findings) {
    const loc = f.location.line ? `${f.location.path}:${f.location.line}` : f.location.path;
    out.push(`${LABEL[f.severity]} ${f.ruleId}  ${loc}`);
    out.push(`  ${f.title}  [${f.status}, confidence ${f.confidence}]`);
    out.push(`  Evidence: ${f.evidence}`);
    out.push(`  Why:      ${f.explanation}`);
    out.push(`  Next:     ${f.suggestion}`);
    out.push(`  id:       ${f.fingerprint}`);
    out.push('');
  }

  out.push('Coverage');
  for (const e of result.coverage.evaluated) out.push(`  evaluated      ${e.area}: ${e.detail}`);
  for (const e of result.coverage.notEvaluated) out.push(`  NOT evaluated  ${e.area}: ${e.detail}`);
  if (result.skipped.length) {
    out.push(`  skipped files  ${result.skipped.length}: ${result.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join(', ')}${result.skipped.length > 5 ? ', …' : ''}`);
  }
  out.push('');
  const s = summary.bySeverity;
  out.push(`Summary: ${summary.total} total: ${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} info `
    + `(${summary.byStatus.finding} finding, ${summary.byStatus['needs-review']} needs-review).`);
  if (failOn !== 'none') {
    const failing = result.findings.filter((f) => severityRank(f.severity) >= severityRank(failOn)).length;
    out.push(`Threshold --fail-on ${failOn}: ${failing} finding(s) at or above it.`);
  }
  return `${out.join('\n')}\n`;
}
