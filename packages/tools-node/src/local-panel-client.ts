import { createHash } from 'node:crypto';
import {
  isLocalCodingPanel,
  bindingDigest,
  localPosition,
  localRuntimeRecord,
  MAX_PANEL_LENGTH,
  PREVIEW_CHUNK,
  type LocalCodingPanel,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
export interface LocalPanelClient {
  codingPanel(query: LocalCodingPanel): Promise<readonly string[]>;
}
export function localPanelClient(
  send: (method: string, query: unknown, timeout?: number) => Promise<unknown>,
): LocalPanelClient {
  return {
    async codingPanel(input) {
      const q = validatedParams(input, isLocalCodingPanel);
      let version: string | undefined, length: number | undefined;
      let text = '';
      do {
        const offset = text.length;
        const r = await send(
          'coding.panel',
          { ...q, offset, ...(version ? { version } : {}) },
          30000,
        );
        if (
          !localRuntimeRecord(r) ||
          r['workspaceId'] !== q.workspaceId ||
          r['roomId'] !== q.roomId ||
          r['taskId'] !== q.taskId ||
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
      return text.split('\n');
    },
  };
}
