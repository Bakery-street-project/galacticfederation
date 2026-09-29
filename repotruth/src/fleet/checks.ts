// Maps a completed fleet run onto a GitHub check run: one summary, plus a
// bounded set of annotations that map each finding's `location` to file and
// line. Advisory by default — a check run conclusion never blocks a merge
// unless the operator explicitly asks for the gating policy.
//
// Nothing from a scanned repository reaches GitHub: only counts, paths, and the
// tool's own rule text. Finding evidence is untrusted repository text and is
// deliberately left out, and every repository-derived string that is rendered as
// markdown is stripped of the characters that could form a link or a heading.

import { SEVERITIES, severityRank, type Finding, type Severity } from '../types.js';
import { completeness } from './compare.js';
import type { GitHubAppSource } from './sources/github.js';
import type { RunRecord } from './types.js';

/** GitHub accepts at most 50 annotations per check run. */
export const MAX_ANNOTATIONS = 50;

export type CheckPolicy = 'advisory' | 'gating';
export type CheckConclusion = 'success' | 'failure' | 'neutral';
export type AnnotationLevel = 'notice' | 'warning' | 'failure';

export interface CheckAnnotation {
  path: string;
  start_line: number;
  annotation_level: AnnotationLevel;
  title: string;
  message: string;
}

export interface CheckRunTarget {
  fullName: string;
  headSha: string;
}

export interface CheckRunReport {
  id: number;
  conclusion: CheckConclusion;
  annotations: number;
  url: string | undefined;
}

const LEVEL: Record<Severity, AnnotationLevel> = {
  info: 'notice', low: 'notice', medium: 'warning', high: 'failure',
};

/**
 * Advisory runs report `neutral` and can never fail a build. Gating runs fail
 * on a high-severity finding, and stay `neutral` when the scan was incomplete:
 * an unevaluated repository proves neither clean nor dirty.
 */
export function conclusionFor(run: RunRecord, policy: CheckPolicy = 'advisory'): CheckConclusion {
  if (run.status !== 'completed' || !run.audit) return 'neutral';
  if (policy === 'advisory') return 'neutral';
  if (!completeness(run).complete) return 'neutral';
  return (run.audit.summary.bySeverity.high ?? 0) > 0 ? 'failure' : 'success';
}

/** Repository-relative path, or null when the location cannot name a file safely. */
function annotationPath(path: string | undefined): string | null {
  if (typeof path !== 'string' || !path || path.length > 512) return null;
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) return null;
  if (path.split('/').some((s) => s === '' || s === '..')) return null;
  return path;
}

/** Control characters out; no characters that would change markdown structure. */
function safeText(s: string, max: number): string {
  const flat = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_\[\]<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function annotationFor(f: Finding): CheckAnnotation | null {
  const p = annotationPath(f.location?.path);
  if (!p) return null;
  const line = f.location.line;
  return {
    path: p,
    start_line: Number.isInteger(line) && line! > 0 ? line! : 1,
    annotation_level: LEVEL[f.severity] ?? 'notice',
    title: safeText(f.title, 255) || f.ruleId,
    message: safeText(f.explanation, 1024) || f.ruleId,
  };
}

/** Highest severity first, then a stable order, so repeated runs agree. */
function rank(f: Finding): string {
  return `${9 - severityRank(f.severity)}|${f.location.path}|${f.location.line ?? 0}|${f.ruleId}|${f.fingerprint}`;
}

export function annotationsFor(run: RunRecord): { annotations: CheckAnnotation[]; omitted: number } {
  const mapped = (run.audit?.findings ?? []).map((f) => ({ f, a: annotationFor(f) })).sort((x, y) => rank(x.f).localeCompare(rank(y.f)));
  const annotations: CheckAnnotation[] = [];
  let omitted = 0;
  for (const { a } of mapped) {
    if (!a) { omitted++; continue; }
    if (annotations.length < MAX_ANNOTATIONS) annotations.push(a);
    else omitted++;
  }
  return { annotations, omitted };
}

function severityLine(bySeverity: Record<Severity, number>): string {
  return [...SEVERITIES].reverse().map((s) => `${bySeverity[s] ?? 0} ${s}`).join(', ');
}

function title(run: RunRecord): string {
  const total = run.audit?.summary.total ?? 0;
  const high = run.audit?.summary.bySeverity.high ?? 0;
  if (total === 0) return 'RepoTruth: no findings';
  return `RepoTruth: ${total} finding${total === 1 ? '' : 's'}${high ? `, ${high} high` : ''}`;
}

function summary(run: RunRecord, annotations: CheckAnnotation[], omitted: number, policy: CheckPolicy): string {
  const a = run.audit!;
  const c = completeness(run);
  const lines = [
    `${safeText(title(run), 255)}.`,
    `Severity: ${severityLine(a.summary.bySeverity)}. Status: ${a.summary.byStatus.finding} finding, ${a.summary.byStatus['needs-review']} needs review.`,
    `Coverage: ${c.complete ? 'complete within limits' : `incomplete — ${c.reasons.map((r) => safeText(r, 200)).join('; ')}`}.`,
    `Scanned: ${a.stats.filesRead} of ${a.stats.filesIndexed} indexed file(s) in ${Math.round(a.durationMs)} ms (repotruth ${safeText(a.toolVersion, 40)}).`,
  ];
  if (run.source?.commitSha) lines.push(`Commit: ${safeText(run.source.commitSha.slice(0, 12), 40)} — ${safeText(run.source.commitNote, 200)}.`);
  if (policy === 'advisory') lines.push('Advisory: this check reports findings and does not block merges.');
  else lines.push('Gating: this check fails on a high-severity finding. An incomplete scan stays neutral rather than claiming the repository is clean.');
  if (omitted) lines.push(`${omitted} finding(s) are not annotated (limit ${MAX_ANNOTATIONS}, or an unmappable location); counts above are complete.`);
  lines.push(`Run ${safeText(run.id, 64)} in the local RepoTruth fleet dashboard.`);
  return lines.join('\n\n');
}

/** Posts one check run per completed run. Nothing is persisted or retried here. */
export class CheckRunReporter {
  constructor(
    private readonly github: GitHubAppSource,
    readonly policy: CheckPolicy = 'advisory',
    readonly name = 'repotruth',
  ) {}

  /** Returns null when the run has nothing reportable on the target commit. */
  async report(run: RunRecord, target: CheckRunTarget): Promise<CheckRunReport | null> {
    if (run.status !== 'completed' || !run.audit) return null;
    const audited = run.source?.commitSha ?? null;
    // Annotations describe the commit that was audited; posting them anywhere
    // else would point at code the scan never read.
    if (!audited || audited.toLowerCase() !== target.headSha.toLowerCase()) return null;
    const now = new Date().toISOString();
    const { annotations, omitted } = annotationsFor(run);
    const conclusion = conclusionFor(run, this.policy);
    const created = await this.github.createCheckRun(target.fullName, {
      name: this.name,
      head_sha: target.headSha,
      status: 'completed',
      started_at: run.startedAt ?? now,
      completed_at: run.finishedAt ?? now,
      conclusion,
      output: { title: title(run), summary: summary(run, annotations, omitted, this.policy), annotations },
    });
    return { id: created.id, conclusion, annotations: annotations.length, url: created.html_url };
  }
}
