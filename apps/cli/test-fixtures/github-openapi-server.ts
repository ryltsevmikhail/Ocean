/**
 * Loopback GitHub-like OpenAPI service for Task 6's second real-adapter
 * qualification: the same admission/journal path through the pinned OpenAPI
 * plugin. It counts business reads separately from discovery probes so exactly
 * one dispatch per allowed call stays provable.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface GithubOpenApiCounts {
  /** Authenticated business reads of the declared issue routes. */
  business: number;
  /** Any other request (discovery probes, spec fetches). */
  discovery: number;
  httpPaths: string[];
}

export interface GithubOpenApiServer {
  readonly base: string;
  readonly specJson: string;
  readonly counts: GithubOpenApiCounts;
  readonly close: () => Promise<void>;
}

const ISSUES = [
  { number: 7, title: 'Composer loses focus', state: 'open' },
  { number: 8, title: 'Add keyboard shortcut', state: 'closed' },
];

/** Inline spec declaring exactly the two read operations Ocean may grant. */
export function githubOpenApiSpec(base: string): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'GitHub-like issues', version: '1.0.0', description: 'Loopback fixture' },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearer: [] }],
    paths: {
      '/repos/{owner}/{repo}/issues': {
        get: {
          operationId: 'list_issues',
          summary: 'List issues in one repository',
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'issues' } },
        },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}': {
        get: {
          operationId: 'issue_read',
          summary: 'Read one issue and its comments',
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'issue_number',
              in: 'path',
              required: true,
              schema: { type: 'number' },
            },
          ],
          responses: { '200': { description: 'issue' } },
        },
      },
    },
  });
}

export function startGithubOpenApiServer(): Promise<GithubOpenApiServer> {
  const counts: GithubOpenApiCounts = { business: 0, discovery: 0, httpPaths: [] };
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      counts.httpPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const issueRoute =
        req.method === 'GET' && parts[0] === 'repos' && parts[3] === 'issues' && parts.length >= 4;
      if (!issueRoute) {
        counts.discovery += 1;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
        return;
      }
      counts.business += 1;
      const number = parts[4];
      if (number === undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ISSUES));
        return;
      }
      const issue = ISSUES.find((entry) => entry.number === Number(number)) ?? ISSUES[0];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...issue, comments: ['First comment', 'Second comment'] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const base = `http://127.0.0.1:${String(port)}`;
      resolve({
        base,
        specJson: githubOpenApiSpec(base),
        counts,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Bearer auth template accepted by the pinned OpenAPI plugin. */
export const githubOpenApiAuthTemplates = [
  {
    slug: 'bearer',
    type: 'apiKey',
    headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
  },
];
