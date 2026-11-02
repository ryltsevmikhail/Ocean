import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { CodingApplyReceipt } from '@runnets/domain';
import { assetFdPath } from './coding-asset-io.js';
import { checkAssetPolicy } from './coding-asset-policy.js';
import {
  type CodingAssetCapture,
  type PublicationGuard,
  type PublicationGuards,
} from './coding-asset-state.js';
import type { RecoverySource } from './coding-backup-scope-source.js';
import { decodeRecoveryMain, readRecoveryJsonBytes } from './coding-recovery-evidence.js';
import { invalidRecovery, type CodingRecoveryIntent } from './coding-recovery-record.js';
import { bindPublication } from './coding-publication-guard.js';

interface PublicationScope {
  common: string;
  slot: string;
  project: string;
  witness: string;
  headerHash: string;
}
/** Only the scoped collector supplies receipt authority, after checking its header and full metadata namespace. */
export function classifyPublications(
  scope: PublicationScope,
  source: RecoverySource,
  metadata: CodingAssetCapture,
  candidates: ReadonlySet<string>,
  receipts: ReadonlyMap<string, CodingApplyReceipt['files'][number]['status']>,
  checkIntent: (intent: CodingRecoveryIntent) => void,
  classified: Map<string, string>,
  witness?: (value: string) => void,
): PublicationGuards {
  const guards = new Map<string, PublicationGuard>();
  if (!candidates.size) return guards;
  if (!source.files || scope.project === '/') return invalidRecovery();
  const entries = new Map(metadata.manifest.entries.map((e) => [e.path, e]));
  const states = new Map(metadata.sourceEntries);
  const header = entries.get('scope.json');
  const seen = new Set<string>(),
    projects = new Set([scope.project]);
  for (const [name, entry] of entries) {
    if (!name.startsWith('files/') || !name.endsWith('.json')) continue;
    const id = basename(name, '.json'),
      main = basename(name);
    const bytes = readRecoveryJsonBytes(
      source.files.fd,
      source.files.path,
      main,
      entry,
      states.get(name),
      2097152,
      false,
    );
    const intent = decodeRecoveryMain(bytes, id, projects);
    checkIntent(intent);
    const digest = createHash('sha256').update(bytes).digest('hex');
    classified.set(name, digest);
    const status = receipts.get(intent.path);
    if (!status || status === 'pending' || seen.has(intent.path)) return invalidRecovery();
    seen.add(intent.path);
    const staged = 'files/' + intent.staged,
      original = 'files/' + intent.backup;
    if (!candidates.has(staged)) continue;
    if (
      !intent.after ||
      intent.status !== 'started' ||
      status === 'completed' ||
      entries.has(name + '.next') ||
      entries.has(original) !== !!intent.before ||
      entries.get(staged)?.kind !== 'file' ||
      header?.kind !== 'file' ||
      entry.kind !== 'file' ||
      join(scope.project, intent.path).startsWith(metadata.root + '/')
    )
      return invalidRecovery();
    const stat = fs.lstatSync(join(assetFdPath(source.files.fd), intent.staged), { bigint: true });
    checkAssetPolicy('coding-worktree', intent.path, stat);
    const fd = fs.openSync(
      join(assetFdPath(source.files.fd), intent.staged),
      0x200000 | fs.constants.O_NOFOLLOW,
    );
    try {
      const proof = bindPublication(
        {
          ...scope,
          target: intent.path,
          id,
          mount: metadata.sourceMount,
          stagedState: states.get(staged)!,
          originalState: states.get(original),
          header: {
            entry: { ...header, sha256: scope.headerHash },
            state: states.get('scope.json')!,
          },
          main: { entry: { ...entry, sha256: digest }, state: states.get(name)! },
        },
        fd,
      );
      witness?.(proof.witness);
      guards.set(staged, proof.guard);
    } finally {
      fs.closeSync(fd);
    }
  }
  if (guards.size !== candidates.size) return invalidRecovery();
  return guards;
}
