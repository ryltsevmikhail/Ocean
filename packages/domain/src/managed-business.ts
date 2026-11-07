import { authorityObject, authorityText } from './service-authority-validation.js';
import { validServiceConnection } from './service-connection.js';
import { managedEnrollment, managedWorkspaceOf } from './managed-workspace.js';
import type { ToolEffectAdmission } from './effect-resource-conflicts.js';
export function hasManagedMarkers(a: ToolEffectAdmission): boolean {
  return (
    authorityObject(a.binding) &&
    ['managedWorkspace', 'managedSession', 'managedEnrollment'].some((key) =>
      Object.hasOwn(a.binding as object, key),
    )
  );
}
/** Complete historical intent only; current dispatch additionally requires the exact live receipt. */
export function validManagedBusinessAdmission(a: ToolEffectAdmission): boolean {
  if (!authorityObject(a.binding) || !a.grantReference || !managedWorkspaceOf(a)) return false;
  const b = a.binding;
  if (
    typeof b.managedSession !== 'string' ||
    !/^[0-9a-f]{64}$/.test(b.managedSession) ||
    typeof b.managedEnrollment !== 'string' ||
    !authorityText(b.tool)
  )
    return false;
  try {
    const c: unknown = JSON.parse(b.managedEnrollment);
    return (
      validServiceConnection(c) &&
      c.configuration.kind === 'stdio' &&
      c.configuration.workspaceRoot === managedWorkspaceOf(a)!.root &&
      c.id === b.connectionId &&
      c.credentialReference === null &&
      c.credentialBinding === undefined &&
      c.state === 'active' &&
      c.trust.metadataPermission === 'allow' &&
      managedEnrollment(c) === b.managedEnrollment &&
      c.configRevision === b.configRevision &&
      c.trustRevision === b.trustRevision &&
      c.credentialRevision === b.credentialRevision
    );
  } catch {
    return false;
  }
}
