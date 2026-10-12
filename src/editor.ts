// The board editor: canvas layers, pointer routing and the drawing / erasing / selection tools.
//
// Layers (bottom → top):
//   scene   – background + committed items (redrawn on view change / edits)
//   wet     – the stroke being drawn (low-latency, desynchronized context)
//   overlay – prediction tail, lasso, eraser cursor, selection chrome
import {
  bounds,
  dist,
  distToSegment,
  pointInPolygon,
  polylineLength,
  rectContains,
  rectsIntersect,
  segmentsIntersect,
  unionRect,
  type Rect,
  type Vec,
} from './geom';
import { History, emptyPatch, type Patch } from './history';
import { DelegatedInk } from './ink/delegated';
import { emitStroke, Path2DSink } from './ink/geometry';
import { clampPressure, decimate, InkPipeline, pressureFactor } from './ink/pipeline';
import {
  emptyBoard,
  inkOpacity,
  itemBounds,
  newId,
  shapeOutline,
  type Board,
  type InkPoint,
  type InkStyle,
  type Item,
  type StrokeItem,
} from './model';
import { drawItem, drawScene } from './render/scene';
import { isStraight, lineToInk, recognize, trySnap, tryStraight } from './shapes/recognize';
import { Viewport } from './viewport';

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'select' | 'pan';
export type EraserMode = 'stroke' | 'point';

export interface Settings {
  pens: InkStyle[];
  activePen: number;
  highlighter: InkStyle;
  eraser: EraserMode;
  autoShapes: boolean;
  /** User-added colours, shared by all pens and the highlighter. */
  customColors: string[];
}

export const defaultSettings = (): Settings => ({
  pens: [
    { kind: 'pen', color: '#000000', width: 3.5 },
    { kind: 'pen', color: '#0069BF', width: 3.5 },
    { kind: 'pen', color: '#E71224', width: 3.5 },
  ],
  activePen: 0,
  highlighter: { kind: 'highlighter', color: '#FFF100', width: 22 },
  eraser: 'stroke',
  autoShapes: true,
  customColors: [],
});

const HOLD_MS = 500;
const HOLD_JITTER_PX = 5;
const STROKE_ERASER_PX = 16;
const POINT_ERASER_PX = 10;
const HANDLE_PX = 9;

interface Gesture {
  move(e: PointerEvent, samples: PointerEvent[]): void;
  up(e: PointerEvent): void;
  cancel(): void;
  frame?(): void;
}

function makeLayer(stage: HTMLElement, cls: string, opts?: CanvasRenderingContext2DSettings) {
  const c = document.createElement('canvas');
  c.className = `layer ${cls}`;
  stage.appendChild(c);
  const ctx = c.getContext('2d', opts) as CanvasRenderingContext2D;
  return { canvas: c, ctx };
}

export class Editor {
  board: Board = emptyBoard();
  readonly view = new Viewport();
  readonly history: History;
  settings: Settings;
  tool: ToolId = 'pen';
  selection = new Set<string>();

  readonly scene;
  readonly wet;
  readonly overlay;
  readonly delegated: DelegatedInk;
  dpr = window.devicePixelRatio || 1;

  private gesture: Gesture | null = null;
  private gesturePointer: number | null = null;
  private touches = new Map<number, Vec>();
  private pinch: { d: number; c: Vec } | null = null;
  private penSeen = false;
  private spaceDown = false;
  private sceneDirty = true;
  /** Content changed: the next scene render must redraw everything (no scroll blit). */
  private sceneFull = true;
  private lastRender: { tx: number; ty: number; zoom: number; w: number; h: number } | null = null;
  private overlayDirty = true;
  private raf = 0;
  private listeners = new Set<() => void>();
  /** Items hidden from the scene while a gesture renders them elsewhere. */
  hidden = new Set<string>();

  constructor(readonly stage: HTMLElement, settings: Settings) {
    this.settings = settings;
    this.scene = makeLayer(stage, 'scene', { alpha: false });
    this.wet = makeLayer(stage, 'wet', { desynchronized: true });
    this.overlay = makeLayer(stage, 'overlay');
    this.delegated = new DelegatedInk(this.overlay.canvas);
    this.history = new History(
      () => this.board.items,
      () => this.changed(),
    );
    this.view.onChange(() => {
      this.sceneDirty = true;
      this.overlayDirty = true;
      this.schedule();
    });
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.bindInput();
  }

  // ---------- state / notifications ----------

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  /** Board content changed (edit, undo, load): redraw and notify UI/autosave. */
  changed() {
    this.selection = new Set([...this.selection].filter((id) => this.board.items.some((it) => it.id === id)));
    this.sceneDirty = this.sceneFull = true;
    this.overlayDirty = true;
    this.schedule();
    for (const fn of this.listeners) fn();
  }

