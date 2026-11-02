export interface OceanArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly json: boolean;
  readonly bots: readonly string[];
}
const valueFlags = new Set([
  'profile',
  'workspace',
  'handle',
  'name',
  'role',
  'provider',
  'model',
  'bot',
  'text',
  'request-id',
  'after',
  'limit',
  'room',
  'to',
]);
/** Parse once, rejecting ambiguous flags and duplicate options before accessing a profile. */
export function oceanArguments(argv: readonly string[]): OceanArguments {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let json = false;
  const bots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[++i];
      if (
        !valueFlags.has(key) ||
        (key !== 'bot' && flags.has(key)) ||
        value === undefined ||
        value.startsWith('--')
      )
        throw new Error('Invalid or duplicate option');
      flags.set(key, value);
      if (key === 'bot') bots.push(value);
    } else positional.push(token);
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags, json, bots };
}
/** Required options fail before writes or model dispatch. */
export function required(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined || value.trim() === '') throw new Error('Missing --' + key);
  return value;
}
