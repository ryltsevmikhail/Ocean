import { createHash } from 'node:crypto';
import {
  validCodingBackupFiles,
  type CodingApplyContext,
  type CodingBackupInventory,
} from '@runnets/domain';
import { codingApplyRecoveryScope, codingApplyRecoverySlot } from './coding-apply-scope.js';
import {
  captureAssetTreeAt,
  checkAssetTreeAt,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { observeRecoverySource } from './coding-backup-scope-source.js';
import {
  readCodingRecoveryRecords,
  readRecoveryJsonBytes,
  parseRecoveryJson,
  type CodingRecoveryRecordEvidence,
} from './coding-recovery-evidence.js';
import type { RecoveryBudget } from './coding-recovery-budget.js';
import { recoveryFileKey, type RecoveryPlan } from './coding-recovery-plan.js';
import { invalidRecovery } from './coding-recovery-record.js';
type Application = CodingBackupInventory['applications'][number];
export type ScopedCodingApplyRecoveryObservation = {
  readonly context: CodingApplyContext;
  readonly projectRoot: string;
  readonly slot: string;
  readonly recoveryProtocol: 2;
  readonly canonicalHeader: boolean;
  readonly status: Application['status'];
  readonly records: readonly CodingRecoveryRecordEvidence[];
} & (
  | { readonly presence: 'absent'; readonly capture: null }
  | {
      readonly presence: 'incomplete' | 'header-only' | 'scoped';
      readonly capture: CodingAssetCapture;
    }
);
function receiptFiles(application: Application, context: CodingApplyContext) {
  if (
    application.taskId !== context.taskId ||
    application.id !== context.applicationId ||
    application.changesetHash !== context.changesetHash ||
    !['completed', 'uncertain', 'applying', 'not_started'].includes(application.status) ||
    !validCodingBackupFiles(application.files)
  )
    return invalidRecovery();
  const files = new Map<string, Application['files'][number]['status']>();
  for (const { path, status } of application.files) {
    if (
      files.has(path) ||
      (application.status === 'completed' && status !== 'completed') ||
      (application.status === 'not_started' && status !== 'pending') ||
      (application.status === 'uncertain' && status === 'started') ||
      (application.status === 'applying' && status === 'uncertain')
    )
      return invalidRecovery();
    files.set(path, status);
  }
  return files;
}
/** Read-only evidence for one frozen application. The trusted caller supplies its original root and owner. */
export function captureScopedCodingApplyRecovery(
  common: string,
  projectRoot: string,
  context: CodingApplyContext,
  application: Application,
): ScopedCodingApplyRecoveryObservation {
  if (application.recoveryProtocol !== 2) return invalidRecovery();
  return observeBoundRecovery(common, projectRoot, context, application);
}
export function observeBoundRecovery(
  common: string,
  projectRoot: string,
  context: CodingApplyContext,
  application: Application,
  graph?: {
    plan: RecoveryPlan;
    budget: RecoveryBudget;
    binding: { commonState: string; mount: string };
    witness: (value: string) => void;
  },
): ScopedCodingApplyRecoveryObservation {
  const scope = codingApplyRecoveryScope(projectRoot, context),
    slot = codingApplyRecoverySlot(projectRoot, context);
  const files = receiptFiles(application, context),
    statuses = [...files.values()];
  const base = {
    context: { ...context },
    projectRoot,
    slot,
    recoveryProtocol: 2 as const,
    status: application.status,
  };
  const declared = application.recoveryProtocol === 2;
  const required = declared && statuses.includes('completed');
  return observeRecoverySource(
    common,
    slot,
    (source, witness) => {
      graph?.witness(witness);
      const leaf = source.leaf;
      if (!leaf) {
        if (required) return invalidRecovery();
        return { ...base, presence: 'absent', capture: null, records: [], canonicalHeader: false };
      }
      if (!statuses.some((status) => status !== 'pending')) return invalidRecovery();
      let validHeader = false;
      let classifiedHeaderHash: string | undefined;
      const capture = captureAssetTreeAt(
        leaf.path,
        graph?.budget.limits ?? {},
        'coding-recovery-v2',
        leaf.fd,
        (metadata) => {
          for (const entry of metadata.manifest.entries)
            if (
              entry.kind === 'file' &&
              (entry.path === 'scope.json' ||
                entry.path.endsWith('.json') ||
                entry.path.endsWith('.json.next'))
            )
              graph?.budget.json(
                entry.bytes,
                entry.path !== 'scope.json' && entry.path.endsWith('.json'),
              );
          const states = new Map(metadata.sourceEntries);
          if (states.get('') !== leaf.state || states.get('files') !== source.files?.state)
            throw Error('stale_coding_asset');
          const header = metadata.manifest.entries.find((e) => e.path === 'scope.json');
          if (header) {
            const bytes = readRecoveryJsonBytes(
              leaf.fd,
              leaf.path,
              'scope.json',
              header,
              states.get('scope.json'),
              65536,
              false,
            );
            classifiedHeaderHash = createHash('sha256').update(bytes).digest('hex');
            const expected = Buffer.from(JSON.stringify(scope) + '\n');
            validHeader = bytes.equals(expected);
            if (!validHeader) {
              if (!declared || source.files || required) return invalidRecovery();
              // A short write can stop immediately before the final newline, leaving valid JSON.
              if (expected.subarray(0, bytes.length).equals(bytes)) return;
              try {
                parseRecoveryJson(bytes);
              } catch (error) {
                if (error instanceof SyntaxError || error instanceof TypeError) return;
                throw error;
              }
              return invalidRecovery();
            }
          }
          if (
            (!declared && !validHeader) ||
            (source.files && !validHeader) ||
            (required && !source.files)
          )
            return invalidRecovery();
        },
      );
      const capturedHeader = capture.manifest.entries.find((entry) => entry.path === 'scope.json');
      if (
        (capturedHeader?.kind === 'file' ? capturedHeader.sha256 : undefined) !==
        classifiedHeaderHash
      )
        throw Error('stale_coding_asset');
      const records = source.files
        ? readCodingRecoveryRecords(
            capture,
            source.files.fd,
            new Set([projectRoot]),
            'files/',
            (intent) => {
              if (graph) {
                const file = graph.plan.files.get(intent.path);
                if (
                  !file ||
                  recoveryFileKey(projectRoot, file) !== recoveryFileKey(projectRoot, intent)
                )
                  return invalidRecovery();
              }
            },
          )
        : [];
      const seen = new Set<string>();
      for (const record of records) {
        const status = files.get(record.path);
        if (
          !status ||
          status === 'pending' ||
          seen.has(record.path) ||
          (status === 'completed' && record.status !== 'completed')
        )
          return invalidRecovery();
        seen.add(record.path);
      }
      for (const [path, status] of files)
        if (declared && status === 'completed' && !seen.has(path)) return invalidRecovery();
      checkAssetTreeAt(capture, leaf.fd);
      const incomplete =
        [...files].some(([path, status]) => status !== 'pending' && !seen.has(path)) ||
        records.some((record) => record.status === 'started');
      if (!source.files)
        return {
          ...base,
          presence: validHeader ? 'header-only' : 'incomplete',
          capture,
          records,
          canonicalHeader: validHeader,
        };
      return {
        ...base,
        presence: incomplete ? 'incomplete' : 'scoped',
        capture,
        records,
        canonicalHeader: validHeader,
      };
    },
    graph?.binding,
  );
}
