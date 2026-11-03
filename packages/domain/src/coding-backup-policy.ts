import type { CodingPolicy, CodingTestPreset } from './coding-policy.js';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
export function validCodingBackupPresets(value: unknown): value is readonly CodingTestPreset[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    new Set(value.map((p) => record(p) && p['id'])).size === value.length &&
    value.every(
      (p) =>
        record(p) &&
        Object.keys(p).every((k) => ['id', 'program', 'args', 'cwd'].includes(k)) &&
        text(p['id'], 4096) &&
        p['id'].length > 0 &&
        text(p['program'], 4096) &&
        p['program'].startsWith('/') &&
        p['cwd'] === '.' &&
        Array.isArray(p['args']) &&
        p['args'].length <= 128 &&
        p['args'].every((a) => text(a, 8192)),
    )
  );
}
/** Strict bounded frozen evidence; it never authorizes capabilities. */
export function validCodingBackupPolicy(version: unknown, value: unknown): value is CodingPolicy {
  const capabilities = ['project_read', 'propose_write', 'run_test_preset', 'changeset_read'];
  return (
    version === 1 &&
    record(value) &&
    value['version'] === 1 &&
    Object.keys(value).every((k) =>
      ['version', 'devCapabilities', 'reviewCapabilities', 'testPresets'].includes(k),
    ) &&
    Array.isArray(value['devCapabilities']) &&
    value['devCapabilities'].length <= 4 &&
    value['devCapabilities'].every((c) => typeof c === 'string' && capabilities.includes(c)) &&
    new Set(value['devCapabilities']).size === value['devCapabilities'].length &&
    JSON.stringify(value['reviewCapabilities']) === '["changeset_read"]' &&
    validCodingBackupPresets(value['testPresets'])
  );
}
