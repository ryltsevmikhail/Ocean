import { verifyProfileLegacy } from './profile-backup-legacy.js';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import type { CodingAssetManifest, CodingBackupInventory } from '@runnets/domain';
import type { CodingRecoveryAssetCatalog } from './coding-recovery-graph.js';
import { planRecoveryGraph, graphHash, recoveryFileKey } from './coding-recovery-plan.js';
import { codingApplyRecoverySlot, codingApplyRecoveryScope } from './coding-apply-scope.js';
import { decodeCodingRecoveryRecords } from './coding-recovery-evidence.js';
import { privateAssetDirectory } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
const bad = (): never => {
  throw Error('invalid_profile_recovery');
};
export function verifyProfileRecovery(
  directory: string,
  inventory: CodingBackupInventory,
  catalog: CodingRecoveryAssetCatalog,
  manifests: ReadonlyMap<string, CodingAssetManifest>,
): void {
  const managed = inventory.worktrees[0] ? dirname(inventory.worktrees[0].root) : '/absent',
    plans = planRecoveryGraph(inventory, managed),
    { hash, ...body } = catalog;
  if (
    catalog.format !== 1 ||
    hash !== graphHash(body) ||
    catalog.inventoryHash !== inventory.hash ||
    catalog.applications.length !== plans.length
  )
    return bad();
  for (const [name, manifest] of manifests) {
    const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const record = uuid + '\\.(?:json(?:\\.next)?|before|after)';
    for (const entry of manifest.entries) {
      if (entry.path === '' && entry.kind === 'directory') continue;
      if (name.startsWith('scoped-') && entry.path === 'files' && entry.kind === 'directory')
        continue;
      if (name.startsWith('scoped-') && entry.path === 'scope.json' && entry.kind === 'file')
        continue;
      if (
        !['file', 'hardlink'].includes(entry.kind) ||
        !new RegExp('^' + (name.startsWith('scoped-') ? 'files/' : '') + record + '$').test(
          entry.path,
        )
      )
        return bad();
    }
  }
  const used = new Set<string>();
  const reader = (name: string, manifest: CodingAssetManifest) => (path: string) => {
    const selected = manifest.entries.find((e) => e.path === path);
    const entry =
      selected?.kind === 'hardlink'
        ? manifest.entries.find((e) => e.path === selected.target)
        : selected;
    if (!entry || entry.kind !== 'file' || entry.bytes > 2097152) return bad();
    const blobs = privateAssetDirectory(join(directory, name, 'blobs'));
    try {
      return readDesktopArchiveFile(blobs, entry.sha256, entry.bytes, entry.sha256);
    } finally {
      fs.closeSync(blobs);
    }
  };
  for (const [index, plan] of plans.entries()) {
    const record = catalog.applications[index]!,
      { application, tree, context } = plan,
      slot = codingApplyRecoverySlot(tree.projectRoot, context),
      name = 'scoped-' + slot,
      manifest = manifests.get(name),
      unknown = application.files
        .filter((f) => f.status === 'started' || f.status === 'uncertain')
        .map((f) => f.path);
    if (
      record.id !== application.id ||
      record.taskId !== tree.taskId ||
      record.slot !== slot ||
      record.changesetHash !== application.changesetHash ||
      record.status !== application.status ||
      record.declaredProtocol !== application.recoveryProtocol ||
      graphHash(record.unknown) !== graphHash(unknown)
    )
      return bad();
    if (!manifest) {
      if (
        record.presence !== 'absent' ||
        record.manifestHash !== null ||
        record.observedProtocol !== null ||
        record.records.length ||
        (application.recoveryProtocol === 2 &&
          application.files.some((f) => f.status === 'completed'))
      )
        return bad();
      continue;
    }
    used.add(name);
    if (record.manifestHash !== manifest.hash || record.presence === 'absent') return bad();
    const read = reader(name, manifest),
      header = manifest.entries.find((e) => e.path === 'scope.json');
    const expected = Buffer.from(
      JSON.stringify(codingApplyRecoveryScope(tree.projectRoot, context)) + '\n',
    );
    const headerBytes = header ? read('scope.json') : null,
      canonical = headerBytes?.equals(expected) ?? false;
    if (record.observedProtocol !== (canonical ? 2 : null)) return bad();
    const hasFiles = manifest.entries.some((e) => e.path === 'files');
    if ((hasFiles && !canonical) || (application.recoveryProtocol === null && !canonical))
      return bad();
    if (
      headerBytes &&
      !canonical &&
      !expected.subarray(0, headerBytes.length).equals(headerBytes)
    ) {
      try {
        JSON.parse(headerBytes.toString());
        return bad();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const publications = new Set(
      record.records
        .filter((r) => r.publicationLink !== undefined)
        .map((r) => 'files/' + r.id + '.after'),
    );
    const records = hasFiles
      ? decodeCodingRecoveryRecords(
          manifest,
          new Set([tree.projectRoot]),
          'files/',
          (p) => read('files/' + p),
          (intent) => {
            const file = plan.files.get(intent.path);
            if (
              !file ||
              recoveryFileKey(tree.projectRoot, file) !== recoveryFileKey(tree.projectRoot, intent)
            )
              return bad();
          },
          publications,
        )
      : [];
    if (graphHash(records) !== graphHash(record.records)) return bad();
    const seen = new Set<string>();
    for (const r of records) {
      const status = application.files.find((f) => f.path === r.path)?.status;
      if (
        !status ||
        status === 'pending' ||
        seen.has(r.path) ||
        (status === 'completed' && r.status !== 'completed')
      )
        return bad();
      seen.add(r.path);
    }
    if (
      application.recoveryProtocol === 2 &&
      application.files.some((f) => f.status === 'completed' && !seen.has(f.path))
    )
      return bad();
    const incomplete =
      application.files.some((f) => f.status !== 'pending' && !seen.has(f.path)) ||
      records.some((r) => r.status === 'started');
    const presence = hasFiles
      ? incomplete
        ? 'incomplete'
        : 'scoped'
      : canonical
        ? 'header-only'
        : 'incomplete';
    if (record.presence !== presence) return bad();
  }
  for (const name of verifyProfileLegacy(plans, catalog, manifests, reader)) used.add(name);
  if (used.size !== manifests.size) return bad();
}
