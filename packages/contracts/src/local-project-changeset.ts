import { bindingDigest } from './local-runtime-decisions.js';
import { localPosition } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
import {
  isLocalCodingPanel,
  isLocalPanelChunk,
  MAX_PANEL_LENGTH,
  type LocalCodingPanel,
  type LocalPanelChunk,
} from './local-coding-panel.js';
import type { CodingTaskPrepare } from './local-project-prepare.js';

export type CodingChangesetCapture = CodingTaskPrepare;
export { isCodingTaskPrepare as isCodingChangesetCapture } from './local-project-prepare.js';

export interface CodingChangesetRead extends LocalCodingPanel {
  readonly hash: string;
}
export interface CodingChangesetChunk extends LocalPanelChunk, CodingChangesetRead {}
export interface CodingChangesetSummary extends CodingChangesetRead {
  readonly baseCommit: string;
  readonly beforeTreeHash: string;
  readonly afterTreeHash: string;
  readonly fileCount: number;
}
export interface CodingChangesetDiff extends CodingChangesetSummary {
  readonly diff: string;
}
export type CodingChangesetMethod = 'coding.changesets.capture' | 'coding.changesets.read';
export const isCodingChangesetMethod = (method: string): method is CodingChangesetMethod =>
  method === 'coding.changesets.capture' || method === 'coding.changesets.read';

export function isCodingChangesetRead(v: unknown): v is CodingChangesetRead {
  if (!localRuntimeRecord(v)) return false;
  const { hash, ...scope } = v;
  return bindingDigest(hash) && isLocalCodingPanel(scope);
}
export function isCodingChangesetChunk(v: unknown): v is CodingChangesetChunk {
  if (!localRuntimeRecord(v)) return false;
  const { hash, ...chunk } = v;
  return bindingDigest(hash) && isLocalPanelChunk(chunk);
}
export function isCodingChangesetSummary(v: unknown): v is CodingChangesetSummary {
  if (!localRuntimeRecord(v)) return false;
  const { baseCommit, beforeTreeHash, afterTreeHash, fileCount, ...q } = v;
  return (
    isCodingChangesetRead(q) &&
    typeof baseCommit === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) &&
    bindingDigest(beforeTreeHash) &&
    bindingDigest(afterTreeHash) &&
    localPosition(fileCount) &&
    // One snapshot compares up to 1000 paths in each tree.
    fileCount <= 2000
  );
}
export function isCodingChangesetDiff(v: unknown): v is CodingChangesetDiff {
  if (!localRuntimeRecord(v)) return false;
  const { diff, ...summary } = v;
  return (
    typeof diff === 'string' && diff.length <= MAX_PANEL_LENGTH && isCodingChangesetSummary(summary)
  );
}
