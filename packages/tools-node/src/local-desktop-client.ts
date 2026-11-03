import { createHash, randomUUID } from 'node:crypto';
import {
  isDesktopCommand,
  isDesktopReply,
  type LocalDesktopCommand,
  type LocalDesktopReply,
  type LocalDesktopAttachment,
} from '@runnets/contracts';
export interface LocalDesktopClient {
  desktopAssets(command: LocalDesktopCommand): Promise<LocalDesktopReply>;
}
export function localDesktopClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): LocalDesktopClient {
  return {
    async desktopAssets(command) {
      if (!isDesktopCommand(command)) throw Error('invalid_params');
      const reply = await send('desktop.assets', command);
      if (!isDesktopReply(reply) || reply.op !== command.op) throw Error('invalid_frame');
      return reply;
    },
  };
}
/** Shared native host entry: bounded chunks, exact commit and read-back digest. */
export class DesktopAttachmentClient {
  private readonly client: LocalDesktopClient;
  constructor(client: LocalDesktopClient) {
    this.client = client;
  }
  async enroll(userData: string): Promise<void> {
    await this.client.desktopAssets({ op: 'enroll', userData });
  }
  async import(
    room: string,
    name: string,
    encoded: string,
    id = randomUUID(),
  ): Promise<LocalDesktopAttachment> {
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded || data.length > 10485760)
      throw Error('invalid_attachment');
    const sha256 = createHash('sha256').update(data).digest('hex');
    await this.client.desktopAssets({ op: 'begin', id, room, name, bytes: data.length, sha256 });
    for (let offset = 0; offset < data.length; offset += 262144) {
      const reply = await this.client.desktopAssets({
        op: 'chunk',
        id,
        offset,
        data: data.subarray(offset, offset + 262144).toString('base64'),
      });
      if (reply.op !== 'chunk' || reply.offset < Math.min(data.length, offset + 262144))
        throw Error('invalid_frame');
    }
    const result = await this.client.desktopAssets({ op: 'commit', id });
    if (
      result.op !== 'commit' ||
      result.info.bytes !== data.length ||
      result.info.sha256 !== sha256
    )
      throw Error('invalid_frame');
    return result.info;
  }
  async read(room: string, id: string) {
    let offset = 0,
      info: LocalDesktopAttachment | undefined;
    const chunks: Buffer[] = [];
    do {
      const r = await this.client.desktopAssets({ op: 'read', room, id, offset });
      if (
        r.op !== 'read' ||
        r.offset !== offset ||
        r.info.id !== id ||
        (info && JSON.stringify(info) !== JSON.stringify(r.info))
      )
        throw Error('invalid_frame');
      info = r.info;
      const chunk = Buffer.from(r.data, 'base64');
      if (
        chunk.toString('base64') !== r.data ||
        chunk.length > 262144 ||
        chunk.length !== Math.min(262144, info.bytes - offset)
      )
        throw Error('invalid_frame');
      chunks.push(chunk);
      offset += chunk.length;
    } while (offset < info.bytes);
    const data = Buffer.concat(chunks);
    if (createHash('sha256').update(data).digest('hex') !== info.sha256)
      throw Error('invalid_frame');
    return { info, data };
  }
  async prepare(
    room: string,
    requestId: string,
    body: string,
    to: string | null,
    ids: readonly string[],
  ) {
    const r = await this.client.desktopAssets({ op: 'prepare', room, requestId, body, to, ids });
    if (
      r.op !== 'prepare' ||
      !r.receipt ||
      r.receipt.body !== body ||
      r.receipt.to !== to ||
      JSON.stringify(r.receipt.ids) !== JSON.stringify(ids) ||
      createHash('sha256').update(r.receipt.prepared).digest('hex') !== r.receipt.digest
    )
      throw Error('invalid_frame');
    return r.receipt;
  }
  async receipt(room: string, requestId: string, messageId?: string) {
    const r = await this.client.desktopAssets({
      op: 'receipt',
      room,
      requestId,
      ...(messageId === undefined ? {} : { messageId }),
    });
    if (r.op !== 'receipt') throw Error('invalid_frame');
    return r.receipt;
  }
}
