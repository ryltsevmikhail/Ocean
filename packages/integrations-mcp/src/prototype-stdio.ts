import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { createSandboxBackend } from '@runnets/tools-node';
import { empty, type Case } from './prototype-types.js';

type Caller = Case & {
  client: { pid: number; start: string };
  sdkPid: number | null;
  stderrBytes: number;
  retainedBytes: number;
  overflowDetected: boolean;
};
type Effect = {
  server: { pid: number; start: string };
  child: number;
  stdout: string;
  childStdout: string;
};
interface Env {
  pwd: string;
  home: string;
  cwd: string;
  custom: string | null;
  keys: string[];
  canaryVisible: boolean;
  socketAccessible: boolean;
}
async function observation<T>(dir: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(dir, name + '.json'), 'utf8')) as T;
  } catch {
    return null;
  }
}
export const nativeCases = [
  'held-timeout',
  'default',
  'custom',
  'revoked',
  'abort',
  'parent-failure',
  'overflow',
] as const;
export async function runStdioCase(
  mode: (typeof nativeCases)[number],
  root: string,
): Promise<Case> {
  const r = empty('stdio-' + mode);
  const workspace = await mkdtemp(join(root, 'stdio-' + mode + '-'));
  const privateDir = await mkdtemp(join(tmpdir(), 'mcps-'));
  const marker = join(privateDir, 'profile');
  const socket = join(privateDir, 'owner.sock');
  const owner = createServer((c) => c.destroy());
  try {
    await writeFile(marker, 'synthetic');
    owner.listen(socket);
    await once(owner, 'listening');
    await writeFile(join(workspace, '.git'), 'synthetic');
    await mkdir(join(workspace, 'server'));
    const bundle = await rolldown({
      input: fileURLToPath(new URL('./prototype-stdio-fixture.js', import.meta.url)),
      platform: 'node',
    });
    try {
      await bundle.write({
        file: join(workspace, 'fixture.cjs'),
        format: 'cjs',
        codeSplitting: false,
      });
    } finally {
      await bundle.close();
    }
    const preset = {
      id: 'native',
      program: '/toolchain/node',
      cwd: '.' as const,
      args: ['/workspace/fixture.cjs', 'caller', mode, marker, socket],
    };
    const backend = await createSandboxBackend({ root: workspace }, [preset], () =>
      readFile(join(workspace, 'fixture.cjs'), 'utf8').then((body) =>
        createHash('sha256').update(body).digest('hex'),
      ),
    );
    const result = await backend.command(
      preset.program,
      preset.args,
      preset.cwd,
      new AbortController().signal,
    );
    const evidence = JSON.parse(result.output) as {
      cleanupConfirmed: boolean;
      exitCode: number | null;
      reason: string;
      cgroup: string | null;
      truncated: boolean;
    };
    const caller = await observation<Caller>(workspace, 'caller');
    const effect = await observation<Effect>(join(workspace, 'server'), 'effect');
    const env = await observation<Env>(join(workspace, 'server'), 'env');
    r.sdkAttempts = caller?.sdkAttempts ?? 0;
    r.metadataAttempts = caller?.metadataAttempts ?? 0;
    r.businessAttempts = caller?.businessAttempts ?? 0;
    r.outcome = caller?.outcome ?? null;
    r.observedEffects = effect ? 1 : 0;
    const withheld = mode === 'revoked' || mode === 'held-timeout';
    const expected = withheld ? 0 : 1;
    r.detail = JSON.stringify({
      env,
      client: caller?.client,
      sdkPid: caller?.sdkPid,
      effect,
      stderrBytes: caller?.stderrBytes,
      retainedBytes: caller?.retainedBytes,
      overflowDetected: caller?.overflowDetected,
      exitCode: evidence.exitCode,
      cgroup: evidence.cgroup,
      cleanupConfirmed: evidence.cleanupConfirmed,
      truncated: evidence.truncated,
    });
    const outcome = withheld
      ? 'not_started'
      : ['default', 'custom'].includes(mode)
        ? 'observed'
        : 'uncertain';
    r.status =
      (mode !== 'overflow' || caller?.overflowDetected === true) &&
      evidence.cleanupConfirmed &&
      !evidence.truncated &&
      evidence.reason === 'exit' &&
      (mode === 'parent-failure' ? evidence.exitCode !== 0 : evidence.exitCode === 0) &&
      env?.home === '/home/worker' &&
      env.cwd === '/workspace' &&
      env.pwd === '/workspace' &&
      !env.canaryVisible &&
      !env.socketAccessible &&
      env.custom === (mode === 'default' ? null : 'synthetic') &&
      env.keys.every((key) => ['HOME', 'PATH', 'PWD', 'FIXTURE_CUSTOM'].includes(key)) &&
      r.sdkAttempts === 1 &&
      r.businessAttempts === expected &&
      r.observedEffects === expected &&
      r.outcome === outcome &&
      (!expected ||
        (!!effect?.child &&
          effect.childStdout === effect.stdout &&
          /^(socket|pipe):/.test(effect.stdout))) &&
      (mode !== 'custom' || (caller?.stderrBytes === 32768 && caller.retainedBytes === 512))
        ? 'passed'
        : 'failed';
  } catch (e) {
    r.detail = e instanceof Error ? e.message : 'unavailable';
  } finally {
    owner.close();
    await rm(privateDir, { recursive: true, force: true });
  }
  return r;
}
export async function nativeQualification(root: string, enabled: boolean) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!enabled)
    return [Object.assign(empty('stdio-native'), { detail: 'native flag not enabled' })];
  const cases = [];
  for (const name of nativeCases) cases.push(await runStdioCase(name, root));
  return cases;
}
