import {
  ToolError,
  type PreparedTool,
  type ToolExecutorPort,
  type ToolInvocation,
  type ToolDispatchGuard,
} from '@runnets/application';
import { checkedPath, blockedName, type WorkspaceBackend } from './backend.js';
import { TOOL_DEFINITIONS } from './definitions.js';

const MAX_FILE = 131072;
function string(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.includes('\0'))
    throw new ToolError('invalid_arguments', `${key} must be text`);
  return value;
}
function argsOf(call: ToolInvocation): Record<string, unknown> {
  if (call.arguments.length > 262144)
    throw new ToolError('invalid_arguments', 'arguments too large');
  let args: unknown;
  try {
    args = JSON.parse(call.arguments) as unknown;
  } catch {
    throw new ToolError('invalid_arguments', 'arguments must be JSON');
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    throw new ToolError('invalid_arguments', 'arguments must be an object');
  const record = args as Record<string, unknown>;
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === call.name);
  if (schema === undefined) throw new ToolError('unknown_tool', 'tool is not registered');
  const properties = schema.parameters['properties'] as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(key in properties)))
    throw new ToolError('invalid_arguments', 'unexpected argument');
  return record;
}
function lines(content: string, start: unknown, end: unknown): string {
  const from = start ?? 1;
  const to = end ?? Number.MAX_SAFE_INTEGER;
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < from
  )
    throw new ToolError('invalid_arguments', 'invalid line range');
  return content
    .split('\n')
    .slice(from - 1, to)
    .map((line, index) => `${index + from}: ${line}`)
    .join('\n')
    .slice(0, MAX_FILE);
}

/** Prepare immutable operations and reject stale edits after permission is granted. */
export class WorkspaceTools implements ToolExecutorPort {
  readonly definitions = TOOL_DEFINITIONS;
  readonly #backend: WorkspaceBackend;
  readonly #requireContainment: boolean;
  readonly #read = new Map<string, string>();
  constructor(backend: WorkspaceBackend, options: { readonly requireContainment?: boolean } = {}) {
    this.#backend = backend;
    this.#requireContainment = options.requireContainment === true;
  }

  async prepare(
    call: ToolInvocation,
    signal?: AbortSignal,
    guard?: ToolDispatchGuard,
  ): Promise<PreparedTool> {
    const authorize = async (activeSignal = signal, activeGuard = guard) => {
      await activeGuard?.prepare?.();
      if (activeSignal?.aborted || (activeGuard && !activeGuard.authorize()))
        throw new ToolError('coding_denied', 'worktree access refused');
    };
    if (
      this.#requireContainment &&
      (this.#backend.capabilities?.filesystemContainment !== true ||
        this.#backend.capabilities.processContainment !== true ||
        this.#backend.capabilities.confirmedTreeStop !== true)
    )
      throw new ToolError(
        'containment_unavailable',
        'backend cannot enforce requested containment',
      );
    const args = argsOf(call);
    if (call.name === 'run_command') return this.#command(args);
    const path = checkedPath(string(args, 'path'));
    if (call.name === 'list_files')
      return {
        title: `List ${path}`,
        kind: 'search',
        preview: path,
        execute: async (activeSignal, activeGuard = guard) => {
          await authorize(activeSignal, activeGuard);
          const entries = await this.#backend.list(path, activeSignal, activeGuard);
          return {
            isError: false,
            output: entries
              .filter((entry) => !blockedName(entry.name))
              .slice(0, 1000)
              .map((entry) => entry.name + (entry.directory ? '/' : ''))
              .join('\n'),
          };
        },
      };
    await authorize();
    const before = await this.#backend.read(path, signal, guard);
    if (before !== null && Buffer.byteLength(before) > MAX_FILE)
      throw new ToolError('file_too_large', 'file exceeds 128 KiB');
    if (call.name === 'read_file') {
      if (before === null) throw new ToolError('not_found', 'file does not exist');
      const output = lines(before, args['start_line'], args['end_line']);
      return {
        title: `Read ${path}`,
        kind: 'read',
        preview: path,
        execute: async (activeSignal, activeGuard = guard) => {
          await authorize(activeSignal, activeGuard);
          this.#read.set(path, before);
          return Promise.resolve({ isError: false, output });
        },
      };
    }
    if (before !== null && this.#read.get(path) !== before)
      throw new ToolError('stale_read', 'read the current file before editing');
    let after: string;
    if (call.name === 'write_file') after = string(args, 'content');
    else {
      const old = string(args, 'old_text');
      if (before === null || old === '' || before.split(old).length !== 2)
        throw new ToolError('ambiguous_edit', 'old_text must match exactly once');
      after = before.replace(old, () => string(args, 'new_text'));
    }
    if (Buffer.byteLength(after) > MAX_FILE)
      throw new ToolError('file_too_large', 'file exceeds 128 KiB');
    return {
      title: `Edit ${path}`,
      kind: 'edit',
      preview: `--- ${path}\n${before ?? '(new file)'}\n+++ ${path}\n${after}`,
      execute: async (signal, guard) => {
        signal.throwIfAborted();
        await this.#backend.write(path, after, before, signal, guard);
        this.#read.set(path, after);
        return { isError: false, output: `Updated ${path}` };
      },
    };
  }

  #command(args: Record<string, unknown>): PreparedTool {
    const program = string(args, 'program');
    const raw = args['args'];
    if (
      !program ||
      program.length > 1024 ||
      !Array.isArray(raw) ||
      raw.length > 128 ||
      raw.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)
    )
      throw new ToolError('invalid_arguments', 'invalid command arguments');
    const argv = Object.freeze([...(raw as string[])]);
    const cwd = checkedPath(string(args, 'cwd'));
    return {
      title: `Run ${program}`,
      kind: 'execute',
      preview: JSON.stringify({ program, args: argv, cwd }),
      execute: (signal, guard) => this.#backend.command(program, argv, cwd, signal, guard),
    };
  }
}
