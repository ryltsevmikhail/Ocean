import { createHash } from 'node:crypto';
import type { CodingBackupInventory } from '@runnets/domain';
import type { CodingAssetCapture } from './coding-asset-scan.js';
import { observeBoundRecovery } from './coding-backup-scope.js';
import {
  graphHash,
  planRecoveryGraph,
  recoveryFileKey,
  type RecoveryPlan,
} from './coding-recovery-plan.js';
import { RecoveryBudget } from './coding-recovery-budget.js';
import { verifyRecoveryBinding } from './coding-recovery-binding.js';
import { collectLegacyRecovery, type LegacyDemand } from './coding-recovery-legacy.js';
export interface CodingRecoveryAssetInput {
  readonly kind: 'legacy' | 'scoped';
  readonly slot: string;
  readonly capture: CodingAssetCapture;
}
type Consumer = (input: CodingRecoveryAssetInput) => Promise<void>;
/** One bounded pass. Captures go directly to the sequential consumer. Retain only catalog references and witnesses. */
async function observeGraph(plans: RecoveryPlan[], consume?: Consumer) {
  const budget = new RecoveryBudget(),
    witnessed = createHash('sha256');
  const witness = (value: string) => {
    witnessed.update(JSON.stringify(value));
  };
  const bindings = new Map<string, ReturnType<typeof verifyRecoveryBinding>>();
  for (const { tree } of plans)
    if (!bindings.has(tree.taskId)) {
      const binding = verifyRecoveryBinding(tree);
      bindings.set(tree.taskId, binding);
      witness(binding.hash);
    }
  const emit = async (
    kind: CodingRecoveryAssetInput['kind'],
    slot: string,
    capture: CodingAssetCapture | null,
  ) => {
    if (!capture) return null;
    budget.capture(capture);
    witness(capture.sourceStateHash);
    const hash = capture.manifest.hash;
    witness(hash);
    if (consume) await consume({ kind, slot, capture });
    return hash;
  };
  const applications = [],
    legacy = [];
  const commons = new Map<
    string,
    { binding: ReturnType<typeof verifyRecoveryBinding>; demands: Map<string, LegacyDemand> }
  >();
  for (const plan of plans) {
    const { tree, context, application } = plan,
      binding = bindings.get(tree.taskId)!;
    const scoped = observeBoundRecovery(tree.gitCommonDir, tree.projectRoot, context, application, {
      binding,
      plan,
      budget,
      witness,
    });
    const completed = new Set(
      scoped.records.filter((r) => r.status === 'completed').map((r) => r.path),
    );
    if (
      application.recoveryProtocol === null &&
      application.files.some((file) => file.status !== 'pending')
    ) {
      const group = commons.get(tree.gitCommonDir) ?? {
        binding,
        demands: new Map<string, LegacyDemand>(),
      };
      commons.set(tree.gitCommonDir, group);
      for (const file of application.files) {
        if (file.status === 'pending') continue;
        const key = recoveryFileKey(tree.projectRoot, plan.files.get(file.path)!);
        const existing = group.demands.get(key);
        if (!existing) budget.reference(key);
        budget.reference(application.id);
        const demand = existing ?? { required: 0, ids: [] };
        demand.ids.push(application.id);
        if (file.status === 'completed' && !completed.has(file.path)) demand.required++;
        group.demands.set(key, demand);
      }
    }
    const record = {
      id: application.id,
      taskId: tree.taskId,
      changesetHash: application.changesetHash,
      slot: scoped.slot,
      status: application.status,
      declaredProtocol: application.recoveryProtocol,
      observedProtocol: scoped.canonicalHeader ? (2 as const) : null,
      presence: scoped.presence,
      records: scoped.records,
      unknown: application.files
        .filter((f) => f.status === 'started' || f.status === 'uncertain')
        .map((f) => f.path),
      manifestHash: await emit('scoped', scoped.slot, scoped.capture),
    };
    budget.reference(record);
    applications.push(record);
  }
  for (const [common, { binding, demands }] of commons) {
    const slot = graphHash(common);
    const result = collectLegacyRecovery(common, binding, demands, budget);
    witness(result.witness);
    if (!result.capture) continue;
    const reference = { slot, manifestHash: await emit('legacy', slot, result.capture) };
    budget.reference(reference);
    legacy.push({ ...reference, records: result.records });
  }
  return { applications, legacy, witness: witnessed.digest('hex') };
}
/** The caller holds profile maintenance ownership. The graph is evidence, never authority to settle or replay. */
export async function captureCodingRecoveryAssets(
  frozen: CodingBackupInventory,
  managedDirectory: string,
  consume: Consumer,
) {
  const inventory = structuredClone(frozen),
    plans = planRecoveryGraph(inventory, managedDirectory);
  const first = await observeGraph(plans, consume);
  const body = {
    format: 1 as const,
    inventoryHash: inventory.hash,
    applications: first.applications,
    legacy: first.legacy,
  };
  if (Buffer.byteLength(JSON.stringify(body)) + 80 > 16777216) throw Error('coding_asset_limit');
  const last = await observeGraph(plans);
  if (
    first.witness !== last.witness ||
    graphHash([first.applications, first.legacy]) !== graphHash([last.applications, last.legacy])
  )
    throw Error('stale_coding_asset');
  return { ...body, hash: graphHash(body) };
}
export type CodingRecoveryAssetCatalog = Awaited<ReturnType<typeof captureCodingRecoveryAssets>>;
