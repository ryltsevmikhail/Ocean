import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetEntry } from '@runnets/domain';
import { assetFdPath, assetNames, checkAssetPath } from './coding-asset-io.js';
import { captureAssetTreeAt, codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import { checkAssetPolicy } from './coding-asset-policy.js';
import { observeRecoveryDirectories } from './coding-backup-scope-source.js';
import { decodeCodingRecoveryIntent, invalidRecovery } from './coding-recovery-record.js';
import {
  parseRecoveryJson,
  readRecoveryJsonBytes,
  type CodingRecoveryRecordEvidence,
} from './coding-recovery-evidence.js';
import { graphHash, recoveryFileKey, type BackupFile } from './coding-recovery-plan.js';
import type { RecoveryBudget } from './coding-recovery-budget.js';

export interface LegacyDemand {
  ids: string[];
  required: number;
}
export interface LegacyEvidence extends CodingRecoveryRecordEvidence {
  readonly candidateApplicationIds: readonly string[];
  readonly ambiguous: boolean;
}
interface LegacyFile {
  entry: Extract<CodingAssetEntry, { kind: 'file' }>;
  state: string;
}
function namespace(fd: number, path: string, budget: RecoveryBudget) {
  const files = new Map<string, LegacyFile>(),
    mount = codingAssetMount(fd);
  // At most four physical entries per UUID. Refuse even malformed unbounded directories.
  for (const name of assetNames(fd, Math.min(40000, budget.records * 4))) {
    const at = join(assetFdPath(fd), name),
      stat = fs.lstatSync(at, { bigint: true });
    checkAssetPolicy('coding-recovery', name, stat);
    if (
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o7000n) !== 0n ||
      !Number.isSafeInteger(Number(stat.size))
    )
      return invalidRecovery();
    // O_PATH inspects bound identity/mount without opening an unrelated original for reading.
    const file = fs.openSync(at, 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      const state = codingAssetIdentity(stat);
      if (
        codingAssetMount(file) !== mount ||
        codingAssetIdentity(fs.fstatSync(file, { bigint: true })) !== state
      )
        return invalidRecovery();
      checkAssetPath(file, join(path, name));
      const bytes = Number(stat.size);
      if (name.includes('.json')) budget.json(bytes, name.endsWith('.json'));
      files.set(name, {
        entry: { kind: 'file', path: name, mode: Number(stat.mode & 0o777n), bytes, sha256: '' },
        state,
      });
    } finally {
      fs.closeSync(file);
    }
  }
  for (const name of files.keys())
    if (!files.has(name.split('.')[0] + '.json')) return invalidRecovery();
  return files;
}
export function collectLegacyRecovery(
  common: string,
  binding: { commonState: string; mount: string },
  demands: Map<string, LegacyDemand>,
  budget: RecoveryBudget,
) {
  return observeRecoveryDirectories(
    common,
    ['ocean-apply-recovery'],
    (dirs, namespaceWitness) => {
      const root = dirs[1];
      if (!root) {
        if ([...demands.values()].some((d) => d.required)) return invalidRecovery();
        return {
          capture: null,
          witness: graphHash(namespaceWitness),
          records: [] as LegacyEvidence[],
        };
      }
      const files = namespace(root.fd, root.path, budget);
      const observed = createHash('sha256').update(namespaceWitness);
      for (const [name, file] of files) observed.update(JSON.stringify([name, file.state]));
      const classifiedHashes = new Map<string, string>();
      const read = (name: string) => {
        const { entry, state } = files.get(name)!;
        const body = readRecoveryJsonBytes(root.fd, root.path, name, entry, state, 2097152, false);
        const hash = createHash('sha256').update(body).digest('hex');
        observed.update(JSON.stringify([name, hash]));
        classifiedHashes.set(name, hash);
        return body;
      };
      const selected: string[] = [];
      type Coverage = { matches: number; finalized: number };
      const coverage = new Map<string, Coverage>();
      const matches: {
        evidence: Omit<LegacyEvidence, 'ambiguous'>;
        before: BackupFile['before'];
        group: Coverage;
      }[] = [];

      for (const name of files.keys()) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        let value: unknown;
        try {
          value = parseRecoveryJson(read(name));
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof TypeError) return invalidRecovery();
          throw error;
        }
        const main = decodeCodingRecoveryIntent(value, id, null),
          key = recoveryFileKey(main.root, main),
          candidates = demands.get(key);
        const before = files.has(main.backup),
          after = files.has(main.staged);
        let nextOpaque = false;
        if (
          (!main.before && before) ||
          ((!main.after || main.status === 'completed') && after) ||
          (main.status === 'completed' && main.before && !before)
        )
          return invalidRecovery();
        if (files.has(name + '.next')) {
          const body = read(name + '.next');
          let next: unknown;
          try {
            next = parseRecoveryJson(body);
          } catch (error) {
            if (error instanceof SyntaxError || error instanceof TypeError) nextOpaque = true;
            else throw error;
          }
          if (!nextOpaque) {
            const decoded = decodeCodingRecoveryIntent(next, id, null);
            if (
              main.status !== 'started' ||
              decoded.status !== 'completed' ||
              after ||
              (main.before && !before) ||
              recoveryFileKey(decoded.root, decoded) !== key
            )
              return invalidRecovery();
          }
        }
        if (!candidates) continue;
        const record = {
          id,
          root: main.root,
          path: main.path,
          status: main.status,
          nextOpaque,
          original: main.before ? ('absent' as const) : ('not-required' as const),
          candidateApplicationIds: candidates.ids,
        };
        // Charge the longest final original classification before retaining a candidate list.
        budget.reference({ ...record, original: 'not-required', ambiguous: false });
        const group = coverage.get(key) ?? { matches: 0, finalized: 0 };
        group.matches++;
        if (main.status === 'completed') group.finalized++;
        coverage.set(key, group);
        matches.push({
          evidence: record,
          before: main.before && { mode: main.before.mode, sha256: main.before.sha256 },
          group,
        });
        for (const path of [name, name + '.next', main.backup, main.staged])
          if (files.has(path)) selected.push(path);
      }
      for (const [key, demand] of demands)
        if ((coverage.get(key)?.finalized ?? 0) < demand.required) return invalidRecovery();
      const capture = selected.length
        ? captureAssetTreeAt(
            root.path,
            budget.limits,
            'classified-legacy',
            root.fd,
            (metadata) => {
              for (const [name, state] of metadata.sourceEntries) {
                if ((name ? files.get(name)?.state : root.state) !== state)
                  throw Error('stale_coding_asset');
              }
            },
            selected,
          )
        : null;
      const entries = new Map(capture?.manifest.entries.map((e) => [e.path, e]));
      for (const path of selected) {
        const hash = classifiedHashes.get(path),
          entry = entries.get(path);
        if (hash !== undefined && (entry?.kind !== 'file' || entry.sha256 !== hash))
          throw Error('stale_coding_asset');
      }
      const qualified = matches.map(({ evidence, before: expected, group }) => {
        const record = {
          ...evidence,
          ambiguous: group.matches > 1 || evidence.candidateApplicationIds.length > 1,
        };
        const entry = entries.get(record.id + '.before');
        if (!expected || !entry) return record;
        const file = entry.kind === 'hardlink' ? entries.get(entry.target) : entry;
        const matching =
          file?.kind === 'file' &&
          file.sha256 === expected.sha256 &&
          (file.mode & 0o111 ? '100755' : '100644') === expected.mode;
        return { ...record, original: matching ? ('matching' as const) : ('conflict' as const) };
      });
      return { capture, records: qualified, witness: observed.digest('hex') };
    },
    binding,
  );
}
