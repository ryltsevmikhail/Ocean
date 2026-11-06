import { validConversationText } from './conversations.js';
import { validServiceConnection, type ServiceConnection } from './service-connection.js';
import { canonicalJson } from './plugin-catalog.js';
import { authorityKeys, authorityObject } from './service-authority-validation.js';
import type { ToolEffectAdmission } from './effect-resource-conflicts.js';
/** Private trusted-adapter evidence, never a model-supplied selector or grant. */
export interface ManagedWorkspace {
  readonly version: 1;
  readonly root: string;
  readonly boot: string;
  readonly mountNamespace: string;
  readonly mountId: string;
  readonly dev: string;
  readonly ino: string;
  readonly anchor: string | null;
}
export interface ManagedWorkspacePair {
  readonly existing: ToolEffectAdmission;
  readonly incoming: ToolEffectAdmission;
  readonly existingCoordinate: string;
  readonly incomingCoordinate: string;
}
export const MANAGED_LIFETIME_RUN = '\0managed-stdio/v1';
export const MANAGED_LIFETIME_TOOL = '\0managed-stdio/lifetime';
export const managedNonce = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function managedCanonicalRoot(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    validConversationText(v, 4096) &&
    v.startsWith('/') &&
    !/[\0\r\n]/.test(v) &&
    (v === '/' ||
      !v
        .slice(1)
        .split('/')
        .some((s) => !s || s === '.' || s === '..'))
  );
}
export function validManagedWorkspace(v: unknown): v is ManagedWorkspace {
  if (
    !authorityObject(v) ||
    !authorityKeys(v, [
      'version',
      'root',
      'boot',
      'mountNamespace',
      'mountId',
      'dev',
      'ino',
      'anchor',
    ])
  )
    return false;
  return (
    v.version === 1 &&
    managedCanonicalRoot(v.root) &&
    v.root !== '/' &&
    managedNonce(v.boot) &&
    typeof v.mountNamespace === 'string' &&
    /^mnt:\[[1-9][0-9]{0,19}\]$/.test(v.mountNamespace) &&
    [v.mountId, v.dev, v.ino].every(
      (s) => typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s),
    ) &&
    (v.anchor === null ||
      (typeof v.anchor === 'string' &&
        /^linux-btrfs-v1:[0-9a-f]{32}:[0-9a-f]{32}:[1-9][0-9]{0,19}:[0-9]{1,10}:[0-9a-f]{2,256}$/.test(
          v.anchor,
        )))
  );
}
export function managedWorkspaceOf(a: ToolEffectAdmission | undefined): ManagedWorkspace | null {
  if (
    !a ||
    a.effectKind !== 'mutation' ||
    a.scope.kind !== 'resources' ||
    a.scope.resources.length !== 1 ||
    !authorityObject(a.binding)
  )
    return null;
  const selector = a.scope.resources[0]!;
  return selector.kind === 'connection' &&
    selector.connectionId === a.binding.connectionId &&
    validManagedWorkspace(a.binding.managedWorkspace)
    ? a.binding.managedWorkspace
    : null;
}
export function managedPairDisjoint(
  existing: ToolEffectAdmission,
  incoming: ToolEffectAdmission,
  pair?: ManagedWorkspacePair,
): boolean {
  if (
    !pair ||
    canonicalJson(existing) !== canonicalJson(pair.existing) ||
    canonicalJson(incoming) !== canonicalJson(pair.incoming)
  )
    return false;
  const a = managedWorkspaceOf(existing),
    b = managedWorkspaceOf(incoming);
  if (
    !a ||
    !b ||
    !a.anchor ||
    !b.anchor ||
    a.boot !== b.boot ||
    a.mountNamespace !== b.mountNamespace ||
    a.mountId !== b.mountId ||
    a.dev !== b.dev ||
    a.anchor.split(':').slice(0, 4).join(':') !== b.anchor.split(':').slice(0, 4).join(':') ||
    a.ino === b.ino ||
    a.anchor === b.anchor
  )
    return false;
  const x = pair.existingCoordinate,
    y = pair.incomingCoordinate;
  return (
    managedCanonicalRoot(x) &&
    managedCanonicalRoot(y) &&
    x !== '/' &&
    y !== '/' &&
    x !== y &&
    !x.startsWith(y + '/') &&
    !y.startsWith(x + '/')
  );
}
export function managedEnrollment(c: ServiceConnection): string {
  return canonicalJson({ ...c, currentCatalogId: null });
}
export function validManagedLifetime(row: {
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly id: string;
  readonly tool: string;
  readonly admission?: ToolEffectAdmission;
}): boolean {
  const a = row.admission;
  if (
    row.taskRunId !== MANAGED_LIFETIME_RUN ||
    row.tool !== MANAGED_LIFETIME_TOOL ||
    !managedNonce(row.id) ||
    row.attemptId !== row.id ||
    !a ||
    a.grantReference !== null ||
    !managedWorkspaceOf(a) ||
    !authorityObject(a.binding) ||
    !authorityKeys(a.binding, [
      'connectionId',
      'managedWorkspace',
      'managedEnrollment',
      'managedLifetime',
    ])
  )
    return false;
  const v = a.binding.managedLifetime;
  if (!authorityObject(v)) return false;
  let enrollment: unknown;
  try {
    enrollment =
      authorityObject(v) && typeof v.enrollment === 'string' ? JSON.parse(v.enrollment) : null;
  } catch {
    return false;
  }
  if (
    !validServiceConnection(enrollment) ||
    enrollment.configuration.kind !== 'stdio' ||
    enrollment.credentialReference !== null ||
    enrollment.credentialBinding !== undefined ||
    enrollment.configuration.workspaceRoot !== managedWorkspaceOf(a)?.root ||
    enrollment.id !== a.binding.connectionId ||
    enrollment.state !== 'active' ||
    enrollment.trust.metadataPermission !== 'allow' ||
    managedEnrollment(enrollment) !== v.enrollment ||
    a.binding.managedEnrollment !== v.enrollment
  )
    return false;
  return (
    authorityObject(v) &&
    authorityKeys(v, ['version', 'nonce', 'unit', 'cgroup', 'enrollment']) &&
    v.version === 1 &&
    v.nonce === row.id &&
    typeof v.unit === 'string' &&
    /^ocean-mcp-[0-9a-f]{32}-[0-9a-f-]{36}\.service$/.test(v.unit) &&
    v.unit.endsWith(row.id + '.service') &&
    typeof v.cgroup === 'string' &&
    /^\/user\.slice\/user-(0|[1-9][0-9]{0,9})\.slice\/user@\1\.service\/app\.slice\/[^/]+$/.test(
      v.cgroup,
    ) &&
    v.cgroup.endsWith('/' + v.unit) &&
    typeof v.enrollment === 'string' &&
    v.enrollment.length <= 65536
  );
}

export function managedLifetimeFingerprint(row: {
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly id: string;
  readonly tool: string;
  readonly admission?: ToolEffectAdmission;
}): string {
  return canonicalJson({
    taskRunId: row.taskRunId,
    attemptId: row.attemptId,
    id: row.id,
    tool: row.tool,
    admission: row.admission,
  });
}