  /** Notify UI listeners without touching the board (selection/tool changes). */
  notify() {
    this.overlayDirty = true;
    this.schedule();
    for (const fn of this.listeners) fn();
  }

  /** Redraw the scene during a gesture without notifying listeners (no autosave churn). */
  changedLive() {
    this.sceneDirty = this.sceneFull = true;
    this.schedule();
  }

  /** Apply and record an edit. */
  commit(p: Patch) {
    const items = this.board.items;
    for (const r of [...p.removed].sort((a, b) => b.index - a.index)) {
      const i = items.findIndex((it) => it.id === r.item.id);
      if (i >= 0) items.splice(i, 1);
    }
    for (const c of p.changed) {
      const i = items.findIndex((it) => it.id === c.before.id);
      if (i >= 0) items[i] = c.after;
    }
    items.push(...p.added);
    this.history.push(p);
    this.changed();
  }

  load(board: Board) {
    this.board = board;
    this.selection.clear();
    this.history.clear();
    if (board.view) this.view.set(board.view.x, board.view.y, board.view.zoom);
    else this.fit();
    this.changed();
  }

  setTool(t: ToolId) {
    this.tool = t;
    if (t !== 'select') this.selection.clear();
    this.stage.dataset.tool = t;
    this.notify();
  }

  activeStyle(): InkStyle {
    return this.tool === 'highlighter' ? this.settings.highlighter : this.settings.pens[this.settings.activePen];
  }

  fit() {
    let r: Rect | null = null;
    for (const it of this.board.items) r = unionRect(r, itemBounds(it));
    this.view.fit(r);
  }

  zoomBy(f: number) {
    this.view.zoomAt(this.view.width / 2, this.view.height / 2, f);
  }

  deleteSelection() {
    if (!this.selection.size) return;
    const p = emptyPatch();
    this.board.items.forEach((it, index) => {
      if (this.selection.has(it.id)) p.removed.push({ item: it, index });
    });
    this.selection.clear();
    this.commit(p);
  }

  /**
   * Select every item on the board, as if lassoed, ready to move, resize or delete.
   * The current tool stays active: drawing outside the selection simply clears it.
   */
  selectAll() {
    this.selection = new Set(this.board.items.map((it) => it.id));
    this.notify();
  }

  selectedItems(): Item[] {
    return this.board.items.filter((it) => this.selection.has(it.id));
  }

  /** Add items (e.g. paste/import) centred on the viewport and select them. */
  insertItems(items: Item[], at?: Vec) {
    if (!items.length) return;
    let r: Rect | null = null;
    for (const it of items) r = unionRect(r, itemBounds(it));
    const target = at ?? this.view.toWorld(this.view.width / 2, this.view.height / 2);
    const dx = target.x - (r!.x + r!.w / 2);
    const dy = target.y - (r!.y + r!.h / 2);
    const moved = items.map((it) => transformItem(it, (p) => ({ x: p.x + dx, y: p.y + dy }), 1));
    const p = emptyPatch();
    p.added = moved;
    this.commit(p);
    this.setTool('select');
    this.selection = new Set(moved.map((it) => it.id));
  }

