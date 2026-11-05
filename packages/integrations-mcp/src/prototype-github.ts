import { InvocationSend } from './send.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { client, empty, immutable, methodOf } from './prototype-types.js';
import { httpTransport } from './prototype-http.js';

const approved = '/home/ryltsevmg/.config/ocean-rc/github-qualification.token';
const endpoint = new URL('https://api.githubcopilot.com/mcp/');
async function issueRead(path: string) {
  const r = empty('github-issue-5');
  const c = client(false);
  let stage = 'approved token file';
  let httpStatus = 0;
  let invocation: InvocationSend | undefined;
  try {
    if (path !== approved) throw Error('wrong path');
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const token = await (async () => {
      try {
        const st = await fd.stat();
        if (
          !st.isFile() ||
          st.uid !== process.getuid?.() ||
          (st.mode & 0o777) !== 0o600 ||
          st.size > 4096
        )
          throw Error('unsafe token file');
        return (await fd.readFile('utf8')).trim();
      } finally {
        await fd.close();
      }
    })();
    if (!token) throw Error('empty');
    stage = 'metadata';
    const stop = AbortSignal.timeout(18000);
    const transport = httpTransport(
      endpoint,
      async (url, init) => {
        if (String(url) !== endpoint.href) throw Error('unexpected endpoint');
        const method = methodOf(init);
        if (method === 'tools/call') {
          r.sdkAttempts++;
          if (stage !== 'issue read' || r.sdkAttempts !== 1) throw Error('unexpected dispatch');
          InvocationSend.current().admit();
          r.businessAttempts++;
        } else {
          if (
            !['initialize', 'GET', 'notifications/initialized', 'tools/list'].includes(method) ||
            ++r.metadataAttempts > 8
          )
            throw Error('unexpected metadata');
        }
        const response = await fetch(url, {
          ...init,
          redirect: 'error',
          signal: init?.signal ? AbortSignal.any([stop, init.signal]) : stop,
        });
        httpStatus = response.status;
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctrl) {
              if ((bytes += chunk.length) > 1024 * 1024) throw Error('read limit');
              ctrl.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      },
      { Authorization: 'Bearer ' + token, 'X-MCP-Readonly': 'true', 'X-MCP-Tools': 'issue_read' },
    );
    await c.connect(transport, { timeout: 8000, signal: stop });
    const tools = (await c.listTools(undefined, { timeout: 8000, signal: stop })).tools;
    const issue = tools.find((t) => t.name === 'issue_read');
    if (!issue) throw Error('missing read tool');
    stage = 'issue read';
    invocation = new InvocationSend(8000, stop);
    const reply = await invocation.run(() =>
      c.callTool(
        {
          name: issue.name,
          arguments: { method: 'get', owner: 'ryltsevmikhail', repo: 'Ocean', issue_number: 5 },
        },
        { toolDefinition: immutable(issue), timeout: 8000, signal: stop },
      ),
    );
    r.outcome = 'observed';
    // Retain only issue identity/status, never its title/body, headers or raw errors.
    const text = reply.content?.find((x) => x.type === 'text');
    const item: unknown = text?.type === 'text' ? JSON.parse(text.text) : reply.structuredContent;
    if (
      reply.isError ||
      !item ||
      typeof item !== 'object' ||
      !('number' in item) ||
      item.number !== 5 ||
      !('state' in item) ||
      !['open', 'closed'].includes(String(item.state))
    )
      throw Error('identity not returned');
    r.status = r.sdkAttempts === 1 ? 'passed' : 'failed';
    r.detail = JSON.stringify({
      repository: 'ryltsevmikhail/Ocean',
      issue: 5,
      state: item.state,
      protocol: c.getNegotiatedProtocolVersion(),
      httpStatus,
    });
  } catch (e) {
    r.status = r.sdkAttempts > 1 ? 'failed' : 'unqualified';
    if (r.outcome === null && invocation) r.outcome = invocation.sent ? 'uncertain' : 'not_started';
    r.detail = JSON.stringify({
      stage,
      httpStatus,
      code:
        e instanceof Error && 'code' in e && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code)
          ? e.code
          : undefined,
    });
  } finally {
    await c.close();
  }
  return r;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await issueRead(process.argv[2] ?? '');
  process.stdout.write(JSON.stringify(result));
}
