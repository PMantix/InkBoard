// Floating toolbar, popovers and zoom control.
import { colorWheel } from './colorPicker';
import type { Editor, ToolId } from './editor';
import { PAPER_COLORS, type GridKind, type InkStyle } from './model';

export const PEN_COLORS = [
  '#000000', '#FFFFFF', '#7A7574', '#E71224', '#F7630C', '#FFC114',
  '#02A556', '#00B7C3', '#0069BF', '#8764B8', '#E3008C', '#8E562E',
];
export const HIGHLIGHTER_COLORS = ['#FFF100', '#9CF27A', '#7FE3FF', '#FFA8E0', '#FFB870', '#C9A8FF'];
export const PEN_WIDTHS = [1.5, 2.5, 3.5, 5, 8, 12];
export const HIGHLIGHTER_WIDTHS = [12, 18, 24, 32];

const GRIDS: { id: GridKind; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'dot', label: 'Dots' },
  { id: 'graph', label: 'Grid' },
  { id: 'rule', label: 'Lines' },
  { id: 'compactRule', label: 'Narrow' },
  { id: 'triangular', label: 'Triangles' },
];

const icon = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  select: icon('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  pan: icon('<path d="M8 13V5.5a1.5 1.5 0 013 0V12m0-1.5v-6a1.5 1.5 0 013 0v6m0-4a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L4.6 15a1.6 1.6 0 012.6-1.8L8 14"/>'),
  eraser: icon('<path d="M7 20h11M4.6 14.6l8.8-8.8a2 2 0 012.8 0l2 2a2 2 0 010 2.8L11 18H7.4z"/><path d="M9 10l5 5"/>'),
  shapes: icon('<path d="M4 20l5-9 5 9z"/><circle cx="17" cy="7" r="3.5"/><path d="M14 2.5l.6 1.4M20.5 13l-1.4.6M21.5 2.5l-1 1"/>'),
  image: icon('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>'),
  undo: icon('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>'),
  redo: icon('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>'),
  paper: icon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" stroke-width="2.4"/>'),
  minus: icon('<path d="M6 12h12"/>'),
  plus: icon('<path d="M6 12h12M12 6v12"/>'),
};

/** Upright pen illustration whose tip and band take the ink colour. */
function penSvg(style: InkStyle) {
  const c = style.color;
  if (style.kind === 'highlighter') {
    return `<svg viewBox="0 0 26 46" aria-hidden="true"><path d="M7 46V17h12v29z" fill="#e9e9e9" stroke="rgba(0,0,0,.18)"/><path d="M7 17l2-7h8l2 7z" fill="#d6d6d6" stroke="rgba(0,0,0,.18)"/><path d="M9 10V3l8 3v4z" fill="${c}" stroke="rgba(0,0,0,.25)"/><rect x="7" y="22" width="12" height="5" fill="${c}"/></svg>`;
  }
  return `<svg viewBox="0 0 26 46" aria-hidden="true"><path d="M8 46V18h10v28z" fill="#f4f4f4" stroke="rgba(0,0,0,.18)"/><path d="M8 18l5-14 5 14z" fill="#e2d3bf" stroke="rgba(0,0,0,.18)"/><path d="M11.2 9l1.8-5 1.8 5z" fill="${c}"/><rect x="8" y="22" width="10" height="5" fill="${c}"/></svg>`;
}

export class Toolbar {
  private bar = document.getElementById('toolbar')!;
  private pop = document.getElementById('popover')!;
  private zoomEl = document.getElementById('zoom')!;
  private popFor: string | null = null;
  private wheelOpen = false;

  constructor(private ed: Editor, private actions: { importFiles(): void; saveSettings(): void }) {
    ed.onChange(() => this.render());
    ed.view.onChange(() => this.renderZoom());
    document.addEventListener('pointerdown', (e) => {
      if (this.popFor && !(e.target as HTMLElement).closest('#popover, #toolbar')) this.closePop();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePop();
    });
    this.render();
    this.renderZoom();
  }

  private btn(id: string, html: string, title: string, pressed: boolean | null, onClick: (el: HTMLElement) => void, cls = 'tb') {
    const b = document.createElement('button');
    b.className = cls;
    b.dataset.id = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
    b.innerHTML = html;
    b.addEventListener('click', () => onClick(b));
    this.bar.appendChild(b);
    return b;
  }

  private sep() {
    const s = document.createElement('div');
    s.className = 'sep';
    this.bar.appendChild(s);
  }

