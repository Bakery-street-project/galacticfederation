// Structural GitHub Actions workflow parsing. Only `jobs.<id>.steps[*].run`,
// `uses`, and `continue-on-error` keys are modelled; comments and arbitrary
// strings elsewhere in the file are never treated as executable steps.

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';

export interface RunLine {
  /** Logical shell line with comments removed. */
  text: string;
  /** 1-based line in the workflow file. */
  line: number;
}

export interface WorkflowStep {
  jobId: string;
  index: number;
  name?: string;
  uses?: string;
  run?: RunLine[];
  continueOnError?: { raw: unknown; line: number };
  line: number;
}

export interface WorkflowJob {
  id: string;
  line: number;
  continueOnError?: { raw: unknown; line: number };
  steps: WorkflowStep[];
}

export type WorkflowParse =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string; line?: number }
  | { kind: 'ok'; jobs: WorkflowJob[] };

export function isWorkflowPath(p: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);
}

export function parseWorkflow(src: string): WorkflowParse {
  if (src.trim() === '') return { kind: 'empty' };
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc, prettyErrors: false, uniqueKeys: false });
  const err = doc.errors[0];
  if (err) return { kind: 'invalid', message: err.message.split('\n')[0] ?? 'YAML error', line: lc.linePos(err.pos[0]).line };
  const root = doc.contents;
  if (!isMap(root)) return { kind: 'invalid', message: 'top level is not a mapping' };
  const lineAt = (n: Node | null | undefined): number => (n?.range ? lc.linePos(n.range[0]).line : 1);

  const jobsNode = root.get('jobs', true);
  const jobs: WorkflowJob[] = [];
  if (!isMap(jobsNode)) return { kind: 'ok', jobs };

  for (const pair of jobsNode.items) {
    const jobId = isScalar(pair.key) ? String(pair.key.value) : '?';
    const jobNode = pair.value;
    if (!isMap(jobNode)) continue;
    const job: WorkflowJob = { id: jobId, line: lineAt(pair.key as Node), steps: [] };
    const jobCoe = continueOnErrorOf(jobNode, lineAt);
    if (jobCoe) job.continueOnError = jobCoe;
    const steps = jobNode.get('steps', true);
    if (isSeq(steps)) {
      steps.items.forEach((stepNode, index) => {
        if (!isMap(stepNode)) return;
        const step: WorkflowStep = { jobId, index, line: lineAt(stepNode as Node) };
        const name = stepNode.get('name');
        if (typeof name === 'string') step.name = name;
        const uses = stepNode.get('uses');
        if (typeof uses === 'string') step.uses = uses;
        const runNode = stepNode.get('run', true);
        if (isScalar(runNode) && typeof runNode.value === 'string') {
          step.run = runLines(src, runNode, lc);
        }
        const coe = continueOnErrorOf(stepNode, lineAt);
        if (coe) step.continueOnError = coe;
        job.steps.push(step);
      });
    }
    jobs.push(job);
  }
  return { kind: 'ok', jobs };
}

function continueOnErrorOf(map: YAMLMap, lineAt: (n: Node) => number): { raw: unknown; line: number } | undefined {
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === 'continue-on-error');
  if (!pair || !isScalar(pair.value)) return undefined;
  return { raw: pair.value.value, line: lineAt(pair.key as Node) };
}

/**
 * Splits a `run:` script into logical lines (joining `\` continuations),
 * strips shell comments, and maps each back to its source line by locating
 * the text inside the scalar's source range.
 */
function runLines(src: string, node: Node, lc: LineCounter): RunLine[] {
  const value = String((node as { value: unknown }).value);
  const [start = 0, , end = src.length] = node.range ?? [];
  const raw = src.slice(start, end);
  const out: RunLine[] = [];
  const physical = value.split('\n');
  let searchFrom = 0;
  for (let i = 0; i < physical.length; i++) {
    const first = physical[i] ?? '';
    let text = first;
    while (text.endsWith('\\') && i + 1 < physical.length) {
      text = `${text.slice(0, -1)} ${physical[++i] ?? ''}`;
    }
    const stripped = stripShellComment(text).trim();
    if (!stripped) continue;
    const needle = first.trim();
    const at = needle ? raw.indexOf(needle, searchFrom) : -1;
    if (at >= 0) searchFrom = at + needle.length;
    out.push({ text: stripped, line: lc.linePos(start + Math.max(at, 0)).line });
  }
  return out;
}

/** Removes an unquoted `#` comment (at line start or after whitespace). */
export function stripShellComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
}
