import { describe, expect, it } from 'vitest';
import type { InkPoint } from '../model';
import { isEnclosed, isStraight, recognize, tryStraight } from './recognize';

// Deterministic pseudo-random jitter so hand-drawn samples are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
}

function ink(path: { x: number; y: number }[], jitter = 2, seed = 1): InkPoint[] {
  const r = rng(seed);
  return path.map((p, i) => ({ x: p.x + r() * jitter, y: p.y + r() * jitter, p: 0.5 + r() * 0.2, t: i * 8 }));
}

function polyPath(verts: { x: number; y: number }[], perEdge = 20, overshoot = 0.05) {
  const out: { x: number; y: number }[] = [];
  const k = verts.length;
  for (let e = 0; e < k; e++) {
    const a = verts[e];
    const b = verts[(e + 1) % k];
    for (let s = 0; s < perEdge; s++) out.push({ x: a.x + ((b.x - a.x) * s) / perEdge, y: a.y + ((b.y - a.y) * s) / perEdge });
  }
  // Slight overshoot past the start, like a real hand closing a shape.
  const a = verts[0];
  const b = verts[1];
  for (let s = 0; s <= perEdge * overshoot; s++) out.push({ x: a.x + ((b.x - a.x) * s) / perEdge, y: a.y + ((b.y - a.y) * s) / perEdge });
  return out;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, n = 80, rot = 0) {
  return Array.from({ length: n + 3 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const u = rx * Math.cos(t);
    const v = ry * Math.sin(t);
    return { x: cx + u * Math.cos(rot) - v * Math.sin(rot), y: cy + u * Math.sin(rot) + v * Math.cos(rot) };
  });
}

describe('gates', () => {
  it('detects closed vs open strokes', () => {
    expect(isEnclosed(ink(ellipsePath(0, 0, 100, 60)))).toBe(true);
    const arc = ellipsePath(0, 0, 100, 100, 80).slice(0, 50);
    expect(isEnclosed(ink(arc))).toBe(false);
  });

  it('detects straight strokes', () => {
    const line = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: i * 3 }));
    expect(isStraight(ink(line, 1))).toBe(true);
    expect(isStraight(ink(ellipsePath(0, 0, 50, 50).slice(0, 30)))).toBe(false);
  });
});

describe('recognize', () => {
  it('circle', () => {
    expect(recognize(ink(ellipsePath(200, 200, 120, 115), 4), 4)?.kind).toBe('circle');
  });

  it('ellipse', () => {
    expect(recognize(ink(ellipsePath(0, 0, 200, 90, 80, 0.1), 4), 4)?.kind).toBe('ellipse');
  });

  it('rectangle and square', () => {
    const rect = polyPath([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 140 }, { x: 0, y: 140 }]);
    expect(recognize(ink(rect, 4), 4)?.kind).toBe('rectangle');
    const sq = polyPath([{ x: 0, y: 0 }, { x: 200, y: 5 }, { x: 195, y: 205 }, { x: -5, y: 198 }]);
    expect(recognize(ink(sq, 4), 4)?.kind).toBe('square');
  });

  it('triangle', () => {
    const tri = polyPath([{ x: 0, y: 0 }, { x: 260, y: 40 }, { x: 60, y: 220 }], 30);
    expect(recognize(ink(tri, 3), 4)?.kind).toMatch(/triangle/i);
  });

  it('equilateral triangle', () => {
    const h = 200 * Math.sqrt(3) / 2;
    const tri = polyPath([{ x: 100, y: 0 }, { x: 200, y: h }, { x: 0, y: h }], 30);
    expect(recognize(ink(tri, 3), 4)?.kind).toBe('equilateralTriangle');
  });

  it('diamond', () => {
    const d = polyPath([{ x: 100, y: 0 }, { x: 220, y: 110 }, { x: 100, y: 220 }, { x: -20, y: 110 }], 25);
    expect(recognize(ink(d, 3), 4)?.kind).toBe('diamond');
  });

  it('hexagon', () => {
    const verts = Array.from({ length: 6 }, (_, i) => ({ x: 150 * Math.cos((i * Math.PI) / 3), y: 150 * Math.sin((i * Math.PI) / 3) }));
    expect(recognize(ink(polyPath(verts, 18), 2), 4)?.kind).toBe('hexagon');
  });

  it('keeps scribbles as ink', () => {
    const r = rng(7);
    const scribble = Array.from({ length: 120 }, (_, i) => ({ x: Math.sin(i * 0.9) * 80 + r() * 60, y: Math.cos(i * 0.37) * 80 + r() * 60 }));
    scribble.push({ ...scribble[0] });
    expect(recognize(ink(scribble, 0), 4)).toBeNull();
  });

  it('leaves open strokes alone unless forced', () => {
    const line = Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: 0 }));
    expect(recognize(ink(line, 1), 4)).toBeNull();
    const forced = recognize(ink(line, 1), 4, true);
    expect(forced?.kind).toBe('line');
  });

  it('shape output keeps pressure profile', () => {
    const pts = ink(ellipsePath(0, 0, 100, 100), 3);
    const res = recognize(pts, 4)!;
    const ps = res.points.map((p) => p.p);
    expect(Math.min(...ps)).toBeGreaterThan(0.3);
    expect(new Set(ps.map((p) => p.toFixed(3))).size).toBeGreaterThan(5);
  });
});

describe('line snapping', () => {
  it('snaps near-horizontal, vertical and 45°', () => {
    expect(tryStraight({ x: 0, y: 0 }, { x: 100, y: 6 })).toEqual({ x: 100, y: 0 });
    expect(tryStraight({ x: 0, y: 0 }, { x: 4, y: 100 })).toEqual({ x: 0, y: 100 });
    expect(tryStraight({ x: 0, y: 0 }, { x: 100, y: 110 })).toEqual({ x: 105, y: 105 });
  });
});
