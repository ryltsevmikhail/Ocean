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
export interface CodingOperationInput {
  readonly task: CodingTask;
  readonly scope: CodingOperationScope;
  readonly approvalId: string;
  readonly call: ToolInvocation;
  readonly sandbox: SandboxOptions;
  readonly snapshot: () => Promise<string>;
}
export async function prepareCodingOperation(
  input: CodingOperationInput,
): Promise<PreparedCodingOperation> {
  return prepareOperation(input);
}
async function prepareOperation(
  input: CodingOperationInput,
  sessionTools?: WorkspaceTools,
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
  const tools =
    sessionTools ??
    new WorkspaceTools(await createSandboxBackend(sandbox, task.policy.testPresets, snapshot), {
      requireContainment: true,
    });
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
    policyVersion: task.policyVersion,
    limitsHash: hash(sandboxLimits),
    toolchainHash: hash([
      await fingerprintFile(await realpath(process.execPath)),
      await validateMounts(sandbox.mounts ?? [], sandbox.dependencyProjectRoot),
    ]),
    sourceTreeHash: await snapshot(),
  });
  const binding = await currentBinding();
  return {
    approvalId,
    binding,
    currentBinding,
    tool: {
      ...tool,
      preview,
      execute: async (signal) => {
        signal.throwIfAborted();
        if ((await snapshot()) !== binding.sourceTreeHash)
          throw new ToolError('stale_read', 'approved source tree changed before execution');
        return tool.execute(signal);
      },
    },
  };
}

export async function createCodingOperationSession(
  input: Omit<CodingOperationInput, 'approvalId' | 'call'>,
) {
  const fixed = {
    ...structuredClone({ task: input.task, scope: input.scope, sandbox: input.sandbox }),
    snapshot: input.snapshot,
  };
  if (
    fixed.task.status !== 'reserved' ||
    fixed.task.worktreeRoot !== fixed.sandbox.root ||
    fixed.scope.roomId !== fixed.task.ownerRoomId ||
    fixed.scope.botId !== fixed.task.devBotId
  )
    throw new ToolError('coding_denied', 'task session scope mismatch');
  const tools = new WorkspaceTools(
    await createSandboxBackend(fixed.sandbox, fixed.task.policy.testPresets, fixed.snapshot),
    { requireContainment: true },
  );
  return {
    async read(call: ToolInvocation, signal: AbortSignal) {
      if (
        !fixed.task.policy.devCapabilities.includes('project_read') ||
        (call.name !== 'read_file' && call.name !== 'list_files')
      )
        throw new ToolError('coding_denied', 'task read capability required');
      const prepared = await tools.prepare(call);
      return prepared.execute(signal);
    },
    prepare(approvalId: string, call: ToolInvocation, attemptId = fixed.scope.attemptId) {
      return prepareOperation(
        { ...fixed, approvalId, call, scope: { ...fixed.scope, attemptId, invocationId: call.id } },
        tools,
      );
    },
  };
}
