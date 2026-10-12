// Infinite-canvas camera: world <-> screen transforms, pan and pinch/wheel zoom.
import type { Rect, Vec } from './geom';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

export class Viewport {
  /** World coordinate shown at the screen's top-left corner. */
  x = 0;
  y = 0;
  zoom = 1;
  width = 0;
  height = 0;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.emit();
  }

  toWorld(sx: number, sy: number): Vec {
    return { x: this.x + sx / this.zoom, y: this.y + sy / this.zoom };
  }

  toScreen(p: Vec): Vec {
    return { x: (p.x - this.x) * this.zoom, y: (p.y - this.y) * this.zoom };
  }

  visibleWorld(): Rect {
    return { x: this.x, y: this.y, w: this.width / this.zoom, h: this.height / this.zoom };
  }

  panBy(dxScreen: number, dyScreen: number) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.emit();
  }

  /** Zoom keeping the world point under (sx, sy) fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number) {
    const anchor = this.toWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.x = anchor.x - sx / this.zoom;
    this.y = anchor.y - sy / this.zoom;
    this.emit();
  }

  set(x: number, y: number, zoom: number) {
    this.x = x;
    this.y = y;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.emit();
  }

  fit(r: Rect | null, margin = 80) {
    if (!r || r.w === 0 || r.h === 0) {
      this.set(-this.width / 2, -this.height / 2, 1);
      return;
    }
    const z = Math.min((this.width - margin * 2) / r.w, (this.height - margin * 2) / r.h, 2);
    this.set(r.x + r.w / 2 - this.width / 2 / z, r.y + r.h / 2 - this.height / 2 / z, z);
  }
}
