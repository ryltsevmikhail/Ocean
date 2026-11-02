import { createHash } from 'node:crypto';
import { ToolError } from '@runnets/application';
import type { CodingTestPreset } from '@runnets/domain';
import { blockedName, checkedPath, type WorkspaceBackend, type FileEntry } from './backend.js';
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
export type SandboxOptions = Pick<SandboxRequest, 'root' | 'mounts' | 'dependencyProjectRoot'>;
const canary = `
const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.env.DEEPSEEK_API_KEY,undefined);
assert.equal(fs.existsSync('/sys/fs/cgroup'),false);
assert.equal(fs.existsSync('/run/user'),false);
assert.equal(fs.existsSync('/home/ryltsevmg'),false);
assert.throws(()=>fs.writeFileSync('/usr/ocean-canary','x'));
const net=require('node:net'),s=net.connect({host:'1.1.1.1',port:443});
s.on('connect',()=>process.exit(2));
s.on('error',()=>process.exit(0));
setTimeout(()=>process.exit(3),500);
`;
export async function probeSandbox(options: SandboxOptions): Promise<SandboxQualification> {
  const platform = process.platform + '/' + process.arch;
  let qualified = false;
  try {
    if (platform !== 'linux/x64') throw new Error('unsupported platform');
    const result = await runSandbox({ ...options, program: '/usr/bin/node', args: ['-e', canary] });
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
  const invocationHash = createHash('sha256')
    .update(JSON.stringify({ preset, limits: sandboxLimits, options }))
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
  if (!(await probeSandbox(options)).qualified)
    throw new ToolError('containment_unavailable', 'sandbox qualification failed');
  return {
    capabilities: {
      filesystemContainment: true,
      processContainment: true,
      confirmedTreeStop: true,
    },
    async read(path) {
      return (await sandboxFile(options, { op: 'read', path })) as string | null;
    },
    async list(path) {
      const entries = (await sandboxFile(options, { op: 'list', path })) as FileEntry[];
      return entries
        .filter((e) => !blockedName(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async write(path, content, expected) {
      if (Buffer.byteLength(content) > 131072 || content.includes('\0'))
        throw new ToolError('unsupported_file', 'write exceeds text limits');
      await sandboxFile(options, { op: 'write', path, content, expected });
    },
    async command(program, args, cwd, signal) {
      const preset = presets.find(
        (p) =>
          p.program === program && p.cwd === cwd && JSON.stringify(p.args) === JSON.stringify(args),
      );
      if (!preset)
        throw new ToolError('preset_denied', 'only exact owner-registered presets are allowed');
      const result = await sandboxCommand(options, preset, signal, snapshot);
      return {
        output: JSON.stringify(result),
        isError: result.exitCode !== 0 || result.reason !== 'exit' || !result.sourceUnchanged,
        ...(!result.cleanupConfirmed ? { uncertain: true } : {}),
      };
    },
  };
}
