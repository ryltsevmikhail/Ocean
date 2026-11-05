// Isolated process; no raw replies, errors or headers leave it.
import { constants, openSync, fstatSync, readFileSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServiceTransport } from '@runnets/integrations-mcp';
import { connection, admission } from './admission.ts';
const path = '/home/ryltsevmg/.config/ocean-rc/github-qualification.token';
const dir = join(process.argv[2]!, 'live');
mkdirSync(dir);
const c = connection(
  { kind: 'http', url: 'https://api.githubcopilot.com/mcp/' },
  'env:APPROVED_GITHUB_PAT',
);
let attempts = 0,
  stage = 'approved token file',
  code;
const t = createMcpServiceTransport({
  protocol: 'legacy',
  githubIssueReadOnly: true,
  resolveCredential: (ref) => {
    if (ref !== c.credentialReference) throw Error('wrong reference');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.uid !== process.getuid!() ||
        (st.mode & 0o777) !== 0o600 ||
        st.size < 1 ||
        st.size > 4096
      )
        throw Error('unsafe file');
      const token = readFileSync(fd, 'utf8').trim();
      if (!token) throw Error('empty file');
      stage = 'discovery';
      return token;
    } finally {
      closeSync(fd);
    }
  },
  prepareDispatch: () => {
    if (++attempts !== 1) throw Error('unexpected send');
  },
});
const a = admission(join(dir, 'database'), c, t, 8000);
let result: Record<string, unknown> = {};
try {
  const candidate = await t.discover(c, {
    signal: new AbortController().signal,
    deadlineMs: 12000,
    authorizeMetadata: () => a.metadata(c),
  });
  const snap = { ...candidate, id: 'issue_read_only' };
  if (!a.publish(snap) || !t.activate(candidate, snap, () => a.current(snap)))
    throw Error('publication failed');
  stage = 'fixed issue read';
  a.grant(['issue_read']);
  const r = await a.call(
    snap.id,
    'issue_read',
    { method: 'get', owner: 'ryltsevmikhail', repo: 'Ocean', issue_number: 5 },
    'only_read',
  );
  code = r.code;
  if (r.outcome?.code !== 'ok') throw Error('no observed issue');
  const reply = r.outcome.result as {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
  };
  const text = reply.content?.find((x) => x.type === 'text');
  const item = text ? (JSON.parse(text.text) as unknown) : reply.structuredContent;
  if (
    !item ||
    typeof item !== 'object' ||
    !('number' in item) ||
    !('state' in item) ||
    item.number !== 5 ||
    !['open', 'closed'].includes(String(item.state)) ||
    attempts !== 1
  )
    throw Error('no verified issue response');
  result = {
    status: 'qualified',
    repository: 'ryltsevmikhail/Ocean',
    issue: 5,
    state: item.state,
    protocol: snap.provenance['protocol'],
    account: 'unverified',
    attempts,
  };
} catch {
  result = { status: 'unqualified', stage, code, attempts };
} finally {
  a.store.close();
  result['cleanup'] = await t.close();
}
console.log(JSON.stringify(result));
process.exitCode = result['status'] === 'qualified' ? 0 : 1;