  // ---------- rendering ----------

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    for (const l of [this.scene, this.wet, this.overlay]) {
      l.canvas.width = Math.round(w * this.dpr);
      l.canvas.height = Math.round(h * this.dpr);
    }
    if (this.view.width === 0) this.view.set(-w / 2, -h / 2, 1);
    this.view.resize(w, h);
  }

  /** Set a context's transform to world coordinates. */
  /**
   * World → device transform. The translation is rounded to whole device pixels so the
   * scene can be scrolled by copying pixels (no resampling blur) and all layers line up.
   */
  worldTransform(ctx: CanvasRenderingContext2D) {
    const s = this.dpr * this.view.zoom;
    ctx.setTransform(s, 0, 0, s, Math.round(-this.view.x * s), Math.round(-this.view.y * s));
  }

  private renderScene() {
    const ctx = this.scene.ctx;
    const s = this.dpr * this.view.zoom;
    const tx = Math.round(-this.view.x * s);
    const ty = Math.round(-this.view.y * s);
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const last = this.lastRender;
    this.lastRender = { tx, ty, zoom: this.view.zoom, w, h };
    const opts = {
      scale: s,
      hidden: this.hidden,
      onImageReady: () => {
        this.sceneDirty = this.sceneFull = true;
        this.schedule();
      },
    };
    const dx = last ? tx - last.tx : 0;
    const dy = last ? ty - last.ty : 0;
    const canScroll = !this.sceneFull && last && last.zoom === this.view.zoom && last.w === w && last.h === h && Math.abs(dx) < w && Math.abs(dy) < h;
    this.sceneFull = false;
    if (!canScroll) {
      this.worldTransform(ctx);
      drawScene(ctx, this.board.background, this.board.items, { ...opts, world: this.view.visibleWorld() });
      return;
    }
    if (dx === 0 && dy === 0) return;
    // Pan: shift existing pixels, then repaint only the newly exposed strips.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(ctx.canvas, dx, dy);
    ctx.globalCompositeOperation = 'source-over';
    const strips: [number, number, number, number][] = [];
    if (dx > 0) strips.push([0, 0, dx, h]);
    if (dx < 0) strips.push([w + dx, 0, -dx, h]);
    if (dy > 0) strips.push([0, 0, w, dy]);
    if (dy < 0) strips.push([0, h + dy, w, -dy]);
    for (const [x, y, sw, sh] of strips) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, sw, sh);
      ctx.clip();
      this.worldTransform(ctx);
      // Pad by a pixel so antialiased edges at the seam are repainted too.
      const world = { x: (x - tx - 1) / s, y: (y - ty - 1) / s, w: (sw + 2) / s, h: (sh + 2) / s };
      drawScene(ctx, this.board.background, this.board.items, { ...opts, world });
      ctx.restore();
    }
  }

  clear(ctx: CanvasRenderingContext2D) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame() {
    this.raf = 0;
    if (this.sceneDirty) {
      this.sceneDirty = false;
      this.renderScene();
    }
    if (this.gesture?.frame) {
      this.gesture.frame();
    } else if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawSelectionChrome();
    }
  }

  /** Draw a freshly committed item straight onto the scene (avoids a full redraw). */
  paintCommitted(it: Item) {
    const ctx = this.scene.ctx;
    this.worldTransform(ctx);
    drawItem(ctx, it, {
      scale: this.view.zoom * this.dpr,
      onImageReady: () => {
        this.sceneDirty = this.sceneFull = true;
        this.schedule();
      },
    });
  }

  selectionBounds(): Rect | null {
    let r: Rect | null = null;
    for (const it of this.board.items) if (this.selection.has(it.id)) r = unionRect(r, itemBounds(it));
    return r;
  }

  private drawSelectionChrome() {
    const ctx = this.overlay.ctx;
    this.clear(ctx);
    const r = this.selectionBounds();
    if (!r) return;
    const a = this.view.toScreen(r);
    const b = this.view.toScreen({ x: r.x + r.w, y: r.y + r.h });
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.strokeStyle = '#3B6FE0';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(b.x + 4, b.y + 4, HANDLE_PX - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---------- input ----------

  private bindInput() {
    const el = this.stage;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onCancel(e));
    el.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId === this.gesturePointer) this.onUp(e);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.view.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)));
        } else {
          const k = e.deltaMode === 1 ? 20 : 1;
          this.view.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
        }
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return;
      if (e.code === 'Space') {
        this.spaceDown = true;
        this.stage.classList.add('panning');
      } else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
      else if (e.key === 'Escape') {
        this.selection.clear();
        this.overlayDirty = true;
        this.schedule();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.stage.classList.remove('panning');
      }
    });
    window.addEventListener('blur', () => {
      if (this.gesture) this.gesture.cancel();
      this.endGesture();
    });
  }

  worldPoint(e: PointerEvent, t0: number): InkPoint {
    const rect = this.stage.getBoundingClientRect();
    const w = this.view.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    // Mice report 0.5 while pressed; pens report real pressure (0 on hover is filtered upstream).
    const p = e.pointerType === 'pen' ? clampPressure(e.pressure) : 0.5;
    return { x: w.x, y: w.y, p, t: e.timeStamp - t0 };
  }

  screenPoint(e: PointerEvent): Vec {
    const rect = this.stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown(e: PointerEvent) {
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.screenPoint(e));
      if (this.touches.size === 2) {
        // Second finger: abandon whatever the first finger started and pinch instead.
        if (this.gesture) this.gesture.cancel();
        this.endGesture();
        this.startPinch();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.gesture) return;
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone (or synthetic); the gesture still works without capture.
    }
    this.gesturePointer = e.pointerId;

    const navigate =
      this.tool === 'pan' ||
      this.spaceDown ||
      e.button === 1 ||
      (e.pointerType === 'touch' && this.penSeen) ||
      (e.pointerType === 'mouse' && e.button === 2);
    if (navigate) {
      this.gesture = new PanGesture(this, e);
      return;
    }
    // Pen eraser end / barrel button act as temporary tools.
    const eraserEnd = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    const barrel = e.pointerType === 'pen' && (e.button === 2 || (e.buttons & 2) !== 0);
    const tool: ToolId = eraserEnd ? 'eraser' : barrel ? 'select' : this.tool;
    if (this.selection.size) {
      // Any tool can grab an existing selection (e.g. after Ctrl+A) to move or resize it.
      const grab = this.selectionGestureAt(e);
      if (grab) {
        this.gesture = grab;
        this.schedule();
        return;
      }
      if (tool !== 'select') {
        this.selection.clear();
        this.notify();
      }
    }
    if (tool === 'pen' || tool === 'highlighter') {
      this.gesture = new InkGesture(this, e, { ...(tool === 'highlighter' ? this.settings.highlighter : this.settings.pens[this.settings.activePen]) });
    } else if (tool === 'eraser') {
      this.gesture = new EraseGesture(this, e, eraserEnd ? 'stroke' : this.settings.eraser);
    } else if (tool === 'select') {
      this.gesture = this.selectGestureFor(e);
    }
    this.schedule();
  }

  private onMove(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.screenPoint(e));
      if (this.pinch) {
        this.updatePinch();
        return;
      }
    }
    if (!this.gesture || e.pointerId !== this.gesturePointer) return;
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    this.gesture.move(e, samples.length ? samples : [e]);
    this.schedule();
  }

  private onUp(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        if (this.touches.size < 2) this.pinch = null;
        return;
      }
    }
    if (!this.gesture || e.pointerId !== this.gesturePointer) return;
    const g = this.gesture;
    this.gesture = null;
    g.up(e);
    this.endGesture();
  }

  private onCancel(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    if (!this.gesture || e.pointerId !== this.gesturePointer) return;
    this.gesture.cancel();
    this.endGesture();
  }

  private endGesture() {
    this.gesture = null;
    this.gesturePointer = null;
    this.overlayDirty = true;
    this.schedule();
  }

  private startPinch() {
    const [a, b] = [...this.touches.values()];
    this.pinch = { d: dist(a, b), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private updatePinch() {
    if (!this.pinch || this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const d = dist(a, b);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.view.panBy(c.x - this.pinch.c.x, c.y - this.pinch.c.y);
    if (this.pinch.d > 0) this.view.zoomAt(c.x, c.y, d / this.pinch.d);
    this.pinch = { d, c };
  }

  private selectGestureFor(e: PointerEvent): Gesture {
    return this.selectionGestureAt(e) ?? new LassoGesture(this, e);
  }

  /** Move/resize gesture when the pointer is on the current selection, else null. */
  private selectionGestureAt(e: PointerEvent): Gesture | null {
    const r = this.selectionBounds();
    if (r) {
      const s = this.screenPoint(e);
      const corner = this.view.toScreen({ x: r.x + r.w, y: r.y + r.h });
      if (dist(s, { x: corner.x + 4, y: corner.y + 4 }) <= HANDLE_PX + 4) return new TransformGesture(this, e, 'scale');
      const w = this.view.toWorld(s.x, s.y);
      const pad = 6 / this.view.zoom;
      if (rectContains({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, w)) return new TransformGesture(this, e, 'move');
    }
    return null;
  }

  /** Topmost item under a world point. */
  hitTest(w: Vec): Item | null {
    const tol = 6 / this.view.zoom;
    for (let i = this.board.items.length - 1; i >= 0; i--) {
      const it = this.board.items[i];
      const b = itemBounds(it);
      if (!rectContains({ x: b.x - tol, y: b.y - tol, w: b.w + tol * 2, h: b.h + tol * 2 }, w)) continue;
      if (it.type === 'image') return it;
      const pts = it.type === 'stroke' ? it.points : shapeOutline(it);
      const reach = (it.style.width / 2) * 1.75 + tol;
      if (pts.length === 1 && dist(pts[0], w) <= reach) return it;
      for (let k = 1; k < pts.length; k++) if (distToSegment(w, pts[k - 1], pts[k]) <= reach) return it;
    }
    return null;
  }

  /** Endpoints of visible strokes, used for line-mode snapping. */
  strokeEndpoints(): Vec[] {
    const vis = this.view.visibleWorld();
    const out: Vec[] = [];
    for (const it of this.board.items) {
      if (it.type !== 'stroke' || it.points.length < 2) continue;
      if (!rectsIntersect(itemBounds(it), vis)) continue;
      out.push(it.points[0], it.points[it.points.length - 1]);
    }
    return out;
  }
}

// ---------- item transforms ----------

export function transformItem(it: Item, f: (p: Vec) => Vec, scale: number): Item {
  switch (it.type) {
    case 'stroke':
      return { ...it, id: it.id, style: { ...it.style, width: it.style.width * scale }, points: it.points.map((p) => ({ ...p, ...f(p) })) };
    case 'shape': {
      const e = it.ellipse;
      const c = e ? f({ x: e.cx, y: e.cy }) : undefined;
      return {
        ...it,
        style: { ...it.style, width: it.style.width * scale },
        points: it.points.map(f),
        ellipse: e && c ? { ...e, cx: c.x, cy: c.y, rx: e.rx * scale, ry: e.ry * scale } : undefined,
      };
    }
    case 'image': {
      const a = f({ x: it.x, y: it.y });
      return { ...it, x: a.x, y: a.y, w: it.w * scale, h: it.h * scale };
    }
  }
}

// ---------- gestures ----------

class PanGesture implements Gesture {
  private last: Vec;
  constructor(private ed: Editor, e: PointerEvent) {
    this.last = ed.screenPoint(e);
    ed.stage.classList.add('panning');
  }
  move(e: PointerEvent) {
    const s = this.ed.screenPoint(e);
    this.ed.view.panBy(s.x - this.last.x, s.y - this.last.y);
    this.last = s;
  }
  up() {
    this.ed.stage.classList.remove('panning');
  }
  cancel() {
    this.ed.stage.classList.remove('panning');
  }
}

type InkMode = 'ink' | 'line' | 'shape';

class InkGesture implements Gesture {
  private t0: number;
  private pipeline: InkPipeline;
  private rendered = 0;
  private lastEvent: PointerEvent;
  private lastWorld: InkPoint;
  private mode: InkMode = 'ink';
  private holdAnchor: Vec;
  private holdTimer = 0;
  // line mode
  private doodly: InkPoint[] = [];
  private lineStart: InkPoint | null = null;
  private snapTargets: Vec[] = [];
  // shape (draw-and-hold) mode
  private shapeBase: InkPoint[] = [];
  private shapeCenter: Vec = { x: 0, y: 0 };
  private holdWorld: Vec = { x: 0, y: 0 };
  private preview: InkPoint[] = [];
  private needsFull = false;
  /** The ink as drawn when draw-and-hold converted it, so undo can restore it. */
  private rawAtHold: InkPoint[] | null = null;

  constructor(private ed: Editor, e: PointerEvent, private style: InkStyle) {
    this.t0 = e.timeStamp;
    this.pipeline = new InkPipeline(0.5 / ed.view.zoom);
    this.lastEvent = e;
    this.lastWorld = ed.worldPoint(e, this.t0);
    this.pipeline.push(this.lastWorld);
    this.holdAnchor = ed.screenPoint(e);
    this.armHold();
    ed.wet.canvas.style.mixBlendMode = style.kind === 'highlighter' ? 'darken' : 'normal';
    if (e.shiftKey) this.enterLine(false);
  }

  private get full() {
    // Translucent/blended ink and the non-freehand modes redraw the whole wet stroke each frame.
    // (Incremental drawing would double the alpha wherever new pieces overlap old ones.)
    return this.style.kind === 'highlighter' || inkOpacity(this.style) < 1 || this.mode !== 'ink' || this.ed.view.zoom < 0.25;
  }

  private armHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => this.onHold(), HOLD_MS);
  }

  move(e: PointerEvent, samples: PointerEvent[]) {
    for (const s of samples) {
      const p = this.ed.worldPoint(s, this.t0);
      if (s.pointerType === 'pen' && s.pressure === 0) p.p = this.lastWorld.p;
      this.lastWorld = p;
      if (this.mode === 'ink') this.pipeline.push(p);
    }
    this.lastEvent = e;
    if (this.mode === 'ink' && e.shiftKey) this.enterLine(false);
    if (this.mode === 'shape') this.updateShape();
    if (this.mode === 'line') this.updateLine();
    if (dist(this.ed.screenPoint(e), this.holdAnchor) > HOLD_JITTER_PX) {
      this.holdAnchor = this.ed.screenPoint(e);
      if (this.mode === 'ink') this.armHold();
    }
  }

  private onHold() {
    if (this.mode !== 'ink') return;
    const pts = [...this.pipeline.points, this.lastWorld];
    if (isStraight(pts)) {
      this.rawAtHold = decimate(pts, 0.05 / this.ed.view.zoom);
      this.enterLine(true);
      return;
    }
    if (this.style.kind !== 'pen') return;
    const rec = recognize(pts, this.style.width, true);
    if (!rec || rec.kind === 'line') return;
    this.rawAtHold = decimate(pts, 0.05 / this.ed.view.zoom);
    this.mode = 'shape';
    this.shapeBase = rec.points;
    const b = bounds(rec.points);
    this.shapeCenter = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    this.holdWorld = { x: this.lastWorld.x, y: this.lastWorld.y };
    this.preview = rec.points;
    this.needsFull = true;
  }

  private enterLine(fromHold: boolean) {
    const pts = this.pipeline.points;
    this.mode = 'line';
    this.snapTargets = this.ed.strokeEndpoints();
    if (fromHold) {
      this.doodly = [];
      this.lineStart = { ...pts[0], p: 0.5 };
    } else {
      this.doodly = pts.length > 1 ? pts.slice() : [];
      this.lineStart = { ...(pts[pts.length - 1] ?? this.lastWorld), p: 0.5 };
    }
    this.lineStart = { ...this.lineStart, ...trySnap(this.lineStart, this.snapTargets) };
    this.updateLine();
    this.needsFull = true;
  }

  private updateLine() {
    const a = this.lineStart!;
    const end = trySnap(tryStraight(a, this.lastWorld), this.snapTargets);
    this.preview = [...this.doodly, ...lineToInk(a, { ...end, p: 0.5, t: this.lastWorld.t }, this.style.width)];
  }

  private updateShape() {
    const c = this.shapeCenter;
    const h = this.holdWorld;
    const r0 = dist(c, h);
    const r1 = dist(c, this.lastWorld);
    const s = r0 > 1 ? r1 / r0 : 1;
    const rot = Math.atan2(this.lastWorld.y - c.y, this.lastWorld.x - c.x) - Math.atan2(h.y - c.y, h.x - c.x);
    const co = Math.cos(rot) * s;
    const si = Math.sin(rot) * s;
    this.preview = this.shapeBase.map((p) => {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      return { ...p, x: c.x + dx * co - dy * si, y: c.y + dx * si + dy * co };
    });
  }

  frame() {
    const ed = this.ed;
    const wet = ed.wet.ctx;
    const ov = ed.overlay.ctx;
    ed.clear(ov);
    if (this.full || this.needsFull) {
      this.needsFull = false;
      ed.clear(wet);
      ed.worldTransform(wet);
      const pts = this.mode === 'ink' ? [...this.pipeline.points, ...this.pipeline.prediction().slice(1)] : this.preview;
      fillStroke(wet, pts, this.style);
    } else {
      ed.worldTransform(wet);
      const pts = this.pipeline.points;
      if (pts.length > this.rendered) {
        fillStroke(wet, pts, this.style, Math.max(0, this.rendered));
        this.rendered = pts.length;
      }
      // Prediction tail lives on the overlay so it can be thrown away next frame.
      ed.worldTransform(ov);
      fillStroke(ov, this.pipeline.prediction(), this.style);
      const p = this.lastWorld.p;
      ed.delegated.update(this.lastEvent, this.style.color, this.style.width * ed.view.zoom * pressureFactor(p));
    }
    // Keep animating while the pen is down so late samples show without waiting for input.
    ed.schedule();
  }

  up(e: PointerEvent) {
    clearTimeout(this.holdTimer);
    const ed = this.ed;
    let points: InkPoint[];
    // Ink as the user drew it, when a shape/line replaced it (undo steps back to this).
    let drawn: InkPoint[] | null = null;
    if (this.mode === 'ink') {
      if (e.pointerType !== 'pen' || e.pressure > 0) this.pipeline.push(ed.worldPoint(e, this.t0));
      this.pipeline.finish();
      points = decimate(this.pipeline.points, 0.05 / ed.view.zoom);
      if (points.length === 1) points = [points[0], { ...points[0], x: points[0].x + 0.01 }];
      if (ed.settings.autoShapes && this.style.kind === 'pen') {
        const rec = recognize(points, this.style.width, false);
        if (rec) {
          drawn = points;
          points = rec.points;
        }
      }
    } else {
      points = this.preview;
      drawn = this.rawAtHold; // null for Shift-lines, which are deliberate from the start
    }
    this.clearWet();
    if (points.length < 2) return;
    const item: StrokeItem = { id: newId(), type: 'stroke', style: this.style, points };
    // Paint immediately so the wet → dry hand-off has no blank frame.
    ed.paintCommitted(item);
    if (drawn && drawn.length >= 2) {
      // Two history steps, like Whiteboard: the ink as drawn, then its beautification.
      // The first Ctrl+Z turns the shape back into the original ink.
      const original: StrokeItem = { ...item, points: drawn };
      const add = emptyPatch();
      add.added.push(original);
      ed.commit(add);
      const beautify = emptyPatch();
      beautify.changed.push({ before: original, after: item });
      ed.commit(beautify);
    } else {
      const p = emptyPatch();
      p.added.push(item);
      ed.commit(p);
    }
  }

  cancel() {
    clearTimeout(this.holdTimer);
    this.clearWet();
  }

  private clearWet() {
    this.ed.clear(this.ed.wet.ctx);
    this.ed.clear(this.ed.overlay.ctx);
  }
}

function fillStroke(ctx: CanvasRenderingContext2D, pts: readonly InkPoint[], style: InkStyle, from = 0) {
  if (!pts.length) return;
  const sink = new Path2DSink();
  emitStroke(sink, pts, style, from);
  ctx.fillStyle = style.color;
  ctx.globalAlpha = inkOpacity(style);
  ctx.fill(sink.path, 'nonzero');
  ctx.globalAlpha = 1;
}

class EraseGesture implements Gesture {
  private prev: Vec;
  private cur: Vec;
  private patch = emptyPatch();
  private originalIndex = new Map<string, number>();
  private created = new Set<string>();

  constructor(private ed: Editor, e: PointerEvent, private mode: EraserMode) {
    ed.board.items.forEach((it, i) => this.originalIndex.set(it.id, i));
    this.prev = this.cur = ed.worldPoint(e, 0);
    this.erase();
  }

  private get radius() {
    return (this.mode === 'stroke' ? STROKE_ERASER_PX : POINT_ERASER_PX) / this.ed.view.zoom;
  }

  move(_e: PointerEvent, samples: PointerEvent[]) {
    for (const s of samples) {
      this.cur = this.ed.worldPoint(s, 0);
      this.erase();
      this.prev = this.cur;
    }
  }

  private erase() {
    const r = this.radius;
    const a = this.prev;
    const b = this.cur;
    const sweep: Rect = { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, w: Math.abs(a.x - b.x) + r * 2, h: Math.abs(a.y - b.y) + r * 2 };
    const items = this.ed.board.items;
    let touched = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'image') continue;
      if (!rectsIntersect(itemBounds(it), sweep)) continue;
      const pts: readonly Vec[] = it.type === 'stroke' ? it.points : shapeOutline(it);
      const reach = r + it.style.width / 2;
      if (this.mode === 'stroke' || it.type === 'shape') {
        if (capsuleHits(pts, a, b, reach)) {
          this.remove(i);
          touched = true;
        }
      } else {
        const frags = splitStroke(it, a, b, reach);
        if (frags) {
          this.remove(i);
          items.splice(i, 0, ...frags);
          for (const f of frags) this.created.add(f.id);
          touched = true;
        }
      }
    }
    if (touched) this.ed.changedLive();
  }

  private remove(i: number) {
    const it = this.ed.board.items[i];
    this.ed.board.items.splice(i, 1);
    if (this.created.has(it.id)) this.created.delete(it.id);
    else this.patch.removed.push({ item: it, index: this.originalIndex.get(it.id) ?? i });
  }

  frame() {
    const ed = this.ed;
    const ov = ed.overlay.ctx;
    ed.clear(ov);
    const s = ed.view.toScreen(this.cur);
    const r = this.radius * ed.view.zoom;
    ov.setTransform(ed.dpr, 0, 0, ed.dpr, 0, 0);
    ov.beginPath();
    if (this.mode === 'stroke') ov.arc(s.x, s.y, r, 0, Math.PI * 2);
    else ov.rect(s.x - r, s.y - r, r * 2, r * 2);
    ov.fillStyle = 'rgba(255,255,255,0.5)';
    ov.fill();
    ov.strokeStyle = 'rgba(0,0,0,0.45)';
    ov.lineWidth = 1;
    ov.stroke();
  }

  up() {
    this.ed.clear(this.ed.overlay.ctx);
    this.patch.added = this.ed.board.items.filter((it) => this.created.has(it.id));
    // Items are already applied live; record the patch without re-applying it.
    this.ed.history.push(this.patch);
    this.ed.changed();
  }

  cancel() {
    this.up();
  }
}

