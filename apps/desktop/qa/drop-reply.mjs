// Runs only inside the disposable fixture owner. Suppress an already-committed
// submit reply, or disconnect an observer, without modifying production dispatch.
import { Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const log = process.env.OCEAN_TEST_LOG;
const write = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    const result = JSON.parse(chunk).result;
    const drop = log + '.drop';
    if (result?.messageId && result.requestId && existsSync(drop)) {
      unlinkSync(drop);
      this.destroy();
      return false;
    }
    if (result?.cursor && existsSync(log + '.hold-reads')) {
      this.destroy();
      return false;
    }
  }
  return write.call(this, chunk, ...rest);
};
