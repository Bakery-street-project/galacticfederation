// Fleet data model. Everything here is persisted by the store as JSON.

import type { CoverageEntry, Finding, Limits, Severity, SkippedEntry } from '../types.js';

export type SourceKind = 'local' | 'github';

export interface RepoRecord {
  id: string;
  kind: SourceKind;
  /** Local: path relative to the allowed root. GitHub: "owner/name". */
  locator: string;
  name: string;
  addedAt: string;
  /** GitHub only: the repository's default branch at selection time. */
  defaultBranch?: string;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface SourceReport {
  /** Commit the audited files came from, if known. */
  commitSha: string | null;
  /** How the commit was determined, e.g. "git HEAD (working tree may differ)". */
  commitNote: string;
  /** Files the source step itself declined to materialize. */
  skipped: SkippedEntry[];
  /** True when the source step dropped files for limit reasons. */
  truncated: boolean;
  notes: string[];
  bytesFetched: number;
}

export interface RunRecord {
  id: string;
  repoId: string;
  status: RunStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  source?: SourceReport;
  /** Present when status is `completed`. */
  audit?: {
    schemaVersion: string;
    toolVersion: string;
    durationMs: number;
    stats: { filesIndexed: number; filesRead: number; bytesRead: number };
    limits: Limits & { truncated: boolean; notes: string[] };
    coverage: { evaluated: CoverageEntry[]; notEvaluated: CoverageEntry[] };
    skipped: SkippedEntry[];
    summary: { total: number; bySeverity: Record<Severity, number>; byStatus: Record<'finding' | 'needs-review', number> };
    findings: Finding[];
  };
}

export interface StoreData {
  version: 1;
  repos: RepoRecord[];
  runs: RunRecord[];
}

/** Whether a completed run saw everything it was supposed to see. */
export interface Completeness {
  complete: boolean;
  reasons: string[];
}

export type ChangeKind = 'new' | 'continuing' | 'resolved';

export interface Comparison {
  baseRunId: string | null;
  headRunId: string;
  /** True only when both runs are complete and evaluated the same areas. */
  verified: boolean;
  reasons: string[];
  new: Finding[];
  continuing: Finding[];
  /** In base but not head. Only a verified conclusion when `verified` is true. */
  resolved: Finding[];
}
