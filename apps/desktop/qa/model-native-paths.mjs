import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
export const defaultQualificationParent = resolve(
  import.meta.dirname,
  '../../../../Ocean-artifacts',
);
export const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const digest = (data) => createHash('sha256').update(data).digest('hex');
export function directory(root) {
  mkdirSync(root, { mode: 0o700 });
  return root;
}
export function verified(path) {
  assert.equal(realpathSync(path), path, 'explicit absolute canonical input required');
  return path;
}
export function fresh(root, qualificationParent) {
  assert.equal(resolve(root), root);
  verified(qualificationParent);
  assert.equal(
    dirname(root),
    qualificationParent,
    'proof root must be a fresh direct child of the qualification parent',
  );
  const parent = lstatSync(qualificationParent);
  assert.ok(
    parent.isDirectory() && parent.uid === process.getuid() && !(parent.mode & 0o022),
    'untrusted qualification parent',
  );
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    assert.ok(
      !['.git', 'artifact-proof.json', 'desktop-artifact.json', 'identity.json', 'seal.json'].some(
        (name) => existsSync(join(dir, name)),
      ),
      'cannot write inside checkout or previous evidence',
    );
    const s = lstatSync(dir);
    assert.ok(
      [0, process.getuid()].includes(s.uid) && (!(s.mode & 0o022) || s.mode & 0o1000),
      'untrusted output ancestor',
    );
    if (dir === '/') break;
  }
  const fd = openSync(
    qualificationParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const pinned = fstatSync(fd);
    assert.ok(
      pinned.dev === parent.dev &&
        pinned.ino === parent.ino &&
        pinned.uid === process.getuid() &&
        !(pinned.mode & 0o022),
      'qualification parent changed',
    );
    directory(root);
  } finally {
    closeSync(fd);
  }
}
export function artifact(root) {
  verified(root);
  const manifest = json(join(root, 'manifest.json'));
  assert.equal(manifest.node, process.version);
  for (const [name, record] of Object.entries(manifest.files)) {
    const file = verified(join(root, name));
    assert.ok(file.startsWith(root + '/'));
    assert.equal(digest(readFileSync(file)), record.sha256, name);
  }
  return manifest.revision;
}
export function saveProof(root, name, data) {
  assert.match(name, /^[a-z0-9-]+\.json$/);
  writeFileSync(join(root, name), JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