function capsuleHits(pts: readonly Vec[], a: Vec, b: Vec, reach: number): boolean {
  if (pts.length === 1) return distToSegment(pts[0], a, b) <= reach;
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1];
    const q = pts[k];
    if (segmentsIntersect(p, q, a, b)) return true;
    if (distToSegment(p, a, b) <= reach || distToSegment(q, a, b) <= reach) return true;
    if (distToSegment(a, p, q) <= reach || distToSegment(b, p, q) <= reach) return true;
  }
  return false;
}

/** Split a stroke where the eraser capsule covers it; null when untouched. */
function splitStroke(s: StrokeItem, a: Vec, b: Vec, reach: number): StrokeItem[] | null {
  // Densify so long straight spans can be cut in the middle.
  const step = Math.max(0.5, reach / 2);
  const dense: InkPoint[] = [];
  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i];
    if (i > 0) {
      const q = s.points[i - 1];
      const n = Math.floor(dist(p, q) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        dense.push({ x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, p: q.p + (p.p - q.p) * t, t: q.t + (p.t - q.t) * t });
      }
    }
    dense.push(p);
  }
  const keep = dense.map((p) => distToSegment(p, a, b) > reach);
  if (keep.every(Boolean)) return null;
  const frags: StrokeItem[] = [];
  let run: InkPoint[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const bb = bounds(run);
      if (Math.max(bb.w, bb.h) > s.style.width || polylineLength(run) > s.style.width) {
        frags.push({ id: newId(), type: 'stroke', style: s.style, points: decimate(run, 0.01) });
      }
    }
    run = [];
  };
  dense.forEach((p, i) => {
    if (keep[i]) run.push(p);
    else flush();
  });
  flush();
  return frags;
}

