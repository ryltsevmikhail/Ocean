/**
 * Local synthetic OpenAPI service for the real `@executor-js/plugin-openapi`
 * counter tests. Counts actual business POSTs, token grants and attacker
 * requests separately, so setup discovery cannot be mistaken for a dispatch.
 */
import type { Loopback } from './loopback.js';
import { closeServer, listen, readBody, writeJson } from './loopback.js';

export type OpenApiScenario =
  'ok' | 'static401' | 'oauth401' | 'drop' | 'redirect' | 'bigDiscovery';

export interface OpenApiCounts {
  business: number;
  token: number;
  grants: string[];
  attacker: number;
}

export interface OpenApiService {
  readonly business: Loopback;
  readonly token: Loopback;
  readonly attacker: Loopback;
  readonly counts: OpenApiCounts;
  readonly close: () => Promise<void>;
}

const specFor = (base: string, kind: 'bearer' | 'oauth2'): string =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Probe Things', version: '1.0.0', description: 'Synthetic service' },
    servers: [{ url: base }],
    paths: {
      '/things': {
        post: {
          operationId: 'writeThing',
          summary: 'Write one thing',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    // The authentication template is supplied to the plugin separately; this
    // comment marker only keeps the two spec variants distinguishable.
    'x-ocean-auth': kind,
  });

/** The inline spec document; discovery GETs still hit the service origin. */
export const openApiSpecJson = (base: string): string => specFor(base, 'bearer');

/** A spec with `count` synthetic operations, to prove the discovery caps. */
export const openApiSpecJsonWithOperations = (base: string, count: number): string =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Guard Probe', version: '1.0.0', description: 'Synthetic' },
    servers: [{ url: base }],
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/things${index === 0 ? '' : index}`,
        {
          post: {
            operationId: `writeThing${index}`,
            summary: 'Write one thing',
            responses: { '200': { description: 'ok' } },
          },
        },
      ]),
    ),
  });

export async function startOpenApiService(scenario: OpenApiScenario): Promise<OpenApiService> {
  const counts: OpenApiCounts = { business: 0, token: 0, grants: [], attacker: 0 };

  const attacker = await listen((_req, res) => {
    counts.attacker += 1;
    writeJson(res, 200, { stolen: true });
  });

  const business = await listen((req, res) => {
    if (req.method === 'GET') {
      if (scenario === 'bigDiscovery') {
        writeJson(res, 200, { blob: 'x'.repeat(2_048) });
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }
    counts.business += 1;
    void readBody(req).then(() => {
      if (scenario === 'drop') {
        // The write happened; the response is lost.
        req.socket.destroy();
        return;
      }
      if (scenario === 'redirect') {
        res.writeHead(302, { location: `${attacker.base}/steal` });
        res.end();
        return;
      }
      const auth = req.headers.authorization ?? '';
      if (scenario === 'static401' && auth === 'Bearer static-secret-1') {
        writeJson(res, 401, { message: 'token expired' });
        return;
      }
      if (scenario === 'oauth401' && auth === 'Bearer oauth-access-1') {
        writeJson(res, 401, { message: 'token expired' });
        return;
      }
      writeJson(res, 200, { ok: true, wrote: true });
    });
  });

  const token = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const location = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:9/');
      location.searchParams.set('code', 'probe-code-1');
      location.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      void readBody(req).then((body) => {
        counts.token += 1;
        const grant = new URLSearchParams(body).get('grant_type') ?? 'authorization_code';
        counts.grants.push(grant);
        writeJson(res, 200, {
          access_token: grant === 'refresh_token' ? 'oauth-access-2' : 'oauth-access-1',
          refresh_token: grant === 'refresh_token' ? 'oauth-refresh-2' : 'oauth-refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read',
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    business,
    token,
    attacker,
    counts,
    async close() {
      await Promise.all([
        closeServer(business.server),
        closeServer(token.server),
        closeServer(attacker.server),
      ]);
    },
  };
}

/** Authentication templates accepted by `executor.openapi.addSpec`. */
export const openApiAuthTemplates = {
  bearer: [
    {
      slug: 'bearer',
      type: 'apiKey',
      headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
    },
  ],
  oauth2: (tokenBase: string) => [
    {
      slug: 'oauth',
      kind: 'oauth2',
      authorizationUrl: `${tokenBase}/authorize`,
      tokenUrl: `${tokenBase}/token`,
      scopes: ['read'],
    },
  ],
};
