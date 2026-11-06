import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctl,
  inspect,
} from '../../../packages/integrations-mcp/test-fixtures/native-observation.ts';
export function observeNative(proof: string, profile: string): void {
  const prefix =
    'ocean-mcp-' +
    createHash('sha256')
      .update(JSON.stringify([realpathSync(profile), 'connection']))
      .digest('hex')
      .slice(0, 32) +
    '-';
  const units = ctl('list-units', '--all', '--plain', '--no-legend', '--full', prefix + '*.service')
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => !!name && name.startsWith(prefix));
  assert.equal(units.length, 1);
  const unit = units[0]!;
  const group = ctl('show', unit, '--property=ControlGroup', '--value');
  writeFileSync(
    join(proof, 'native-before.json'),
    JSON.stringify({ unit, ...inspect(group) }, null, 2) + '\n',
  );
}
export function retiredNative(proof: string): void {
  const before = JSON.parse(readFileSync(join(proof, 'native-before.json'), 'utf8')) as {
    cg: string;
    pids: { pid: number; start: string }[];
  };
  const path = '/sys/fs/cgroup' + before.cg;
  const empty =
    !existsSync(path) || /populated 0/.test(readFileSync(path + '/cgroup.events', 'utf8'));
  assert.equal(empty, true);
  for (const { pid, start } of before.pids) {
    let current: string | undefined;
    try {
      current = readFileSync('/proc/' + pid + '/stat', 'utf8')
        .split(') ')
        .at(-1)!
        .split(' ')[19];
    } catch {
      /* Absence is retirement evidence for this recorded PID/start. */
    }
    assert.notEqual(current, start);
  }
  writeFileSync(
    join(proof, 'native-retired.json'),
    JSON.stringify({ group: before.cg, empty, recordedPidsAbsent: true }) + '\n',
  );
}