class LassoGesture implements Gesture {
  private pts: Vec[] = [];
  constructor(private ed: Editor, e: PointerEvent) {
    this.pts.push(ed.worldPoint(e, 0));
    ed.selection.clear();
  }
  move(_e: PointerEvent, samples: PointerEvent[]) {
    for (const s of samples) this.pts.push(this.ed.worldPoint(s, 0));
  }
  frame() {
    const ed = this.ed;
    const ov = ed.overlay.ctx;
    ed.clear(ov);
    ov.setTransform(ed.dpr, 0, 0, ed.dpr, 0, 0);
    ov.beginPath();
    this.pts.forEach((p, i) => {
      const s = ed.view.toScreen(p);
      if (i) ov.lineTo(s.x, s.y);
      else ov.moveTo(s.x, s.y);
    });
    ov.closePath();
    ov.fillStyle = 'rgba(59,111,224,0.07)';
    ov.fill();
    ov.setLineDash([5, 4]);
    ov.strokeStyle = '#3B6FE0';
    ov.lineWidth = 1.25;
    ov.stroke();
    ov.setLineDash([]);
  }
  up() {
    const ed = this.ed;
    ed.selection.clear();
    const screenLen = polylineLength(this.pts) * ed.view.zoom;
    if (this.pts.length < 15 || screenLen < 12) {
      const hit = ed.hitTest(this.pts[this.pts.length - 1]);
      if (hit) ed.selection.add(hit.id);
    } else {
      const poly = this.pts;
      for (const it of ed.board.items) {
        if (it.type === 'stroke') {
          let inside = 0;
          for (const p of it.points) if (pointInPolygon(p, poly)) inside++;
          if (inside >= 0.95 * it.points.length) ed.selection.add(it.id);
        } else {
          const r = itemBounds(it);
          const mids = [
            { x: r.x + r.w / 2, y: r.y },
            { x: r.x + r.w, y: r.y + r.h / 2 },
            { x: r.x + r.w / 2, y: r.y + r.h },
            { x: r.x, y: r.y + r.h / 2 },
          ];
          if (mids.every((m) => pointInPolygon(m, poly))) ed.selection.add(it.id);
        }
      }
    }
    ed.clear(ed.overlay.ctx);
    ed.notify();
  }
  cancel() {
    this.ed.clear(this.ed.overlay.ctx);
  }
}

