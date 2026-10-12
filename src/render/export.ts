// PNG / SVG / PDF export of the whole board (or a selection).
import { unionRect, type Rect } from '../geom';
import { emitStroke, SvgSink } from '../ink/geometry';
import { itemBounds, shapeOutline, type Board, type Item } from '../model';
import { drawScene, imageFor, isDarkPaper } from './scene';

const MAX_PNG_SIDE = 16200;
const MARGIN = 48;

export function contentBounds(items: readonly Item[]): Rect | null {
  let r: Rect | null = null;
  for (const it of items) r = unionRect(r, itemBounds(it));
  return r;
}

function exportRect(items: readonly Item[]): Rect {
  const r = contentBounds(items) ?? { x: 0, y: 0, w: 800, h: 600 };
  return { x: r.x - MARGIN, y: r.y - MARGIN, w: r.w + MARGIN * 2, h: r.h + MARGIN * 2 };
}

async function waitForImages(items: readonly Item[]) {
  await Promise.all(
    items
      .filter((it) => it.type === 'image')
      .map(
        (it) =>
          new Promise<void>((resolve) => {
            if (imageFor(it.src, resolve)) resolve();
            setTimeout(resolve, 3000);
          }),
      ),
  );
}

export async function exportPng(board: Board, items: readonly Item[] = board.items, pixelRatio = 2): Promise<Uint8Array> {
  await waitForImages(items);
  const r = exportRect(items);
  let s = pixelRatio;
  while (Math.max(r.w, r.h) * s > MAX_PNG_SIDE && s > 0.05) s /= 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(r.w * s);
  canvas.height = Math.ceil(r.h * s);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(s, 0, 0, s, -r.x * s, -r.y * s);
  drawScene(ctx, board.background, items, { world: r, scale: s });
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function exportSvg(board: Board, items: readonly Item[] = board.items): { svg: string; width: number; height: number } {
  const r = exportRect(items);
  const parts: string[] = [];
  parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${board.background.color}"/>`);
  if (board.background.grid === 'dot') {
    const ink = isDarkPaper(board.background.color) ? 'rgba(255,255,255,0.22)' : 'rgba(64,64,64,0.188)';
    parts.push(
      `<defs><pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1.4" fill="${ink}"/><circle cx="32" cy="0" r="1.4" fill="${ink}"/><circle cx="0" cy="32" r="1.4" fill="${ink}"/><circle cx="32" cy="32" r="1.4" fill="${ink}"/></pattern></defs>`,
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="url(#dots)"/>`,
    );
  }
  for (const it of items) {
    if (it.type === 'stroke') {
      const sink = new SvgSink();
      emitStroke(sink, it.points, it.style);
      const blend = it.style.kind === 'highlighter' ? ' style="mix-blend-mode:darken"' : '';
      parts.push(`<path d="${sink}" fill="${it.style.color}" fill-rule="nonzero"${blend}/>`);
    } else if (it.type === 'shape') {
      const pts = shapeOutline(it);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + (it.closed ? 'Z' : '');
      parts.push(`<path d="${d}" fill="${it.fill ?? 'none'}" stroke="${it.style.color}" stroke-width="${it.style.width}" stroke-linejoin="round" stroke-linecap="round"/>`);
    } else {
      parts.push(`<image href="${esc(it.src)}" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" preserveAspectRatio="none"/>`);
    }
  }
  const width = Math.ceil(r.w);
  const height = Math.ceil(r.h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${r.x} ${r.y} ${r.w} ${r.h}">${parts.join('')}</svg>`;
  return { svg, width, height };
}
