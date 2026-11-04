import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Loaded only by an explicitly isolated qualification launcher through NODE_OPTIONS.
if (process.versions.electron && process.env.OCEAN_QA_NATIVE_PROOF)
  setImmediate(() => {
    const { app, dialog, nativeImage } = require('electron');
    const { appendFileSync, existsSync, writeFileSync, mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    const proof = process.env.OCEAN_QA_NATIVE_PROOF;
    const record = (value) => appendFileSync(proof, JSON.stringify(value) + '\n', { mode: 0o600 });
    app.whenReady().then(() => {
      record({ userData: app.getPath('userData'), versions: process.versions });
      mkdirSync(process.env.OCEAN_QA_EXPORT, { recursive: true, mode: 0o700 });
      const target = join(process.env.OCEAN_QA_EXPORT, 'fixture-large.png');
      if (!existsSync(target)) {
        const pixels = Buffer.alloc(1600 * 1600 * 4);
        let seed = 713;
        for (let i = 0; i < pixels.length; i++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          pixels[i] = i % 4 === 3 ? 255 : seed & 255;
        }
        writeFileSync(
          target,
          nativeImage.createFromBitmap(pixels, { width: 1600, height: 1600 }).toPNG(),
          { mode: 0o600 },
        );
      }
    });
    app.on('browser-window-created', (_event, win) => {
      record({ webPreferences: win.webContents.getLastWebPreferences() });
      win.webContents.on('console-message', (detail) =>
        record({
          console: {
            level: detail.level,
            message: detail.message,
            sourceId: detail.sourceId,
            lineNumber: detail.lineNumber,
          },
        }),
      );
      win.webContents.on('render-process-gone', (_e, detail) => record({ renderGone: detail }));
    });
    dialog.showSaveDialog = async (_win, options) => ({
      canceled: false,
      filePath: join(process.env.OCEAN_QA_EXPORT, options.defaultPath),
    });
    process.on('unhandledRejection', (e) => record({ unhandledRejection: String(e) }));
    process.on('uncaughtExceptionMonitor', (e) => record({ uncaughtException: String(e) }));
  });
