import { describe, expect, it } from 'vitest';
import { run } from '../../test-fixtures/plugin-command-fixture.js';

describe('ocean plugin access commands', () => {
  it('shows the group visibility explanation in human mode and refuses an unacknowledged grant', async () => {
    const human = await run(
      [
        'access',
        'grant',
        '--connection',
        'conn_work',
        '--room',
        'room_1',
        '--bot',
        'bot_dev',
        '--tool',
        'list_issues',
        '--repository',
        'team/api',
        '--plugin',
        'github',
      ],
      false,
    );
    expect(human.result.code).toBe(4);
    expect(human.stdout).toContain('Everyone in the group chat');
    expect(human.calls.grant).toHaveLength(0);
    const refused = await run([
      'access',
      'grant',
      '--connection',
      'conn_work',
      '--room',
      'room_1',
      '--bot',
      'bot_dev',
      '--tool',
      'list_issues',
      '--repository',
      'team/api',
      '--plugin',
      'github',
    ]);
    expect(refused.result.code).toBe(4);
    expect(JSON.stringify(refused.result.data)).toContain('Everyone in the group chat');
    expect(refused.stderr).toContain('--acknowledge-group-visibility');
    expect(refused.calls.grant).toHaveLength(0);
  });

  it('grants and revokes when the owner acknowledged the explanation', async () => {
    const granted = await run([
      'access',
      'grant',
      '--connection',
      'conn_work',
      '--room',
      'room_1',
      '--bot',
      'bot_dev',
      '--tool',
      'list_issues',
      '--repository',
      'team/api',
      '--plugin',
      'github',
      '--acknowledge-group-visibility',
    ]);
    expect(granted.result.code).toBe(0);
    expect(granted.calls.grant).toHaveLength(1);
    // JSON mode leaves stdout to the single envelope writer: no human preamble.
    expect(granted.stdout).toBe('');
    const revoked = await run(['access', 'revoke', '--grant', 'grant_1']);
    expect(revoked.result.code).toBe(0);
    expect(revoked.calls.revoke).toBe(1);
  });
});
