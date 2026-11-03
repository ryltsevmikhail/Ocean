import { app, BrowserWindow, ipcMain } from 'electron';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
import { dispatch } from './runtime-client.js';
import { profileAssets } from './profile-assets.js';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AttachmentHost } from './attachment-host.js';
import { attachmentCommands } from '../attachments.js';
import { commands, outputs } from '../protocol.js';

process.umask(0o077);
app.enableSandbox();
const dist = resolve(import.meta.dirname, '../..');
const page = pathToFileURL(join(dist, 'web/index.html')).href;
const failure = (code: string) => ({ version: 1, ok: false, error: { code } });
async function open() {
  const userData = app.getPath('userData');
  const profile = process.env['OCEAN_DESKTOP_PROFILE'] ?? join(userData, 'conversation', 'profile');
  const win = new BrowserWindow({
    width: 1180,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    icon: join(dist, 'web/marks/ocean.png'),
    height: 800,
    webPreferences: {
      preload: join(dist, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  let media: AttachmentHost | undefined;
  const detached = new AbortController();
  let inflight = 0;
  ipcMain.handle('ocean:request', async (event, raw: unknown) => {
    if (
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      !event.senderFrame ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      return failure('invalid_request');
    const asset = attachmentCommands.safeParse(raw);
    const parsed = commands.safeParse(raw);
    if (!parsed.success && !asset.success) return failure('invalid_request');
    if (inflight >= 8) return failure('client_busy');
    inflight++;
    try {
      const client = await connectLocalRuntime({ profile, signal: detached.signal }).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw Error('profile_missing');
          throw error;
        },
      );
      try {
        media ??= new AttachmentHost(
          profileAssets(userData, profile, client.identity.profileId),
          win,
        );
        if (asset.success) return { version: 1, ok: true, data: await media.handle(asset.data) };
        if (!parsed.success) return failure('invalid_request');
        const c = parsed.data;
        const input = c.op === 'send' ? await media.prepare(c) : c;
        const reply = await dispatch(client, input);
        let data = outputs[c.op].parse(reply);
        if (c.op === 'rooms') for (const r of outputs.rooms.parse(data)) media.rooms.add(r.id);
        if (c.op === 'direct' || c.op === 'group')
          media.rooms.add(outputs[c.op].parse(data).data.id);
        if (c.op === 'history') data = await media.history(outputs.history.parse(data));
        return { version: 1, ok: true, data };
      } finally {
        client.close();
      }
    } catch (e) {
      return failure(
        e instanceof Error && /^[a-z_]+$/.test(e.message)
          ? e.message
          : (e as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? 'attachment_unavailable'
            : 'outcome_unknown',
      );
    } finally {
      inflight--;
    }
  });
  win.on('closed', () => detached.abort());
  await win.loadURL(page);
}
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(open);
