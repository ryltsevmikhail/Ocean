import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
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
  let active: { id: string; abort: () => void } | undefined;
  let busy = false;
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
    const parsed = commands.safeParse(raw);
    if (!parsed.success) return failure('invalid_request');
    if (busy) return failure('owner_busy');
    busy = true;
    const c = parsed.data;
    try {
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
        child.stdin?.end(JSON.stringify(c));
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
      const data =
        c.op === 'runs'
          ? outputs.runs.parse(reply.data).filter((run) => run.roomId === c.room)
          : outputs[c.op].parse(reply.data);
      return { version: 1, ok: true, data };
    } catch {
      return failure('outcome_unknown');
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
