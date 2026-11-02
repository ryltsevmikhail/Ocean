import { commands, pageSize } from '../protocol.js';

// Only the native host supplies these paths. No dispatch by renderer-supplied method or argv.
export function cliArguments(raw: unknown, profile: string, workspace: string): string[] {
  const c = commands.parse(raw);
  const common = ['--json', '--profile', profile];
  if ('requestId' in c) common.push('--request-id', c.requestId);
  switch (c.op) {
    case 'init':
      return ['init', '--workspace', workspace, ...common];
    case 'doctor':
      return ['doctor', ...common];
    case 'bots':
      return ['bot', 'list', ...common];
    case 'rooms':
      return ['room', 'list', ...common];
    case 'runs':
      return ['run', 'list', ...common];
    case 'history':
      return [
        'history',
        c.room,
        '--after',
        String(c.after),
        '--limit',
        String(pageSize),
        ...common,
      ];
    case 'bot':
      return [
        'bot',
        'add',
        '--handle',
        c.handle,
        '--name',
        c.name,
        '--role',
        c.role,
        '--model',
        c.model,
        ...common,
      ];
    case 'direct':
      return ['room', 'direct', '--bot', c.bot, ...common];
    case 'group':
      return [
        'room',
        'group',
        '--name',
        c.title,
        ...c.bots.flatMap((id) => ['--bot', id]),
        ...common,
      ];
    case 'send':
      if (c.to === null && /^\s*@/.test(c.text)) throw new Error('choose_recipient');
      return [
        'send',
        c.room,
        '--text',
        c.text,
        ...(c.to === null ? [] : ['--to', c.to]),
        ...common,
      ];
  }
}
