// Draws a board (background + items) into a 2D context for a given world→device transform.
// Used for the live canvas and for PNG export.
import { rectsIntersect, type Rect } from '../geom';
import { strokeHairline, strokePath } from '../ink/geometry';
import { itemBounds, shapeOutline, type Background, type Item } from '../model';

const GRID_INK = 'rgba(64,64,64,0.188)';
const GRID_INK_DARK = 'rgba(255,255,255,0.22)';
const GRID_SPACING = 32;

export const isDarkPaper = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 96;
};

const images = new Map<string, HTMLImageElement>();

/** Decoded image for a data URL; triggers `onReady` once when it finishes loading. */
export function imageFor(src: string, onReady?: () => void): HTMLImageElement | null {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = src;
    images.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  if (onReady) img.addEventListener('load', onReady, { once: true });
  return null;
}

const dotTiles = new Map<string, CanvasPattern | null>();

/** Device-pixel tile with a dot at its corner, cached by colour/size. */
function dotPattern(ctx: CanvasRenderingContext2D, ink: string, stepPx: number, radiusPx: number): CanvasPattern | null {
  const size = Math.max(4, Math.round(stepPx));
  const key = `${ink}|${size}|${radiusPx.toFixed(2)}`;
  if (!dotTiles.has(key)) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const t = c.getContext('2d')!;
    t.fillStyle = ink;
    // Quarter dots in each corner so the dot sits exactly on the lattice when tiled.
    for (const [x, y] of [[0, 0], [size, 0], [0, size], [size, size]]) {
      t.beginPath();
      t.arc(x, y, radiusPx, 0, Math.PI * 2);
      t.fill();
    }
    dotTiles.set(key, ctx.createPattern(c, 'repeat'));
    if (dotTiles.size > 64) dotTiles.delete(dotTiles.keys().next().value!);
  }
  return dotTiles.get(key)!;
}

export interface DrawOptions {
  /** World rectangle being drawn (for culling and background). */
  world: Rect;
  /** World units → device pixels. */
  scale: number;
  /** Item ids to skip (e.g. items being dragged, drawn separately). */
  hidden?: Set<string>;
  onImageReady?: () => void;
}

export function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, o: DrawOptions) {
  const { world, scale } = o;
  ctx.fillStyle = bg.color;
  ctx.fillRect(world.x, world.y, world.w, world.h);
  // Grids fade out when zoomed far out (they'd become noise).
  if (bg.grid === 'none' || scale < 0.2) return;
  let step = GRID_SPACING;
  while (step * scale < 12) step *= 2;
  const ink = isDarkPaper(bg.color) ? GRID_INK_DARK : GRID_INK;
  const x0 = Math.floor(world.x / step) * step;
  const y0 = Math.floor(world.y / step) * step;
  const x1 = world.x + world.w;
  const y1 = world.y + world.h;
  const px = 1 / scale;
  ctx.save();
  if (bg.grid === 'dot') {
    // One pattern fill instead of thousands of arcs.
    const pat = dotPattern(ctx, ink, step * scale, Math.max(1.1, 1.4 * scale));
    if (pat) {
      pat.setTransform(new DOMMatrix().translateSelf(x0, y0).scaleSelf(1 / scale, 1 / scale));
      ctx.fillStyle = pat;
      ctx.fillRect(world.x, world.y, world.w, world.h);
    }
  } else {
    ctx.strokeStyle = ink;
    ctx.lineWidth = px;
    ctx.beginPath();
    const vertical = bg.grid === 'graph';
    const rowStep = bg.grid === 'compactRule' ? step * 0.75 : step;
    if (bg.grid === 'triangular') {
      const h = step * Math.sqrt(3) / 2;
      const ty0 = Math.floor(world.y / h) * h;
      for (let y = ty0; y <= y1; y += h) {
        ctx.moveTo(world.x, y);
        ctx.lineTo(x1, y);
      }
      // Two diagonal families at ±60°.
      const span = world.h / Math.tan(Math.PI / 3);
      for (let x = x0 - span - step; x <= x1 + span; x += step) {
        ctx.moveTo(x, world.y);
        ctx.lineTo(x + span, y1);
        ctx.moveTo(x + span, world.y);
        ctx.lineTo(x, y1);
      }
    } else {
      const ry0 = Math.floor(world.y / rowStep) * rowStep;
      for (let y = ry0; y <= y1; y += rowStep) {
        ctx.moveTo(world.x, y);
        ctx.lineTo(x1, y);
      }
      if (vertical) {
        for (let x = x0; x <= x1; x += step) {
          ctx.moveTo(x, world.y);
          ctx.lineTo(x, y1);
        }
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawItem(ctx: CanvasRenderingContext2D, it: Item, o: Pick<DrawOptions, 'onImageReady'> & { scale?: number }) {
  const scale = o.scale ?? 1;
  switch (it.type) {
    case 'stroke': {
      ctx.save();
      if (it.style.kind === 'highlighter') ctx.globalCompositeOperation = 'darken';
      if (it.style.width * scale < 1.5) {
        ctx.strokeStyle = it.style.color;
        ctx.lineWidth = Math.max(it.style.width, 0.7 / scale);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.stroke(strokeHairline(it.points, scale));
      } else {
        ctx.fillStyle = it.style.color;
        ctx.fill(strokePath(it.points, it.style, scale), 'nonzero');
      }
      ctx.restore();
      break;
    }
    case 'shape': {
      const pts = shapeOutline(it);
      if (pts.length < 2) break;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (it.closed) ctx.closePath();
      if (it.fill) {
        ctx.fillStyle = it.fill;
        ctx.fill();
      }
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = it.style.width;
      ctx.strokeStyle = it.style.color;
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'image': {
      const img = imageFor(it.src, o.onImageReady);
      if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
      else {
        ctx.save();
        ctx.fillStyle = 'rgba(128,128,128,0.12)';
        ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.restore();
      }
      break;
    }
  }
}

/** Draw background and visible items; the caller has already set the world transform. */
export function drawScene(ctx: CanvasRenderingContext2D, bg: Background, items: readonly Item[], o: DrawOptions) {
  drawBackground(ctx, bg, o);
  for (const it of items) {
    if (o.hidden?.has(it.id)) continue;
    if (!rectsIntersect(itemBounds(it), o.world)) continue;
    drawItem(ctx, it, o);
  }
}
