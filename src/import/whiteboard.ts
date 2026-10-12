// Import from Microsoft Whiteboard's clipboard format.
//
// Whiteboard's copy puts `<whiteboard-tag whiteboardcontent="URI-encoded JSON">` in the
// HTML clipboard flavour. The JSON is {boardItems:[{position, scale, rotation, size,
// content:{contentType, ...}}], anchorPosition, ...}. Ink lives in `inkGroup` items whose
// strokes carry their points as a base64 binary blob (`inkPointSequence.pointsData`).
import { newId, type ImageItem, type InkPoint, type Item, type StrokeItem } from '../model';
import { decodePointsData } from './wbPoints';

interface WbVec {
  x: number;
  y: number;
}

interface WbBoardItem {
  position?: WbVec;
  scale?: WbVec | number;
  rotation?: number;
  size?: { width?: number; height?: number } | WbVec;
  content?: WbContent;
}

interface WbContent {
  contentType?: string;
  imageContent?: string;
  inkStrokes?: WbStroke[];
  [k: string]: unknown;
}

interface WbStroke {
  materialType?: string;
  materialColor?: { r: number; g: number; b: number; a?: number } | string;
  nibType?: string;
  nibScale?: number;
  translation?: WbVec;
  scale?: WbVec | number;
  rotation?: number;
  minPressure?: number;
  maxPressure?: number;
  inkPointSequence?: {
    pointsData?: string;
    translation?: WbVec;
    scale?: WbVec | number;
    rotation?: number;
    pointDiameter?: number;
  };
}

export function extractWhiteboardJson(html: string): unknown {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tag = doc.querySelector('[whiteboardcontent]');
  const raw = tag?.getAttribute('whiteboardcontent');
  if (!raw) throw new Error('No Whiteboard content found on the clipboard');
  return JSON.parse(decodeURIComponent(raw));
}

const sxy = (s: WbVec | number | undefined): WbVec => (typeof s === 'number' ? { x: s, y: s } : { x: s?.x ?? 1, y: s?.y ?? 1 });

/** Affine as [a b c d e f] mapping (x,y) → (a·x + c·y + e, b·x + d·y + f). */
type Affine = [number, number, number, number, number, number];

const compose = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** translate · rotate(deg) · scale */
function trs(t: WbVec | undefined, rotDeg: number | undefined, s: WbVec | number | undefined): Affine {
  const r = ((rotDeg ?? 0) * Math.PI) / 180;
  const sc = sxy(s);
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return [c * sc.x, sn * sc.x, -sn * sc.y, c * sc.y, t?.x ?? 0, t?.y ?? 0];
}

const apply = (m: Affine, p: WbVec): WbVec => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

function cssColor(c: WbStroke['materialColor']): string {
  if (!c) return '#000000';
  if (typeof c === 'string') return c.startsWith('#') ? c.slice(0, 7) : `#${c.slice(-6)}`;
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export async function importWhiteboardClipboard(html: string): Promise<{ items: Item[]; skipped: number }> {
  const data = extractWhiteboardJson(html) as { boardItems?: WbBoardItem[] };
  const items: Item[] = [];
  let skipped = 0;
  for (const bi of data.boardItems ?? []) {
    const c = bi.content;
    const itemM = trs(bi.position, bi.rotation, bi.scale);
    switch (c?.contentType) {
      case 'inkGroup':
        for (const s of c.inkStrokes ?? []) {
          const st = strokeFrom(s, itemM);
          if (st) items.push(st);
          else skipped++;
        }
        break;
      case 'image':
      case 'documentPage': {
        if (typeof c.imageContent !== 'string') {
          skipped++;
          break;
        }
        const size = bi.size as { width?: number; height?: number } | undefined;
        const sc = sxy(bi.scale);
        const w = (size?.width ?? 400) * sc.x;
        const h = (size?.height ?? 300) * sc.y;
        const img: ImageItem = { id: newId(), type: 'image', src: c.imageContent, x: bi.position?.x ?? 0, y: bi.position?.y ?? 0, w, h };
        items.push(img);
        break;
      }
      default:
        skipped++;
    }
  }
  return { items, skipped };
}

function strokeFrom(s: WbStroke, itemM: Affine): StrokeItem | null {
  const seq = s.inkPointSequence;
  if (!seq?.pointsData) return null;
  const raw = decodePointsData(seq.pointsData);
  if (!raw.length) return null;
  const m = compose(itemM, compose(trs(s.translation, s.rotation, s.scale), trs(seq.translation, seq.rotation, seq.scale)));
  const scaleMag = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const minP = s.minPressure ?? 0;
  const maxP = s.maxPressure ?? 1;
  const t0 = raw[0].t;
  const points: InkPoint[] = raw.map((p) => {
    const w = apply(m, p);
    const pr = maxP > minP ? (p.p - minP) / (maxP - minP) : p.p;
    return { x: w.x, y: w.y, p: Math.max(0, Math.min(1, pr)), t: p.t - t0 };
  });
  const highlighter = /highlight/i.test(s.materialType ?? '');
  const width = (seq.pointDiameter ?? 2) * (s.nibScale ?? 1) * scaleMag;
  return {
    id: newId(),
    type: 'stroke',
    style: { kind: highlighter ? 'highlighter' : 'pen', color: cssColor(s.materialColor), width },
    points: points.length === 1 ? [points[0], { ...points[0], x: points[0].x + 0.01 }] : points,
  };
}