  render() {
    const ed = this.ed;
    const s = ed.settings;
    this.bar.replaceChildren();
    const toolBtn = (tool: ToolId, title: string) =>
      this.btn(tool, ICONS[tool as keyof typeof ICONS], title, ed.tool === tool, (el) => {
        if (ed.tool === tool && tool === 'eraser') this.togglePop('eraser', el, () => this.eraserPop());
        else ed.setTool(tool);
      });

    toolBtn('select', 'Select (lasso)');
    toolBtn('pan', 'Pan');
    this.sep();
    s.pens.forEach((pen, i) => {
      const active = ed.tool === 'pen' && s.activePen === i;
      this.btn(`pen${i}`, penSvg(pen), `Pen ${i + 1}`, active, (el) => {
        if (active) this.togglePop(`pen${i}`, el, () => this.stylePop(pen, PEN_COLORS, PEN_WIDTHS));
        else {
          s.activePen = i;
          ed.setTool('pen');
        }
      }, 'tb pen');
    });
    const hl = ed.tool === 'highlighter';
    this.btn('highlighter', penSvg(s.highlighter), 'Highlighter', hl, (el) => {
      if (hl) this.togglePop('highlighter', el, () => this.stylePop(s.highlighter, HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS));
      else ed.setTool('highlighter');
    }, 'tb pen');
    toolBtn('eraser', `Eraser (${s.eraser === 'stroke' ? 'stroke' : 'point'}) — click again for options`);
    this.sep();
    this.btn('shapes', ICONS.shapes, `Ink to shape: ${s.autoShapes ? 'on' : 'off'} (or draw and hold)`, s.autoShapes, () => {
      s.autoShapes = !s.autoShapes;
      this.actions.saveSettings();
      this.render();
    });
    this.btn('image', ICONS.image, 'Insert image', null, () => this.actions.importFiles());
    this.btn('paper', ICONS.paper, 'Background', null, (el) => this.togglePop('paper', el, () => this.paperPop()));
    this.sep();
    this.btn('undo', ICONS.undo, 'Undo', null, () => ed.history.undo()).toggleAttribute('disabled', !ed.history.canUndo);
    this.btn('redo', ICONS.redo, 'Redo', null, () => ed.history.redo()).toggleAttribute('disabled', !ed.history.canRedo);
    if (this.popFor) {
      const anchor = this.bar.querySelector<HTMLElement>(`[data-id="${this.popFor}"]`);
      if (anchor) this.place(anchor);
    }
  }

  private renderZoom() {
    const z = this.zoomEl;
    z.replaceChildren();
    const mk = (html: string, title: string, fn: () => void, cls = 'tb') => {
      const b = document.createElement('button');
      b.className = cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = html;
      b.addEventListener('click', fn);
      z.appendChild(b);
    };
    mk(ICONS.minus, 'Zoom out', () => this.ed.zoomBy(1 / 1.25));
    mk(`${Math.round(this.ed.view.zoom * 100)}%`, 'Fit to content', () => this.ed.fit(), 'pct');
    mk(ICONS.plus, 'Zoom in', () => this.ed.zoomBy(1.25));
  }

  // ---------- popovers ----------

  private togglePop(id: string, anchor: HTMLElement, build: () => void) {
    if (this.popFor === id) return this.closePop();
    this.popFor = id;
    this.wheelOpen = false;
    this.pop.replaceChildren();
    build();
    this.pop.hidden = false;
    this.place(anchor);
  }

  private closePop() {
    this.popFor = null;
    this.pop.hidden = true;
  }

