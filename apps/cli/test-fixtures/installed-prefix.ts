/**
 * Disposable installed-prefix helpers for installed-tree rehearsals: a private
 * synthetic HOME/XDG layout, the production installer, and JSON calls against
 * the installed CLI. Everything stays under a `/tmp` root owned by the caller.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable no-restricted-imports -- Test-only fixture installing this CLI package's own release archives. */
import { installArchive } from '../src/release/installer.js';
import type { ReleasePackage } from '../src/release/package.js';

export interface Installed {
  readonly prefix: string;
  readonly profile: string;
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Create a private synthetic HOME/XDG layout and an empty install prefix. */
export function privateInstall(root: string, label: string): Installed {
  const base = join(root, label),
    home = join(base, 'home'),
    prefix = join(base, 'local'),
    profile = join(base, 'profile'),
    workspace = join(base, 'workspace');
  for (const directory of [
    home,
    join(home, '.config'),
    join(home, '.local/share'),
    join(home, '.local/state'),
    join(home, '.cache'),
    join(base, 'run'),
    join(base, 'tmp'),
    workspace,
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  return {
    prefix,
    profile,
    workspace,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_RUNTIME_DIR: join(base, 'run'),
      TMPDIR: join(base, 'tmp'),
    },
  };
}

/** Install the release archive under a private umask, like an operator would. */
export function install(target: Installed, release: ReleasePackage): void {
  const previous = process.umask(0o077);
  try {
    installArchive(release.archive, release.sha256, target.prefix);
  } finally {
    process.umask(previous);
  }
}

export function cli(
  target: Installed,
  args: readonly string[],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(join(target.prefix, 'bin/ocean'), args, {
    encoding: 'utf8',
    env: target.env,
    timeout: 120_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function call(
  target: Installed,
  args: readonly string[],
): { code: number | null; reply: Record<string, unknown> } {
  const result = cli(target, [...args, '--profile', target.profile, '--json']);
  return { code: result.code, reply: JSON.parse(result.stdout) as Record<string, unknown> };
}

export function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply['data'] as Record<string, unknown>) ?? {};
}

/** Command payloads are either the data object itself or `{kind, data}`. */
export function payload(reply: Record<string, unknown>): unknown {
  const outer = data(reply);
  return outer['data'] === undefined ? outer : outer['data'];
}
