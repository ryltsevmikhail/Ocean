import { bindingDigest } from './local-runtime-decisions.js';
import { localId, localPosition } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
import type { LocalRoomScope } from './local-runtime-turns.js';

export interface LocalCodingPanel extends LocalRoomScope {
  readonly taskId: string;
}
export interface LocalPanelChunk extends LocalCodingPanel {
  readonly offset: number;
  readonly version?: string;
}
export const MAX_PANEL_LENGTH = 16 * 1024 * 1024;
const ids = ['workspaceId', 'roomId', 'taskId'];
export function isLocalCodingPanel(v: unknown): v is LocalCodingPanel {
  return (
    localRuntimeRecord(v) &&
    ids.every((k) => localId(v[k])) &&
    Object.keys(v).every((k) => ids.includes(k))
  );
}
export function isLocalPanelChunk(v: unknown): v is LocalPanelChunk {
  if (!localRuntimeRecord(v)) return false;
  const { offset, version, ...scope } = v;
  return (
    isLocalCodingPanel(scope) &&
    localPosition(offset) &&
    offset <= MAX_PANEL_LENGTH &&
    (offset === 0 ? version === undefined : bindingDigest(version))
  );
}
