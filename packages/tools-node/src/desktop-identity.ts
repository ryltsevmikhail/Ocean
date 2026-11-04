import type { DesktopBinding } from '@runnets/domain';
/** Portable shape only. Archived bindings never cause an original source path to be opened. */
const integer = '(?:0|[1-9][0-9]{0,19})';
const legacy = /^\d+(?::\d+){5}$/;
const durable = new RegExp(
  '^linux-btrfs-v1:([a-f0-9]{32}):([a-f0-9]{32}):(' +
    integer +
    '):([0-9]{1,10}):((?:[a-f0-9]{2}){1,128}):(' +
    integer +
    '):(' +
    integer +
    '):(' +
    integer +
    ')$',
);
export function desktopIdentityMode(identity: unknown): 'legacy-exact' | 'linux-btrfs-v1' | null {
  if (typeof identity !== 'string' || identity.length > 512) return null;
  if (legacy.test(identity)) return 'legacy-exact';
  const value = durable.exec(identity);
  if (!value || value[1] === '0'.repeat(32) || value[2] === '0'.repeat(32)) return null;
  if (
    BigInt(value[3]!) < 1n ||
    BigInt(value[3]!) > 18446744073709551615n ||
    Number(value[4]) > 2147483647
  )
    return null;
  if ([value[6], value[7]].some((n) => Number(n) > 4294967295) || Number(value[8]) !== 16832)
    return null;
  return 'linux-btrfs-v1';
}

export function validDesktopBindingShape(value: unknown): value is DesktopBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as DesktopBinding;
  return (
    Object.keys(binding).sort().join() === 'identity,originalRoot,profileId,root' &&
    typeof binding.profileId === 'string' &&
    /^[a-f0-9]{64}$/.test(binding.profileId) &&
    desktopIdentityMode(binding.identity) !== null &&
    [binding.root, binding.originalRoot].every(
      (p) =>
        typeof p === 'string' &&
        p.length <= 4096 &&
        p.startsWith('/') &&
        !p.includes('\0') &&
        !p.split('/').some((part) => part === '.' || part === '..'),
    )
  );
}
