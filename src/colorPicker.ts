// Hue/saturation colour wheel with a brightness slider and hex entry.

export interface HSV {
  h: number; // 0–360
  s: number; // 0–1
  v: number; // 0–1
}

export function hsvToRgb({ h, s, v }: HSV): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export const toHex = (rgb: [number, number, number]) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

export function parseHex(text: string): [number, number, number] | null {
  let t = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(t)) return null;
  const n = parseInt(t, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build a colour wheel UI. `onChange` fires live while dragging; the caller decides when
 * to commit (e.g. an "Add colour" button).
 */
export function colorWheel(initial: string, onChange: (hex: string) => void): HTMLElement {
  const SIZE = 168;
  const dpr = window.devicePixelRatio || 1;
  const rgb0 = parseHex(initial) ?? [0, 0, 0];
  let hsv = rgbToHsv(...rgb0);
  // A pure black/white start still lets you pick a hue straight away.
  if (hsv.v < 0.05) hsv = { h: hsv.h, s: hsv.s, v: 1 };

  const root = document.createElement('div');
  root.className = 'wheel';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE * dpr;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const marker = document.createElement('div');
  marker.className = 'wheel-marker';
  const disc = document.createElement('div');
  disc.className = 'wheel-disc';
  disc.append(canvas, marker);

  const bright = document.createElement('input');
  bright.type = 'range';
  bright.min = '0';
  bright.max = '100';
  bright.className = 'wheel-bright';
  bright.setAttribute('aria-label', 'Brightness');

  const row = document.createElement('div');
  row.className = 'wheel-row';
  const preview = document.createElement('span');
  preview.className = 'wheel-preview';
  const hex = document.createElement('input');
  hex.className = 'wheel-hex';
  hex.spellcheck = false;
  hex.maxLength = 7;
  hex.setAttribute('aria-label', 'Hex colour');
  row.append(preview, hex);
  root.append(disc, bright, row);

  const ctx = canvas.getContext('2d')!;
  const paintWheel = () => {
    const n = SIZE * dpr;
    const img = ctx.createImageData(n, n);
    const r = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - r;
        const dy = y + 0.5 - r;
        const d = Math.hypot(dx, dy);
        const i = (y * n + x) * 4;
        if (d > r) continue;
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const [R, G, B] = hsvToRgb({ h, s: Math.min(1, d / r), v: hsv.v });
        img.data[i] = R;
        img.data[i + 1] = G;
        img.data[i + 2] = B;
        // Soft antialiased rim.
        img.data[i + 3] = Math.round(255 * Math.min(1, r - d));
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const sync = (fromHexInput = false) => {
    const color = toHex(hsvToRgb(hsv));
    const a = (hsv.h * Math.PI) / 180;
    marker.style.left = `${SIZE / 2 + Math.cos(a) * hsv.s * (SIZE / 2)}px`;
    marker.style.top = `${SIZE / 2 + Math.sin(a) * hsv.s * (SIZE / 2)}px`;
    marker.style.background = color;
    preview.style.background = color;
    bright.value = String(Math.round(hsv.v * 100));
    bright.style.background = `linear-gradient(to right, #000, ${toHex(hsvToRgb({ ...hsv, v: 1 }))})`;
    if (!fromHexInput) hex.value = color;
    onChange(color);
  };

  const pick = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - SIZE / 2;
    const dy = e.clientY - rect.top - SIZE / 2;
    hsv = { ...hsv, h: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / (SIZE / 2)) };
    sync();
  };
  disc.addEventListener('pointerdown', (e) => {
    disc.setPointerCapture(e.pointerId);
    pick(e);
  });
  disc.addEventListener('pointermove', (e) => {
    if (disc.hasPointerCapture(e.pointerId)) pick(e);
  });
  bright.addEventListener('input', () => {
    hsv = { ...hsv, v: Number(bright.value) / 100 };
    paintWheel();
    sync();
  });
  hex.addEventListener('input', () => {
    const rgb = parseHex(hex.value);
    if (!rgb) return;
    hsv = rgbToHsv(...rgb);
    paintWheel();
    sync(true);
  });

  paintWheel();
  sync();
  return root;
}
