import { DesktopAssetService, type DesktopAssetStore } from '@runnets/application';
import { decodeDesktopAttachments, hasDesktopAttachmentMarker } from '@runnets/domain';
import { isDesktopCommand, type LocalDesktopReply } from '@runnets/contracts';
import {
  desktopAssetFiles,
  desktopImageResolver,
  desktopBindingMatches,
} from '@runnets/tools-node';
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
          !desktopBindingMatches(bound))
      )
        throw Error('desktop_binding_mismatch');
      if (!isDesktopCommand(params)) throw Error('invalid_params');
      const c = params;
      switch (c.op) {
        case 'attach': {
          const enrollment = store.operation('enrollment');
          if (enrollment && enrollment.state !== 'completed')
            throw Error('desktop_outcome_unknown');
          if (!bound) throw Error('desktop_not_enrolled');
          return { result: { op: c.op, ok: true } };
        }
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
 * Plain markers stay text; a marker body is admitted only with its durable preparation.
 * Any marker-bearing body survives into the room and is then re-authenticated on every
 * later context reconstruction, so one pasted/forged marker without a completed
 * `prepare:` receipt would poison every later model turn in that room. This pre-write
 * check therefore refuses: a body that does not decode, a marker whose preparation
 * request id is not the submission request id (`modelBound`, where a broadcast batch has
 * no admission-time context check), and a marker with no completed preparation for the
 * same room+requestId. Notes keep no-model semantics but follow the same binding: the
 * Desktop prepares a note body exactly like a directed one (`to: null`). Plain text (no
 * marker) keeps the pre-existing prepared-outcome rules for its request id.
 */
export function desktopSubmitRefusal(
  store: DesktopAssetStore,
  params: Record<string, unknown>,
  modelBound = false,
): string | null {
  if (typeof params['roomId'] !== 'string' || typeof params['requestId'] !== 'string') return null;
  if (typeof params['text'] !== 'string') return null;
  const marker = hasDesktopAttachmentMarker(params['text']);
  const decoded = marker ? decodeDesktopAttachments(params['text']) : null;
  // A marker that does not decode names no preparation: it must never be stored,
  // not even as an inert room message.
  if (marker && decoded === null) return 'image_unavailable';
  // A broadcast batch has no admission-time context check, so the marker's own
  // preparation request id must be the submitting request id.
  if (modelBound && decoded !== null && decoded.requestId !== params['requestId'])
    return 'image_unavailable';
  const op = store.operation('prepare:' + params['roomId'] + ':' + params['requestId']);
  // A marker body is admitted only with its durable preparation; plain text keeps
  // the pre-existing rule (an unknown prepared outcome still blocks the request id).
  if (!op) return marker ? 'image_unavailable' : null;
  if (op.state !== 'completed') return 'desktop_outcome_unknown';
  const prepared = store.prepared(params['roomId'], params['requestId']);
  return !prepared || prepared.prepared !== params['text'] || prepared.to !== (params['to'] ?? null)
    ? 'request_conflict'
    : null;
}
