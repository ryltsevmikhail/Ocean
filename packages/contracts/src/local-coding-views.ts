import { localRuntimeRecord as rec } from './local-runtime.js';
import { bindingDigest } from './local-runtime-decisions.js';
import type { CodingReadMethod, LocalCodingRead } from './local-profile.js';
export interface LocalCodingTaskView {
  workspaceId: string;
  id: string;
  ownerRoomId: string;
  reviewRoomId: string;
  devBotId: string;
  reviewBotId: string;
  policyVersion: 1;
  projectRoot: string;
  worktreeRoot: string | null;
  baseCommit: string;
  status: 'reserved' | 'cancelled' | 'finalizing' | 'finalized';
  policy: {
    version: 1;
    devCapabilities: readonly string[];
    reviewCapabilities: readonly string[];
    testPresets: readonly { id: string; program: string; cwd: '.'; args: readonly string[] }[];
  };
}
interface Content {
  mode: '100644' | '100755';
  sha256: string;
  text: string;
}
export interface LocalDiffView {
  workspaceId: string;
  roomId: string;
  taskId: string;
  kind: 'preview';
  hash: string;
  baseCommit: string;
  beforeTreeHash: string;
  afterTreeHash: string;
  diff: string;
  files: readonly { path: string; before: Content | null; after: Content | null }[];
  tests: readonly {
    presetId: string;
    evidence: null | {
      hash: string;
      binding: Readonly<Record<string, unknown>>;
      passed: boolean;
      current: boolean;
      afterTreeHash: string;
    };
  }[];
}
export interface LocalApplyView {
  workspaceId: string;
  roomId: string;
  projectRoot: string;
  holdReleased: false;
  receipt: {
    id: string;
    taskId: string;
    changesetHash: string;
    status: string;
    files: readonly { path: string; status: string }[];
  };
  files: readonly {
    path: string;
    comparison: string;
    kind: string;
    mode: string | null;
    sha256: string | null;
  }[];
  resolution: null | {
    applicationId: string;
    workspaceId: string;
    taskId: string;
    accepted: 'before' | 'after';
    reason: string;
  };
}
const strings = (v: unknown) => Array.isArray(v) && v.every((t) => typeof t === 'string');
const str = (r: Record<string, unknown>, ...keys: string[]) =>
  keys.every((k) => typeof r[k] === 'string');
const content = (v: unknown) =>
  v === null ||
  (rec(v) &&
    bindingDigest(v['sha256']) &&
    typeof v['text'] === 'string' &&
    (v['mode'] === '100644' || v['mode'] === '100755'));
function task(v: Record<string, unknown>, q: LocalCodingRead) {
  const p = v['policy'];
  return (
    v['id'] === q.id &&
    str(v, 'ownerRoomId', 'reviewRoomId', 'devBotId', 'reviewBotId', 'projectRoot', 'baseCommit') &&
    (q.roomId === undefined || q.roomId === v['ownerRoomId']) &&
    (typeof v['worktreeRoot'] === 'string' || v['worktreeRoot'] === null) &&
    ['reserved', 'cancelled', 'finalizing', 'finalized'].includes(String(v['status'])) &&
    v['policyVersion'] === 1 &&
    !('lease' in v) &&
    rec(p) &&
    p['version'] === 1 &&
    strings(p['devCapabilities']) &&
    strings(p['reviewCapabilities']) &&
    Array.isArray(p['testPresets']) &&
    p['testPresets'].every(
      (s: unknown) => rec(s) && str(s, 'id', 'program') && s['cwd'] === '.' && strings(s['args']),
    )
  );
}
function diff(v: Record<string, unknown>, q: LocalCodingRead) {
  return (
    v['kind'] === 'preview' &&
    v['taskId'] === q.id &&
    v['hash'] === v['id'] &&
    bindingDigest(v['hash']) &&
    bindingDigest(v['beforeTreeHash']) &&
    bindingDigest(v['afterTreeHash']) &&
    str(v, 'baseCommit', 'diff') &&
    Array.isArray(v['files']) &&
    v['files'].every(
      (f: unknown) => rec(f) && str(f, 'path') && content(f['before']) && content(f['after']),
    ) &&
    Array.isArray(v['tests']) &&
    v['tests'].every((t: unknown) => {
      if (!rec(t) || !str(t, 'presetId')) return false;
      const e = t['evidence'];
      return (
        e === null ||
        (rec(e) &&
          bindingDigest(e['hash']) &&
          bindingDigest(e['afterTreeHash']) &&
          typeof e['passed'] === 'boolean' &&
          typeof e['current'] === 'boolean' &&
          rec(e['binding']) &&
          e['binding']['taskId'] === q.id &&
          e['binding']['roomId'] === v['roomId'] &&
          e['binding']['workspaceId'] === q.workspaceId)
      );
    })
  );
}
function inspection(v: Record<string, unknown>, q: LocalCodingRead) {
  const r = v['receipt'],
    d = v['resolution'];
  return (
    v['holdReleased'] === false &&
    str(v, 'projectRoot') &&
    rec(r) &&
    r['id'] === q.id &&
    str(r, 'taskId', 'status') &&
    bindingDigest(r['changesetHash']) &&
    Array.isArray(r['files']) &&
    r['files'].every((f: unknown) => rec(f) && str(f, 'path', 'status')) &&
    Array.isArray(v['files']) &&
    v['files'].every(
      (f: unknown) =>
        rec(f) &&
        str(f, 'path', 'kind', 'comparison') &&
        (f['mode'] === null || typeof f['mode'] === 'string') &&
        (f['sha256'] === null || bindingDigest(f['sha256'])),
    ) &&
    (d === null ||
      (rec(d) &&
        d['applicationId'] === q.id &&
        d['workspaceId'] === q.workspaceId &&
        d['taskId'] === r['taskId'] &&
        (d['accepted'] === 'before' || d['accepted'] === 'after') &&
        str(d, 'reason')))
  );
}
export type LocalCodingView = LocalCodingTaskView | LocalDiffView | LocalApplyView;
export function isCodingView(
  v: unknown,
  method: CodingReadMethod,
  q: LocalCodingRead,
): v is LocalCodingView {
  if (!rec(v) || v['workspaceId'] !== q.workspaceId) return false;
  if (method === 'coding.show') return task(v, q);
  if (typeof v['roomId'] !== 'string' || (q.roomId !== undefined && v['roomId'] !== q.roomId))
    return false;
  return method === 'coding.diff' ? diff(v, q) : inspection(v, q);
}
