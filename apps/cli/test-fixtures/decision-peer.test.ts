import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const decisionPeer =
  (profile: string, runDirectory: string, path = process.env['PATH']) =>
  async (method: string, params: unknown) => {
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
      {
        env: {
          ...Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ),
          PATH: path,
          XDG_RUNTIME_DIR: runDirectory,
        },
      },
    );
    return JSON.parse(stdout);
  };
