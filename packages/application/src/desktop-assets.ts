import type {
  DesktopAssetInventory,
  DesktopBinding,
  DesktopOperation,
  DesktopPreparation,
  DesktopAttachment,
} from '@runnets/domain';
export interface DesktopAdoptedPreparation {
  readonly room: string;
  readonly requestId: string;
  readonly receipt: DesktopPreparation;
}
export interface DesktopAssetStore {
  binding(): DesktopBinding | null;
  inventory(legacy?: boolean): DesktopAssetInventory;
  room(room: string): void;
  operation(id: string): DesktopOperation | null;
  start(id: string, binding: string): void;
  complete(
    id: string,
    result: string,
    binding?: DesktopBinding,
    adopted?: DesktopAssetInventory['messages'],
    preparations?: readonly DesktopAdoptedPreparation[],
  ): void;
  upload(id: string, room: string, name: string, size: number, sha256: string): void;
  chunk(id: string, offset: number, data: string): number;
  uploaded(id: string): { room: string; name: string; size: number; sha256: string; data: string };
  prepared(room: string, requestId: string): DesktopPreparation | null;
  associated(room: string, requestId: string, messageId: string, prepared: string): boolean;
}
export interface DesktopAssetFiles {
  enroll(
    userData: string,
    inventory: DesktopAssetInventory,
  ): { binding: DesktopBinding; preparations: readonly DesktopAdoptedPreparation[] };
  import(binding: DesktopBinding, room: string, name: string, data: string): DesktopAttachment;
  prepare(
    binding: DesktopBinding,
    room: string,
    requestId: string,
    body: string,
    to: string | null,
    ids: readonly string[],
  ): DesktopPreparation;
  read(
    binding: DesktopBinding,
    room: string,
    id: string,
  ): { info: DesktopAttachment; data: string };
}
/** Runtime owner retains every synchronous publication independently of its requesting connection. */
export class DesktopAssetService {
  private readonly store: DesktopAssetStore;
  private readonly files: DesktopAssetFiles;
  constructor(store: DesktopAssetStore, files: DesktopAssetFiles) {
    this.store = store;
    this.files = files;
  }
  private bound(): DesktopBinding {
    const b = this.store.binding();
    if (!b) throw Error('desktop_not_enrolled');
    return b;
  }
  private effect<T>(id: string, binding: string, run: () => T): T {
    const old = this.store.operation(id);
    if (old) {
      if (old.binding !== binding) throw Error('request_conflict');
      if (old.state !== 'completed' || old.result === null) throw Error('desktop_outcome_unknown');
      return JSON.parse(old.result) as T;
    }
    this.store.start(id, binding);
    const result = run();
    this.store.complete(id, JSON.stringify(result));
    return result;
  }
  enroll(userData: string): DesktopBinding {
    const current = this.store.binding();
    if (current) {
      const old = this.store.operation('enrollment');
      if (old?.binding !== userData) throw Error('desktop_binding_conflict');
      return current;
    }
    if (this.store.operation('enrollment')) throw Error('desktop_outcome_unknown');
    const inventory = this.store.inventory(true);
    this.store.start('enrollment', userData);
    const { binding, preparations } = this.files.enroll(userData, inventory);
    this.store.complete(
      'enrollment',
      JSON.stringify(binding),
      binding,
      inventory.messages,
      preparations,
    );
    return binding;
  }
  begin(id: string, room: string, name: string, size: number, sha256: string): void {
    this.bound();
    this.store.room(room);
    this.store.upload(id, room, name, size, sha256);
  }
  chunk(id: string, offset: number, data: string): number {
    this.bound();
    return this.store.chunk(id, offset, data);
  }
  commit(id: string): DesktopAttachment {
    const b = this.bound(),
      upload = this.store.uploaded(id);
    this.store.room(upload.room);
    return this.effect('upload:' + id, JSON.stringify({ ...upload, data: undefined }), () =>
      this.files.import(b, upload.room, upload.name, upload.data),
    );
  }
  prepare(
    room: string,
    requestId: string,
    body: string,
    to: string | null,
    ids: readonly string[],
  ): DesktopPreparation {
    const b = this.bound();
    this.store.room(room);
    return this.effect(
      'prepare:' + room + ':' + requestId,
      JSON.stringify({ room, requestId, body, to, ids }),
      () => this.files.prepare(b, room, requestId, body, to, ids),
    );
  }
  read(room: string, id: string) {
    this.store.room(room);
    return this.files.read(this.bound(), room, id);
  }
  receipt(room: string, requestId: string, messageId?: string): DesktopPreparation | null {
    this.store.room(room);
    const result = this.store.prepared(room, requestId);
    return result &&
      messageId !== undefined &&
      !this.store.associated(room, requestId, messageId, result.prepared)
      ? null
      : result;
  }
}
