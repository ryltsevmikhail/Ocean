import { parseRecoveryJson } from './coding-recovery-evidence.js';
import { decodeCodingRecoveryIntent } from './coding-recovery-record.js';
import type { CodingAssetManifest } from '@runnets/domain';
import type { CodingRecoveryAssetCatalog } from './coding-recovery-graph.js';
import { decodeCodingRecoveryRecords } from './coding-recovery-evidence.js';
import { graphHash, recoveryFileKey, type RecoveryPlan } from './coding-recovery-plan.js';
import type { LegacyDemand } from './coding-recovery-legacy.js';
const bad = (): never => {
  throw Error('invalid_profile_recovery');
};
/** Reconstruct exact legacy candidate sets and required completion coverage from frozen SQLite. */
export function verifyProfileLegacy(
  plans: readonly RecoveryPlan[],
  catalog: CodingRecoveryAssetCatalog,
  manifests: ReadonlyMap<string, CodingAssetManifest>,
  reader: (name: string, manifest: CodingAssetManifest) => (path: string) => Buffer,
): Set<string> {
  const commons = new Map<string, Map<string, LegacyDemand>>();
  for (const plan of plans) {
    const { application, tree } = plan;
    if (
      application.recoveryProtocol !== null ||
      !application.files.some((f) => f.status !== 'pending')
    )
      continue;
    const slot = graphHash(tree.gitCommonDir),
      demands = commons.get(slot) ?? new Map<string, LegacyDemand>();
    commons.set(slot, demands);
    const completed = new Set(
      catalog.applications
        .find((a) => a.id === application.id)!
        .records.filter((r) => r.status === 'completed')
        .map((r) => r.path),
    );
    for (const file of application.files) {
      if (file.status === 'pending') continue;
      const key = recoveryFileKey(tree.projectRoot, plan.files.get(file.path)!),
        demand = demands.get(key) ?? { ids: [], required: 0 };
      demand.ids.push(application.id);
      if (file.status === 'completed' && !completed.has(file.path)) demand.required++;
      demands.set(key, demand);
    }
  }
  const used = new Set<string>();
  for (const legacy of catalog.legacy) {
    const name = 'legacy-' + legacy.slot,
      manifest = manifests.get(name),
      demands = commons.get(legacy.slot);
    if (!manifest || manifest.hash !== legacy.manifestHash || !demands || used.has(name))
      return bad();
    used.add(name);
    const read = reader(name, manifest),
      keys = new Map<string, string>(),
      coverage = new Map<string, { matches: number; finalized: number }>();
    const records = decodeCodingRecoveryRecords(
      manifest,
      new Set(plans.map((p) => p.tree.projectRoot)),
      '',
      read,
      (intent) => {
        const id = intent.backup.slice(0, -7),
          has = (name: string) => manifest.entries.some((e) => e.path === name);
        if (
          (!intent.before && has(intent.backup)) ||
          ((!intent.after || intent.status === 'completed') && has(intent.staged))
        )
          return bad();
        if (has(id + '.json.next')) {
          let next: unknown,
            opaque = false;
          try {
            next = parseRecoveryJson(read(id + '.json.next'));
          } catch (error) {
            if (error instanceof SyntaxError || error instanceof TypeError) opaque = true;
            else throw error;
          }
          if (!opaque) {
            const decoded = decodeCodingRecoveryIntent(next, id, null);
            if (
              intent.status !== 'started' ||
              decoded.status !== 'completed' ||
              has(intent.staged) ||
              (intent.before && !has(intent.backup))
            )
              return bad();
          }
        }
        const key = recoveryFileKey(intent.root, intent);
        if (!demands.has(key)) return bad();
        keys.set(intent.backup.slice(0, -7), key);
        const group = coverage.get(key) ?? { matches: 0, finalized: 0 };
        group.matches++;
        if (intent.status === 'completed') group.finalized++;
        coverage.set(key, group);
      },
    );
    if (records.length !== legacy.records.length) return bad();
    for (const [index, record] of records.entries()) {
      const actual = legacy.records[index]!,
        { candidateApplicationIds, ambiguous, ...evidence } = actual;
      const key = keys.get(record.id)!,
        demand = demands.get(key)!;
      if (
        graphHash(record) !== graphHash(evidence) ||
        graphHash(candidateApplicationIds) !== graphHash(demand.ids) ||
        ambiguous !== (demand.ids.length > 1 || coverage.get(key)!.matches > 1)
      )
        return bad();
    }
    for (const [key, demand] of demands)
      if ((coverage.get(key)?.finalized ?? 0) < demand.required) return bad();
  }
  for (const [slot, demands] of commons)
    if (!used.has('legacy-' + slot) && [...demands.values()].some((d) => d.required)) return bad();
  return used;
}
