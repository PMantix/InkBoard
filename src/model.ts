// Board document model and (de)serialization of the .inkboard file format.
import { bounds, type Rect, type Vec } from './geom';

/** One captured ink sample in world space. p = pressure 0..1, t = ms since stroke start. */
export interface InkPoint extends Vec {
  p: number;
  t: number;
}

export type PenKind = 'pen' | 'highlighter';

export interface InkStyle {
  color: string;
  /** Nominal stroke diameter in world units at pressure 0.5. */
  width: number;
  kind: PenKind;
}

export interface StrokeItem {
  id: string;
  type: 'stroke';
  style: InkStyle;
  points: InkPoint[];
}

export type ShapeKind =
  | 'line'
  | 'arrow'
  | 'ellipse'
  | 'triangle'
  | 'rectangle'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'star'
  | 'polygon';

export interface ShapeItem {
  id: string;
  type: 'shape';
  kind: ShapeKind;
  style: InkStyle;
  /** Vertices for polygonal kinds / endpoints for line & arrow, in world space. */
  points: Vec[];
  /** Ellipse geometry (kind === 'ellipse'). rotation in radians. */
  ellipse?: { cx: number; cy: number; rx: number; ry: number; rotation: number };
  closed: boolean;
  fill?: string;
}

export interface ImageItem {
  id: string;
  type: 'image';
  /** data: URL (PNG/JPEG/SVG), embedded so boards are self-contained. */
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Item = StrokeItem | ShapeItem | ImageItem;

export type GridKind = 'none' | 'dot' | 'graph' | 'rule' | 'compactRule' | 'triangular';

export interface Background {
  /** Paper colour (hex). */
  color: string;
  grid: GridKind;
}

export const PAPER_COLORS = ['#FFFFFF', '#F0F0F0', '#FEEE9E', '#CCECF7', '#FDE0CF', '#FED6D6', '#E4D1EE', '#E5F3CC', '#1F1F1F'];

export const defaultBackground = (): Background => ({ color: '#FFFFFF', grid: 'dot' });

export interface Board {
  version: 1;
  background: Background;
  items: Item[];
  view?: { x: number; y: number; zoom: number };
}

export const emptyBoard = (): Board => ({ version: 1, background: defaultBackground(), items: [] });

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function shapeOutline(s: ShapeItem, segments = 72): Vec[] {
  if (s.kind === 'ellipse' && s.ellipse) {
    const { cx, cy, rx, ry, rotation } = s.ellipse;
    const c = Math.cos(rotation);
    const sn = Math.sin(rotation);
    const out: Vec[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ex = rx * Math.cos(a);
      const ey = ry * Math.sin(a);
      out.push({ x: cx + ex * c - ey * sn, y: cy + ex * sn + ey * c });
    }
    return out;
  }
  return s.closed && s.points.length > 2 ? [...s.points, s.points[0]] : s.points;
}

const boundsCache = new WeakMap<Item, Rect>();

/** World bounds of an item (cached; items are replaced, never mutated, on edit). */
export function itemBounds(it: Item): Rect {
  let r = boundsCache.get(it);
  if (!r) {
    r = computeBounds(it);
    boundsCache.set(it, r);
  }
  return r;
}

function computeBounds(it: Item): Rect {
  switch (it.type) {
    case 'stroke':
      return bounds(it.points, it.style.width);
    case 'shape':
      return bounds(shapeOutline(it, 24), it.style.width);
    case 'image':
      return { x: it.x, y: it.y, w: it.w, h: it.h };
  }
}

export function serialize(board: Board): string {
  // Round coordinates to keep files compact; 1/100 world unit is far below visible precision.
  const r = (n: number) => Math.round(n * 100) / 100;
  const items = board.items.map((it) => {
    if (it.type === 'stroke') {
      return { ...it, points: it.points.map((p) => ({ x: r(p.x), y: r(p.y), p: Math.round(p.p * 1000) / 1000, t: Math.round(p.t) })) };
    }
    if (it.type === 'shape') return { ...it, points: it.points.map((p) => ({ x: r(p.x), y: r(p.y) })) };
    return it;
  });
  return JSON.stringify({ ...board, items });
}

export function deserialize(text: string): Board {
  const raw = JSON.parse(text) as Partial<Board>;
  if (raw.version !== 1 || !Array.isArray(raw.items)) throw new Error('Not an Inkboard v1 file');
  const items = raw.items.filter((it): it is Item => !!it && typeof it === 'object' && ['stroke', 'shape', 'image'].includes((it as Item).type));
  const bg = raw.background && typeof raw.background === 'object' ? raw.background : defaultBackground();
  return { version: 1, background: bg, items, view: raw.view };
}
