import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const decisionPeer =
  (profile: string, runDirectory: string) => async (method: string, params: unknown) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
      const c=await connectLocalRuntime({profile:process.argv[1]});
      try { console.log(JSON.stringify(await c[process.argv[2]](JSON.parse(process.argv[3])))); }
      finally { c.close(); }
    `,
        profile,
        method,
        JSON.stringify(params),
      ],
      { env: { PATH: process.env['PATH'], XDG_RUNTIME_DIR: runDirectory } },
    );
    return JSON.parse(stdout);
  };
