import type { ModelConnectionReadModel } from './model-connection-state.js';
import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCheckMetadata, ModelConnectionCheck } from './model-connection-types.js';
import type { LocalModelMetadataCheck, LocalModelCheckResult } from './model-credential-ports.js';
import { checkSignal } from './provider-connection-request.js';
import {
  copyLocalQualification,
  sameLocalQualification,
  type LocalModelQualification,
} from './model-local-qualification.js';
/** Only this explicit owner path can publish local evidence. Admission and streams never write it. */
export async function checkLocalConnection(
  state: ModelConnectionReadModel,
  record: ModelConnectionRecord,
  caller?: AbortSignal,
): Promise<ModelConnectionCheck> {
  const o = state.options;
  const eligible = (r: ModelConnectionRecord) =>
    o.mutationsAllowed !== false &&
    o.disabled !== true &&
    !o.injected &&
    !(o.restored === true && !r.configuredAfterRestore) &&
    r.intent === 'active' &&
    !(r.auth === 'none' && r.secretRef !== null) &&
    o.factory.localBootstrap?.acceptsDesired(r) === true;
  const checkedAt = o.clock.now().toISOString(),
    start = Date.now(),
    signal = checkSignal(caller);
  let probe: LocalModelMetadataCheck | null = null;
  let result: LocalModelCheckResult = { outcome: 'unavailable', httpStatus: null },
    qualification: LocalModelQualification | null = null;
  const attempted = eligible(record);
  if (attempted && !signal.aborted) {
    try {
      const secret =
        record.auth === 'none'
          ? null
          : record.secretRef === null
            ? null
            : o.secrets.read(record.secretRef);
      if (record.auth === 'none' || secret?.status === 'ok')
        probe = o.factory.localBootstrap!.prepareCheck(record, secret);
      if (probe) {
        // Enforce the application deadline even if an injected adapter ignores cancellation.
        result = await bounded(probe.check(signal), signal);
        if (result.outcome === 'ok') {
          qualification = copyLocalQualification(result.qualification);
          if (qualification.modelId !== record.defaultModelId) throw Error('connection_unverified');
        }
      }
    } catch {
      result = { outcome: 'unavailable', httpStatus: null };
      qualification = null;
    }
  }
  if (signal.aborted) {
    result = { outcome: caller?.aborted ? 'cancelled' : 'timeout', httpStatus: null };
    qualification = null;
  }
  const metadata: ModelCheckMetadata = {
    connectionId: record.connectionId,
    outcome: result.outcome,
    httpStatus: result.httpStatus,
    durationMs: probe ? Math.max(0, Date.now() - start) : 0,
    models: qualification ? [qualification.modelId] : [],
    modelSupported: qualification !== null,
    source: probe?.source ?? 'none',
    revision: record.revision,
    checkedAt,
  };
  let persisted = false;
  if (attempted && !signal.aborted) {
    try {
      const current = state.record(record.connectionId);
      if (current.revision === record.revision && eligible(current) && !signal.aborted) {
        const changed =
          qualification !== null &&
          !sameLocalQualification(current.localQualification, qualification);
        if (changed && current.revision === Number.MAX_SAFE_INTEGER)
          throw Error('revision_conflict');
        o.store.put(
          {
            ...current,
            localQualification: qualification ?? current.localQualification,
            revision: current.revision + (changed ? 1 : 0),
            lastCheck: metadata,
            updatedAt: checkedAt,
          },
          record.revision,
        );
        persisted = true;
      }
    } catch {
      /* The store's single-row CAS owns publication; stale evidence never rebases. */
    }
  }
  return { status: state.status(record.connectionId), check: { ...metadata, persisted } };
}
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error('check interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
