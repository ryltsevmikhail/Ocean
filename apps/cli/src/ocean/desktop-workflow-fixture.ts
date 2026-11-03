import * as fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { encodeDesktopAttachments } from '@runnets/domain';
import { desktopRootIdentity } from '@runnets/tools-node';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import type { CodingBackupInventory } from '@runnets/domain';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';

export const attachmentId = '12345678-1234-4123-8123-123456789abc';
export const prepareRequest = '22345678-1234-4123-8123-123456789abc';
export const startedRequest = '32345678-1234-4123-8123-123456789abc';
export const desktopCaption = 'archived desktop caption';
export const desktopBytes = Buffer.from([0, 255, 10, 0, 42, 13]);
export const decoyBytes = Buffer.from('decoy old-provenance bytes', 'utf8');
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface CodingDesktopFixture {
  readonly directory: string;
  readonly desktop: string;
  readonly project: string;
  readonly base: string;
  readonly room: string;
  readonly userData: string;
  readonly task: CodingBackupInventory['tasks'][number];
  readonly binding: Record<string, string>;
  readonly close: () => void;
}
/**
 * Real frozen SQLite task and Desktop evidence. The binding/enrollment row, one
 * completed preparation and one genuinely started operation are durable rows; the
 * completed receipt and attachment bytes are exact Desktop archive sources.
 */
export async function codingDesktopFixture(): Promise<CodingDesktopFixture> {
  const f = await codingWorkflowFixture('direct');
  const userData = join(f.directory, 'userData');
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.writeFileSync(join(f.worktree, 'answer.txt'), 'ready-tree after last capture\n');
  f.runtime.close();
  fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
  fs.writeFileSync(
    join(f.directory, 'coding-projects.json'),
    JSON.stringify([
      {
        id: 'project',
        root: f.project,
        testPresets: inventory.tasks[0]!.policy.testPresets,
        mounts: [],
      },
    ]),
    { mode: 0o600 },
  );
  const desktop = join(f.directory, 'desktop-fixture'),
    room = f.room,
    info = {
      id: attachmentId,
      name: 'archived.txt',
      bytes: desktopBytes.length,
      sha256: hash(desktopBytes),
      kind: 'file' as const,
      mime: 'text/plain',
    },
    prepared = encodeDesktopAttachments(desktopCaption, prepareRequest, [info]),
    receipt = {
      body: desktopCaption,
      ids: [attachmentId],
      to: null,
      prepared,
      digest: hash(prepared),
    },
    input = {
      room,
      requestId: prepareRequest,
      body: desktopCaption,
      to: null,
      ids: [attachmentId],
    },
    originalRoot = join(f.directory, 'userData/attachments');
  fs.mkdirSync(desktop, { mode: 0o700 });
  fs.mkdirSync(join(desktop, room, attachmentId), { recursive: true, mode: 0o700 });
  const binding = {
    profileId: hash(f.directory),
    root: desktop,
    identity: desktopRootIdentity(desktop),
    originalRoot,
  };
  fs.writeFileSync(join(desktop, room, attachmentId, 'blob'), desktopBytes, { mode: 0o600 });
  fs.writeFileSync(join(desktop, room, attachmentId, 'metadata.json'), JSON.stringify(info), {
    mode: 0o600,
  });
  fs.writeFileSync(join(desktop, room, prepareRequest + '.json'), JSON.stringify(receipt), {
    mode: 0o600,
  });
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
  try {
    db.prepare("INSERT INTO meta VALUES('desktop_assets_binding',?)").run(JSON.stringify(binding));
    db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'completed',?)").run(
      'enrollment',
      userData,
      JSON.stringify(binding),
    );
    db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'completed',?)").run(
      'prepare:' + room + ':' + prepareRequest,
      JSON.stringify(input),
      JSON.stringify(receipt),
    );
    db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'started',NULL)").run(
      'prepare:' + room + ':' + startedRequest,
      JSON.stringify({ ...input, requestId: startedRequest, body: 'unknown outcome caption' }),
    );
  } finally {
    db.close();
  }
  return {
    directory: f.directory,
    desktop,
    project: f.project,
    base: f.base,
    room,
    userData,
    task: inventory.tasks[0]!,
    binding,
    close: () => f.close(),
  };
}
