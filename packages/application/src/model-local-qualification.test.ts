import { expect, it } from 'vitest';
import {
  copyLocalQualification,
  modelConnectionRecord,
  unconfiguredModelConnection,
} from '@runnets/application';

function qualification(usage: unknown) {
  return {
    modelId: 'qwen3:1.7b',
    artifactDigest: 'a'.repeat(64),
    backendVersion: 'fixture-qualification',
    configuredContextTokens: 4096,
    capabilities: {
      tools: true,
      streaming: true,
      inputModalities: ['text'],
      contextTokens: 4096,
      maxOutputTokens: null,
      usage,
    },
  };
}
function connection(localQualification: unknown) {
  return {
    ...unconfiguredModelConnection('ollama'),
    connectionId: 'local',
    kind: 'local',
    auth: 'none',
    endpoint: 'http://127.0.0.1:11434',
    defaultModelId: 'qwen3:1.7b',
    intent: 'active',
    revision: 1,
    localQualification,
  };
}

const invalidUsages: readonly { readonly label: string; readonly usage: unknown }[] = [
  { label: 'custom string conversion', usage: { toString: () => 'optional' } },
  { label: 'primitive conversion', usage: { [Symbol.toPrimitive]: () => 'reported' } },
  { label: 'nested array', usage: [['unavailable']] },
  { label: 'boolean', usage: true },
  { label: 'number', usage: 0 },
  { label: 'null', usage: null },
  { label: 'missing', usage: undefined },
  { label: 'unknown string', usage: 'estimated' },
];

for (const boundary of [
  { label: 'copyLocalQualification', read: copyLocalQualification },
  {
    label: 'modelConnectionRecord',
    read: (value: unknown) => modelConnectionRecord(connection(value)),
  },
]) {
  it.each(['reported', 'optional', 'unavailable'])(
    `${boundary.label} rejects JSON array usage [%s]`,
    (usage) => {
      const input: unknown = JSON.parse(JSON.stringify(qualification([usage])));
      expect(() => boundary.read(input)).toThrow('connection_unverified');
    },
  );
  it.each(invalidUsages)(`${boundary.label} refuses $label without coercion`, ({ usage }) => {
    expect(() => boundary.read(qualification(usage))).toThrow('connection_unverified');
  });
}

it.each(['reported', 'optional', 'unavailable'] as const)(
  'retains valid scalar %s in detached qualification and record copies',
  (usage) => {
    const input = qualification(usage);
    const copied = copyLocalQualification(input);
    const row = modelConnectionRecord(connection(input));
    expect(copied.capabilities.usage).toBe(usage);
    expect(row.localQualification?.capabilities.usage).toBe(usage);
    expect(copied).not.toBe(input);
    expect(copied.capabilities).not.toBe(input.capabilities);
    expect(copied.capabilities.inputModalities).not.toBe(input.capabilities.inputModalities);
    expect(row.localQualification).not.toBe(input);
    expect(row.localQualification?.capabilities).not.toBe(copied.capabilities);
    input.capabilities.usage = ['optional'];
    input.capabilities.tools = false;
    input.capabilities.inputModalities.push('image');
    expect(copied.capabilities).toMatchObject({ tools: true, inputModalities: ['text'], usage });
    expect(row.localQualification?.capabilities).toMatchObject({
      tools: true,
      inputModalities: ['text'],
      usage,
    });
    Object.assign(copied.capabilities, { tools: false, usage: 'reported' });
    expect(row.localQualification?.capabilities).toMatchObject({ tools: true, usage });
    expect(input.capabilities.usage).toEqual(['optional']);
  },
);
