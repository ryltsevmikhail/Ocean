import * as fs from 'node:fs';
import { posix } from 'node:path';
export interface ManagedMount {
  readonly id: string;
  readonly dev: string;
  readonly root: string;
  readonly point: string;
  readonly type: string;
  readonly options: string;
}
const decode = (s: string) =>
  s.replace(/\\(040|011|012|134)/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
export const within = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : b + '/');
export const overlap = (a: string, b: string) => within(a, b) || within(b, a);
export function managedMounts(): readonly ManagedMount[] {
  const bytes = fs.readFileSync('/proc/self/mountinfo');
  if (bytes.length > 1048576) throw Error('managed mount inventory limit');
  const rows = bytes.toString('utf8').trim().split('\n');
  if (rows.length > 4096) throw Error('managed mount inventory limit');
  const found = new Set<string>();
  return rows.map((line) => {
    const fields = line.split(' '),
      split = fields.indexOf('-');
    if (
      split < 6 ||
      fields.length !== split + 4 ||
      !/^[1-9][0-9]*$/.test(fields[0]!) ||
      !/^[0-9]+:[0-9]+$/.test(fields[2]!) ||
      found.has(fields[0]!)
    )
      throw Error('ambiguous managed mount');
    found.add(fields[0]!);
    const root = decode(fields[3]!),
      point = decode(fields[4]!);
    if (!root.startsWith('/') || !point.startsWith('/') || /[\0\n]/.test(root + point))
      throw Error('invalid managed mount');
    return {
      id: fields[0]!,
      dev: fields[2]!,
      root,
      point,
      type: fields[split + 1]!,
      options: fields[split + 3]!,
    };
  });
}
export function managedMount(fd: number, rows: readonly ManagedMount[]): ManagedMount {
  const id = /^mnt_id:\s+([0-9]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1];
  const found = rows.filter((m) => m.id === id);
  if (found.length !== 1) throw Error('missing managed mount');
  return found[0]!;
}
export function managedCoordinate(mount: ManagedMount, path: string): string {
  if (!within(path, mount.point)) throw Error('invalid managed coordinate');
  return posix.join(mount.root, posix.relative(mount.point, path));
}
export function mountedPath(path: string, rows: readonly ManagedMount[]) {
  const found = rows
    .filter((m) => within(path, m.point))
    .sort((a, b) => b.point.length - a.point.length);
  if (!found[0] || found[0].point === found[1]?.point) throw Error('ambiguous managed topology');
  return { mount: found[0], coordinate: managedCoordinate(found[0], path) };
}
export function managedTopology(m: ManagedMount, root: string, rows: readonly ManagedMount[]) {
  if (rows.some((other) => other.id !== m.id && within(other.point, root)))
    throw Error('nested managed mount');
  // A directory bind presentation must not masquerade as its original filesystem mount.
  if (m.type === 'btrfs') {
    const subvol = m.options
      .split(',')
      .find((s) => s.startsWith('subvol='))
      ?.slice(7);
    if (!subvol || decode(subvol) !== m.root) throw Error('unqualified managed alias');
  } else if (m.root !== '/') throw Error('unqualified managed alias');
  const coordinate = managedCoordinate(m, root);
  if (
    rows.some(
      (other) => other.id !== m.id && other.dev === m.dev && overlap(coordinate, other.root),
    )
  )
    throw Error('aliased managed mount');
  return coordinate;
}
