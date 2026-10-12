// App bootstrap: editor + toolbar, persistence, menu commands, clipboard, import/export.
import { defaultSettings, Editor, type Settings } from './editor';
import { importWhiteboardClipboard } from './import/whiteboard';
import { deserialize, emptyBoard, newId, serialize, type ImageItem, type Item } from './model';
import { exportPng, exportSvg } from './render/export';
import { toast, Toolbar } from './ui';

interface Bridge {
  open(): Promise<{ path: string; text: string } | null>;
  save(text: string, saveAs?: boolean): Promise<string | null>;
  autosave(text: string): Promise<void>;
  restore(): Promise<string | null>;
  importFiles(): Promise<{ name: string; bytes: Uint8Array }[]>;
  exportFile(bytes: Uint8Array, defaultName: string, ext: string): Promise<string | null>;
  exportPdf(svg: string, width: number, height: number): Promise<string | null>;
  onMenu(fn: (cmd: string) => void): void;
  onLoaded(fn: (doc: { path: string; text: string }) => void): void;
}

const bridge = (window as unknown as { inkboard?: Bridge }).inkboard;
const SETTINGS_KEY = 'inkboard.settings.v1';
const CLIP_MIME = 'web application/x-inkboard+json';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  return defaultSettings();
}

const editor = new Editor(document.getElementById('stage')!, loadSettings());
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(editor.settings));
  } catch {
    // Non-fatal: settings just won't persist.
  }
};

const toolbar = new Toolbar(editor, { importFiles: () => void importFiles(), saveSettings });
void toolbar;

// ---------- persistence ----------

let autosaveTimer = 0;
let dirty = false;
const snapshot = () => serialize({ ...editor.board, view: { x: editor.view.x, y: editor.view.y, zoom: editor.view.zoom } });

editor.onChange(() => {
  dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (bridge) void bridge.autosave(snapshot());
    else localStorage.setItem('inkboard.autosave', snapshot());
  }, 1200);
});

async function restore() {
  let board = emptyBoard();
  try {
    const text = bridge ? await bridge.restore() : localStorage.getItem('inkboard.autosave');
    if (text) board = deserialize(text);
  } catch (err) {
    console.warn('Could not restore autosave', err);
  }
  // The user may have started drawing while the autosave was loading; never clobber that.
  if (editor.board.items.length || editor.history.canUndo) return;
  editor.load(board);
}

async function save(saveAs = false) {
  if (!bridge) return toast('Saving needs the desktop app');
  const path = await bridge.save(snapshot(), saveAs);
  if (path) {
    dirty = false;
    toast(`Saved ${path.split(/[\\/]/).pop()}`);
  }
}

async function open() {
  if (!bridge) return;
  const doc = await bridge.open();
  if (doc) loadText(doc.text);
}

function loadText(text: string) {
  try {
    editor.load(deserialize(text));
    dirty = false;
  } catch (err) {
    toast(`Could not open: ${(err as Error).message}`);
  }
}

window.addEventListener('beforeunload', () => {
  if (dirty && bridge) void bridge.autosave(snapshot());
});

// ---------- images ----------

const mimeFor = (name: string) => {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function imageItem(src: string): Promise<ImageItem> {
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => undefined);
  const w0 = img.naturalWidth || 400;
  const h0 = img.naturalHeight || 300;
  // Fit within 60% of the visible area (in world units) without upscaling small images.
  const vis = editor.view.visibleWorld();
  const s = Math.min(1, (vis.w * 0.6) / w0, (vis.h * 0.6) / h0);
  return { id: newId(), type: 'image', src, x: 0, y: 0, w: w0 * s, h: h0 * s };
}

async function importFiles() {
  if (!bridge) return;
  const files = await bridge.importFiles();
  const items: Item[] = [];
  for (const f of files) {
    const blob = new Blob([f.bytes as BlobPart], { type: mimeFor(f.name) });
    items.push(await imageItem(await blobToDataUrl(blob)));
  }
  layoutRow(items);
  editor.insertItems(items);
}

