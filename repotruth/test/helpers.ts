import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { auditRepository, type AuditOptions } from '../src/audit.js';
import type { AuditResult, Finding } from '../src/types.js';

const created: string[] = [];
after(async () => {
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

/** Writes a throwaway fixture repository and returns its path. */
export async function makeRepo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'repotruth-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

export async function auditFiles(files: Record<string, string | Buffer>, options?: AuditOptions): Promise<AuditResult> {
  return auditRepository(await makeRepo(files), options);
}

export function byRule(result: AuditResult, ruleId: string): Finding[] {
  return result.findings.filter((f) => f.ruleId === ruleId);
}

export const wf = (steps: string, extraJob = ''): string => `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
${extraJob}    steps:
${steps}`;
