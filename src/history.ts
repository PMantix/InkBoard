// Undo/redo as reversible item-level patches (cheap even for boards with many strokes).
import type { Item } from './model';

export interface Patch {
  /** Items added (by index position at the time of apply). */
  added: Item[];
  /** Items removed, with the index they occupied so undo restores z-order. */
  removed: { item: Item; index: number }[];
  /** Items replaced in place (before -> after), e.g. move/resize/recolor/beautify. */
  changed: { before: Item; after: Item }[];
}

export const emptyPatch = (): Patch => ({ added: [], removed: [], changed: [] });

export class History {
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  constructor(private items: () => Item[], private onChange: () => void, private limit = 500) {}

  /** Record a patch that has already been applied to the board. */
  push(p: Patch) {
    if (!p.added.length && !p.removed.length && !p.changed.length) return;
    this.undoStack.push(p);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const p = this.undoStack.pop();
    if (!p) return;
    const items = this.items();
    for (const a of p.added) {
      const i = items.findIndex((it) => it.id === a.id);
      if (i >= 0) items.splice(i, 1);
    }
    for (const c of p.changed) {
      const i = items.findIndex((it) => it.id === c.after.id);
      if (i >= 0) items[i] = c.before;
    }
    for (const r of [...p.removed].sort((a, b) => a.index - b.index)) items.splice(Math.min(r.index, items.length), 0, r.item);
    this.redoStack.push(p);
    this.onChange();
  }

  redo() {
    const p = this.redoStack.pop();
    if (!p) return;
    applyPatch(this.items(), p);
    this.undoStack.push(p);
    this.onChange();
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

export function applyPatch(items: Item[], p: Patch) {
  for (const r of [...p.removed].sort((a, b) => b.index - a.index)) {
    const i = items.findIndex((it) => it.id === r.item.id);
    if (i >= 0) items.splice(i, 1);
  }
  for (const c of p.changed) {
    const i = items.findIndex((it) => it.id === c.before.id);
    if (i >= 0) items[i] = c.after;
  }
  items.push(...p.added);
}
