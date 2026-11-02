import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { ToolError, type PreparedCodingOperation, type ToolInvocation } from '@runnets/application';
import { WorkspaceTools } from './executor.js';
import { createSandboxBackend, type SandboxOptions } from './sandbox-probe.js';
import { fingerprintFile, validateMounts } from './sandbox-mounts.js';
import { sandboxLimits } from './sandbox-layout.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CodingOperationScope = Pick<
  CodingApprovalBinding,
  'roomId' | 'botId' | 'runId' | 'attemptId' | 'invocationId'
>;

/** Trusted host factory. Caller supplies the authoritative task and complete source snapshot port. */
export async function prepareCodingOperation(
  input: Readonly<{
    task: CodingTask;
    scope: CodingOperationScope;
    approvalId: string;
    call: ToolInvocation;
    sandbox: SandboxOptions;
    snapshot: () => Promise<string>;
  }>,
): Promise<PreparedCodingOperation> {
  const { task, scope, call, sandbox, approvalId } = structuredClone({
    task: input.task,
    scope: input.scope,
    call: input.call,
    sandbox: input.sandbox,
    approvalId: input.approvalId,
  });
  if (
    task.worktreeRoot === null ||
    sandbox.root !== task.worktreeRoot ||
    task.ownerRoomId !== scope.roomId ||
    task.devBotId !== scope.botId ||
    call.id !== scope.invocationId
  )
    throw new ToolError('coding_denied', 'task operation scope mismatch');
  const snapshot = input.snapshot;
  const backend = await createSandboxBackend(sandbox, task.policy.testPresets, snapshot);
  const tools = new WorkspaceTools(backend, { requireContainment: true });
  const tool = await tools.prepare(call);
  if (tool.kind !== 'edit' && tool.kind !== 'execute')
    throw new ToolError('coding_denied', 'approval factory accepts mutations and tests');
  const operation = tool.kind === 'edit' ? 'write' : 'test';
  if (operation === 'test') {
    const args = JSON.parse(call.arguments) as { program: string; args: string[]; cwd: string };
    if (
      !task.policy.testPresets.some(
        (p) =>
          p.program === args.program &&
          p.cwd === args.cwd &&
          JSON.stringify(p.args) === JSON.stringify(args.args),
      )
    )
      throw new ToolError('preset_denied', 'only registered test presets can be prepared');
  }
  const preview =
    tool.preview +
    '\n' +
    JSON.stringify({
      limits: sandboxLimits,
      environment: {
        HOME: '/home/worker',
        PATH: '/workspace/node_modules/.bin:/toolchain/pnpm/bin:/toolchain:/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
    });
  const currentBinding = async (): Promise<CodingApprovalBinding> => ({
    ...scope,
    workspaceId: task.workspaceId,
    taskId: task.id,
    projectRoot: task.projectRoot,
    worktreeRoot: task.worktreeRoot!,
    operation,
    operationHash: hash({ call, preview }),
    sourceTreeHash: await snapshot(),
    policyVersion: task.policyVersion,
    limitsHash: hash(sandboxLimits),
    toolchainHash: hash([
      await fingerprintFile(await realpath(process.execPath)),
      await validateMounts(sandbox.mounts ?? [], sandbox.dependencyProjectRoot),
    ]),
  });
  return {
    approvalId,
    binding: await currentBinding(),
    currentBinding,
    tool: { ...tool, preview },
  };
}
