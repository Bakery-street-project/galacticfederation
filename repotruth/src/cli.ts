// CLI adapter over the audit core. Exit codes:
//   0  no findings at or above the --fail-on threshold
//   1  one or more findings at or above the threshold
//   2  usage, configuration, or scanner error

import { AuditConfigError, auditRepository } from './audit.js';
import { toHuman, toJson } from './report.js';
import { SEVERITIES, severityRank, TOOL_VERSION, type Limits, type Severity } from './types.js';

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

const USAGE = `Usage: repotruth audit <path> [options]

Audits one local repository. Read-only: never runs the target's code.

Options:
  --format human|json     Output format (default: human)
  --fail-on LEVEL         info|low|medium|high|none (default: low)
  --max-files N           Max files to index (default: 5000)
  --max-file-bytes N      Max size of a file to read (default: 1048576)
  --max-total-bytes N     Max bytes read overall (default: 52428800)
  --timeout-ms N          Overall time budget (default: 30000)
  -h, --help              Show help
  -v, --version           Show version

Exit codes: 0 = no findings at/above threshold, 1 = findings at/above threshold, 2 = error.
`;

interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help')) { io.stdout(USAGE); return EXIT_OK; }
  if (args.includes('-v') || args.includes('--version')) { io.stdout(`${TOOL_VERSION}\n`); return EXIT_OK; }
  const cmd = args.shift();
  if (cmd !== 'audit') {
    io.stderr(`${cmd ? `unknown command: ${cmd}\n` : ''}${USAGE}`);
    return EXIT_ERROR;
  }
  let target: string | undefined;
  let format = 'human';
  let failOn: Severity | 'none' = 'low';
  const limits: Partial<Limits> = {};
  const numeric: Record<string, keyof Limits> = {
    '--max-files': 'maxFiles', '--max-file-bytes': 'maxFileBytes',
    '--max-total-bytes': 'maxTotalBytes', '--timeout-ms': 'timeoutMs',
  };
  while (args.length) {
    const a = args.shift()!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? args.shift();
    if (flag === '--format') {
      format = value() ?? '';
      if (format !== 'human' && format !== 'json') return usageError(io, `--format must be human or json`);
    } else if (flag === '--fail-on') {
      const v = value() ?? '';
      if (v !== 'none' && !(SEVERITIES as readonly string[]).includes(v)) return usageError(io, `--fail-on must be one of ${SEVERITIES.join('|')}|none`);
      failOn = v as Severity | 'none';
    } else if (flag in numeric) {
      const v = Number(value());
      if (!Number.isInteger(v) || v <= 0) return usageError(io, `${flag} must be a positive integer`);
      limits[numeric[flag]!] = v;
    } else if (flag.startsWith('-')) {
      return usageError(io, `unknown option: ${flag}`);
    } else if (target === undefined) {
      target = flag;
    } else {
      return usageError(io, `unexpected argument: ${flag}`);
    }
  }
  if (target === undefined) return usageError(io, 'missing <path>');

  let result;
  try {
    result = await auditRepository(target, { limits });
  } catch (err) {
    io.stderr(`repotruth: ${err instanceof AuditConfigError ? err.message : `internal error: ${(err as Error).stack ?? err}`}\n`);
    return EXIT_ERROR;
  }
  io.stdout(format === 'json' ? toJson(result) : toHuman(result, failOn));
  if (failOn === 'none') return EXIT_OK;
  return result.findings.some((f) => severityRank(f.severity) >= severityRank(failOn)) ? EXIT_FINDINGS : EXIT_OK;
}

function usageError(io: Io, msg: string): number {
  io.stderr(`repotruth: ${msg}\n\n${USAGE}`);
  return EXIT_ERROR;
}
