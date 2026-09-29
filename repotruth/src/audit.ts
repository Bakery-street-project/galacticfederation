// Audit core: discovery → rules → fingerprinting → sorted result. This is the
// single entry point later adapters (MCP tool, GitHub App, fleet runner) call.

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DeadlineExceeded, DEFAULT_LIMITS, discover } from './discovery.js';
import { ciRules } from './rules/ci.js';
import { claimRules } from './rules/claims.js';
import { jsRules } from './rules/js.js';
import { setupRules } from './rules/setup.js';
import type { RuleModule } from './rules/types.js';
import {
  SCHEMA_VERSION, SEVERITIES, TOOL_NAME, TOOL_VERSION,
  type AuditResult, type CoverageEntry, type DraftFinding, type Finding, type Limits,
} from './types.js';

export const RULE_MODULES: RuleModule[] = [ciRules, setupRules, jsRules, claimRules];

export class AuditConfigError extends Error {}

export interface AuditOptions {
  limits?: Partial<Limits>;
  /** Display name for the target; defaults to the directory's basename. Absolute paths are never emitted. */
  name?: string;
}

export function fingerprint(ruleId: string, filePath: string, key: string, occurrence: number): string {
  const norm = key.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(`${ruleId}\0${filePath}\0${norm}\0${occurrence}`).digest('hex').slice(0, 16);
}

export async function auditRepository(root: string, options: AuditOptions = {}): Promise<AuditResult> {
  const started = Date.now();
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isInteger(v) || v <= 0) throw new AuditConfigError(`limit ${k} must be a positive integer`);
  }
  const abs = path.resolve(root);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new AuditConfigError(`target does not exist or is not accessible: ${root}`);
  }
  if (!st.isDirectory()) throw new AuditConfigError(`target is not a directory: ${root}`);

  const deadline = started + limits.timeoutMs;
  let index;
  try {
    index = await discover(abs, limits, deadline);
  } catch (err) {
    if (err instanceof DeadlineExceeded) throw new AuditConfigError('timeout reached during discovery; raise --timeout-ms');
    throw new AuditConfigError(`cannot read target: ${(err as Error).message}`);
  }

  const drafts: DraftFinding[] = [];
  const evaluated: CoverageEntry[] = [];
  const notEvaluated: CoverageEntry[] = [];
  const ctx = {
    index,
    report: (f: DraftFinding) => drafts.push(f),
    evaluated: (e: CoverageEntry) => evaluated.push(e),
    notEvaluated: (e: CoverageEntry) => notEvaluated.push(e),
  };
  for (const mod of RULE_MODULES) {
    try {
      await mod.run(ctx);
    } catch (err) {
      if (!(err instanceof DeadlineExceeded)) throw err;
      index.truncated = true;
      index.notes.push(`timeout reached during "${mod.id}" rules; later rules did not run`);
      notEvaluated.push({ area: mod.id, detail: 'stopped by timeout' });
      break;
    }
  }

  const seen = new Map<string, number>();
  const findings: Finding[] = drafts.map(({ fingerprintKey, ...f }) => {
    const base = `${f.ruleId}\0${f.location.path}\0${fingerprintKey ?? f.evidence}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...f, fingerprint: fingerprint(f.ruleId, f.location.path, fingerprintKey ?? f.evidence, n) };
  });
  findings.sort((a, b) =>
    a.location.path.localeCompare(b.location.path)
    || (a.location.line ?? 0) - (b.location.line ?? 0)
    || a.ruleId.localeCompare(b.ruleId)
    || a.fingerprint.localeCompare(b.fingerprint));

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as AuditResult['summary']['bySeverity'];
  const byStatus: AuditResult['summary']['byStatus'] = { finding: 0, 'needs-review': 0 };
  for (const f of findings) {
    bySeverity[f.severity]++;
    byStatus[f.status]++;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: { name: options.name ?? path.basename(abs) },
    durationMs: Date.now() - started,
    stats: { filesIndexed: index.files.size, filesRead: index.filesRead, bytesRead: index.bytesRead },
    limits: { ...limits, truncated: index.truncated, notes: index.notes },
    coverage: { evaluated, notEvaluated },
    skipped: index.skipped,
    summary: { total: findings.length, bySeverity, byStatus },
    findings,
  };
}
