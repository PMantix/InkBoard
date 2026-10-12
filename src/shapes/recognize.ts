// Local ink-to-shape recognition.
//
// Behaviour follows Whiteboard's documented pipeline (closed-stroke gate, straightness
// test, corner counting, 20° angle snap, ellipse fallback, output re-drawn as an ink
// stroke that keeps the original pressure profile). Whiteboard delegated the actual
// classification to a cloud service; here it is done locally by fitting candidate
// shapes and picking the one with the lowest normalized error.
import {
  bounds,
  convexHull,
  dist,
  distToSegment,
  lerp,
  polygonArea,
  polylineLength,
  resample,
  rotate,
  sub,
  type Vec,
} from '../geom';
import type { InkPoint } from '../model';

export type RecognizedKind =
  | 'line'
  | 'circle'
  | 'ellipse'
  | 'triangle'
  | 'rightTriangle'
  | 'equilateralTriangle'
  | 'square'
  | 'rectangle'
  | 'diamond'
  | 'quadrilateral'
  | 'pentagon'
  | 'hexagon';

export interface Recognition {
  kind: RecognizedKind;
  /** Replacement ink points (same pen, original pressure profile). */
  points: InkPoint[];
  /** Mean fit error / size, 0 = perfect. */
  error: number;
}

// ---- gates (constants match the documented Whiteboard behaviour) ----

/** Closed-stroke test: any of the first 12% of points within 0.1·length of any of the last 12%. */
export function isEnclosed(pts: readonly Vec[], tolerance = 0.1, pct = 12): boolean {
  const n = pts.length;
  if (n < 6) return false;
  const L = polylineLength(pts);
  const limit = tolerance * L;
  const headEnd = Math.max(1, Math.floor((n * pct) / 100));
  const tailStart = Math.min(n - 1, Math.ceil((n * (100 - pct)) / 100));
  for (let i = 0; i < headEnd; i++) {
    for (let j = tailStart; j < n; j++) if (dist(pts[i], pts[j]) <= limit) return true;
  }
  return false;
}

/** Fraction of points lying within tol·chord of the first→last chord (0 if chord < minChord). */
export function straightness(pts: readonly Vec[], tol = 0.05, minChord = 20): number {
  if (pts.length < 2) return 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);
  if (chord < minChord) return 0;
  let ok = 0;
  for (const p of pts) if (distToSegment(p, a, b) <= tol * chord) ok++;
  return ok / pts.length;
}

export const isStraight = (pts: readonly Vec[]) => straightness(pts) >= 0.95;

// ---- corner detection ----

/** Indices of corners on a closed, evenly resampled loop (curvature peaks). */
export function findCorners(loop: readonly Vec[]): number[] {
  const n = loop.length;
  // Turning angle over a window of ±w samples is robust to hand jitter.
  const w = Math.max(2, Math.round(n * 0.04));
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = loop[(i - w + n) % n];
    const p1 = loop[i];
    const p2 = loop[(i + w) % n];
    const a1 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const a2 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn[i] = Math.abs(d);
  }
  // A corner is a local maximum turning at least ~32°; suppress neighbours within the window.
  const threshold = (32 * Math.PI) / 180;
  const corners: number[] = [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => turn[b] - turn[a]);
  const taken = new Uint8Array(n);
  for (const i of order) {
    if (turn[i] < threshold) break;
    if (taken[i]) continue;
    corners.push(i);
    for (let k = -w * 2; k <= w * 2; k++) taken[(i + k + n) % n] = 1;
  }
  return corners.sort((a, b) => a - b);
}

/** Drop vertices whose interior angle is nearly straight (closed polygon). */
function mergeCollinear(poly: Vec[], minTurnDeg = 22): Vec[] {
  let changed = true;
  let out = poly.slice();
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const t1 = Math.atan2(b.y - a.y, b.x - a.x);
      const t2 = Math.atan2(c.y - b.y, c.x - b.x);
      let d = Math.abs(t2 - t1);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if ((d * 180) / Math.PI < minTurnDeg) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// ---- fitting ----

function centroid(pts: readonly Vec[]): Vec {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

interface EllipseFit {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
}

/** PCA-oriented ellipse; radii from RMS projected extents of a uniformly sampled loop. */
export function fitEllipse(loop: readonly Vec[]): EllipseFit {
  const c = centroid(loop);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of loop) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  let su = 0;
  let sv = 0;
  for (const p of loop) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    su += u * u;
    sv += v * v;
  }
  // For points uniform in angle on an ellipse, E[u²] = rx²/2.
  const rx = Math.sqrt((2 * su) / loop.length);
  const ry = Math.sqrt((2 * sv) / loop.length);
  return { cx: c.x, cy: c.y, rx, ry, angle };
}

