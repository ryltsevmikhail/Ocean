/**
 * One independent client process over the public local-runtime SDK.
 *
 * Each call spawns a fresh Node process so a test can prove that detach/reconnect
 * does not depend on the owning test process. Split out of
 * `admission-process.test.ts` to keep that file inside the 300-line source cap.
 */
import { spawn } from 'node:child_process';

export interface DetachedClientOptions {
  readonly profile: string;
  readonly env: NodeJS.ProcessEnv;
  /** Submission request available to the evaluated client expression as `request`. */
  readonly request: unknown;
}

/**
 * Evaluate one client expression (e.g. `client.submit(request)`) in a child process.
 * The reply is arbitrary JSON for assertions; callers name the shape they need.
 */
export interface DetachedClient {
  <T = Record<string, unknown>>(body: string): Promise<T>;
}

export function detachedClient(options: DetachedClientOptions): DetachedClient {
  return async <T = Record<string, unknown>>(body: string): Promise<T> => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
      const client = await connectLocalRuntime({profile:process.argv[1]});
      const request = JSON.parse(process.argv[2]);
      try {console.log(JSON.stringify(await (${body})));} catch(e) {console.log(JSON.stringify({error:e.message}));}
      finally {client.close();}
    `,
        options.profile,
        JSON.stringify(options.request),
      ],
      { env: options.env },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString();
    });
    const code = await new Promise((resolve) => child.once('close', resolve));
    if (code !== 0) throw Error('client failed: ' + err);
    return JSON.parse(out) as T;
  };
}
