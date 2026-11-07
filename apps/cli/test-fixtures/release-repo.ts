/**
 * Disposable committed release checkout for packaging/installer process tests.
 *
 * The fixture is a real git repository whose first-party packages, CLI build and
 * documentation are symlinked to this workspace's built output. Packaging then
 * exercises the production code path (pinned identity assertions, rolldown
 * bundling, archive assembly) with real bytes. The synthetic adapter variant is
 * for fast assembly/allowlist tests; the real one is used for bundled-adapter
 * evidence.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Workspace root that owns the built package/CLI output this fixture references. */
export const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const GIT = ['-c', 'user.name=Release Fixture', '-c', 'user.email=release@example.invalid'];

export interface ReleaseRepoTarget {
  /** `real` bundles the built adapter; `synthetic` uses a trivial bundled entry. */
  readonly adapter?: 'real' | 'synthetic';
}

function git(repo: string, ...args: readonly string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd: repo, encoding: 'utf8' });
}

/** Commit everything pending so the archived tree is clean. */
export function commitReleaseRepo(repo: string, message = 'fixture'): void {
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', message);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Create a committed release checkout below `base`. */
export function releaseRepo(base: string, target: ReleaseRepoTarget = {}): string {
  mkdirSync(base, { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'packages'), { recursive: true });
  mkdirSync(join(repo, 'apps'), { recursive: true });
  const adapter = target.adapter ?? 'real';
  for (const name of readdirSync(join(workspace, 'packages'))) {
    const destination = join(repo, 'packages', name);
    if (name !== 'integrations-mcp' || adapter === 'real') {
      symlinkSync(join(workspace, 'packages', name), destination);
      continue;
    }
    const source = join(workspace, 'packages', name);
    const synthetic = join(source, 'package.json');
    mkdirSync(join(destination, 'dist'), { recursive: true });
    writeJson(
      join(destination, 'package.json'),
      JSON.parse(readFileSync(synthetic, 'utf8')) as Record<string, unknown>,
    );
    writeFileSync(
      join(destination, 'dist/index.js'),
      [
        "export * from '@modelcontextprotocol/client';",
        "export * from '@modelcontextprotocol/client/stdio';",
        'export const fixtureAdapter = true;',
        '',
      ].join('\n'),
    );
    mkdirSync(join(destination, 'THIRD_PARTY_LICENSES'));
    copyFileSync(
      join(source, 'THIRD_PARTY_LICENSES/modelcontextprotocol-client-LICENSE'),
      join(destination, 'THIRD_PARTY_LICENSES/modelcontextprotocol-client-LICENSE'),
    );
    // Real pinned public SDK identities resolve through this link.
    symlinkSync(join(source, 'node_modules'), join(destination, 'node_modules'));
  }
  symlinkSync(join(workspace, 'apps', 'cli'), join(repo, 'apps', 'cli'));
  symlinkSync(join(workspace, 'docs'), join(repo, 'docs'));
  // The pinned bundler and repository tooling stay build-time-only inputs.
  symlinkSync(join(workspace, 'node_modules'), join(repo, 'node_modules'));
  for (const name of ['LICENSE', 'NOTICE', 'README.md', 'pnpm-lock.yaml'])
    copyFileSync(join(workspace, name), join(repo, name));
  git(repo, 'init', '-q');
  commitReleaseRepo(repo);
  return repo;
}

/** Add a first-party package directory (for dependency-allowlist probes). */
export function addReleaseRepoPackage(
  repo: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>> = {},
): void {
  const directory = join(repo, 'packages', name);
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeJson(join(directory, 'package.json'), manifest);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(directory, path), body);
}
