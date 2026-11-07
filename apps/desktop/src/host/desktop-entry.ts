import { join } from 'node:path';

export function desktopEntry(
  args: readonly string[],
  botUserData: string,
  profileOverride?: string,
) {
  const projects = args.includes('--projects');
  return {
    page: projects ? 'projects.html' : 'index.html',
    userData: projects ? join(botUserData, 'projects') : botUserData,
    profile: profileOverride ?? join(botUserData, 'conversation', 'profile'),
  };
}
