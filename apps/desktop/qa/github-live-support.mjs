/** Private live qualification helpers; no credential values enter diagnostics. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const { Request, Headers, TextDecoder, URL, Buffer } = globalThis;
const execute = promisify(execFile);
export function liveCli(cli, profile, env) {
  return async (...words) => {
    try {
      const { stdout } = await execute(
        process.execPath,
        [cli, ...words, '--profile', profile, '--json'],
        { env, encoding: 'utf8', timeout: 25_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const envelope = JSON.parse(stdout);
      assert.equal(envelope.ok, true, 'CLI operation refused');
      return envelope.data;
    } catch {
      // Child errors can contain environment-dependent output; do not serialize them.
      throw new Error('qualification_cli_failed:' + words.slice(0, 3).join(' '));
    }
  };
}

export function observeGithubRequests(repository) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.githubcopilot.com');
    assert.equal(url.pathname, '/mcp/');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const body =
      typeof init?.body === 'string'
        ? init.body
        : ArrayBuffer.isView(init?.body) || init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : '';
    const rpc = body === '' ? {} : JSON.parse(body);
    const entry = {
      method: rpc.method ?? 'HTTP ' + (init?.method ?? 'GET'),
      tool: rpc.params?.name ?? null,
      fixedTools: headers.get('X-MCP-Tools') === 'list_issues,issue_read',
      readonly: headers.get('X-MCP-Readonly') === 'true',
      status: null,
    };
    requests.push(entry);
    if (rpc.method === 'tools/call') {
      assert.ok(['list_issues', 'issue_read'].includes(rpc.params?.name));
      assert.equal(rpc.params.arguments.owner + '/' + rpc.params.arguments.repo, repository);
      if (rpc.params.name === 'issue_read') assert.equal(rpc.params.arguments.method, 'get');
    }
    const response = await original(input, init);
    entry.status = response.status;
    return response;
  };
  return {
    requests,
    business: () => requests.filter((entry) => entry.method === 'tools/call').length,
    close: () => {
      globalThis.fetch = original;
    },
  };
}

/** Check every synthetic artifact for the exact secret without printing the match/value. */
export function scanPrivateTree(root, credential) {
  let files = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      files += scanPrivateTree(path, credential);
    } else if (stat.isFile()) {
      assert.equal(
        readFileSync(path).includes(Buffer.from(credential)),
        false,
        'credential unexpectedly persisted in synthetic evidence',
      );
      chmodSync(path, 0o600);
      files++;
    }
  }
  return files;
}