  private place(anchor: HTMLElement) {
    const a = anchor.getBoundingClientRect();
    const p = this.pop.getBoundingClientRect();
    const left = Math.min(window.innerWidth - p.width - 8, Math.max(8, a.left + a.width / 2 - p.width / 2));
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${a.top - p.height - 12}px`;
  }

  private heading(text: string) {
    const h = document.createElement('h3');
    h.textContent = text;
    this.pop.appendChild(h);
  }

  private swatch(color: string, selected: boolean, onPick: () => void) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = color;
    b.title = color;
    b.setAttribute('aria-label', color);
    b.setAttribute('aria-pressed', String(selected));
    b.addEventListener('click', onPick);
    return b;
  }

  private stylePop(style: InkStyle, colors: string[], widths: number[]) {
    const settings = this.ed.settings;
    const rebuild = () => this.refreshPop(() => this.stylePop(style, colors, widths));
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const choose = (c: string) => {
      style.color = c;
      this.actions.saveSettings();
      this.render();
      rebuild();
    };

    this.heading('Colour');
    const sw = document.createElement('div');
    sw.className = 'swatches';
    for (const c of colors) sw.appendChild(this.swatch(c, same(style.color, c), () => choose(c)));
    this.pop.appendChild(sw);

    this.heading('Custom');
    const custom = document.createElement('div');
    custom.className = 'swatches';
    for (const c of settings.customColors) {
      const b = this.swatch(c, same(style.color, c), () => choose(c));
      b.title = `${c} (right-click to remove)`;
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        settings.customColors = settings.customColors.filter((x) => !same(x, c));
        this.actions.saveSettings();
        rebuild();
      });
      custom.appendChild(b);
    }
    const add = document.createElement('button');
    add.className = 'swatch add-swatch';
    add.title = 'Pick any colour';
    add.setAttribute('aria-label', 'Pick any colour');
    add.setAttribute('aria-pressed', String(this.wheelOpen));
    add.textContent = '+';
    add.addEventListener('click', () => {
      this.wheelOpen = !this.wheelOpen;
      rebuild();
    });
    custom.appendChild(add);
    this.pop.appendChild(custom);

    if (this.wheelOpen) {
      let picked = style.color;
      const wheel = colorWheel(style.color, (hex) => (picked = hex));
      const use = document.createElement('button');
      use.className = 'menu-item wheel-add';
      use.textContent = 'Add colour';
      use.addEventListener('click', () => {
        if (!settings.customColors.some((c) => same(c, picked))) settings.customColors = [...settings.customColors, picked].slice(-12);
        this.wheelOpen = false;
        choose(picked);
      });
      wheel.appendChild(use);
      this.pop.appendChild(wheel);
    }

    this.heading('Opacity');
    const op = document.createElement('div');
    op.className = 'opacity';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '10';
    range.max = '100';
    range.step = '5';
    range.value = String(Math.round((style.opacity ?? 1) * 100));
    range.setAttribute('aria-label', 'Opacity');
    const label = document.createElement('span');
    const paint = () => {
      label.textContent = `${range.value}%`;
      range.style.setProperty('--ink', style.color);
    };
    range.addEventListener('input', () => {
      style.opacity = Number(range.value) / 100;
      paint();
    });
    range.addEventListener('change', () => this.actions.saveSettings());
    paint();
    op.append(range, label);
    this.pop.appendChild(op);

    this.heading('Thickness');
    const ws = document.createElement('div');
    ws.className = 'widths';
    for (const w of widths) {
      const b = document.createElement('button');
      b.className = 'width';
      b.title = `${w}`;
      b.setAttribute('aria-pressed', String(style.width === w));
      const dot = document.createElement('span');
      const d = Math.min(26, style.kind === 'highlighter' ? w * 0.7 : w * 1.6 + 2);
      dot.style.width = dot.style.height = `${d}px`;
      if (style.kind === 'highlighter') dot.style.borderRadius = '3px';
      b.appendChild(dot);
      b.addEventListener('click', () => {
        style.width = w;
        this.actions.saveSettings();
        rebuild();
      });
      ws.appendChild(b);
    }
    this.pop.appendChild(ws);
  }

  private eraserPop() {
    const s = this.ed.settings;
    for (const [mode, label] of [['stroke', 'Stroke eraser — removes whole strokes'], ['point', 'Point eraser — erases just what you touch']] as const) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(s.eraser === mode));
      b.addEventListener('click', () => {
        s.eraser = mode;
        this.actions.saveSettings();
        this.closePop();
        this.render();
      });
      this.pop.appendChild(b);
    }
  }

  private paperPop() {
    const bg = this.ed.board.background;
    this.heading('Paper');
    const sw = document.createElement('div');
    sw.className = 'swatches';
    for (const c of PAPER_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.setAttribute('aria-pressed', String(bg.color.toLowerCase() === c.toLowerCase()));
      b.addEventListener('click', () => {
        bg.color = c;
        this.ed.changed();
        this.refreshPop(() => this.paperPop());
      });
      sw.appendChild(b);
    }
    this.pop.appendChild(sw);
    this.heading('Pattern');
    const gr = document.createElement('div');
    gr.className = 'grids';
    for (const g of GRIDS) {
      const b = document.createElement('button');
      b.className = 'grid-opt';
      b.textContent = g.label;
      b.setAttribute('aria-pressed', String(bg.grid === g.id));
      b.addEventListener('click', () => {
        bg.grid = g.id;
        this.ed.changed();
        this.refreshPop(() => this.paperPop());
      });
      gr.appendChild(b);
    }
    this.pop.appendChild(gr);
  }

  private refreshPop(build: () => void) {
    this.pop.replaceChildren();
    build();
    // Content height can change (e.g. the colour wheel opening), so re-anchor.
    const anchor = this.popFor ? this.bar.querySelector<HTMLElement>(`[data-id="${this.popFor}"]`) : null;
    if (anchor) this.place(anchor);
  }
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
