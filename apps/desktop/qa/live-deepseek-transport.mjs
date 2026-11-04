import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { Buffer } from 'node:buffer';

/** The SSH child gets private fixture paths and no provider/agent credentials. */
export function sshChildEnvironment(source) {
  const environment = { PATH: '/usr/bin:/bin' };
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'TMPDIR',
  ]) {
    if (!source[key]?.startsWith('/')) throw Error('explicit private environment required');
    environment[key] = source[key];
  }
  return environment;
}

export function sshFetch({ root, launch, remoteCode }) {
  const custody = lstatSync(root);
  if (
    !custody.isDirectory() ||
    custody.isSymbolicLink() ||
    (custody.mode & 0o077) !== 0 ||
    custody.uid !== process.getuid() ||
    realpathSync(root) !== root
  )
    throw Error('private canonical evidence directory required');
  const record = (value) =>
    appendFileSync(
      root + '/events.jsonl',
      JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n',
      { mode: 0o600 },
    );
  return async (url, options) => {
    if (url !== 'https://api.deepseek.com/chat/completions' || options.method !== 'POST')
      throw Error('bridge_route_refused');
    if (options.headers.authorization !== 'Bearer bridge-placeholder-only')
      throw Error('bridge_credential_refused');
    if (options.signal?.aborted)
      throw new globalThis.DOMException('aborted before dispatch', 'AbortError');
    const body = options.body;
    if (typeof body !== 'string' || Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw Error('bridge_body_refused');
    const id = randomUUID();
    writeFileSync(root + '/' + id + '.request.json', body, { mode: 0o600, flag: 'wx' });
    record({ id, state: 'intent' });
    const child = launch(remoteCode);
    child.stderr.resume(); // Never expose SSH/server exception text or inherited environment.
    let responseController,
      settled = false,
      done = false,
      status,
      aborted = false,
      failed = false,
      onAbort;
    const stream = new globalThis.ReadableStream({
      start(c) {
        responseController = c;
      },
      cancel() {
        aborted = true;
      },
    });
    const response = new Promise((resolve, reject) => {
      const failure = (outcome = 'unknown') => {
        if (failed) return;
        failed = true;
        record({ id, state: outcome });
        if (!settled) {
          settled = true;
          reject(Error('bridge_outcome_unknown'));
        } else if (!aborted) {
          aborted = true;
          responseController.error(Error('bridge_outcome_unknown'));
        }
      };
      onAbort = () => {
        if (done || failed) return;
        record({ id, state: 'client_abort_remote_not_cancelled' });
        const error = new globalThis.DOMException(
          'local observer aborted; remote outcome pending',
          'AbortError',
        );
        if (!settled) {
          settled = true;
          reject(error);
        } else if (!aborted) responseController.error(error);
        aborted = true;
      };
      child.stdin.on('error', () => failure());
      const exit = new Promise((resolveExit) => {
        child.once('error', () => {
          failure('not_started');
          resolveExit(null);
        });
        child.once('close', (code) => {
          record({ id, state: 'ssh_closed', code });
          resolveExit(code);
        });
      });
      const observe = async () => {
        try {
          for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
            const frame = JSON.parse(line);
            if (frame.type === 'dispatching') record({ id, state: 'dispatching' });
            else if (frame.type === 'headers') {
              status = frame.status;
              if (!Number.isInteger(status) || status < 100 || status > 599) throw Error();
              record({ id, state: 'headers', status });
              settled = true;
              resolve(
                new globalThis.Response(stream, {
                  status,
                  headers: { 'content-type': 'text/event-stream' },
                }),
              );
            } else if (frame.type === 'data') {
              if (!status) throw Error();
              const bytes = Buffer.from(frame.base64, 'base64');
              appendFileSync(root + '/' + id + '.response.sse', bytes, { mode: 0o600 });
              while (existsSync(root + '/hold')) await delay(20);
              if (!aborted) responseController.enqueue(bytes);
            } else if (frame.type === 'done') {
              if (!status) throw Error();
              done = true;
              record({ id, state: 'observed_complete', status });
              if (!aborted) responseController.close();
            } else if (frame.type === 'failure') {
              failure(frame.outcome === 'not_started' ? 'not_started' : 'unknown');
            } else throw Error();
          }
          const code = await exit;
          if (!done || code !== 0) failure();
        } catch {
          failure();
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
        }
      };
      void observe();
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdin.end(body);
    return response;
  };
}
if (process.env.OCEAN_LIVE_EVIDENCE) {
  if (!process.env.OCEAN_LIVE_SSH_CONFIG?.startsWith('/'))
    throw Error('explicit SSH configuration required');
  const remoteCode = readFileSync(new URL('./live-deepseek-remote.py', import.meta.url), 'utf8');
  globalThis.fetch = sshFetch({
    root: process.env.OCEAN_LIVE_EVIDENCE,
    remoteCode,
    launch(code) {
      const quoted = "'" + code.replaceAll("'", "'\\''") + "'";
      return spawn(
        '/usr/bin/ssh',
        [
          '-F',
          process.env.OCEAN_LIVE_SSH_CONFIG,
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          'bigpc',
          'python3 -c ' + quoted,
        ],
        { env: sshChildEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] },
      );
    },
  });
}
