import { readFileSync, statSync } from 'node:fs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A PID has meaning only in this boot and PID namespace. Unknown evidence stays held. */
function namespace(): string {
  if (process.platform !== 'linux') throw Error('ownership_verification_unavailable');
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const ns = statSync('/proc/self/ns/pid', { bigint: true });
  if (!uuid.test(boot)) throw Error('ownership_verification_unavailable');
  return `linux-owner-v2:${boot}:${ns.dev}:${ns.ino}:`;
}
export function ownerEvidence(id: string): string {
  if (!uuid.test(id)) throw Error('ownership_verification_unavailable');
  return namespace() + id;
}
export function verifiedOwnerDead(
  row: Record<string, unknown>,
  isAlive: (pid: number) => boolean,
): boolean {
  const pid = row['pid'],
    owner = row['owner'];
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof owner !== 'string'
  )
    return false;
  try {
    const prefix = namespace();
    return owner.startsWith(prefix) && uuid.test(owner.slice(prefix.length)) && !isAlive(pid);
  } catch {
    return false;
  }
}
