// Electron main process: window lifecycle, native menus, file I/O and autosave.
// The renderer never touches the filesystem directly; it goes through preload.cjs.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.INKBOARD_DEV_URL;
const autosaveDir = () => path.join(app.getPath('userData'), 'autosave');

// Per-window document path, so title bar and Save know where the board lives.
const docPaths = new Map();

function setDocPath(win, filePath) {
  docPaths.set(win.id, filePath ?? null);
  const name = filePath ? path.basename(filePath) : 'Untitled';
  win.setTitle(`${name} — Inkboard`);
  if (filePath) {
    win.setRepresentedFilename?.(filePath);
    app.addRecentDocument(filePath);
  }
}

function createWindow(openPath) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f6f6f4',
    title: 'Inkboard',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  setDocPath(win, null);
  win.on('closed', () => docPaths.delete(win.id));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(here, '..', 'dist', 'index.html'));
  if (openPath) {
    win.webContents.once('did-finish-load', () => openInWindow(win, openPath));
  }
  return win;
}

async function openInWindow(win, filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    setDocPath(win, filePath);
    win.webContents.send('board:loaded', { path: filePath, text });
  } catch (err) {
    dialog.showErrorBox('Could not open board', `${filePath}\n\n${err.message}`);
  }
}

const send = (cmd) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', cmd);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Import Image / SVG / PDF page…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        {
          label: 'Export',
          submenu: [
            { label: 'PNG…', click: send('exportPng') },
            { label: 'SVG…', click: send('exportSvg') },
            { label: 'PDF…', click: send('exportPdf') },
          ],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Delete Selection', accelerator: 'Delete', click: send('delete') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('selectAll') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { label: 'Fit to Content', accelerator: 'CmdOrCtrl+0', click: send('fit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(devUrl || !app.isPackaged ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const BOARD_FILTERS = [{ name: 'Inkboard board', extensions: ['inkboard'] }];

ipcMain.handle('board:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { filters: BOARD_FILTERS, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = await fs.readFile(r.filePaths[0], 'utf8');
  setDocPath(win, r.filePaths[0]);
  return { path: r.filePaths[0], text };
});

ipcMain.handle('board:save', async (e, { text, saveAs }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  let target = docPaths.get(win.id);
  if (!target || saveAs) {
    const r = await dialog.showSaveDialog(win, { filters: BOARD_FILTERS, defaultPath: 'Board.inkboard' });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, target);
  setDocPath(win, target);
  return target;
});

ipcMain.handle('board:autosave', async (_e, text) => {
  await fs.mkdir(autosaveDir(), { recursive: true });
  const file = path.join(autosaveDir(), 'last.inkboard');
  await fs.writeFile(`${file}.tmp`, text, 'utf8');
  await fs.rename(`${file}.tmp`, file);
});

ipcMain.handle('board:restore', async () => {
  try {
    return await fs.readFile(path.join(autosaveDir(), 'last.inkboard'), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('file:import', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images, SVG, PDF', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'] }],
  });
  if (r.canceled) return [];
  return Promise.all(
    r.filePaths.map(async (p) => ({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) })),
  );
});

ipcMain.handle('file:export', async (e, { bytes, defaultName, ext }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(bytes));
  return r.filePath;
});

// PDF export: render an export-only SVG page in a hidden window and print it.
ipcMain.handle('file:exportPdf', async (e, { svg, width, height }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'Board.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const off = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    const html = `<!doctype html><meta charset="utf-8"><style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0}svg{display:block}</style>${svg}`;
    await off.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await off.webContents.printToPDF({
      printBackground: true,
      pageSize: { width: width / 96, height: height / 96 },
      margins: { marginType: 'none' },
    });
    await fs.writeFile(r.filePath, pdf);
    return r.filePath;
  } finally {
    off.destroy();
  }
});

const pendingOpen = process.argv.find((a) => a.endsWith('.inkboard'));
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) createWindow(filePath);
});

app.whenReady().then(() => {
  buildMenu();
  createWindow(pendingOpen);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
