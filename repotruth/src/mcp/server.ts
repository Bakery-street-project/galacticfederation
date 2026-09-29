// Local stdio MCP server exposing one read-only tool, `audit_repository`.
// stdout carries only MCP protocol messages; diagnostics go to stderr and
// never include repository contents, paths, or environment values.
//
// Entry point: ./bin.ts.

import { McpServer } from '@modelcontextprotocol/server';
import { TOOL_VERSION } from '../types.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES, inputSchema, outputSchema, runAuditTool, summarize,
  TOOL_DESCRIPTION, TOOL_NAME, type ToolConfig,
} from './tool.js';

export interface ServerOptions {
  allowedRoot?: string;
  maxResponseBytes: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ServerOptions | string {
  const opts: ServerOptions = { allowedRoot: env.REPOTRUTH_ALLOWED_ROOT || undefined, maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES };
  const args = [...argv];
  while (args.length) {
    const a = args.shift()!;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = inline ?? args.shift();
    if (flag === '--allowed-root') {
      if (!value) return '--allowed-root needs a directory';
      opts.allowedRoot = value;
    } else if (flag === '--max-response-bytes') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 2048 || n > 10_000_000) return '--max-response-bytes must be an integer between 2048 and 10000000';
      opts.maxResponseBytes = n;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  return opts;
}

/** Builds a server instance; one per connection, as serveStdio expects. */
export function createServer(config: ToolConfig): McpServer {
  const server = new McpServer({ name: 'repotruth', version: TOOL_VERSION });
  // Audits run one at a time so concurrent requests cannot multiply the core's resource limits.
  let queue: Promise<unknown> = Promise.resolve();
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Audit a local repository (read-only)',
      description: TOOL_DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const run = queue.then(() => runAuditTool(input, config));
      queue = run.catch(() => undefined);
      const outcome = await run.catch(() => ({ ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message: 'the audit failed unexpectedly' } }));
      if (!outcome.ok) {
        return {
          content: [{ type: 'text' as const, text: `RepoTruth error ${outcome.error.code}: ${outcome.error.message}` }],
          structuredContent: { error: outcome.error },
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: summarize(outcome.output) }],
        structuredContent: outcome.output,
      };
    },
  );
  return server;
}
