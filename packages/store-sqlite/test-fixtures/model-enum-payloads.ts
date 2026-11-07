import { unconfiguredModelConnection } from '@runnets/application';

/** Keep legacy eligibility false so identity checks cannot mask malformed kind/auth enums. */
export const modelEnumRecord = {
  ...unconfiguredModelConnection('deepseek'),
  intent: 'active' as const,
  revision: 1,
  legacyEnvironment: false,
};
const fields = [
  { field: 'kind', allowed: ['cloud', 'local'] },
  { field: 'auth', allowed: ['api_key', 'none'] },
  { field: 'intent', allowed: ['unconfigured', 'active', 'disconnected', 'pending'] },
  { field: 'pendingSecretChange.action', allowed: ['replace', 'remove'] },
];
export const malformedModelEnums = fields.flatMap(({ field, allowed }) =>
  [
    ...allowed.map((value) => [value]),
    [[allowed[0]]],
    null,
    false,
    true,
    7,
    {},
    [],
    '',
    'invalid',
  ].map((value) => ({
    label: `${field}=${JSON.stringify(value)}`,
    payload: JSON.stringify({
      ...modelEnumRecord,
      ...(field === 'pendingSecretChange.action'
        ? { pendingSecretChange: { action: value, previousRef: null, nextRef: 'fixture-ref' } }
        : { [field]: value }),
    }),
  })),
);
