import { modelConnectionRecord, type ModelConnectionRecord } from '@runnets/application';
export { modelConnectionRecord } from '@runnets/application';

export function decodeModelConnection(payload: unknown): ModelConnectionRecord {
  try {
    if (typeof payload !== 'string') throw Error('connection_unverified');
    return modelConnectionRecord(JSON.parse(payload) as unknown);
  } catch {
    throw Error('connection_unverified');
  }
}
