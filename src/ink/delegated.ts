// OS-composited "delegated ink trail": the compositor paints the last few milliseconds of
// ink straight to the pen tip, hiding render latency. Available in Chromium on Windows;
// silently a no-op elsewhere.

interface InkPresenter {
  updateInkTrailStartPoint(event: PointerEvent, style: { color: string; diameter: number }): void;
}

interface NavigatorInk {
  ink?: { requestPresenter(type: 'delegated-ink-trail', presentationArea?: Element): Promise<InkPresenter> };
}

export class DelegatedInk {
  private presenter: InkPresenter | null = null;

  constructor(area: Element) {
    const ink = (navigator as Navigator & NavigatorInk).ink;
    ink
      ?.requestPresenter('delegated-ink-trail', area)
      .then((p) => (this.presenter = p))
      .catch(() => (this.presenter = null));
  }

  get available() {
    return this.presenter !== null;
  }

  /** Call with the last pointer event rendered this frame. */
  update(event: PointerEvent, color: string, diameterCssPx: number) {
    if (!this.presenter || event.pointerType === 'mouse') return;
    try {
      this.presenter.updateInkTrailStartPoint(event, { color, diameter: Math.max(1, diameterCssPx) });
    } catch {
      // Event may be stale or not trusted (e.g. synthesized); trail just skips a frame.
    }
  }
}
