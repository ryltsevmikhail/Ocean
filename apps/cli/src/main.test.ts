import { afterEach, expect, it, vi } from 'vitest';

const runTui = vi.fn(async () => 0);
vi.mock('./tui/run.js', () => ({ runTui }));
afterEach(() => vi.restoreAllMocks());

it('opens TUI without a workspace override when invoked without arguments', async () => {
  const original = process.argv;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  process.argv = ['node', 'runne', 'help'];
  try {
    const { main } = await import('./main.js');
    runTui.mockClear();
    expect(await main([])).toBe(0);
    expect(runTui).toHaveBeenCalledWith({ workspace: undefined });
    write.mockClear();
    expect(await main(['--help'])).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(runTui).toHaveBeenCalledTimes(1);
  } finally {
    process.argv = original;
  }
});
