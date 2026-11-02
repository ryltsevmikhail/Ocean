import { ToolError, type ToolResult } from '@runnets/application';

export interface FileEntry {
  readonly name: string;
  readonly directory: boolean;
}
/** I/O seam used by deterministic tests and the native Node implementation. */
export interface WorkspaceBackend {
  /** Claims must describe enforced isolation, never lexical path filtering alone. */
  readonly capabilities?: {
    readonly filesystemContainment: boolean;
    readonly processContainment: boolean;
    readonly confirmedTreeStop: boolean;
  };
  read(path: string): Promise<string | null>;
  list(path: string): Promise<readonly FileEntry[]>;
  write(path: string, content: string, expected: string | null): Promise<void>;
  command(
    program: string,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}

/** Lexical validation is followed by native canonical-path validation at every I/O. */
export function checkedPath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\0') ||
    path.length > 1024
  ) {
    throw new ToolError('path_denied', 'use a project-relative path');
  }
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..' || blockedName(part))) {
    throw new ToolError('path_denied', 'path is outside the project or protected');
  }
  return parts.join('/') || '.';
}

/** Do not expose repository internals, credential files or dependency trees as model context. */
export function blockedName(name: string): boolean {
  return (
    ['.git', 'node_modules', '.ssh', '.aws', '.config', '.npmrc', '.netrc', '.DS_Store'].includes(
      name,
    ) ||
    /^\.env(?:\.|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx)$/i.test(name) ||
    /^id_(?:rsa|ed25519)/.test(name)
  );
}
