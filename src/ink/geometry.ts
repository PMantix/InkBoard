// Stroke outline construction ("quad-circle"): one disc (or rectangle for a chisel/
// highlighter tip) per sample, bridged to its predecessor by the outer common-tangent
// quad. Filling everything with the nonzero rule yields the pressure-varying union,
// which is what gives the ink its smooth, round, slightly calligraphic look.
//
// Output goes through a PathSink so the same geometry feeds Canvas (Path2D) and SVG export.
import type { InkPoint, InkStyle } from '../model';
import { pressureFactor } from './pipeline';

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number): void;
  closePath(): void;
}

export type Tip = 'round' | 'rect';

export const tipFor = (style: InkStyle): Tip => (style.kind === 'highlighter' ? 'rect' : 'round');

/** Chisel aspect for the highlighter: tall, narrow nib. */
export const HIGHLIGHTER_ASPECT = 0.3;

export function emitStroke(sink: PathSink, points: readonly InkPoint[], style: InkStyle, from = 0) {
  const tip = tipFor(style);
  const base = style.width / 2;
  // Highlighters keep a flat pressure profile.
  const radius = (p: InkPoint) => base * (style.kind === 'highlighter' ? 1 : pressureFactor(p.p));
  for (let i = Math.max(0, from); i < points.length; i++) {
    const b = points[i];
    const rb = radius(b);
    if (tip === 'round') {
      sink.arc(b.x, b.y, rb);
      if (i > 0) roundBridge(sink, points[i - 1], radius(points[i - 1]), b, rb);
    } else {
      const hw = rb * HIGHLIGHTER_ASPECT;
      const hh = rb;
      rectPolygon(sink, [
        { x: b.x - hw, y: b.y - hh },
        { x: b.x + hw, y: b.y - hh },
        { x: b.x + hw, y: b.y + hh },
        { x: b.x - hw, y: b.y + hh },
      ]);
      if (i > 0) rectBridge(sink, points[i - 1], radius(points[i - 1]), b, rb);
    }
  }
}

/** Polygon with positive (screen-clockwise) winding, matching arc() direction. */
function rectPolygon(sink: PathSink, pts: { x: number; y: number }[]) {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  const ordered = area < 0 ? pts.slice().reverse() : pts;
  sink.moveTo(ordered[0].x, ordered[0].y);
  for (let i = 1; i < ordered.length; i++) sink.lineTo(ordered[i].x, ordered[i].y);
  sink.closePath();
}

function roundBridge(sink: PathSink, a: InkPoint, ra: number, b: InkPoint, rb: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  // One disc contains the other: the disc already covers the bridge.
  if (d <= Math.abs(ra - rb) + 1e-6) return;
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos(Math.max(-1, Math.min(1, (ra - rb) / d)));
  const c1 = Math.cos(theta + alpha);
  const s1 = Math.sin(theta + alpha);
  const c2 = Math.cos(theta - alpha);
  const s2 = Math.sin(theta - alpha);
  rectPolygon(sink, [
    { x: a.x + ra * c1, y: a.y + ra * s1 },
    { x: b.x + rb * c1, y: b.y + rb * s1 },
    { x: b.x + rb * c2, y: b.y + rb * s2 },
    { x: a.x + ra * c2, y: a.y + ra * s2 },
  ]);
}

function rectBridge(sink: PathSink, a: InkPoint, ra: number, b: InkPoint, rb: number) {
  const ha = ra * HIGHLIGHTER_ASPECT;
  const hb = rb * HIGHLIGHTER_ASPECT;
  const corners = [
    { x: a.x - ha, y: a.y - ra },
    { x: a.x + ha, y: a.y - ra },
    { x: a.x + ha, y: a.y + ra },
    { x: a.x - ha, y: a.y + ra },
    { x: b.x - hb, y: b.y - rb },
    { x: b.x + hb, y: b.y - rb },
    { x: b.x + hb, y: b.y + rb },
    { x: b.x - hb, y: b.y + rb },
  ];
  rectPolygon(sink, hull(corners));
}

