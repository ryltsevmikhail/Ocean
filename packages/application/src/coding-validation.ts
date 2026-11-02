import { DEV_CAPABILITIES, validConversationText } from '@runnets/domain';
import type { StartCodingTask, CodingTransaction } from './coding-ports.js';
function preset(p: unknown): boolean {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false;
  const r = p as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['id', 'program', 'args', 'cwd'].includes(k))) return false;
  if (
    typeof r['id'] !== 'string' ||
    !validConversationText(r['id'], 64) ||
    typeof r['program'] !== 'string' ||
    !validConversationText(r['program'], 1024) ||
    r['cwd'] !== '.' ||
    !Array.isArray(r['args'])
  )
    return false;
  const args: unknown[] = r['args'];
  return (
    args.length <= 128 &&
    args.every((a) => typeof a === 'string' && a.length <= 8192 && !a.includes('\0'))
  );
}
export function validCodingStart(i: StartCodingTask): boolean {
  if (i === null || typeof i !== 'object') return false;
  const caps: unknown = i.devCapabilities,
    presets: unknown = i.testPresets;
  if (!Array.isArray(caps) || !Array.isArray(presets)) return false;
  const capabilities: unknown[] = caps,
    definitions: unknown[] = presets;
  return (
    [
      i.taskId,
      i.requestId,
      i.workspaceId,
      i.ownerRoomId,
      i.reviewRoomId,
      i.devBotId,
      i.reviewBotId,
    ].every((v) => validConversationText(v, 128)) &&
    i.devBotId !== i.reviewBotId &&
    typeof i.projectRoot === 'string' &&
    i.projectRoot.startsWith('/') &&
    validConversationText(i.projectRoot, 4096) &&
    capabilities.length <= 3 &&
    new Set(capabilities).size === capabilities.length &&
    capabilities.every(
      (c) => typeof c === 'string' && (DEV_CAPABILITIES as readonly string[]).includes(c),
    ) &&
    definitions.length <= 16 &&
    definitions.every(preset) &&
    new Set(i.testPresets.map((p) => p.id)).size === definitions.length &&
    (!capabilities.includes('run_test_preset') || definitions.length > 0) &&
    validConversationText(JSON.stringify(i), 65536)
  );
}
export function codingBinding(i: StartCodingTask): string {
  return JSON.stringify([
    i.taskId,
    i.requestId,
    i.workspaceId,
    i.projectRoot,
    i.ownerRoomId,
    i.reviewRoomId,
    i.devBotId,
    i.reviewBotId,
    [...i.devCapabilities].sort(),
    i.testPresets.map((p) => [p.id, p.program, [...p.args], p.cwd]),
  ]);
}
export function codingParticipants(
  tx: CodingTransaction,
  i: StartCodingTask,
  root: string,
): boolean {
  return (
    tx.workspaceRoot(i.workspaceId) === root &&
    tx.participates(i.workspaceId, i.ownerRoomId, i.devBotId) &&
    tx.participates(i.workspaceId, i.reviewRoomId, i.reviewBotId)
  );
}
