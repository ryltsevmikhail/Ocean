import { describe, expect, it } from 'vitest';
import { WorkspaceTools } from './executor.js';
import { checkedPath, type WorkspaceBackend } from './backend.js';

function fixture() {
  const files = new Map([['a.ts', 'const a = 1;']]);
  const backend: WorkspaceBackend = {
    read: (path) => Promise.resolve(files.get(path) ?? null),
    list: () =>
      Promise.resolve([
        { name: 'a.ts', directory: false },
        { name: '.env', directory: false },
      ]),
    write: (path, content, expected) => {
      if ((files.get(path) ?? null) !== expected) return Promise.reject(new Error('stale'));
      files.set(path, content);
      return Promise.resolve();
    },
    command: () => Promise.resolve({ output: 'test passed', isError: false }),
  };
  const tools = new WorkspaceTools(backend);
  const call = (name: string, args: unknown) =>
    tools.prepare({ id: 'a', name, arguments: JSON.stringify(args) });
  return { files, tools, call };
}
const signal = new AbortController().signal;

describe('workspace tools', () => {
  it.each([
    '../secret',
    '/etc/passwd',
    '.git/config',
    '.env.local',
    'src/../../x',
    'a.pem',
    '.ssh/id_ed25519',
  ])('rejects protected path %s', (path) => {
    expect(() => checkedPath(path)).toThrow();
  });
  it('reads numbered lines and permits a unique replacement after a read', async () => {
    const { call, files } = fixture();
    await expect(
      call('replace_text', { path: 'a.ts', old_text: '1', new_text: '2' }),
    ).rejects.toThrow('read');
    const read = await call('read_file', { path: 'a.ts' });
    expect((await read.execute(signal)).output).toBe('1: const a = 1;');
    const edit = await call('replace_text', { path: 'a.ts', old_text: '1', new_text: '2' });
    expect(files.get('a.ts')).toBe('const a = 1;');
    expect(edit.preview).toContain('const a = 2;');
    await edit.execute(signal);
    expect(files.get('a.ts')).toBe('const a = 2;');
  });
  it('rejects ambiguous replacements and changes that arrived while awaiting approval', async () => {
    const { call, files } = fixture();
    await (await call('read_file', { path: 'a.ts' })).execute(signal);
    await expect(
      call('replace_text', { path: 'a.ts', old_text: 'missing', new_text: '2' }),
    ).rejects.toThrow('exactly once');
    const edit = await call('write_file', { path: 'a.ts', content: 'new' });
    files.set('a.ts', 'user edit');
    await expect(edit.execute(signal)).rejects.toThrow('stale');
    expect(files.get('a.ts')).toBe('user edit');
  });
  it('filters secrets from directory listings', async () => {
    const { call } = fixture();
    expect((await (await call('list_files', { path: '.' })).execute(signal)).output).toBe('a.ts');
  });
  it('rejects unknown tools, malformed arguments, extra fields and invalid ranges', async () => {
    const { call, tools } = fixture();
    await expect(call('unknown', {})).rejects.toThrow('registered');
    await expect(tools.prepare({ id: 'a', name: 'read_file', arguments: '{' })).rejects.toThrow(
      'JSON',
    );
    await expect(call('read_file', { path: 'a.ts', bypass: true })).rejects.toThrow('unexpected');
    await expect(call('read_file', { path: 'a.ts', start_line: -1 })).rejects.toThrow('range');
  });
  it('prepares commands with an exact argument preview and supports cancellation', async () => {
    const { call } = fixture();
    const tool = await call('run_command', { program: 'node', args: ['--version'], cwd: '.' });
    expect(tool.kind).toBe('execute');
    expect(tool.preview).toContain('--version');
    const controller = new AbortController();
    controller.abort();
    const edit = await call('write_file', { path: 'new.ts', content: 'new' });
    await expect(edit.execute(controller.signal)).rejects.toThrow();
  });
});

it('fails closed when requested containment has no backend guarantee', async () => {
  const backend: WorkspaceBackend = {
    read: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    write: () => Promise.resolve(),
    command: () => Promise.resolve({ isError: false, output: 'unexpected' }),
  };
  const tools = new WorkspaceTools(backend, { requireContainment: true });
  await expect(
    tools.prepare({ id: 'a', name: 'read_file', arguments: '{"path":"a"}' }),
  ).rejects.toThrow('containment');
});
