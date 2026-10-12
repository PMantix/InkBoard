// Live pen pipeline: dedupe → jitter filter → Catmull-Rom/Bézier fit → flatten, plus a
// short "prediction" tail that closes the lag the filter introduces.
//
// Constants follow the behaviour documented for Whiteboard's input stack:
//   IIR  y = 0.17·x + 1.33·y₁ − 0.5·y₂ (unity DC gain), seeded with the first sample
//   Catmull-Rom → Bézier: c1 = p1 + (p2−p0)/6, c2 = p2 − (p3−p1)/6
//   flatten by de Casteljau halving until midpoint deviation ≤ flatness (0.5 screen px)
import type { InkPoint } from '../model';

export const DEFAULT_PRESSURE = 0.5;

/** Width factor for a pressure in [0,1]: 0.25 … 1.75, exactly 1.0 at 0.5. */
export const pressureFactor = (p: number) => 1.5 * p + 0.25;

export function clampPressure(p: number | undefined): number {
  if (p === undefined || Number.isNaN(p)) return DEFAULT_PRESSURE;
  return Math.min(1, Math.max(0, p));
}

class JitterFilter {
  private y1: InkPoint | null = null;
  private y2: InkPoint | null = null;

  push(x: InkPoint): InkPoint {
    if (!this.y1 || !this.y2) {
      this.y1 = this.y2 = x;
      return x;
    }
    const out: InkPoint = {
      x: 0.17 * x.x + 1.33 * this.y1.x - 0.5 * this.y2.x,
      y: 0.17 * x.y + 1.33 * this.y1.y - 0.5 * this.y2.y,
      p: x.p,
      t: x.t,
    };
    this.y2 = this.y1;
    this.y1 = out;
    return out;
  }
}

function cubicPoint(a: InkPoint, c1x: number, c1y: number, c2x: number, c2y: number, b: InkPoint, t: number) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y,
  };
}

/** Emit flattened points for the Catmull-Rom span p1→p2 (excluding p1, including p2). */
function flattenSpan(p0: InkPoint, p1: InkPoint, p2: InkPoint, p3: InkPoint, flatness: number, out: InkPoint[]) {
  const c1x = p1.x + (p2.x - p0.x) / 6;
  const c1y = p1.y + (p2.y - p0.y) / 6;
  const c2x = p2.x - (p3.x - p1.x) / 6;
  const c2y = p2.y - (p3.y - p1.y) / 6;
  const f2 = flatness * flatness;
  const rec = (t0: number, t1: number, a: { x: number; y: number }, b: { x: number; y: number }, depth: number) => {
    const tm = (t0 + t1) / 2;
    const m = cubicPoint(p1, c1x, c1y, c2x, c2y, p2, tm);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (depth < 10 && (m.x - cx) ** 2 + (m.y - cy) ** 2 > f2) {
      rec(t0, tm, a, m, depth + 1);
      rec(tm, t1, m, b, depth + 1);
    } else {
      out.push({ x: b.x, y: b.y, p: p1.p + (p2.p - p1.p) * t1, t: p1.t + (p2.t - p1.t) * t1 });
    }
  };
  rec(0, 1, p1, p2, 0);
}

export class InkPipeline {
  private filter = new JitterFilter();
  private window: InkPoint[] = [];
  private lastRaw: InkPoint | null = null;
  private lastFiltered: InkPoint | null = null;
  private prevFiltered: InkPoint | null = null;
  /** All fitted, flattened points so far (the committed stroke). */
  readonly points: InkPoint[] = [];

  constructor(private flatness: number) {}

  /** Feed one raw sample; returns the newly committed points (may be empty). */
  push(raw: InkPoint): InkPoint[] {
    if (this.lastRaw && raw.x === this.lastRaw.x && raw.y === this.lastRaw.y) {
      // Deduper: identical positions add nothing but can update pressure.
      this.lastRaw = raw;
      return [];
    }
    this.lastRaw = raw;
    const f = this.filter.push(raw);
    this.prevFiltered = this.lastFiltered;
    this.lastFiltered = f;
    const start = this.points.length;
    if (this.window.length === 0) {
      this.window.push(f, f);
      this.points.push(f);
      return this.points.slice(start);
    }
    this.window.push(f);
    if (this.window.length > 4) this.window.shift();
    if (this.window.length === 4) {
      const [p0, p1, p2, p3] = this.window;
      flattenSpan(p0, p1, p2, p3, this.flatness, this.points);
    }
    return this.points.slice(start);
  }

  /**
   * Short tail from the last committed point through the latest filtered sample to the
   * latest raw sample — drawn on a throwaway layer each frame, never committed.
   */
  prediction(): InkPoint[] {
    const out: InkPoint[] = [];
    const last = this.points[this.points.length - 1];
    if (last) out.push(last);
    if (this.prevFiltered && this.window.length >= 3) out.push(this.window[this.window.length - 2]);
    if (this.lastFiltered) out.push(this.lastFiltered);
    if (this.lastRaw) out.push(this.lastRaw);
    return out;
  }

  /** Finish the stroke: flush the remaining spans and land exactly on the last raw sample. */
  finish(): InkPoint[] {
    const start = this.points.length;
    if (this.lastRaw && this.window.length >= 2) {
      // Converge onto the true pen-up position so the filter lag doesn't shorten the stroke.
      const end = { ...this.lastRaw };
      const w = this.window.slice(-3);
      while (w.length < 3) w.unshift(w[0]);
      const [a, b, c] = w;
      flattenSpan(a, b, c, end, this.flatness, this.points);
      flattenSpan(b, c, end, end, this.flatness, this.points);
    }
    return this.points.slice(start);
  }
}

/** Drop interior points that are (nearly) collinear with their neighbours; keeps reversals. */
export function decimate(points: readonly InkPoint[], tolerance: number): InkPoint[] {
  if (points.length <= 2) return points.slice();
  const out: InkPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const acx = c.x - a.x;
    const acy = c.y - a.y;
    const l = Math.hypot(acx, acy);
    const perpDist = l > 0 ? Math.abs(abx * acy - aby * acx) / l : Math.hypot(abx, aby);
    const doublesBack = abx * acx + aby * acy < 0;
    const pressureJump = Math.abs(b.p - a.p) > 0.02;
    if (perpDist >= tolerance || doublesBack || pressureJump) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}
