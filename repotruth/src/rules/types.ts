import type { RepoIndex } from '../discovery.js';
import type { CoverageEntry, DraftFinding } from '../types.js';

export interface RuleContext {
  index: RepoIndex;
  report(finding: DraftFinding): void;
  evaluated(entry: CoverageEntry): void;
  notEvaluated(entry: CoverageEntry): void;
}

/** A rule group. Rules read via `ctx.index` only and never execute repository code. */
export interface RuleModule {
  id: string;
  run(ctx: RuleContext): Promise<void>;
}
