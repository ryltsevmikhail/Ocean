import { connect } from 'node:net';
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LocalRuntimeDescriptor } from '@runnets/contracts';
import type { EndpointProof } from '@runnets/store-sqlite';
import { prepareLocalRuntimeDirectory, type LocalRuntimePaths } from '@runnets/tools-node';
import { EndpointLayout } from './endpoint-files.js';

/** A connect probe sends no credential and authorizes nothing by itself. Only a definite refusal qualifies. */
async function refused(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 1000);
    s.once('connect', () => finish(false));
    s.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
  });
}
export async function recoverEndpoint(
  paths: LocalRuntimePaths,
  store: EndpointProof,
  originalProfile: string,
) {
  const digest = store.current();
  if (digest === null) prepareLocalRuntimeDirectory(paths);
  const layout = new EndpointLayout(paths, originalProfile);
  try {
    if (digest !== null) {
      layout.entries(['connection.json', 'runtime.sock']);
      const socket = layout.pin('runtime.sock');
      try {
        const descriptor = layout.pin('connection.json');
        try {
          if (
            layout.proof(socket, descriptor) !== digest ||
            !(await refused('/proc/self/fd/' + socket)) ||
            layout.proof(socket, descriptor) !== digest
          )
            throw Error('endpoint_exists');
          layout.unlink('connection.json', descriptor);
          layout.unlink('runtime.sock', socket);
          layout.sync();
          store.retire(digest);
        } finally {
          closeSync(descriptor);
        }
      } finally {
        closeSync(socket);
      }
    }
    layout.entries([]);
    return layout;
  } catch (error) {
    layout.close();
    throw error;
  }
}
export function publishEndpoint(
  layout: EndpointLayout,
  socket: number,
  descriptor: LocalRuntimeDescriptor,
  store: EndpointProof,
) {
  layout.entries(['runtime.sock']);
  const name = '.connection-' + descriptor.instanceId;
  const temporary = join(layout.at, name);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const content = Buffer.from(JSON.stringify(descriptor) + '\n');
  let linked = false;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    layout.check();
    if (!layout.matches(name, fd) || !layout.matches('runtime.sock', socket))
      throw Error('endpoint_changed');
    linkSync(temporary, join(layout.at, 'connection.json'));
    linked = true;
    layout.unlink(name, fd);
    layout.sync();
    const digest = layout.proof(socket, fd, content);
    store.publish(digest);
    if (layout.proof(socket, fd, content) !== digest) throw Error('endpoint_changed');
    return { digest, fd };
  } catch (error) {
    try {
      // An already-linked descriptor may have changed in place. Preserve the evidence.
      if (!linked && layout.matches(name, fd)) layout.unlink(name, fd);
    } finally {
      closeSync(fd);
    }
    throw error;
  } finally {
    content.fill(0);
  }
}
