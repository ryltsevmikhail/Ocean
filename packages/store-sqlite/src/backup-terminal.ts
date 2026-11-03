import { spawnSync } from 'node:child_process';

export interface FrozenBackupBytes {
  readonly bytes: number;
  readonly hash: string;
  readonly state: string;
}
// No source paths, packages, preloads or callbacks. Only the original inherited read-only FD.
const program = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto');
const expected = JSON.parse(fs.readFileSync(0, 'utf8'));
const identity = s => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const check = () => {
  if (identity(fs.fstatSync(3, {bigint:true})) !== expected.state) throw Error('changed');
};
const flags = /^flags:\s+([0-7]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/3', 'utf8'));
if (!flags || (parseInt(flags[1],8) & 3) !== 0) throw Error('not read-only');
check();
const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1048576);
let offset = 0;
while (offset < expected.bytes) {
  const n = fs.readSync(3,buffer,0,Math.min(buffer.length,expected.bytes-offset),offset);
  if (!n) throw Error('short read');
  hash.update(buffer.subarray(0,n)); offset += n;
}
check();
if (hash.digest('hex') !== expected.hash) throw Error('changed');
process.stdout.write('verified\n');
`;
/** Synchronous terminal proof: parent-side effect-capable readers cannot execute during this phase. */
export function verifyFrozenBackupBytes(fd: number, expected: FrozenBackupBytes): void {
  const input = JSON.stringify(expected);
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    expected.bytes > 2147483648 ||
    !/^[a-f0-9]{64}$/.test(expected.hash) ||
    input.length > 1024
  )
    throw Error('snapshot_mismatch');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', program], {
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', fd],
    timeout: 30000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024,
    windowsHide: true,
  });
  if (
    result.error ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stdout !== 'verified\n' ||
    result.stderr !== ''
  )
    throw Error('snapshot_mismatch');
}
