/** Run behavioral contracts against immutable installed JS, using source tests only as drivers. */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
const root = import.meta.dirname;
const installed = process.env['OCEAN_RC_INSTALL'];
if (!installed) throw new Error('OCEAN_RC_INSTALL must name an installed release root');
const target = realpathSync(resolve(installed));
export default defineConfig({
  plugins: [
    {
      name: 'ocean-installed-contracts',
      enforce: 'pre',
      resolveId(id, importer) {
        if (!importer || !id.startsWith('.') || !id.endsWith('.js')) return undefined;
        const candidate = resolve(dirname(importer), id);
        const local = relative(root, candidate);
        const mapped = local.replace(/^(apps\/cli|packages\/[^/]+)\/src\//, '$1/dist/');
        if (mapped === local || local.startsWith('..')) return undefined;
        const path = mapped.startsWith('packages/')
          ? join(target, 'node_modules/@runnets', mapped.slice('packages/'.length))
          : join(target, mapped);
        if (!existsSync(path)) throw new Error('Installed contract module missing: ' + mapped);
        return path;
      },
    },
  ],
  resolve: {
    alias: Object.fromEntries(
      [
        'domain',
        'application',
        'store',
        'store-sqlite',
        'contracts',
        'provider-core',
        'provider-deepseek',
        'tools-node',
      ].map((name) => [
        '@runnets/' + name,
        join(target, 'node_modules/@runnets', name, 'dist/index.js'),
      ]),
    ),
  },
  test: {
    server: { deps: { inline: [/ocean-rc/] } },
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: [
      // These drivers intentionally execute source workers or build a source fixture; qualified separately.
      'apps/cli/src/release/installer.test.ts',
    ],
    reporters: ['default'],
  },
});
