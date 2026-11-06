import { canonicalJson } from '@runnets/domain';
import { serviceConnection, ownerGrant } from './service-authority.js';
export const serviceOwnerFieldCases = [
  ['alpha\tbeta', true],
  ['alpha\x01beta', true],
  ['é'.repeat(64), true],
  ['é'.repeat(65), false],
  ['alpha\0beta', false],
  ['alpha\ud800beta', false],
] as const;
/** Legacy authority-v2 counted only item characters; each valid fixture is exactly4000. */
export function legacyServiceOwnerMetadata() {
  function pad(record: unknown, names: string[]) {
    for (let n = 0; canonicalJson(record).length < 4000; n++) {
      const gap = 4000 - canonicalJson(record).length;
      if (gap <= 5 && names.length > 0) {
        names[names.length - 1] += 'x'.repeat(gap);
        break;
      }
      names.push(String(n).padStart(Math.min(120, gap - (names.length ? 3 : 2)), 'x'));
    }
    return record;
  }
  const connections = Array.from({ length: 100 }, (_, n) => {
    const record = { ...serviceConnection, id: String(n).padStart(3, '0'), tools: [] as string[] };
    pad(record, record.tools);
    return record;
  });
  const grants = Array.from({ length: 100 }, (_, n) => {
    const names: string[] = [],
      record = {
        ...ownerGrant,
        id: String(n).padStart(3, '0'),
        permissions: [
          {
            kind: 'service' as const,
            connectionId: 'third',
            trustRevision: 1,
            tools: { kind: 'exact' as const, names },
            resources: [{ kind: 'connection' as const, connectionId: 'third' }],
          },
        ],
      };
    pad(record, names);
    return record;
  });
  return { connections, grants };
}
