import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AttachmentHost } from './attachment-host.js';
import { attachmentCommands } from '../attachments.js';
import { commands, envelope, outputs } from '../protocol.js';

process.umask(0o077);
app.enableSandbox();
const dist = resolve(import.meta.dirname, '../..');
const page = pathToFileURL(join(dist, 'web/index.html')).href;
const cancel = z.strictObject({ op: z.literal('cancel'), requestId: z.uuid() });
const failure = (code: string) => ({ version: 1, ok: false, error: { code } });
async function open() {
  const node = process.env['OCEAN_DESKTOP_NODE'];
  if (
    !node ||
    !isAbsolute(node) ||
    !/^v26\./.test(execFileSync(node, ['--version'], { encoding: 'utf8' }))
  )
    throw new Error('Ocean Desktop requires external Node 26');
  const root = join(app.getPath('userData'), 'conversation');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
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
  const media = new AttachmentHost(root, win);
  let active: { id: string; abort: () => void } | undefined;
  let busy = false;
  let importing = false;
  ipcMain.handle('ocean:request', async (event, raw: unknown) => {
    if (
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      !event.senderFrame ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      return failure('invalid_request');
    const stop = cancel.safeParse(raw);
    if (stop.success) {
      if (active?.id !== stop.data.requestId) return failure('no_active_send');
      active.abort();
      return { version: 1, ok: true, data: {} };
    }
    const asset = attachmentCommands.safeParse(raw);
    if (asset.success) {
      if (asset.data.op === 'attachment-import' && (busy || importing))
        return failure('owner_busy');
      if (asset.data.op === 'attachment-import') importing = true;
      try {
        return { version: 1, ok: true, data: await media.handle(asset.data) };
      } catch (e) {
        const code =
          e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'attachment_unavailable';
        return failure(code);
      } finally {
        if (asset.data.op === 'attachment-import') importing = false;
      }
    }
    const parsed = commands.safeParse(raw);
    if (!parsed.success) return failure('invalid_request');
    if (busy || importing) return failure('owner_busy');
    busy = true;
    const c = parsed.data;
    try {
      const input = c.op === 'send' ? await media.prepare(c) : c;
      const rawReply = await new Promise<string>((done, reject) => {
        const child = execFile(
          node,
          [join(import.meta.dirname, 'worker.js'), join(root, 'profile'), workspace],
          { maxBuffer: 8 * 1024 * 1024 },
          (_err, stdout) => {
            if (!stdout) reject(new Error());
            else done(stdout);
          },
        );
        child.stdin?.on('error', () => {
          /* Child exit determines outcome. */
        });
        child.stdin?.end(JSON.stringify(input));
        if (c.op === 'send')
          active = {
            id: c.requestId,
            abort: () => {
              child.kill('SIGINT');
            },
          };
      });
      const reply = envelope.parse(JSON.parse(rawReply));
      if (!reply.ok) return reply;
      let data =
        c.op === 'runs'
          ? outputs.runs.parse(reply.data).filter((run) => run.roomId === c.room)
          : outputs[c.op].parse(reply.data);
      if (c.op === 'rooms') for (const r of outputs.rooms.parse(data)) media.rooms.add(r.id);
      if (c.op === 'direct' || c.op === 'group') media.rooms.add(outputs[c.op].parse(data).data.id);
      if (c.op === 'history') data = await media.history(outputs.history.parse(data));
      return { version: 1, ok: true, data };
    } catch (e) {
      return failure(
        e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'outcome_unknown',
      );
    } finally {
      active = undefined;
      busy = false;
    }
  });
  win.on('closed', () => active?.abort());
  await win.loadURL(page);
}
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(open);
