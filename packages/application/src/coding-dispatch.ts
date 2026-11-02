import type { CodingApprovalBinding } from '@runnets/domain';
import type { CodingApprovalOwnerPort, CodingApprovalService } from './coding-approval.js';
import type { PreparedTool, ToolJournalPort, ToolResult } from './tools.js';

/** Trusted host preparation owns the immutable binding and executable closure. */
export interface PreparedCodingOperation {
  readonly approvalId: string;
  readonly binding: CodingApprovalBinding;
  readonly tool: PreparedTool;
  currentBinding(): Promise<CodingApprovalBinding>;
  recordResult?(result: ToolResult): void | Promise<void>;
}
export async function dispatchCodingOperation(
  operation: PreparedCodingOperation,
  approvals: CodingApprovalService,
  owner: CodingApprovalOwnerPort,
  journal: ToolJournalPort,
  signal: AbortSignal,
): Promise<ToolResult> {
  signal.throwIfAborted();
  const binding = structuredClone(operation.binding);
  const approvalId = operation.approvalId;
  const preview = operation.tool.preview;
  const execute = operation.tool.execute.bind(operation.tool);
  const currentBinding = operation.currentBinding.bind(operation);
  const recordResult = operation.recordResult?.bind(operation);
  const requested = approvals.request(approvalId, binding, preview);
  if (!requested.ok) return { isError: true, output: requested.error.code };
  const decision = await approvals.decide(approvalId, binding, owner);
  signal.throwIfAborted();
  if (!decision.ok || decision.value.status !== 'allowed')
    return { isError: true, output: 'approval_required' };
  const current = await currentBinding();
  signal.throwIfAborted();
  const consumed = approvals.consume(approvalId, current);
  if (!consumed.ok) return { isError: true, output: consumed.error.code };
  const context = { taskRunId: binding.runId, attemptId: binding.attemptId };
  try {
    const result = await execute(signal);
    await recordResult?.(result);
    await journal.settle(
      binding.invocationId,
      result.uncertain ? 'uncertain' : result.isError ? 'failed' : 'completed',
      context,
    );
    return result;
  } catch {
    await journal.settle(binding.invocationId, 'uncertain', context).catch(() => {});
    return {
      isError: true,
      uncertain: true,
      output: 'coding operation outcome uncertain; reconcile before another effect',
    };
  }
}
