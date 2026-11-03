import { localRuntimeRecord as record } from './local-runtime.js';
export interface LocalDesktopAttachment {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly kind: 'image' | 'file';
  readonly mime: string;
}
export interface LocalDesktopPreparation {
  readonly digest: string;
  readonly ids: readonly string[];
  readonly body: string;
  readonly to: string | null;
  readonly prepared: string;
}
export type LocalDesktopCommand =
  | { readonly op: 'enroll'; readonly userData: string }
  | {
      readonly op: 'begin';
      readonly id: string;
      readonly room: string;
      readonly name: string;
      readonly bytes: number;
      readonly sha256: string;
    }
  | { readonly op: 'chunk'; readonly id: string; readonly offset: number; readonly data: string }
  | { readonly op: 'commit'; readonly id: string }
  | { readonly op: 'read'; readonly room: string; readonly id: string; readonly offset: number }
  | {
      readonly op: 'prepare';
      readonly room: string;
      readonly requestId: string;
      readonly body: string;
      readonly to: string | null;
      readonly ids: readonly string[];
    }
  | {
      readonly op: 'receipt';
      readonly room: string;
      readonly requestId: string;
      readonly messageId?: string;
    };
export type LocalDesktopReply =
  | { readonly op: 'enroll' | 'begin'; readonly ok: true }
  | { readonly op: 'chunk'; readonly offset: number }
  | { readonly op: 'commit'; readonly info: LocalDesktopAttachment }
  | {
      readonly op: 'read';
      readonly info: LocalDesktopAttachment;
      readonly offset: number;
      readonly data: string;
    }
  | { readonly op: 'prepare' | 'receipt'; readonly receipt: LocalDesktopPreparation | null };
const uuid = (s: unknown) =>
  typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
const room = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(s);
const text = (s: unknown, max: number) =>
  typeof s === 'string' && s.length <= max && !s.includes('\0');
const size = (n: unknown, max = 10485760) =>
  Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= max;
const digest = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function isDesktopAttachment(v: unknown): v is LocalDesktopAttachment {
  return (
    record(v) &&
    uuid(v['id']) &&
    text(v['name'], 180) &&
    v['name'] !== '' &&
    size(v['bytes']) &&
    digest(v['sha256']) &&
    ['image', 'file'].includes(String(v['kind'])) &&
    text(v['mime'], 100)
  );
}
function preparation(v: unknown): boolean {
  return (
    record(v) &&
    digest(v['digest']) &&
    text(v['body'], 16384) &&
    text(v['prepared'], 16384) &&
    (v['to'] === null || text(v['to'], 128)) &&
    Array.isArray(v['ids']) &&
    v['ids'].length >= 1 &&
    v['ids'].length <= 4 &&
    v['ids'].every(uuid)
  );
}
export function isDesktopCommand(v: unknown): v is LocalDesktopCommand {
  if (!record(v)) return false;
  const exact = (keys: string) => Object.keys(v).sort().join() === keys.split(',').sort().join();
  switch (v['op']) {
    case 'enroll':
      return (
        exact('op,userData') && text(v['userData'], 4096) && String(v['userData']).startsWith('/')
      );
    case 'begin':
      return (
        exact('op,id,room,name,bytes,sha256') &&
        uuid(v['id']) &&
        room(v['room']) &&
        text(v['name'], 180) &&
        v['name'] !== '' &&
        size(v['bytes']) &&
        digest(v['sha256'])
      );
    case 'chunk':
      return (
        exact('op,id,offset,data') && uuid(v['id']) && size(v['offset']) && text(v['data'], 349528)
      );
    case 'commit':
      return exact('op,id') && uuid(v['id']);
    case 'read':
      return exact('op,room,id,offset') && room(v['room']) && uuid(v['id']) && size(v['offset']);
    case 'receipt':
      return (
        exact('op,room,requestId' + (v['messageId'] === undefined ? '' : ',messageId')) &&
        room(v['room']) &&
        uuid(v['requestId']) &&
        (v['messageId'] === undefined || room(v['messageId']))
      );
    case 'prepare':
      return (
        exact('op,room,requestId,body,to,ids') &&
        room(v['room']) &&
        uuid(v['requestId']) &&
        text(v['body'], 16384) &&
        (v['to'] === null || text(v['to'], 128)) &&
        Array.isArray(v['ids']) &&
        v['ids'].length >= 1 &&
        v['ids'].length <= 4 &&
        v['ids'].every(uuid) &&
        new Set(v['ids']).size === v['ids'].length
      );
    default:
      return false;
  }
}
export function isDesktopReply(v: unknown): v is LocalDesktopReply {
  if (!record(v)) return false;
  switch (v['op']) {
    case 'enroll':
    case 'begin':
      return v['ok'] === true;
    case 'chunk':
      return size(v['offset']);
    case 'commit':
      return isDesktopAttachment(v['info']);
    case 'read':
      return isDesktopAttachment(v['info']) && size(v['offset']) && text(v['data'], 349528);
    case 'prepare':
      return preparation(v['receipt']);
    case 'receipt':
      return v['receipt'] === null || preparation(v['receipt']);
    default:
      return false;
  }
}
