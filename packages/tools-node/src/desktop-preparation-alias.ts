import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  desktopRoom,
  desktopUuid,
  type CodingAssetManifest,
  type DesktopAssetInventory,
  type DesktopPreparation,
} from '@runnets/domain';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import type { CodingAssetCapture, PublicationGuards } from './coding-asset-state.js';
import { checkAssetPath } from './coding-asset-io.js';
const bad = (): never => {
  throw Error('protected_desktop_asset');
};
/** Exact internal receipt aliases, never permission to admit outside hardlinks. */
export function desktopPreparationAliases(
  inventory: DesktopAssetInventory,
  manifest: CodingAssetManifest,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'hardlink') continue;
    const [room, name, extra] = entry.path.split('/'),
      [targetRoom, targetName, targetExtra] = entry.target.split('/');
    if (!desktopRoom(room) || !name || extra || targetExtra || room !== targetRoom) return bad();
    const request = targetName?.slice(0, -5),
      temporary = name.slice((targetName?.length ?? 0) + 1, -4);
    if (
      !targetName?.endsWith('.json') ||
      !desktopUuid(request) ||
      !desktopUuid(temporary) ||
      name !== targetName + '.' + temporary + '.tmp' ||
      !inventory.rooms.includes(room) ||
      aliases.has(entry.target) ||
      manifest.entries.find((e) => e.path === entry.target)?.kind !== 'file'
    )
      return bad();
    const operations = inventory.operations.filter(
      (o) => o.id === 'prepare:' + room + ':' + request,
    );
    if (
      operations.length !== 1 ||
      operations[0]!.state !== 'started' ||
      operations[0]!.result !== null ||
      inventory.messages.some((m) => m.roomId === room && m.requestId === request)
    )
      return bad();
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(operations[0]!.binding) as Record<string, unknown>;
    } catch {
      return bad();
    }
    if (
      !input ||
      Object.keys(input).sort().join() !== 'body,ids,requestId,room,to' ||
      input['room'] !== room ||
      input['requestId'] !== request ||
      typeof input['body'] !== 'string' ||
      !(input['to'] === null || typeof input['to'] === 'string') ||
      !Array.isArray(input['ids']) ||
      input['ids'].length < 1 ||
      input['ids'].length > 4 ||
      !input['ids'].every(desktopUuid) ||
      new Set(input['ids']).size !== input['ids'].length
    )
      return bad();
    aliases.set(entry.target, entry.path);
  }
  return aliases;
}
export function desktopAliasGuards(
  inventory: DesktopAssetInventory,
  source: CodingAssetCapture,
  candidates: ReadonlySet<string>,
): PublicationGuards {
  const pairs = desktopPreparationAliases(inventory, source.manifest),
    admitted = new Set([...pairs].flatMap(([a, b]) => [a, b])),
    states = new Map(source.sourceEntries);
  if (candidates.size !== admitted.size || [...candidates].some((p) => !admitted.has(p)))
    return bad();
  const guards = new Map();
  for (const [first, second] of pairs) {
    if (states.get(first) !== states.get(second)) return bad();
    const verify = () => {
      for (const path of [first, second]) {
        const at = join(source.root, path),
          fd = fs.openSync(at, 0x200000 | fs.constants.O_NOFOLLOW);
        try {
          if (
            codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== states.get(path) ||
            codingAssetMount(fd) !== source.sourceMount
          )
            throw Error('stale_coding_asset');
          checkAssetPath(fd, at);
        } finally {
          fs.closeSync(fd);
        }
      }
    };
    const guard = {
      read<T>(_fd: number, consume: () => T): T {
        verify();
        const result = consume();
        verify();
        return result;
      },
      verify,
    };
    guards.set(first, guard);
    guards.set(second, guard);
  }
  return guards;
}
export function checkDesktopAliasReceipt(
  inventory: DesktopAssetInventory,
  room: string,
  request: string,
  receipt: DesktopPreparation,
): void {
  const operation = inventory.operations.find((o) => o.id === 'prepare:' + room + ':' + request)!;
  const input = JSON.parse(operation.binding) as Record<string, unknown>;
  if (
    input['body'] !== receipt.body ||
    input['to'] !== receipt.to ||
    JSON.stringify(input['ids']) !== JSON.stringify(receipt.ids)
  )
    throw Error('desktop_asset_corrupted');
}
