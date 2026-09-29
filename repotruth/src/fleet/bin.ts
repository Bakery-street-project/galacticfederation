#!/usr/bin/env node
// Starts the local RepoTruth Fleet dashboard.
// Usage: repotruth-fleet --allowed-root <dir> [--data-dir <dir>] [--port N] [--max-parallel N]
//   [--webhook-secret-file <file>]
// Optional GitHub App: REPOTRUTH_GH_APP_ID, REPOTRUTH_GH_INSTALLATION_ID,
// REPOTRUTH_GH_PRIVATE_KEY_FILE [, REPOTRUTH_GH_API_URL].

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalRoot } from '../mcp/policy.js';
import { FleetService } from './service.js';
import { GitHubAppSource, githubConfigFromEnv } from './sources/github.js';
import { FleetStore } from './store.js';
import { startDashboard } from './web.js';
import { WebhookReceiver } from './webhooks.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt: Record<string, string> = {};
  while (args.length) {
    const a = args.shift()!;
    const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (!['--allowed-root', '--data-dir', '--port', '--max-parallel', '--host', '--webhook-secret-file'].includes(k)) {
      process.stderr.write(`repotruth-fleet: unknown argument ${k}\n`);
      return 2;
    }
    const v = inline ?? args.shift();
    if (!v) { process.stderr.write(`repotruth-fleet: ${k} needs a value\n`); return 2; }
    opt[k] = v;
  }
  const allowedRoot = await resolveAllowedRoot(opt['--allowed-root']);
  const dataDir = path.resolve(opt['--data-dir'] ?? process.env.REPOTRUTH_DATA_DIR ?? '.repotruth-data');
  const store = await FleetStore.open(dataDir);
  const ghConfig = await githubConfigFromEnv(process.env, (p) => readFile(p, 'utf8'));
  const github = ghConfig ? new GitHubAppSource(ghConfig) : null;
  if (!allowedRoot && !github) {
    process.stderr.write('repotruth-fleet: give --allowed-root <dir> for local repositories and/or configure a GitHub App\n');
    return 2;
  }
  const secret = await readSecret(opt['--webhook-secret-file'] ?? process.env.REPOTRUTH_GH_WEBHOOK_SECRET_FILE);
  const svc = new FleetService({ store, allowedRoot, github, maxParallel: Number(opt['--max-parallel'] ?? 2) });
  const web = await startDashboard(svc, {
    host: opt['--host'] ?? '127.0.0.1',
    port: Number(opt['--port'] ?? 4178),
    webhooks: secret ? new WebhookReceiver({ service: svc, secret }) : undefined,
  });
  process.stderr.write([
    `RepoTruth Fleet dashboard: ${web.url}  (local only; not multi-user authenticated)`,
    `Data: ${store.file}`,
    `Local repositories: ${allowedRoot ? 'enabled (under the given --allowed-root)' : 'disabled'}`,
    `GitHub App: ${github ? 'configured (not yet contacted)' : 'not configured'}`,
    `Webhooks: ${secret ? 'enabled at POST /webhooks (X-Hub-Signature-256 required)' : 'disabled (no --webhook-secret-file)'}`,
    `API token for scripted POSTs (header X-RepoTruth-Token): ${web.token}`,
    '',
  ].join('\n'));
  const shutdown = async () => { await web.close(); await svc.idle(); process.exit(0); };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  return 0;
}

/** Names the offending path: "allowed root does not exist" alone is unactionable. */
async function resolveAllowedRoot(requested: string | undefined): Promise<string | undefined> {
  if (!requested) return undefined;
  try {
    return await canonicalRoot(requested);
  } catch (err) {
    throw new Error(`--allowed-root ${requested}: ${(err as Error).message}`);
  }
}

async function readSecret(file: string | undefined): Promise<string | null> {
  if (!file) return null;
  const raw = (await readFile(path.resolve(file), 'utf8')).trim();
  if (!raw) throw new Error(`webhook secret file ${file} is empty`);
  return raw;
}

main().then((code) => { if (code) process.exitCode = code; }, (err: Error) => {
  process.stderr.write(`repotruth-fleet: ${err.message}\n`);
  process.exitCode = 2;
});
