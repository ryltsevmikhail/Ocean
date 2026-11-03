import { createHash } from 'node:crypto';
import {
  isLocalCodingPanel,
  isCodingRead,
  type LocalCodingRead,
  type CodingReadMethod,
  type LocalCodingView,
  isCodingView,
  bindingDigest,
  localPosition,
  localRuntimeRecord,
  MAX_PANEL_LENGTH,
  PREVIEW_CHUNK,
  type LocalCodingPanel,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
export interface LocalPanelClient {
  codingRead(method: CodingReadMethod, query: LocalCodingRead): Promise<LocalCodingView>;
  codingPanel(query: LocalCodingPanel): Promise<readonly string[]>;
}
export function localPanelClient(
  send: (method: string, query: unknown, timeout?: number) => Promise<unknown>,
): LocalPanelClient {
  return {
    async codingPanel(input) {
      const q = validatedParams(input, isLocalCodingPanel);
      return (await read('coding.panel', q)).split('\n');
    },
    async codingRead(method, input) {
      if (!['coding.show', 'coding.diff', 'coding.inspect-apply'].includes(method))
        throw Error('invalid_params');
      const q = validatedParams(input, isCodingRead);
      const row: unknown = JSON.parse(await read(method, q));
      if (!isCodingView(row, method, q)) throw Error('invalid_frame');
      return row;
    },
  };
  async function read(
    method: 'coding.panel' | CodingReadMethod,
    q: LocalCodingRead | LocalCodingPanel,
  ) {
    let version: string | undefined, length: number | undefined;
    let text = '';
    do {
      const offset = text.length;
      const r = await send(method, { ...q, offset, ...(version ? { version } : {}) }, 30000);
      if (
        !localRuntimeRecord(r) ||
        r['workspaceId'] !== q.workspaceId ||
        r['roomId'] !== q.roomId ||
        ('taskId' in q ? r['taskId'] !== q.taskId : r['id'] !== q.id) ||
        r['offset'] !== offset ||
        !bindingDigest(r['version']) ||
        !localPosition(r['length']) ||
        r['length'] > MAX_PANEL_LENGTH ||
        (version !== undefined && r['version'] !== version) ||
        (length !== undefined && r['length'] !== length) ||
        typeof r['text'] !== 'string' ||
        r['text'].length !== Math.min(PREVIEW_CHUNK, r['length'] - offset)
      )
        throw Error('invalid_frame');
      version = r['version'];
      length = r['length'];
      text += r['text'];
    } while (text.length < length);
    if (createHash('sha256').update(text).digest('hex') !== version) throw Error('invalid_frame');
    return text;
  }
}
