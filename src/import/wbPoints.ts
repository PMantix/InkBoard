// Decoder for Whiteboard's binary ink point sequence (`inkPointSequence.pointsData`).
// The layout is being determined from a real clipboard sample; until then this throws a
// clear error rather than importing garbage.

export interface RawInkPoint {
  x: number;
  y: number;
  p: number;
  t: number;
}

export function base64Bytes(data: string): Uint8Array {
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodePointsData(_data: string): RawInkPoint[] {
  throw new Error('Whiteboard ink point format not decoded yet');
}
