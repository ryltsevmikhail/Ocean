import { ToolService, type ToolJournalPort, type ToolPermissionPort } from '@runnets/application';
import { createNativeBackend, WorkspaceTools } from '@runnets/tools-node';

/** Requested containment is never silently downgraded to ordinary Node execution. */
export function requireContainmentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const mode = env['RUNNE_EXECUTION_MODE'] ?? 'uncontained';
  if (mode !== 'uncontained' && mode !== 'contained')
    throw new Error('RUNNE_EXECUTION_MODE must be uncontained or contained');
  return mode === 'contained';
}

/** The host selects the workspace explicitly; tools acquire no implicit cwd. */
export async function createTools(
  workspace: string,
  permissions: ToolPermissionPort,
  journal?: ToolJournalPort,
): Promise<ToolService> {
  return new ToolService(
    new WorkspaceTools(await createNativeBackend(workspace), {
      requireContainment: requireContainmentFromEnv(),
    }),
    permissions,
    journal,
  );
}
