import { fingerprintTree } from './sandbox-tree.js';
import { createHash } from 'node:crypto';
import { ToolError } from '@runnets/application';
import type { CodingTestPreset } from '@runnets/domain';
import { blockedName, checkedPath, type WorkspaceBackend, type FileEntry } from './backend.js';
import { realpath } from 'node:fs/promises';
import { fingerprintFile, validateMounts } from './sandbox-mounts.js';
import { sandboxFile } from './sandbox-files.js';
import {
  runSandbox,
  sandboxLimits,
  type SandboxRequest,
  type SandboxEvidence,
} from './sandbox-supervision.js';
export interface SandboxQualification {
  readonly qualified: boolean;
  readonly reason: string;
  readonly limits: typeof sandboxLimits;
  readonly platform: string;
}
export type SandboxOptions = Pick<
  SandboxRequest,
  'root' | 'mounts' | 'dependencyProjectRoot' | 'expectedInputs'
>;
const canary = `
const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.env.DEEPSEEK_API_KEY,undefined);
assert.equal(fs.existsSync('/sys/fs/cgroup'),false);
assert.equal(fs.existsSync('/run/user'),false);
assert.equal(fs.existsSync('/home/ryltsevmg'),false);
assert.throws(()=>fs.writeFileSync('/usr/ocean-canary','x'));
const child=require('node:child_process').spawn('/toolchain/node',
  ['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});
child.on('error',()=>process.exit(4));
child.on('spawn',()=>{
child.unref();
const net=require('node:net'),s=net.connect({host:'1.1.1.1',port:443});
s.on('connect',()=>process.exit(2));
s.on('error',()=>process.exit(0));
setTimeout(()=>process.exit(3),500);
});
`;
export async function probeSandbox(options: SandboxOptions): Promise<SandboxQualification> {
  const platform = process.platform + '/' + process.arch;
  let qualified = false;
  try {
    if (platform !== 'linux/x64') throw new Error('unsupported platform');
    const result = await runSandbox({
      ...options,
      program: '/toolchain/node',
      args: ['-e', canary],
    });
    qualified =
      result.exitCode === 0 &&
      result.reason === 'exit' &&
      result.cleanupConfirmed &&
      !result.truncated;
  } catch {
    /* Fail closed without exposing host paths or process environment. */
  }
  return {
    qualified,
    platform,
    limits: sandboxLimits,
    reason: qualified ? 'qualified' : 'containment_unavailable',
  };
}
export interface SandboxCommandEvidence extends SandboxEvidence {
  readonly invocationHash: string;
  readonly dependencyHash: string;
  readonly dependenciesUnchanged: boolean;
  readonly beforeTreeHash: string;
  readonly afterTreeHash: string;
  readonly sourceUnchanged: boolean;
}
/** The source hash port is host-owned and must cover the relevant complete source manifest. */
export async function sandboxCommand(
  options: SandboxOptions,
  preset: CodingTestPreset,
  signal: AbortSignal,
  snapshot: () => Promise<string>,
): Promise<SandboxCommandEvidence> {
  const beforeTreeHash = await snapshot();
  const dependencyHash = await validateMounts(options.mounts ?? [], options.dependencyProjectRoot);
  const invocationHash = createHash('sha256')
    .update(JSON.stringify({ preset, limits: sandboxLimits, options, dependencyHash }))
    .digest('hex');
  const result = await runSandbox({
    ...options,
    program: preset.program,
    args: preset.args,
    cwd: checkedPath(preset.cwd),
    signal,
  });
  const afterTreeHash = await snapshot();
  return {
    ...result,
    invocationHash,
    dependencyHash,
    dependenciesUnchanged:
      dependencyHash ===
      (await validateMounts(options.mounts ?? [], options.dependencyProjectRoot)),
    beforeTreeHash,
    afterTreeHash,
    sourceUnchanged: beforeTreeHash === afterTreeHash,
  };
}
/** Internal adapter only; normal chat access still requires durable task admission and approvals. */
export async function createSandboxBackend(
  options: SandboxOptions,
  presets: readonly CodingTestPreset[],
  snapshot: () => Promise<string>,
): Promise<WorkspaceBackend> {
  const frozen = structuredClone({ options, presets });
  options = frozen.options;
  presets = frozen.presets;
  const identity = async () =>
    JSON.stringify([
      await fingerprintFile(await realpath(process.execPath)),
      await validateMounts(options.mounts ?? [], options.dependencyProjectRoot),
    ]);
  const expectedInputs: Record<string, string> = {};
  const nodePath = await realpath(process.execPath);
  expectedInputs[nodePath] = await fingerprintFile(nodePath);
  for (const mount of options.mounts ?? [])
    expectedInputs[mount.source] =
      mount.target === '/toolchain/pnpm/bin/pnpm'
        ? await fingerprintFile(mount.source)
        : fingerprintTree(mount.source);
  options = { ...options, expectedInputs };
  const qualifiedIdentity = await identity();
  if (!(await probeSandbox(options)).qualified)
    throw new ToolError('containment_unavailable', 'sandbox qualification failed');
  if ((await identity()) !== qualifiedIdentity)
    throw new ToolError('containment_unavailable', 'sandbox inputs changed during qualification');
  let held = false;
  const verify = async () => {
    if (held) throw new ToolError('effect_uncertain', 'sandbox backend requires reconciliation');
    if ((await identity()) !== qualifiedIdentity)
      throw new ToolError('containment_unavailable', 'sandbox qualification is stale');
  };
  const fileOperation = async (input: Parameters<typeof sandboxFile>[1], signal?: AbortSignal) => {
    try {
      return await sandboxFile(options, input, signal);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'effect_uncertain') held = true;
      throw error;
    }
  };
  return {
    capabilities: {
      filesystemContainment: true,
      processContainment: true,
      confirmedTreeStop: true,
    },
    async read(path) {
      await verify();
      return (await fileOperation({ op: 'read', path })) as string | null;
    },
    async list(path) {
      await verify();
      const entries = (await fileOperation({ op: 'list', path })) as FileEntry[];
      return entries
        .filter((e) => !blockedName(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async write(path, content, expected, signal) {
      await verify();
      if (Buffer.byteLength(content) > 131072 || content.includes('\0'))
        throw new ToolError('unsupported_file', 'write exceeds text limits');
      await fileOperation({ op: 'write', path, content, expected }, signal);
    },
    async command(program, args, cwd, signal) {
      await verify();
      const preset = presets.find(
        (p) =>
          p.program === program && p.cwd === cwd && JSON.stringify(p.args) === JSON.stringify(args),
      );
      if (!preset)
        throw new ToolError('preset_denied', 'only exact owner-registered presets are allowed');
      let result: SandboxCommandEvidence;
      try {
        result = await sandboxCommand(options, preset, signal, snapshot);
      } catch (error) {
        held = true;
        throw error;
      }
      if (!result.cleanupConfirmed) held = true;
      return {
        output: JSON.stringify(result),
        isError:
          !result.cleanupConfirmed ||
          result.exitCode !== 0 ||
          result.reason !== 'exit' ||
          !result.sourceUnchanged ||
          !result.dependenciesUnchanged,
        ...(!result.cleanupConfirmed ? { uncertain: true } : {}),
      };
    },
  };
}
