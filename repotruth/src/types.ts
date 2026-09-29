// Shared data contract for the audit core. Adapters (CLI today; MCP / GitHub App
// later) consume these types and must not depend on rule internals.

export const SCHEMA_VERSION = '1.0.0';
export const TOOL_NAME = 'repotruth';
export const TOOL_VERSION = '0.1.0';

export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Confidence = 'low' | 'medium' | 'high';

/**
 * `finding`: the evidence directly supports the stated problem.
 * `needs-review`: the evidence is suggestive; a human must decide.
 */
export type FindingStatus = 'finding' | 'needs-review';

export interface Location {
  /** POSIX path relative to the audited root. */
  path: string;
  /** 1-based line, when known. */
  line?: number;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  status: FindingStatus;
  location: Location;
  /** Short verbatim excerpt(s) from the repository. */
  evidence: string;
  explanation: string;
  suggestion: string;
  /** Stable across line shifts; derived from rule, path and normalized evidence. */
  fingerprint: string;
}

/** A finding before the core assigns its fingerprint. */
export type DraftFinding = Omit<Finding, 'fingerprint'> & {
  /** Extra stable key material, e.g. the masked command. Defaults to evidence. */
  fingerprintKey?: string;
};

export interface CoverageEntry {
  area: string;
  detail: string;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface Limits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
}

export interface AuditResult {
  schemaVersion: string;
  tool: { name: string; version: string };
  target: { name: string };
  durationMs: number;
  stats: { filesIndexed: number; filesRead: number; bytesRead: number };
  limits: Limits & { truncated: boolean; notes: string[] };
  coverage: { evaluated: CoverageEntry[]; notEvaluated: CoverageEntry[] };
  skipped: SkippedEntry[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byStatus: Record<FindingStatus, number>;
  };
  findings: Finding[];
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}
