#!/usr/bin/env node
// Launches the RepoTruth MCP server on stdio.
// Usage: repotruth-mcp --allowed-root <dir> [--max-response-bytes N]
//    or: REPOTRUTH_ALLOWED_ROOT=<dir> repotruth-mcp

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { TOOL_VERSION } from '../types.js';
import { canonicalRoot } from './policy.js';
import { createServer, parseArgs } from './server.js';
import type { ToolConfig } from './tool.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (typeof parsed === 'string') {
    process.stderr.write(`repotruth-mcp: ${parsed}\n`);
    process.exitCode = 2;
    return;
  }
  if (!parsed.allowedRoot) {
    process.stderr.write('repotruth-mcp: an allowed root is required (--allowed-root <dir> or REPOTRUTH_ALLOWED_ROOT)\n');
    process.exitCode = 2;
    return;
  }
  let allowedRoot: string;
  try {
    allowedRoot = await canonicalRoot(parsed.allowedRoot);
  } catch (err) {
    process.stderr.write(`repotruth-mcp: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const config: ToolConfig = { allowedRoot, maxResponseBytes: parsed.maxResponseBytes };
  const handle = serveStdio(() => createServer(config));
  process.on('SIGINT', () => { void handle.close(); });
  process.on('SIGTERM', () => { void handle.close(); });
  process.stderr.write(`repotruth-mcp ${TOOL_VERSION}: serving 1 tool on stdio\n`);
}

void main();
