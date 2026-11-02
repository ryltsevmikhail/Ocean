import type { Socket } from 'node:net';
import { LOCAL_RUNTIME_MAX_FRAME } from '@runnets/contracts';
/** Bounded byte framing. Consumer results are discarded except literal false, which permanently ends decoding. */
export class LocalRuntimeFrames {
  private pending = Buffer.alloc(1024);
  private length = 0;
  private ended = false;
  private readonly receive: (value: unknown) => unknown;
  constructor(receive: (value: unknown) => unknown) {
    this.receive = receive;
  }
  push(chunk: Buffer): void {
    let offset = 0;
    while (!this.ended && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.length + end - offset > LOCAL_RUNTIME_MAX_FRAME) throw Error('frame_too_large');
      const needed = this.length + end - offset;
      if (needed > this.pending.length) {
        const expanded = Buffer.allocUnsafe(
          Math.min(LOCAL_RUNTIME_MAX_FRAME, Math.max(needed, this.pending.length * 2)),
        );
        this.pending.copy(expanded, 0, 0, this.length);
        this.pending = expanded;
      }
      chunk.copy(this.pending, this.length, offset, end);
      this.length = needed;
      if (newline < 0) return;
      const bytes = this.pending.subarray(0, this.length);
      this.length = 0;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw Error('invalid_frame');
      }
      if (this.receive(value) === false) {
        this.ended = true;
        return;
      }
      offset = newline + 1;
    }
  }
}
/** Never retain an unbounded observer queue. A slow client loses the transport. */
export function writeLocalRuntimeFrame(socket: Socket, value: unknown): boolean {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (
    bytes.length - 1 > LOCAL_RUNTIME_MAX_FRAME ||
    socket.writableLength + bytes.length > LOCAL_RUNTIME_MAX_FRAME
  ) {
    socket.destroy();
    return false;
  }
  return socket.write(bytes);
}
