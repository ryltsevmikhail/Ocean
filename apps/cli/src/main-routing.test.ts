import { afterEach, expect, it, vi } from 'vitest';

const runOceanCommand = vi.fn(async () => 0);
vi.mock('./ocean/command.js', () => ({ runOceanCommand }));
afterEach(() => vi.restoreAllMocks());

it('routes restored-project commands through the public CLI entrypoint', async () => {
  const original = process.argv;
  process.argv = ['node', 'ocean', 'help'];
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const { main } = await import('./main.js');
    const argv = ['rebind', 'inspect', '--config', '/selection.json', '--profile', '/profile'];
    expect(await main(argv)).toBe(0);
    expect(runOceanCommand).toHaveBeenCalledWith(argv);
  } finally {
    process.argv = original;
  }
});