function ellipseError(loop: readonly Vec[], e: EllipseFit): number {
  const ca = Math.cos(e.angle);
  const sa = Math.sin(e.angle);
  let err = 0;
  for (const p of loop) {
    const dx = p.x - e.cx;
    const dy = p.y - e.cy;
    const u = (dx * ca + dy * sa) / (e.rx || 1);
    const v = (-dx * sa + dy * ca) / (e.ry || 1);
    // Radial deviation, scaled back to world units by the local radius.
    const r = Math.hypot(u, v);
    const rad = Math.hypot(u * e.rx, v * e.ry) / (r || 1);
    err += Math.abs(r - 1) * rad;
  }
  return err / loop.length / Math.max(e.rx, e.ry, 1);
}

function polygonError(loop: readonly Vec[], poly: readonly Vec[], size: number): number {
  let err = 0;
  for (const p of loop) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
    err += best;
  }
  return err / loop.length / size;
}

// ---- regularization ----

const SNAP = (20 * Math.PI) / 180;

/** Snap an orientation to the nearest multiple of 90° when within 20°. */
function snapAngle(a: number, period = Math.PI / 2): number {
  const k = Math.round(a / period);
  return Math.abs(a - k * period) < SNAP ? k * period : a;
}

function interiorAngles(poly: readonly Vec[]): number[] {
  return poly.map((b, i) => {
    const a = poly[(i - 1 + poly.length) % poly.length];
    const c = poly[(i + 1) % poly.length];
    const v1 = sub(a, b);
    const v2 = sub(c, b);
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/** Minimum-area bounding rectangle via rotating the convex hull's edges. */
function minAreaRect(pts: readonly Vec[]): { c: Vec; w: number; h: number; angle: number } {
  const hull = convexHull(pts);
  let best = { area: Infinity, c: { x: 0, y: 0 }, w: 0, h: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ca = Math.cos(-ang);
    const sa = Math.sin(-ang);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ca - p.y * sa;
      const v = p.x * sa + p.y * ca;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      best = { area, c: { x: cu * c - cv * s, y: cu * s + cv * c }, w: maxU - minU, h: maxV - minV, angle: ang };
    }
  }
  return best;
}

function rectCorners(c: Vec, w: number, h: number, angle: number): Vec[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((p) => rotate({ x: c.x + p.x, y: c.y + p.y }, c, angle));
}

/** Rotate a polygon about its centroid so its dominant edge snaps to the axes (20° window). */
function snapPolygon(poly: Vec[]): Vec[] {
  // Dominant edge = longest edge.
  let li = 0;
  let ll = 0;
  for (let i = 0; i < poly.length; i++) {
    const l = dist(poly[i], poly[(i + 1) % poly.length]);
    if (l > ll) {
      ll = l;
      li = i;
    }
  }
  const a = poly[li];
  const b = poly[(li + 1) % poly.length];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const snapped = snapAngle(ang);
  if (snapped === ang) return poly;
  const c = centroid(poly);
  return poly.map((p) => rotate(p, c, snapped - ang));
}

function regularPolygon(c: Vec, r: number, k: number, rotation: number): Vec[] {
  return Array.from({ length: k }, (_, i) => {
    const a = rotation + (i / k) * Math.PI * 2 - Math.PI / 2;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

function regularizeQuad(poly: Vec[], all: readonly Vec[]): { kind: RecognizedKind; poly: Vec[] } {
  const angles = interiorAngles(poly);
  const sides = poly.map((p, i) => dist(p, poly[(i + 1) % 4]));
  // Rhombus with near-axis-aligned diagonals → symmetric diamond.
  const meanSide = sides.reduce((s, x) => s + x, 0) / 4;
  const rhombus = sides.every((s) => Math.abs(s - meanSide) / meanSide < 0.22);
  const d1 = sub(poly[2], poly[0]);
  const d1Angle = Math.atan2(d1.y, d1.x);
  const diagonalNearAxis = Math.abs(d1Angle - Math.round(d1Angle / (Math.PI / 2)) * (Math.PI / 2)) < SNAP;
  if (rhombus && diagonalNearAxis) {
    const b = bounds(poly);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const hw = b.w / 2;
    const hh = b.h / 2;
    return {
      kind: 'diamond',
      poly: [
        { x: c.x, y: c.y - hh },
        { x: c.x + hw, y: c.y },
        { x: c.x, y: c.y + hh },
        { x: c.x - hw, y: c.y },
      ],
    };
  }
  const rightish = angles.every((a) => Math.abs(a - 90) < 16);
  if (rightish) {
    const r = minAreaRect(all);
    const angle = snapAngle(r.angle);
    let { w, h } = r;
    const ratio = Math.min(w, h) / Math.max(w, h);
    if (ratio > 0.85) {
      const s = (w + h) / 2;
      return { kind: 'square', poly: rectCorners(r.c, s, s, angle) };
    }
    return { kind: 'rectangle', poly: rectCorners(r.c, w, h, angle) };
  }
  return { kind: 'quadrilateral', poly: snapPolygon(poly) };
}

function regularizeTriangle(poly: Vec[]): { kind: RecognizedKind; poly: Vec[] } {
  const sides = poly.map((p, i) => dist(p, poly[(i + 1) % 3]));
  const mean = (sides[0] + sides[1] + sides[2]) / 3;
  if (sides.every((s) => Math.abs(s - mean) / mean < 0.12)) {
    const c = centroid(poly);
    // Orientation from the vertex farthest "up" relative to the centroid, snapped.
    const top = poly.reduce((a, b) => (b.y < a.y ? b : a));
    const rot = snapAngle(Math.atan2(top.y - c.y, top.x - c.x) + Math.PI / 2, (Math.PI * 2) / 3);
    return { kind: 'equilateralTriangle', poly: regularPolygon(c, (mean / Math.sqrt(3)), 3, rot) };
  }
  const angles = interiorAngles(poly);
  const ri = angles.findIndex((a) => Math.abs(a - 90) < 12);
  if (ri >= 0) {
    // Make the right angle exact and snap its legs to the axes when close.
    const v = poly[ri];
    const p1 = poly[(ri + 1) % 3];
    const p2 = poly[(ri + 2) % 3];
    const a1 = snapAngle(Math.atan2(p1.y - v.y, p1.x - v.x));
    const l1 = dist(v, p1);
    const l2 = dist(v, p2);
    const side = Math.sign((p1.x - v.x) * (p2.y - v.y) - (p1.y - v.y) * (p2.x - v.x)) || 1;
    const a2 = a1 + (side * Math.PI) / 2;
    const out = [v, { x: v.x + l1 * Math.cos(a1), y: v.y + l1 * Math.sin(a1) }, { x: v.x + l2 * Math.cos(a2), y: v.y + l2 * Math.sin(a2) }];
    return { kind: 'rightTriangle', poly: out };
  }
  return { kind: 'triangle', poly: snapPolygon(poly) };
}

// ---- output: re-draw as ink keeping the pressure profile ----

/** Spread the original samples evenly along the polygon edges (closed back to the start). */
export function polygonToInk(poly: readonly Vec[], original: readonly InkPoint[]): InkPoint[] {
  const k = poly.length;
  const n = Math.max(original.length, k * 4);
  const perEdge = Math.max(2, Math.floor(n / k));
  const out: InkPoint[] = [];
  for (let e = 0; e < k; e++) {
    const a = poly[e];
    const b = poly[(e + 1) % k];
    for (let s = 0; s < perEdge; s++) out.push({ ...lerp(a, b, s / perEdge), p: 0, t: 0 });
  }
  out.push({ ...poly[0], p: 0, t: 0 });
  return copyProfile(out, original);
}

export function ellipseToInk(e: EllipseFit, original: readonly InkPoint[]): InkPoint[] {
  const n = Math.max(original.length, 48);
  const ca = Math.cos(e.angle);
  const sa = Math.sin(e.angle);
  const out: InkPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * Math.PI * 2;
    const u = e.rx * Math.cos(th);
    const v = e.ry * Math.sin(th);
    out.push({ x: e.cx + u * ca - v * sa, y: e.cy + u * sa + v * ca, p: 0, t: 0 });
  }
  return copyProfile(out, original);
}

/** Pressure and timing copied by relative index, so the shape keeps the hand-drawn feel. */
function copyProfile(out: InkPoint[], original: readonly InkPoint[]): InkPoint[] {
  const m = original.length;
  for (let i = 0; i < out.length; i++) {
    const src = original[Math.min(m - 1, Math.round((i / Math.max(1, out.length - 1)) * (m - 1)))];
    out[i].p = src?.p ?? 0.5;
    out[i].t = src?.t ?? 0;
  }
  return out;
}

export function lineToInk(a: InkPoint, b: InkPoint, width: number): InkPoint[] {
  // Resample every 2× stroke width so the renderer's smoothing has something to work with.
  const n = Math.max(2, Math.ceil(dist(a, b) / Math.max(1, width * 2)) + 1);
  return Array.from({ length: n }, (_, i) => ({ ...lerp(a, b, i / (n - 1)), p: 0.5, t: a.t + ((b.t - a.t) * i) / (n - 1) }));
}

// ---- classifier ----

const MAX_ERROR = 0.075;

/**
 * Recognize a single stroke. `force` skips the closed-stroke gate (draw-and-hold / shape mode).
 * Returns null when the ink should be left as-is.
 */
export function recognize(points: readonly InkPoint[], width: number, force = false): Recognition | null {
  if (points.length < 4) return null;
  if (isStraight(points)) {
    if (!force) return null; // auto mode leaves open strokes alone
    return { kind: 'line', points: lineToInk(points[0], points[points.length - 1], width), error: 0 };
  }
  if (!isEnclosed(points)) return null;

  const b = bounds(points);
  const size = Math.max(b.w, b.h);
  if (size < 12) return null;

  const loop = resample(points, 96);
  // Close the loop for corner analysis: drop overshoot past the start.
  const closeIdx = closestToStartAfterHalf(loop);
  const ring = loop.slice(0, closeIdx);
  if (ring.length < 12) return null;

  const candidates: Recognition[] = [];

  const ell = fitEllipse(ring);
  const eErr = ellipseError(ring, ell);
  {
    const e = { ...ell };
    let kind: RecognizedKind = 'ellipse';
    if (Math.min(e.rx, e.ry) / Math.max(e.rx, e.ry) > 0.86) {
      const r = (e.rx + e.ry) / 2;
      e.rx = e.ry = r;
      e.angle = 0;
      kind = 'circle';
    } else {
      e.angle = snapAngle(e.angle);
    }
    candidates.push({ kind, points: ellipseToInk(e, points), error: eErr });
  }

  const corners = findCorners(ring);
  if (corners.length >= 3) {
    let poly = mergeCollinear(corners.map((i) => ring[i]));
    if (Math.abs(polygonArea(poly)) > 0.05 * b.w * b.h && poly.length >= 3 && poly.length <= 6) {
      let kind: RecognizedKind;
      if (poly.length === 3) ({ kind, poly } = regularizeTriangle(poly));
      else if (poly.length === 4) ({ kind, poly } = regularizeQuad(poly, ring));
      else {
        kind = poly.length === 5 ? 'pentagon' : 'hexagon';
        poly = snapPolygon(poly);
      }
      const pErr = polygonError(ring, poly, size);
      // Corners are strong evidence: bias slightly towards polygons when a polygon fits.
      candidates.push({ kind, points: polygonToInk(poly, points), error: pErr * 0.8 });
    }
  }

  candidates.sort((a, c) => a.error - c.error);
  const best = candidates[0];
  return best && best.error <= MAX_ERROR ? best : null;
}

function closestToStartAfterHalf(loop: readonly Vec[]): number {
  let best = loop.length;
  let bd = Infinity;
  for (let i = Math.floor(loop.length * 0.6); i < loop.length; i++) {
    const d = dist(loop[i], loop[0]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return Math.max(3, best);
}

// ---- line mode helpers ----

/** Snap a line's end to vertical / horizontal / 45° (Whiteboard tolerances 10 / 10 / 20 world units). */
export function tryStraight(a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 10) return { x: a.x, y: b.y };
  if (Math.abs(dy) < 10) return { x: b.x, y: a.y };
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 20) {
    const m = (Math.abs(dx) + Math.abs(dy)) / 2;
    return { x: a.x + Math.sign(dx) * m, y: a.y + Math.sign(dy) * m };
  }
  return b;
}

/** Snap to a nearby existing endpoint (squared distance < 263 → ~16 units). */
export function trySnap(p: Vec, endpoints: readonly Vec[]): Vec {
  let best: Vec | null = null;
  let bd = 263;
  for (const e of endpoints) {
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best ? { x: best.x, y: best.y } : p;
}
