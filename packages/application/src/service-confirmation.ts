import { canonicalJson } from '@runnets/domain';
import type { ServiceAuthorityTransaction } from './service-authority-ports.js';
import type {
  ServiceCallAdmissionOptions,
  ServiceCallConfirmation,
  ServiceCallRequest,
} from './service-admission-types.js';
import { prepare, type Prepared } from './service-admission-prepare.js';
import { freezeServiceFact } from './service-turn-tools-schema.js';

function operation(request: ServiceCallRequest, p: Prepared): ServiceCallConfirmation {
  const { catalogId: _catalog, ...semanticRequest } = request;
  const binding = { ...(p.admission.binding as Record<string, unknown>) };
  delete binding['catalogId'];
  delete binding['configRevision'];
  delete binding['managedWorkspace'];
  delete binding['managedEnrollment'];
  delete binding['managedSession'];
  return freezeServiceFact(
    structuredClone({
      request: semanticRequest,
      configuration: p.connection.configuration,
      definition: p.tool,
      effect: { ...p.admission, binding },
    }),
  ) as ServiceCallConfirmation;
}
/** Private authority facts never enter the owner preview, including credential references. */
function authority(p: Prepared) {
  const {
    configRevision: _revision,
    currentCatalogId: _catalog,
    updatedAt: _updated,
    ...facts
  } = p.connection;
  return canonicalJson(facts);
}
export function sameConfirmation(
  request: ServiceCallRequest,
  initial: Prepared,
  current: Prepared,
) {
  return (
    current.confirmationRequired &&
    authority(initial) === authority(current) &&
    canonicalJson(operation(request, initial)) === canonicalJson(operation(request, current))
  );
}
/** Returns a live-call-only claim check; an allowed stored decision cannot reconstruct it. */
export async function confirmedPreparation(
  options: ServiceCallAdmissionOptions,
  request: ServiceCallRequest,
  initial: Prepared,
  signal: AbortSignal = new AbortController().signal,
) {
  if (!options.confirmation) return 'confirmation_required';
  const expected = operation(request, initial);
  const expectedSemantic = canonicalJson(expected),
    expectedAuthority = authority(initial);
  const select = (tx: ServiceAuthorityTransaction) => {
    if (signal.aborted) return 'cancelled';
    const connection = tx.connection(request.connectionId);
    if (!connection?.currentCatalogId) return 'catalog_stale';
    const currentRequest = { ...request, catalogId: connection.currentCatalogId };
    const prepared = prepare(tx, currentRequest, options);
    if (typeof prepared === 'string') return prepared;
    if (
      !prepared.confirmationRequired ||
      authority(prepared) !== expectedAuthority ||
      canonicalJson(operation(currentRequest, prepared)) !== expectedSemantic
    )
      return 'confirmation_invalidated';
    return { request: currentRequest, prepared };
  };
  const current = () =>
    Promise.resolve().then(() => options.store.atomic((tx) => typeof select(tx) !== 'string'));
  const outcome = await options.confirmation.confirm(expected, signal, current);
  if (signal.aborted) return 'cancelled';
  return outcome === 'allowed' ? select : 'confirmation_' + outcome;
}
