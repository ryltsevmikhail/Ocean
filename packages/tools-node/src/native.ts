import { constants } from 'node:fs';
import { lstat, realpath, open, readdir, rename, unlink, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from '@runnets/application';
import { blockedName, checkedPath, type WorkspaceBackend } from './backend.js';
import { runCommand } from './process.js';

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Canonical project root plus a no-symlink policy for every selected path component. */
export async function createNativeBackend(workspace: string): Promise<WorkspaceBackend> {
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory())
    throw new ToolError('workspace', 'workspace must be a directory');
  async function pathOf(input: string, allowMissing = false): Promise<string> {
    const relative = checkedPath(input);
    let current = root;
    const parts = relative === '.' ? [] : relative.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new ToolError('path_denied', 'symbolic links are not allowed');
        if (index < parts.length - 1 && !stat.isDirectory())
          throw new ToolError('path_denied', 'parent is not a directory');
      } catch (error) {
        if (allowMissing && index === parts.length - 1 && missing(error)) return current;
        throw error;
      }
    }
    return current;
  }
  async function read(input: string): Promise<string | null> {
    let path: string;
    try {
      path = await pathOf(input);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1)
      throw new ToolError('path_denied', 'only regular single-link files are allowed');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ToolError('path_denied', 'only regular single-link files are allowed');
      if (stat.size > 131072) throw new ToolError('file_too_large', 'file exceeds 128 KiB');
      const buffer = Buffer.alloc(131073);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 131072) throw new ToolError('file_too_large', 'file exceeds 128 KiB');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      if (text.includes('\0')) throw new ToolError('binary_file', 'file is not text');
      return text;
    } finally {
      await file.close();
    }
  }
  return {
    capabilities: {
      filesystemContainment: false,
      processContainment: false,
      confirmedTreeStop: false,
    },
    read,
    async list(input) {
      const entries = await readdir(await pathOf(input), { withFileTypes: true });
      return entries
        .filter((entry) => !blockedName(entry.name) && !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async write(input, content, expected) {
      if ((await read(input)) !== expected)
        throw new ToolError('stale_read', 'file changed while awaiting approval');
      const path = await pathOf(input, true);
      const temp = join(dirname(path), `.runne-${randomUUID()}.tmp`);
      const original = expected === null ? null : await lstat(path);
      const file = await open(temp, 'wx', original === null ? 0o600 : original.mode & 0o777);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
        await file.close();
        if ((await read(input)) !== expected)
          throw new ToolError('stale_read', 'file changed before commit');
        if (expected === null) await link(temp, path);
        else await rename(temp, path);
      } finally {
        await file.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
    },
    async command(program, args, cwd, signal) {
      return runCommand(program, args, await pathOf(cwd), signal);
    },
  };
}
