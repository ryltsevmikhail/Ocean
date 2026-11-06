import { SERVICE_PLUGIN_MAX_DISCOVERY_BYTES } from '@runnets/domain';
import { httpTransport, methodOf } from './profile.js';
import type { SessionWriter } from './session-writer.js';

export function serviceHttp(
  url: string,
  credential: string | null,
  github: boolean,
  writer: SessionWriter,
) {
  const endpoint = new URL(url);
  const headers: Record<string, string> = {};
  if (credential) {
    if (
      endpoint.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw Error('insecure credential endpoint');
    headers['Authorization'] = 'Bearer ' + credential;
  }
  if (github) {
    if (endpoint.href !== 'https://api.githubcopilot.com/mcp/')
      throw Error('unexpected GitHub endpoint');
    headers['X-MCP-Readonly'] = 'true';
    headers['X-MCP-Tools'] = 'issue_read';
  }
  return httpTransport(
    endpoint,
    (target, init) =>
      writer.track(async () => {
        if (String(target) !== endpoint.href) throw Error('unexpected target');
        const method = methodOf(init);
        const invocation = await writer.prepare(method);
        const signal = AbortSignal.any([
          writer.lifetime,
          ...(init?.signal ? [init.signal] : []),
          ...(invocation?.signal ? [invocation.signal] : []),
        ]);
        const request = { ...init, signal, redirect: 'error' as const };
        writer.admit(method, invocation);
        const response = await fetch(target, request);
        if (invocation) invocation.httpStatus = response.status;
        if (!response.body) return response;
        let bytes = 0;
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, ctrl) {
                if (!invocation) writer.countMetadata(chunk.length);
                if ((bytes += chunk.length) > SERVICE_PLUGIN_MAX_DISCOVERY_BYTES)
                  throw Error('frame limit');
                ctrl.enqueue(chunk);
              },
            }),
          ),
          { headers: response.headers, status: response.status, statusText: response.statusText },
        );
      }),
    headers,
  );
}
