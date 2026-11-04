import { DesktopAssetService, type DesktopAssetStore } from '@runnets/application';
import { decodeDesktopAttachments } from '@runnets/domain';
import { isDesktopCommand, type LocalDesktopReply } from '@runnets/contracts';
import { desktopAssetFiles, desktopImageResolver, desktopRootIdentity } from '@runnets/tools-node';
export { desktopImageResolver };
export function runtimeDesktopAssets(store: DesktopAssetStore, profile: string, profileId: string) {
  const service = new DesktopAssetService(store, desktopAssetFiles(profile, profileId));
  return (
    params: unknown,
    draining: boolean,
  ): { result: LocalDesktopReply } | { error: { code: string } } => {
    try {
      if (draining) throw Error('runtime_draining');
      const bound = store.binding();
      if (
        bound &&
        (bound.profileId !== profileId ||
          !bound.root.startsWith(profile + '/') ||
          !/^desktop-[a-f0-9-]{36}\/tree$/.test(bound.root.slice(profile.length + 1)) ||
          desktopRootIdentity(bound.root) !== bound.identity)
      )
        throw Error('desktop_binding_mismatch');
      if (!isDesktopCommand(params)) throw Error('invalid_params');
      const c = params;
      switch (c.op) {
        case 'enroll':
          service.enroll(c.userData);
          return { result: { op: c.op, ok: true } };
        case 'begin':
          service.begin(c.id, c.room, c.name, c.bytes, c.sha256);
          return { result: { op: c.op, ok: true } };
        case 'chunk':
          return { result: { op: c.op, offset: service.chunk(c.id, c.offset, c.data) } };
        case 'commit':
          return { result: { op: c.op, info: service.commit(c.id) } };
        case 'prepare':
          return {
            result: {
              op: c.op,
              receipt: service.prepare(c.room, c.requestId, c.body, c.to, c.ids),
            },
          };
        case 'receipt':
          return {
            result: { op: c.op, receipt: service.receipt(c.room, c.requestId, c.messageId) },
          };
        case 'read': {
          const { info, data } = service.read(c.room, c.id);
          if (c.offset > info.bytes) throw Error('invalid_params');
          return {
            result: {
              op: c.op,
              info,
              offset: c.offset,
              data: Buffer.from(data, 'base64')
                .subarray(c.offset, c.offset + 262144)
                .toString('base64'),
            },
          };
        }
      }
    } catch (e) {
      return {
        error: {
          code:
            e instanceof Error && /^[a-z_]+$/.test(e.message)
              ? e.message
              : 'desktop_asset_unavailable',
        },
      };
    }
  };
}
/**
 * Plain markers stay text; a runtime preparation, once present, binds the actual send too.
 * `modelBound` additionally rejects a marker whose preparation request id is not the
 * submission request id: a broadcast batch is always model-bound and has no admission-time
 * context check to catch the mismatch. Direct model turns get the same check in admission,
 * while Notes stay inert display text (a marker without authority sends no bytes).
 */
export function desktopSubmitRefusal(
  store: DesktopAssetStore,
  params: Record<string, unknown>,
  modelBound = false,
): string | null {
  if (typeof params['roomId'] !== 'string' || typeof params['requestId'] !== 'string') return null;
  const decoded =
    typeof params['text'] === 'string' ? decodeDesktopAttachments(params['text']) : null;
  if (modelBound && decoded !== null && decoded.requestId !== params['requestId'])
    return 'image_unavailable';
  const op = store.operation('prepare:' + params['roomId'] + ':' + params['requestId']);
  if (!op) return null;
  if (op.state !== 'completed') return 'desktop_outcome_unknown';
  const prepared = store.prepared(params['roomId'], params['requestId']);
  return !prepared || prepared.prepared !== params['text'] || prepared.to !== (params['to'] ?? null)
    ? 'request_conflict'
    : null;
}