/** Place several inserted images side by side. */
function layoutRow(items: Item[]) {
  let x = 0;
  for (const it of items) {
    if (it.type !== 'image') continue;
    it.x = x;
    x += it.w + 24;
  }
}

// ---------- clipboard ----------

document.addEventListener('copy', (e) => {
  const items = editor.selectedItems();
  if (!items.length || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData(CLIP_MIME, JSON.stringify(items));
  e.clipboardData.setData('text/plain', `${items.length} Inkboard item(s)`);
});

document.addEventListener('cut', (e) => {
  const items = editor.selectedItems();
  if (!items.length || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData(CLIP_MIME, JSON.stringify(items));
  editor.deleteSelection();
});

document.addEventListener('paste', async (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  const own = dt.getData(CLIP_MIME);
  if (own) {
    const items = (JSON.parse(own) as Item[]).map((it) => ({ ...it, id: newId() }));
    editor.insertItems(items);
    return;
  }
  // Microsoft Whiteboard puts its board JSON inside the HTML flavour.
  const html = dt.getData('text/html');
  if (html.includes('whiteboardcontent')) {
    try {
      const { items, skipped } = await importWhiteboardClipboard(html);
      editor.insertItems(items);
      toast(`Imported ${items.length} item(s) from Whiteboard${skipped ? ` — ${skipped} unsupported skipped` : ''}`, 4000);
    } catch (err) {
      toast(`Whiteboard import failed: ${(err as Error).message}`, 5000);
      console.error(err);
    }
    return;
  }
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    const items: Item[] = [];
    for (const f of files) items.push(await imageItem(await blobToDataUrl(f)));
    layoutRow(items);
    editor.insertItems(items);
  }
});

// ---------- menu ----------

async function exportAs(kind: 'png' | 'svg' | 'pdf') {
  if (!bridge) return;
  const items = editor.selection.size ? editor.selectedItems() : editor.board.items;
  if (!items.length) return toast('Nothing to export yet');
  if (kind === 'png') {
    const path = await bridge.exportFile(await exportPng(editor.board, items), 'Board.png', 'png');
    if (path) toast('Exported PNG');
  } else if (kind === 'svg') {
    const { svg } = exportSvg(editor.board, items);
    const path = await bridge.exportFile(new TextEncoder().encode(svg), 'Board.svg', 'svg');
    if (path) toast('Exported SVG');
  } else {
    const { svg, width, height } = exportSvg(editor.board, items);
    const path = await bridge.exportPdf(svg, width, height);
    if (path) toast('Exported PDF');
  }
}

bridge?.onMenu((cmd) => {
  switch (cmd) {
    case 'open':
      return void open();
    case 'save':
      return void save();
    case 'saveAs':
      return void save(true);
    case 'import':
      return void importFiles();
    case 'exportPng':
      return void exportAs('png');
    case 'exportSvg':
      return void exportAs('svg');
    case 'exportPdf':
      return void exportAs('pdf');
    case 'undo':
      return editor.history.undo();
    case 'redo':
      return editor.history.redo();
    case 'delete':
      return editor.deleteSelection();
    case 'selectAll':
      return editor.selectAll();
    case 'zoomIn':
      return editor.zoomBy(1.25);
    case 'zoomOut':
      return editor.zoomBy(1 / 1.25);
    case 'fit':
      return editor.fit();
  }
});

bridge?.onLoaded((doc) => loadText(doc.text));

// Editing shortcuts are owned by the renderer (the menu shows them but doesn't register
// them), so each keypress acts exactly once in Electron and in a plain browser.
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z') {
    e.preventDefault();
    if (e.shiftKey) editor.history.redo();
    else editor.history.undo();
  } else if (k === 'y') {
    e.preventDefault();
    editor.history.redo();
  } else if (k === 'a') {
    e.preventDefault();
    editor.selectAll();
  }
});

// Single-key tool shortcuts.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'p') editor.setTool('pen');
  else if (k === 'h') editor.setTool('highlighter');
  else if (k === 'e') editor.setTool('eraser');
  else if (k === 'v' || k === 's') editor.setTool('select');
});

void restore();

// Debug handle for automated UI tests.
(window as unknown as { __inkboard: Editor }).__inkboard = editor;
