import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectDatabase } from '@runnets/store-sqlite';
import { CLI_VERSION } from '../version.js';
import { absolutePath, assertProfileFiles, privatePath } from './private-files.js';
import { backupProfile, restoreProfile } from './snapshots.js';
import { profileDirectory } from './profile.js';
import { required, type OceanArguments } from './arguments.js';
export async function runOperations(
  args: OceanArguments,
): Promise<{ data: unknown; code: number }> {
  if (process.env['RUNNE_DB'] !== undefined || process.env['RUNNE_MODE'] !== undefined)
    throw new Error('invalid_input');
  const profile = profileDirectory(args.flags.get('profile'));
  if (args.positional.length !== 0) throw new Error('invalid_input');
  if (args.command === 'doctor') {
    const permissions =
      privatePath(profile, true) &&
      ['runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm', 'restore-guard.json'].every(
        (name) => !existsSync(join(profile, name)) || privatePath(join(profile, name), false),
      );
    const database = args.staticDoctor
      ? { status: 'not_inspected' }
      : permissions
        ? inspectDatabase(join(profile, 'runtime.sqlite'))
        : { status: 'unavailable' };
    let lastBackup: unknown = null;
    if (permissions && privatePath(join(profile, 'last-backup.json'), false)) {
      try {
        const raw = JSON.parse(readFileSync(join(profile, 'last-backup.json'), 'utf8')) as {
          createdAt?: unknown;
        };
        if (typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)))
          lastBackup = raw.createdAt;
      } catch {
        /* Unknown is safer than a repair. */
      }
    }
    let restorationState: 'ready' | 'incomplete' | null = null;
    if (existsSync(join(profile, 'restore-guard.json'))) {
      restorationState = 'incomplete';
      if (permissions) {
        try {
          const marker = JSON.parse(readFileSync(join(profile, 'restore-guard.json'), 'utf8')) as {
            state?: unknown;
          };
          if (marker.state === 'ready') restorationState = 'ready';
        } catch {
          /* Incomplete remains unavailable for execution. */
        }
      }
    }
    const platform = process.platform === 'linux' && process.arch === 'x64';
    const node = process.versions.node.split('.')[0] === '26';
    return {
      code:
        permissions &&
        (database.status === 'ok' || database.status === 'not_inspected') &&
        platform &&
        node &&
        restorationState !== 'incomplete'
          ? 0
          : 3,
      data: {
        cli: CLI_VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        qualifiedPlatform: platform,
        requiredNodeMajor: 26,
        nodeSupported: node,
        permissions,
        database,
        restorationState,
        restored: existsSync(join(profile, 'restore-guard.json')),
        providerKeyPresent: Boolean(process.env['DEEPSEEK_API_KEY']?.trim()),
        lastBackup,
        lastError: 'unavailable',
      },
    };
  }
  if (args.command === 'backup') {
    assertProfileFiles(profile);
    return {
      code: 0,
      data: await backupProfile(profile, absolutePath(required(args.flags, 'to'))),
    };
  }
  if (args.command === 'restore')
    return { code: 0, data: restoreProfile(absolutePath(required(args.flags, 'from')), profile) };
  throw new Error('invalid_input');
}
