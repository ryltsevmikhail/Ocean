export interface OceanArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly json: boolean;
  readonly staticDoctor?: boolean;
  readonly textOnly: boolean;
  readonly bots: readonly string[];
  readonly attachments: readonly string[];
  readonly tools: readonly string[];
  /** Explicit owner acknowledgement of the group-visibility explanation. */
  readonly groupVisibilityAcknowledged: boolean;
  /** Explicit owner acknowledgement after the discovery endpoint was shown. */
  readonly endpointAcknowledged: boolean;
}
const valueFlags = new Set([
  'profile',
  'config',
  'changeset',
  'review-request',
  'project',
  'dev',
  'review',
  'review-room',
  'task-id',
  'task',
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
  'from',
  'reason',
  'accept',
  'review-version',
  'batch',
  'revision',
  'attachment',
  'plugin',
  'connection',
  'connection-id',
  'credential-ref',
  'credential-env',
  'account',
  'repo',
  'repository',
  'tool',
  'grant',
  'generation',
  'search',
  'version',
]);
/** Parse once, rejecting ambiguous flags and duplicate options before accessing a profile. */
export function oceanArguments(argv: readonly string[]): OceanArguments {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let json = false;
  let textOnly = false,
    staticDoctor = false,
    groupVisibilityAcknowledged = false,
    endpointAcknowledged = false;
  const bots: string[] = [];
  const attachments: string[] = [];
  const tools: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--static') {
      if (staticDoctor) throw Error('invalid_input');
      staticDoctor = true;
      continue;
    }
    if (token === '--text-only') {
      textOnly = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--acknowledge-group-visibility') {
      if (groupVisibilityAcknowledged) throw Error('invalid_input');
      groupVisibilityAcknowledged = true;
      continue;
    }
    if (token === '--acknowledge-endpoint') {
      if (endpointAcknowledged) throw Error('invalid_input');
      endpointAcknowledged = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[++i];
      if (
        !valueFlags.has(key) ||
        (!['bot', 'attachment', 'tool'].includes(key) && flags.has(key)) ||
        value === undefined ||
        value.startsWith('--')
      )
        throw new Error('Invalid or duplicate option');
      flags.set(key, value);
      if (key === 'bot') bots.push(value);
      if (key === 'attachment') attachments.push(value);
      if (key === 'tool') tools.push(value);
    } else positional.push(token);
  }
  if (flags.has('task') && !['send', 'tui'].includes(positional[0] ?? ''))
    throw new Error('--task requires send or tui');
  if (flags.has('task') && flags.get('task')!.trim() === '') throw new Error('Missing --task');
  if (staticDoctor && positional[0] !== 'doctor') throw Error('invalid_input');
  return {
    ...(staticDoctor ? { staticDoctor: true } : {}),
    command: positional[0] ?? '',
    positional: positional.slice(1),
    flags,
    json,
    bots,
    attachments,
    tools,
    textOnly,
    groupVisibilityAcknowledged,
    endpointAcknowledged,
  };
}
/** Required options fail before writes or model dispatch. */
export function required(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined || value.trim() === '') throw new Error('Missing --' + key);
  return value;
}