function hull(points: { x: number; y: number }[]) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Canvas sink. Each arc is its own closed subpath so nonzero fill unions everything. */
export class Path2DSink implements PathSink {
  constructor(readonly path: Path2D = new Path2D()) {}
  moveTo(x: number, y: number) {
    this.path.moveTo(x, y);
  }
  lineTo(x: number, y: number) {
    this.path.lineTo(x, y);
  }
  arc(x: number, y: number, r: number) {
    this.path.moveTo(x + r, y);
    this.path.arc(x, y, r, 0, Math.PI * 2);
    this.path.closePath();
  }
  closePath() {
    this.path.closePath();
  }
}

/** SVG path-data sink (1 decimal precision, like Whiteboard's path builder). */
export class SvgSink implements PathSink {
  d: string[] = [];
  private f = (n: number) => (Math.round(n * 10) / 10).toString();
  moveTo(x: number, y: number) {
    this.d.push(`M${this.f(x)} ${this.f(y)}`);
  }
  lineTo(x: number, y: number) {
    this.d.push(`L${this.f(x)} ${this.f(y)}`);
  }
  arc(x: number, y: number, r: number) {
    // Two clockwise half-arcs make a full circle with positive winding.
    const rr = this.f(r);
    this.d.push(`M${this.f(x + r)} ${this.f(y)}A${rr} ${rr} 0 1 1 ${this.f(x - r)} ${this.f(y)}A${rr} ${rr} 0 1 1 ${this.f(x + r)} ${this.f(y)}Z`);
  }
  closePath() {
    this.d.push('Z');
  }
  toString() {
    return this.d.join('');
  }
}

const pathCache = new WeakMap<object, Map<number, Path2D>>();

/**
 * Cached Path2D for a committed (immutable) point array at a given world→device scale.
 * Detail is reduced per power-of-two zoom bucket: points closer than ~0.35 device px to the
 * simplified curve are dropped, which keeps far-zoomed boards fast without visible change.
 */
export function strokePath(points: readonly InkPoint[], style: InkStyle, scale = 1): Path2D {
  const bucket = Math.max(-8, Math.min(4, Math.floor(Math.log2(scale))));
  let byBucket = pathCache.get(points);
  if (!byBucket) {
    byBucket = new Map();
    pathCache.set(points, byBucket);
  }
  let p = byBucket.get(bucket);
  if (!p) {
    const tol = 0.35 / 2 ** bucket;
    const pts = bucket >= 1 ? points : simplifyInk(points, tol);
    const sink = new Path2DSink();
    emitStroke(sink, pts, style);
    p = sink.path;
    byBucket.set(bucket, p);
  }
  return p;
}

/** Thin polyline used when a stroke is under ~1.5 device px wide. */
const hairCache = new WeakMap<object, Map<number, Path2D>>();

export function strokeHairline(points: readonly InkPoint[], scale: number): Path2D {
  const bucket = Math.max(-8, Math.min(4, Math.floor(Math.log2(scale))));
  let byBucket = hairCache.get(points);
  if (!byBucket) {
    byBucket = new Map();
    hairCache.set(points, byBucket);
  }
  const cached = byBucket.get(bucket);
  if (cached) return cached;
  const pts = simplifyInk(points, 0.5 / 2 ** bucket);
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  if (pts.length === 1) path.lineTo(pts[0].x + 0.01, pts[0].y);
  byBucket.set(bucket, path);
  return path;
}

/** Ramer–Douglas–Peucker that also keeps points where pressure changes noticeably. */
export function simplifyInk(pts: readonly InkPoint[], tol: number): InkPoint[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s];
    const b = pts[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      // Treat a pressure deviation as distance so tapers survive simplification.
      const pd = Math.abs(p.p - (a.p + (b.p - a.p) * t)) * 8 * tol / 0.35;
      const m = Math.max(d, pd);
      if (m > maxD) {
        maxD = m;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