class TransformGesture implements Gesture {
  private start: Vec;
  private items: Item[];
  private box: Rect;
  private preview: Item[] = [];

  constructor(private ed: Editor, e: PointerEvent, private kind: 'move' | 'scale') {
    this.start = ed.worldPoint(e, 0);
    this.items = ed.selectedItems();
    this.box = ed.selectionBounds()!;
    for (const it of this.items) ed.hidden.add(it.id);
    ed.changedLive();
    this.preview = this.items;
  }

  private map(cur: Vec): { f: (p: Vec) => Vec; s: number } {
    if (this.kind === 'move') {
      const dx = cur.x - this.start.x;
      const dy = cur.y - this.start.y;
      return { f: (p) => ({ x: p.x + dx, y: p.y + dy }), s: 1 };
    }
    const o = { x: this.box.x, y: this.box.y };
    const d0 = dist(o, { x: this.box.x + this.box.w, y: this.box.y + this.box.h });
    const s = Math.max(0.05, dist(o, cur) / (d0 || 1));
    return { f: (p) => ({ x: o.x + (p.x - o.x) * s, y: o.y + (p.y - o.y) * s }), s };
  }

  move(e: PointerEvent) {
    const { f, s } = this.map(this.ed.worldPoint(e, 0));
    this.preview = this.items.map((it) => transformItem(it, f, s));
  }

  frame() {
    const ed = this.ed;
    const wet = ed.wet.ctx;
    ed.clear(wet);
    wet.canvas.style.mixBlendMode = 'normal';
    ed.worldTransform(wet);
    for (const it of this.preview) drawItem(wet, it, { scale: ed.view.zoom * ed.dpr });
    ed.clear(ed.overlay.ctx);
  }

  up(e: PointerEvent) {
    const ed = this.ed;
    this.move(e);
    for (const it of this.items) ed.hidden.delete(it.id);
    ed.clear(ed.wet.ctx);
    const p = emptyPatch();
    p.changed = this.items.map((before, i) => ({ before, after: this.preview[i] }));
    if (this.kind === 'move' && this.preview.every((it, i) => it === this.items[i])) {
      ed.changedLive();
      return;
    }
    ed.commit(p);
  }

  cancel() {
    for (const it of this.items) this.ed.hidden.delete(it.id);
    this.ed.clear(this.ed.wet.ctx);
    this.ed.changedLive();
  }
}
