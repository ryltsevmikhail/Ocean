import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function stageWorkspace(stage) {
  for (const name of [
    'tools-node',
    'application',
    'domain',
    'contracts',
    'provider-openai',
    'provider-anthropic',
    'provider-deepseek',
    'provider-core',
  ]) {
    const target = join(stage, 'node_modules', '@runnets', name);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    cpSync(join('packages', name, 'package.json'), join(target, 'package.json'));
    cpSync(join('packages', name, 'dist'), join(target, 'dist'), { recursive: true });
  }
}
