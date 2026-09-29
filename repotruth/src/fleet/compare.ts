// Change tracking between runs, keyed by the audit core's finding
// fingerprints. "Resolved" is only a verified conclusion when both runs are
// complete and evaluated the same areas; otherwise a missing finding may
// simply not have been looked for.

import type { Comparison, Completeness, RunRecord } from './types.js';

/** Skip reasons that are normal for any repository and do not reduce coverage of supported inputs. */
const BENIGN_SKIPS = /^(binary file|symlink \(not followed\))$/;

export function completeness(run: RunRecord): Completeness {
  const reasons: string[] = [];
  if (run.status !== 'completed' || !run.audit) {
    return { complete: false, reasons: [`run is ${run.status}`] };
  }
  if (run.audit.limits.truncated) reasons.push(`scan truncated: ${run.audit.limits.notes.join('; ') || 'limit reached'}`);
  if (run.source?.truncated) reasons.push(`source truncated: ${run.source.notes.join('; ') || 'files dropped while fetching'}`);
  const unusual = run.audit.skipped.filter((s) => !BENIGN_SKIPS.test(s.reason));
  if (unusual.length) reasons.push(`${unusual.length} file(s) skipped by the scanner (e.g. ${unusual[0]!.path}: ${unusual[0]!.reason})`);
  if (run.source?.skipped.length) reasons.push(`${run.source.skipped.length} file(s) not fetched (e.g. ${run.source.skipped[0]!.path}: ${run.source.skipped[0]!.reason})`);
  return { complete: reasons.length === 0, reasons };
}

function areas(run: RunRecord): string {
  return (run.audit?.coverage.evaluated ?? []).map((e) => e.area).sort().join('|');
}

/** Latest completed run, and the most recent earlier completed run to compare it with. */
export function latestPair(runs: RunRecord[]): { head?: RunRecord; base?: RunRecord } {
  const done = runs.filter((r) => r.status === 'completed').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
  return { head: done[0], base: done[1] };
}

export function compareRuns(base: RunRecord | undefined, head: RunRecord): Comparison {
  const headFindings = head.audit?.findings ?? [];
  if (!base) {
    return {
      baseRunId: null, headRunId: head.id, verified: false,
      reasons: ['no earlier completed run to compare with'],
      new: headFindings, continuing: [], resolved: [],
    };
  }
  const reasons: string[] = [];
  const b = completeness(base);
  const h = completeness(head);
  for (const r of b.reasons) reasons.push(`earlier run: ${r}`);
  for (const r of h.reasons) reasons.push(`this run: ${r}`);
  if (b.complete && h.complete && areas(base) !== areas(head)) reasons.push('the two runs evaluated different areas');
  if (base.audit && head.audit && base.audit.toolVersion !== head.audit.toolVersion) {
    reasons.push(`scanner version changed (${base.audit.toolVersion} → ${head.audit.toolVersion})`);
  }

  const baseFindings = base.audit?.findings ?? [];
  const inBase = new Set(baseFindings.map((f) => f.fingerprint));
  const inHead = new Set(headFindings.map((f) => f.fingerprint));
  return {
    baseRunId: base.id,
    headRunId: head.id,
    verified: reasons.length === 0,
    reasons,
    new: headFindings.filter((f) => !inBase.has(f.fingerprint)),
    continuing: headFindings.filter((f) => inBase.has(f.fingerprint)),
    resolved: baseFindings.filter((f) => !inHead.has(f.fingerprint)),
  };
}
