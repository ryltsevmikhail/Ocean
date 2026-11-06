import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { desktopImageResolver } from '@runnets/tools-node';
import { assertProfileFiles } from './private-files.js';
import { createRuntime, type Runtime, type RuntimeOptions } from '../runtime.js';

/** Open one explicitly persistent profile. Model credentials are never written to it. */
export function openOceanProfile(
  profile: string | undefined,
  initialize = false,
  options: Pick<
    RuntimeOptions,
    | 'serviceConfirmation'
    | 'serviceTransportOptions'
    | 'codingTools'
    | 'requireUnpublished'
    | 'imageResolver'
    | 'pluginTransport'
    | 'pluginEnv'
    | 'pluginMutationsAllowed'
  > = {},
): Runtime {
  if (process.env['RUNNE_DB'] !== undefined || process.env['RUNNE_MODE'] !== undefined)
    throw new Error('Select Ocean --profile without RUNNE_DB or RUNNE_MODE');
  const directory = profileDirectory(profile);
  const path = join(directory, 'runtime.sqlite');
  if (!initialize && !existsSync(path))
    throw new Error('Profile not initialized; run ocean init --workspace');
  if (initialize) mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertProfileFiles(directory);
  if (initialize && !existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
  // Every durable profile host (runtime, CLI/TUI fallback) composes the same
  // runtime image authority; offline sends must not lose attachment history.
  const canonical = resolve(directory);
  const profileId = createHash('sha256').update(canonical).digest('hex');
  return createRuntime({
    ...options,
    imageResolver:
      options.imageResolver ?? ((store) => desktopImageResolver(store, canonical, profileId)),
    mode: 'durable',
    dbPath: path,
    restoredAccess: true,
  });
}
/** The host verifies a real directory before binding its canonical root to the profile. */
export function canonicalWorkspace(path: string): string {
  const root = realpathSync(resolve(path));
  if (!statSync(root).isDirectory()) throw new Error('Workspace must be a directory');
  return root;
}

export function profileDirectory(profile?: string): string {
  const directory =
    profile ?? join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'ocean');
  if (!isAbsolute(directory)) throw new Error('invalid_input');
  return directory;
}
