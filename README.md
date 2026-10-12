# Inkboard

A local, pen-first infinite whiteboard for Windows and macOS. It's built as a
replacement for Microsoft Whiteboard: the ink feel, ink-to-shape and line tools
copy Whiteboard's behaviour, but every line of code is new. Boards are plain
`.inkboard` files on your disk. There's no account and nothing goes to the cloud.

## Install

Download the latest installer from the
**[Releases page](https://github.com/PMantix/InkBoard/releases/latest)**.

### macOS

1. Download **`Inkboard-<version>-mac.dmg`**. It runs natively on Apple Silicon and Intel.
2. Open the `.dmg` and drag **Inkboard** into **Applications**.
3. The first time only: open Inkboard from Applications. macOS will say it can't
   check the app for malicious software, because it isn't signed with a paid Apple
   developer certificate. Click **Done**, then go to **System Settings › Privacy &
   Security**, scroll down, and click **Open Anyway** next to Inkboard. After that
   it opens normally from Launchpad, Spotlight or the Dock. Right-click its Dock
   icon › **Options › Keep in Dock** to pin it.

   If macOS says the app "is damaged", run this once in Terminal and try again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Inkboard.app
   ```

### Windows

1. Download **`Inkboard-Setup-<version>.exe`** and run it.
2. If you see "Windows protected your PC", click **More info › Run anyway**
   (again because the app isn't code-signed).
3. The installer adds Inkboard to the **Start menu** and **desktop**, and makes
   `.inkboard` files open in Inkboard on double-click. To remove it, use
   **Settings › Apps**.

### Making a new release

Push a version tag and GitHub Actions builds both installers and attaches them
to a release:

```bash
npm version patch        # bumps package.json and creates a tag such as v0.1.1
git push --follow-tags
```

## Build from source

```bash
npm install
npm start          # build and launch
npm run dev        # hot-reload development (Vite + Electron)
npm run dist:win   # Windows installer in release/
npm run dist:mac   # macOS .dmg in release/ (must run on a Mac)
```

## Using it

| | |
|---|---|
| Pens | Three pens and a highlighter. Click the active pen again to change its colour or thickness |
| Ink to shape | The shapes button turns auto-recognition on or off for closed strokes (circle, ellipse, triangle, square, rectangle, diamond, pentagon, hexagon) |
| Draw and hold | Pause for half a second at the end of a stroke. A straight stroke becomes a ruler-straight line; a closed one becomes a shape that you can keep dragging to resize and rotate |
| Straight line | Hold Shift while drawing. Snaps to horizontal, vertical, 45° and nearby stroke ends |
| Eraser | Click the eraser again to switch between the stroke and point erasers. The pen's eraser end works too |
| Select | Lasso, or tap a stroke; Ctrl+A selects everything. Drag to move, drag the corner handle to resize, press Delete to remove. The pen's barrel button lassos |
| Navigate | Scroll or drag with two fingers to pan; Ctrl+scroll or pinch to zoom. Space+drag, middle-drag and right-drag also pan. When a pen is in use, touch only pans |
| Paste | Images and Inkboard selections. From Microsoft Whiteboard (Ctrl+A, Ctrl+C there, Ctrl+V here), images import today; ink import is waiting on decoding Whiteboard's binary point format |
| Export | File › Export as PNG, SVG or PDF (the whole board, or just the selection) |

Shortcuts: P pen, H highlighter, E eraser, V select, Ctrl+A select all, Ctrl+Z / Ctrl+Y undo/redo, Ctrl+0 fit. (On a Mac, use Cmd.)

Undo steps back one action at a time. When ink becomes a shape (auto-shapes or draw-and-hold), the first Ctrl+Z turns the shape back into the ink you actually drew; a second one removes the stroke.

## Where the behaviour comes from

Whiteboard's behaviour was worked out with [REA](https://github.com/morluto/rea)
by statically reading the app's own JavaScript, which was taken from its local
WebView2 cache. Nothing was copied; only behaviour and constants were re-implemented:

- **Input:** coalesced pointer events go through a 2nd-order IIR jitter filter
  (`0.17·x + 1.33·y₁ − 0.5·y₂`), then a Catmull-Rom → Bézier fit, then
  flattening to 0.5 px. A prediction tail covers the filter's lag, and Windows'
  delegated ink trail draws the last bit of ink at the pen tip.
- **Geometry:** each sample becomes a disc of radius `w/2·(1.5p + 0.25)`,
  joined to the previous disc by an outer-tangent bridge, all filled with the
  nonzero rule. The highlighter uses a chisel tip with darken blending.
- **Shapes:** closed-stroke gate (head and tail within 0.1 × length),
  straightness test (95% of points within 5% of the chord), 500 ms hold, 20°
  angle snap. A recognized shape is redrawn as ink that keeps your pressure
  profile. Whiteboard sent strokes to a Microsoft cloud service ("AugLoop") to
  classify them. Inkboard does it locally (`src/shapes/recognize.ts`), so it
  keeps working after Whiteboard's servers are gone.

## Layout

```
electron/        main process (windows, menus, file I/O, autosave, PDF) + preload bridge
src/ink/         input pipeline, stroke geometry, delegated ink
src/shapes/      local shape recognizer (+ tests)
src/render/      scene renderer, PNG/SVG export
src/import/      Microsoft Whiteboard clipboard import
src/editor.ts    canvas layers, tools and gestures
src/ui.ts        toolbar and popovers
```
